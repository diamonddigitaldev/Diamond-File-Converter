const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const Store = require("electron-store").default;
const fs = require("fs");
const path = require("path");

const { APP_NAME, IPC, WINDOW, LOG, ARGV_BATCH_DEBOUNCE_MS, SETTINGS_DEFAULTS } = require("./constants");
const formats = require("./core/formats");
const { createJob, validateJob, STATUS } = require("./core/job");
const { JobRunner, defaultConcurrency } = require("./core/runner");
const probe = require("./core/probe");
const paths = require("./core/paths");
const scan = require("./core/scan");
const pipeline = require("./core/pipeline");

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

const FILE_DIALOG_FILTERS = [
    { name: "Supported Files", extensions: formats.SUPPORTED_EXTENSIONS },
    { name: "Audio", extensions: extensionsOfKind(formats.KIND.AUDIO) },
    { name: "Video", extensions: extensionsOfKind(formats.KIND.VIDEO) },
    { name: "Image", extensions: extensionsOfKind(formats.KIND.IMAGE) },
];

function extensionsOfKind(kind) {
    return Object.values(formats.FORMATS).filter(f => f.kind === kind).map(f => f.ext);
}

const LOG_LEVEL = LOG_LEVELS[String(process.env.LOG_LEVEL || "INFO").toUpperCase()] ?? LOG_LEVELS.INFO;

const logFile = path.join(app.getPath("userData"), "debug.log");
fs.writeFileSync(logFile, `=== App started at ${new Date().toISOString()} ===\n`);

function log(level, ...args) {
    const lvl = String(level).toUpperCase();
    if ((LOG_LEVELS[lvl] ?? LOG_LEVELS.INFO) > LOG_LEVEL) return;
    const message = `[${new Date().toISOString()}] [${lvl}] ${args.join(" ")}\n`;
    fs.appendFileSync(logFile, message);
    if (lvl === "ERROR") console.error(...args);
    else if (lvl === "WARN") console.warn(...args);
    else console.log(...args);
}

if (process.platform === "win32") {
    app.setAppUserModelId(app.getName());
}

// prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const store = new Store({
    defaults: {
        windowBounds: {
            width: WINDOW.DEFAULT_WIDTH,
            height: WINDOW.DEFAULT_HEIGHT,
        },
        settings: SETTINGS_DEFAULTS,
        presets: [],
        pipelines: [],
    }
});

let mainWindow;
let runner = null;

function getIconPath() {
    switch (process.platform) {
        case "darwin": return path.join(__dirname, "assets", "diamondfileconverter.icns");
        case "linux":  return path.join(__dirname, "assets", "diamondfileconverter.png");
        default:       return path.join(__dirname, "assets", "diamondfileconverter.ico");
    }
}

function getFfmpegPath() {
    if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe");
    return require("ffmpeg-static"); // dev: executable path inside node_modules
}

function getFfprobePath() {
    if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg", "ffprobe.exe");
    return require("ffprobe-static").path;
}

function createWindow() {
    const savedBounds = store.get("windowBounds");

    mainWindow = new BrowserWindow({
        width: savedBounds.width,
        height: savedBounds.height,
        x: savedBounds.x,
        y: savedBounds.y,
        minWidth: WINDOW.MIN_WIDTH,
        minHeight: WINDOW.MIN_HEIGHT,
        title: APP_NAME,
        icon: getIconPath(),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));

    // debounced save so we dont spam the disk with updates
    let saveBoundsTimeout;
    const saveBounds = () => {
        clearTimeout(saveBoundsTimeout);
        saveBoundsTimeout = setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                store.set("windowBounds", mainWindow.getBounds());
            }
        }, 500);
    };

    mainWindow.on("resize", saveBounds);
    mainWindow.on("move", saveBounds);
    mainWindow.on("close", () => {
        if (!mainWindow.isDestroyed()) store.set("windowBounds", mainWindow.getBounds());
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.webContents.on("did-finish-load", flushPendingFiles);
}

function createCreditsWindow() {
    const creditsWindow = new BrowserWindow({
        width: 750,
        height: 450,
        parent: mainWindow,
        modal: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: getIconPath()
    });
    creditsWindow.on("minimize", (e) => {
        e.preventDefault();
        creditsWindow.show();
        creditsWindow.focus();
    });
    creditsWindow.setMenu(null);
    creditsWindow.loadFile(path.join(__dirname, "credits.html"));
}

function setupMenu() {
    const template = [
        {
            label: "Menu",
            submenu: [
                {
                    label: "Open Files",
                    accelerator: "Ctrl+O",
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ["openFile", "multiSelections"],
                            filters: FILE_DIALOG_FILTERS,
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            sendFilesToRenderer(result.filePaths);
                        }
                    }
                },
                {
                    label: "Open Folder",
                    accelerator: "Ctrl+Shift+O",
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ["openDirectory"],
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            sendFilesToRenderer(result.filePaths);
                        }
                    }
                },
                { type: "separator" },
                {
                    label: "Check for Updates",
                    click: checkForUpdatesManually
                },
                { type: "separator" },
                {
                    label: "Exit",
                    accelerator: "Alt+F4",
                    role: "quit"
                }
            ]
        },
        {
            label: "Credits",
            accelerator: "C",
            click: () => { createCreditsWindow(); }
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Incoming files (file associations, "Open with", Explorer context menu) ───
//
// v1 had none of this: no open-file handler, no argv parsing, and
// second-instance discarded the paths it was handed. Windows launches one
// process per selected file, so arrivals are batched before being forwarded.

let pendingFiles = [];
let pendingTimer = null;

function queueIncomingFiles(filePaths) {
    const usable = filePaths.filter(p => typeof p === "string" && !p.startsWith("-"));
    if (usable.length === 0) return;

    pendingFiles.push(...usable);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushPendingFiles, ARGV_BATCH_DEBOUNCE_MS);
}

function flushPendingFiles() {
    if (pendingFiles.length === 0) return;
    if (!mainWindow || mainWindow.webContents.isLoading()) return;

    const batch = pendingFiles;
    pendingFiles = [];
    sendFilesToRenderer(batch);
}

function sendFilesToRenderer(filePaths) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(IPC.FILES_OPENED, filePaths);
}

/** Strip Electron's own arguments and keep anything that exists on disk. */
function filePathsFromArgv(argv) {
    return argv.slice(app.isPackaged ? 1 : 2).filter((arg) => {
        if (typeof arg !== "string" || arg.startsWith("-")) return false;
        try { return fs.existsSync(arg); } catch (_) { return false; }
    });
}

// ── Conversion ───────────────────────────────────────────────────────────────

function getRunner() {
    if (runner) return runner;

    const settings = store.get("settings") ?? SETTINGS_DEFAULTS;

    runner = new JobRunner({
        ffmpegPath: getFfmpegPath(),
        concurrency: settings.concurrency ?? defaultConcurrency(),
        conflictResolver: resolveConflict,
    });

    runner.on("progress", (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.JOB_PROGRESS, payload);
        }
    });

    runner.on("status", (payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC.JOB_STATUS, payload);
        }
    });

    return runner;
}

/**
 * The output-exists prompt. Kept as a native dialog with v1's exact button
 * set, so the behaviour users already know is unchanged.
 */
async function resolveConflict(job, candidatePath) {
    const isDirectory = formats.producesDirectory(job.mode);
    const result = await dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "File Already Exists",
        message: `${path.basename(candidatePath)} already exists.`,
        detail: isDirectory
            ? "A folder with this name is already in the destination."
            : "A file with this name is already in the destination.",
        buttons: ["Cancel", "Overwrite", "Save as New"],
        defaultId: 2,
        cancelId: 0,
    });

    if (result.response === 0) return { action: "cancel" };
    if (result.response === 1) return { action: "write", outputPath: candidatePath };
    return {
        action: "write",
        outputPath: isDirectory ? paths.getUniqueDirPath(candidatePath) : paths.getUniquePath(candidatePath),
    };
}

/**
 * Run one job to completion. The runner supports a full concurrency pool; this
 * wrapper resolves when the given job settles so a caller can await a single
 * conversion.
 */
function runJobToCompletion(job) {
    return new Promise((resolve) => {
        const active = getRunner();

        const onStatus = (payload) => {
            if (payload.jobId !== job.id) return;
            if (payload.status === STATUS.RUNNING) return;
            active.off("status", onStatus);
            resolve(payload);
        };

        active.on("status", onStatus);
        active.enqueue(job);
        active.start();
    });
}

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle(IPC.JOB_RUN, async (_event, spec) => {
    const job = createJob(spec);

    // Metadata is what gives progress a denominator, so probe before running.
    // A failed probe is not fatal; the job simply reports indeterminate progress.
    if (!job.inputMeta) {
        const meta = await probe.probe(job.inputPath);
        if (meta.ok) job.inputMeta = meta;
        else log(LOG.WARN, `Could not probe ${job.inputPath}: ${meta.error}`);
    }

    const validation = validateJob(job);
    if (!validation.valid) {
        log(LOG.ERROR, `Invalid job: ${validation.errors.join(" ")}`);
        return { jobId: job.id, status: STATUS.ERROR, error: validation.errors[0] };
    }

    const result = await runJobToCompletion(job);

    if (result.status === STATUS.ERROR) {
        log(LOG.ERROR, `Conversion failed for ${job.inputPath}: ${result.error}`);
        dialog.showMessageBox(mainWindow, {
            type: "error",
            title: "Conversion Failed",
            message: `Could not convert ${path.basename(job.inputPath)}.`,
            detail: result.error ?? "ffmpeg did not report a reason.",
            buttons: ["OK"],
        });
    }

    return result;
});

ipcMain.handle(IPC.JOB_CANCEL, (_event, jobId) => getRunner().cancel(jobId));
ipcMain.handle(IPC.QUEUE_CANCEL_ALL, () => { getRunner().cancelAll(); });
ipcMain.handle(IPC.QUEUE_SET_CONCURRENCY, (_event, n) => {
    getRunner().setConcurrency(n);
    store.set("settings.concurrency", n);
});

ipcMain.handle(IPC.PROBE_FILE, (_event, filePath) => probe.probe(filePath));

ipcMain.handle(IPC.FS_SCAN, (_event, inputPaths, options) => scan.scanPaths(inputPaths ?? [], options ?? {}));

ipcMain.handle(IPC.DIALOG_BROWSE_FILES, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "multiSelections"],
        filters: FILE_DIALOG_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
});

ipcMain.handle(IPC.DIALOG_BROWSE_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
});

ipcMain.handle(IPC.DIALOG_CHOOSE_OUTPUT, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory", "createDirectory"],
        title: "Choose an output folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle(IPC.SHELL_OPEN_PATH, (_event, target) => shell.openPath(target));
ipcMain.handle(IPC.SHELL_SHOW_IN_FOLDER, (_event, target) => { shell.showItemInFolder(target); });
ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, (_event, url) => {
    // Only ever hand the OS an http(s) URL, whatever the page asked for.
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    log(LOG.WARN, `Refused to open external URL: ${url}`);
});

ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());
ipcMain.handle(IPC.APP_GET_FORMATS, () => ({
    conversionMap: formats.buildLegacyConversionMap(),
    aliases: formats.EXT_ALIASES,
    supported: formats.SUPPORTED_EXTENSIONS,
}));

ipcMain.handle(IPC.SETTINGS_GET, () => store.get("settings"));
ipcMain.handle(IPC.SETTINGS_SET, (_event, settings) => {
    store.set("settings", { ...store.get("settings"), ...settings });
    return store.get("settings");
});

ipcMain.handle(IPC.PRESET_LIST, () => store.get("presets"));
ipcMain.handle(IPC.PRESET_SAVE, (_event, preset) => {
    const presets = store.get("presets").filter(p => p.id !== preset.id);
    presets.push(preset);
    store.set("presets", presets);
    return presets;
});
ipcMain.handle(IPC.PRESET_DELETE, (_event, id) => {
    const presets = store.get("presets").filter(p => p.id !== id);
    store.set("presets", presets);
    return presets;
});

ipcMain.handle(IPC.PIPELINE_LIST, () => store.get("pipelines"));
ipcMain.handle(IPC.PIPELINE_SAVE, (_event, graph) => {
    const pipelines = store.get("pipelines").filter(p => p.id !== graph.id);
    pipelines.push(graph);
    store.set("pipelines", pipelines);
    return pipelines;
});
ipcMain.handle(IPC.PIPELINE_DELETE, (_event, id) => {
    const pipelines = store.get("pipelines").filter(p => p.id !== id);
    store.set("pipelines", pipelines);
    return pipelines;
});
ipcMain.handle(IPC.PIPELINE_VALIDATE, (_event, graph) => pipeline.validate(graph));

// ── Auto-update ──────────────────────────────────────────────────────────────

function setupAutoUpdater() {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
        const currentVersion = app.getVersion();
        const newVersion = info.version;
        dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "Update Available",
            message: "A new version of Diamond File Converter is available!",
            detail: `Current version: ${currentVersion}\nNew version: ${newVersion}\n\nWould you like to download and install this update?`,
            buttons: ["Yes, Update Now", "No, Later", "View Changelog"],
            defaultId: 0,
            cancelId: 1
        }).then(result => {
            if (result.response === 0) autoUpdater.downloadUpdate();
            if (result.response === 2) shell.openExternal(`https://github.com/diamonddigitaldev/Diamond-File-Converter/releases/tag/${newVersion}`);
        });
    });

    autoUpdater.on("update-not-available", () => log(LOG.INFO, "No updates available"));

    autoUpdater.on("download-progress", (progress) => {
        log(LOG.INFO, `Download progress: ${Math.round(progress.percent)}%`);
    });

    autoUpdater.on("update-downloaded", (info) => {
        dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "Update Ready",
            message: "Update downloaded successfully!",
            detail: `Version ${info.version} is ready to install. The application will restart to complete the update.`,
            buttons: ["Install Now", "Install on Quit"],
            defaultId: 0,
            cancelId: 1
        }).then(result => {
            if (result.response === 0) autoUpdater.quitAndInstall();
        });
    });

    autoUpdater.on("error", (err) => log(LOG.ERROR, "Auto-updater error:", err.message));

    // delay startup check so the window is ready to show a dialog
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {});
    }, 5000);
}

function checkForUpdatesManually() {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.checkForUpdates().then(result => {
        if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
            dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "No Updates",
                message: "You're up to date!",
                detail: `Diamond File Converter ${app.getVersion()} is the latest version.`,
                buttons: ["OK", "View Changelog"]
            }).then(r => {
                if (r.response === 1) shell.openExternal(`https://github.com/diamonddigitaldev/Diamond-File-Converter/releases/tag/${app.getVersion()}`);
            });
        }
    }).catch(err => {
        dialog.showMessageBox(mainWindow, {
            type: "error",
            title: "Update Check Failed",
            message: "Could not check for updates.",
            detail: err.message,
            buttons: ["OK"]
        });
    });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
    log(LOG.INFO, "=== App ready ===");
    probe.setFfprobePath(getFfprobePath());
    createWindow();
    setupMenu();
    queueIncomingFiles(filePathsFromArgv(process.argv));
    if (app.isPackaged) setupAutoUpdater();
});

// macOS delivers associated files through this event rather than argv.
app.on("open-file", (event, filePath) => {
    event.preventDefault();
    queueIncomingFiles([filePath]);
});

app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
    // v1 focused the window but threw the paths away, so "Open with" on an
    // already-running app did nothing.
    queueIncomingFiles(filePathsFromArgv(argv));
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
    if (runner) runner.cancelAll();
});
