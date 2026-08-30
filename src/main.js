const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require("electron");
const Store = require("electron-store").default;
const fs = require("fs");
const path = require("path");

const { APP_NAME, IPC, WINDOW, LOG, ARGV_BATCH_DEBOUNCE_MS, SETTINGS_DEFAULTS } = require("./constants");
const formats = require("./core/formats");
const { createJob, validateJob, STATUS } = require("./core/job");
const { JobRunner, defaultConcurrency } = require("./core/runner");
const { buildArgs } = require("./core/ffmpeg-args");
const probe = require("./core/probe");
const paths = require("./core/paths");
const scan = require("./core/scan");
const pipeline = require("./core/pipeline");
const version = require("./core/version");

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

// Both pages follow the OS theme through a prefers-color-scheme listener of
// their own, which is the mechanism that is supposed to carry a live change.
// A tester on real Windows saw the app stay dark after switching Windows to
// Light, so this pushes the change explicitly as well: nativeTheme is the
// main process's own view of the OS setting, and does not depend on the media
// query notification reaching the renderer. Belt and braces — the page applies
// whichever arrives first, and applying twice is a no-op.
function broadcastTheme() {
    const theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.THEME_CHANGED, theme);
    }
}

// Only ever one Credits window. Without this guard the menu opened another
// modal on every click, stacking identical windows: Escape closed the top one
// and revealed the one behind it, which looks exactly like Escape doing
// nothing. The handler below was never the problem.
let creditsWindow = null;

function createCreditsWindow() {
    if (creditsWindow && !creditsWindow.isDestroyed()) {
        creditsWindow.focus();
        return;
    }

    creditsWindow = new BrowserWindow({
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

    // Escape closes the window. Handled in the main process rather than with a
    // keydown listener in the page: before-input-event fires no matter where
    // focus sits inside the document, and does not depend on the page script
    // having run. The page-level handler worked when run unpackaged but not in
    // the packaged build, which is exactly the fragility this avoids.
    creditsWindow.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "Escape") {
            event.preventDefault();
            if (!creditsWindow.isDestroyed()) creditsWindow.close();
        }
    });
    creditsWindow.on("closed", () => { creditsWindow = null; });
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
                // Electron's F12 / Ctrl+Shift+I shortcut comes from the default
                // application menu, so replacing that menu with this one took
                // DevTools away with it — which left testers unable to check
                // the console at all. Re-declared explicitly; webPreferences
                // never disabled devTools, so this was an accident, not a
                // lock-down.
                {
                    label: "Toggle Developer Tools",
                    accelerator: "F12",
                    role: "toggleDevTools"
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

    // "Apply to all remaining" is scoped to one batch, not to the session.
    runner.on("idle", () => { conflictChoiceForBatch = null; });

    return runner;
}

// A choice the user asked to apply to the rest of the batch. Cleared whenever
// the runner goes idle, so it never leaks into the next run.
let conflictChoiceForBatch = null;

// Serialises the output-exists prompts so only one dialog is ever open.
let conflictPromptChain = Promise.resolve();

/** Turn a chosen action into the result the runner expects. */
function applyConflictChoice(choice, candidatePath, isDirectory) {
    if (choice === "cancel") return { action: "cancel" };
    if (choice === "overwrite") return { action: "write", outputPath: candidatePath };
    return {
        action: "write",
        outputPath: isDirectory ? paths.getUniqueDirPath(candidatePath) : paths.getUniquePath(candidatePath),
    };
}

/**
 * The output-exists prompt, with v1's exact button set so the behaviour users
 * already know is unchanged.
 *
 * The checkbox matters: jobs run through a concurrency pool, so without a way
 * to answer once for the whole batch, converting fifty files into a folder
 * that already has them would mean fifty dialogs.
 */
async function resolveConflict(job, candidatePath) {
    const isDirectory = formats.producesDirectory(job.mode);

    // Prompts are serialised, one at a time. The concurrency pool brings
    // several jobs here at once, and each used to read conflictChoiceForBatch
    // (still null) and open its own dialog *before* the first answer came
    // back — so ticking "apply to all remaining" had no effect on the dialogs
    // already queued behind it, and the user was asked again for every file.
    // Chaining means each prompt re-reads the batch choice after the previous
    // one has settled.
    const mine = conflictPromptChain.then(
        () => promptForConflict(candidatePath, isDirectory)
    );
    conflictPromptChain = mine.then(() => {}, () => {});
    return mine;
}

/** The prompt itself. Only ever called one at a time, via resolveConflict. */
async function promptForConflict(candidatePath, isDirectory) {
    if (conflictChoiceForBatch) {
        return applyConflictChoice(conflictChoiceForBatch, candidatePath, isDirectory);
    }

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
        checkboxLabel: "Apply to all remaining files",
        checkboxChecked: false,
    });

    const choice = ["cancel", "overwrite", "unique"][result.response] ?? "cancel";
    if (result.checkboxChecked) conflictChoiceForBatch = choice;

    return applyConflictChoice(choice, candidatePath, isDirectory);
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

/**
 * Fold a saved pipeline into a job. Returns { job, error }.
 *
 * A missing or invalid graph is an error rather than a silent fallback: the
 * file would otherwise convert with whatever settings happened to be left on
 * it, which is not what was asked for.
 */
function resolvePipeline(job, pipelineId) {
    const graph = (store.get("pipelines") ?? []).find(p => p.id === pipelineId);
    if (!graph) return { job: null, error: "That pipeline no longer exists." };

    const check = pipeline.validate(graph);
    if (!check.valid) return { job: null, error: `Pipeline is not valid: ${check.errors[0]}` };

    try {
        return { job: pipeline.applyToJob(job, graph), error: null };
    } catch (err) {
        return { job: null, error: err.message };
    }
}

ipcMain.handle(IPC.JOB_RUN, async (_event, spec) => {
    const settings = store.get("settings") ?? SETTINGS_DEFAULTS;

    const job = createJob({
        ...spec,
        output: {
            routing:      settings.outputRouting,
            dir:          settings.outputDir,
            nameTemplate: settings.nameTemplate,
            onConflict:   settings.onConflict,
            ...spec.output,
        },
    });

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

    let runnable = job;
    if (spec.pipelineId) {
        const resolved = resolvePipeline(job, spec.pipelineId);
        if (resolved.error) {
            log(LOG.ERROR, `Pipeline failed for ${job.inputPath}: ${resolved.error}`);
            return { jobId: job.id, status: STATUS.ERROR, error: resolved.error };
        }
        runnable = resolved.job;

        // A pipeline's encode node can name a codec the target container cannot
        // carry. The check above ran before the pipeline was folded in, so it
        // never saw those settings — without this, ffmpeg is the first thing to
        // object, and it does so in its own words rather than the app's.
        const afterPipeline = validateJob(runnable);
        if (!afterPipeline.valid) {
            log(LOG.ERROR, `Pipeline settings rejected for ${job.inputPath}: ${afterPipeline.errors.join(" ")}`);
            return { jobId: job.id, status: STATUS.ERROR, error: afterPipeline.errors[0] };
        }
    }

    const result = await runJobToCompletion(runnable);

    // Failures are reported on the card and in a toast, not as a blocking
    // dialog. v1 opened one modal per failed file mid-queue, which with a
    // concurrency pool would stack several at once and halt the whole batch.
    if (result.status === STATUS.ERROR) {
        log(LOG.ERROR, `Conversion failed for ${job.inputPath}: ${result.error}`);
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
    // The full capability graph, including cross-kind targets. core/display.js
    // takes this as an argument because the renderer cannot require formats.js.
    targetsByExt: Object.fromEntries(
        formats.SUPPORTED_EXTENSIONS.map(ext => [ext, formats.targetsFor(ext)])
    ),
    // Capability descriptors, so the New Job dialog can offer exactly the
    // codecs and quality ranges each container supports rather than hardcoding
    // lists that would drift from the format graph.
    descriptors: formats.FORMATS,
    modes: formats.MODE,
    kinds: formats.KIND,
}));

// Live ffmpeg preview for the New Job dialog. Runs the spec through the real
// argument builder, so what the dialog shows is what will actually be executed.
ipcMain.handle(IPC.JOB_PREVIEW, (_event, spec) => {
    try {
        let job = createJob(spec);
        const validation = validateJob(job);
        if (!validation.valid) return { ok: false, errors: validation.errors, args: [] };

        if (spec.pipelineId) {
            const resolved = resolvePipeline(job, spec.pipelineId);
            if (resolved.error) return { ok: false, errors: [resolved.error], args: [] };
            job = resolved.job;

            // Same reason as the run path: encode-node settings arrive after
            // the first check, so the preview has to look again or it would
            // show a command the run would then refuse.
            const afterPipeline = validateJob(job);
            if (!afterPipeline.valid) return { ok: false, errors: afterPipeline.errors, args: [] };
        } else if (spec.pipelineId === null && spec.processing === "pipeline") {
            return { ok: false, errors: ["Choose a pipeline."], args: [] };
        }

        return { ok: true, errors: [], args: buildArgs(job, { outputPath: "<output>", progress: false }) };
    } catch (err) {
        return { ok: false, errors: [err.message], args: [] };
    }
});

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

    // Pre-releases are never an update target. The updater only ever looks at
    // the latest stable, whatever the user is currently running.
    //
    // This has to be explicit: electron-updater turns allowPrerelease ON BY
    // ITSELF when the running version carries a pre-release tag, so shipping
    // 2.0.0-alpha.1 would silently opt every alpha tester into being updated to
    // the next alpha. allowDowngrade stays off so an alpha user is not dragged
    // back to an older stable either — they simply get nothing until a stable
    // release supersedes what they are running.
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.channel = "latest";

    autoUpdater.on("update-available", (info) => {
        const currentVersion = app.getVersion();
        const newVersion = info.version;

        // Belt and braces. allowPrerelease above should mean this never fires
        // for a pre-release, but a mis-tagged GitHub release would otherwise
        // push an alpha at every user, so the offer is checked again here.
        if (!version.isOfferableUpdate(newVersion, currentVersion)) {
            log(LOG.WARN, `Ignoring update ${newVersion}: not an offerable stable release`);
            return;
        }

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
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.channel = "latest";

    autoUpdater.checkForUpdates().then(result => {
        const found = result?.updateInfo?.version ?? null;
        // Equality was the wrong test: running 2.0.0-alpha.1 against a latest
        // stable of 1.0.0 is neither equal nor an update, and the check used to
        // fall through and do nothing at all.
        if (!version.isOfferableUpdate(found, app.getVersion())) {
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
    nativeTheme.on("updated", broadcastTheme);
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
