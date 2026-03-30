const { app, BrowserWindow, ipcMain, dialog, Menu, shell, globalShortcut } = require("electron");
const Store = require("electron-store").default;
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const { APP_NAME, IPC, WINDOW, LOG, AUDIO_FORMATS, VIDEO_FORMATS, IMAGE_FORMATS, SUPPORTED_EXTENSIONS, EXT_ALIASES, isGifToStaticImage } = require("./constants");

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

const FILE_DIALOG_FILTERS = [
    { name: "Supported Files", extensions: SUPPORTED_EXTENSIONS },
    { name: "Audio",           extensions: AUDIO_FORMATS.map(f => f.ext) },
    { name: "Video",           extensions: VIDEO_FORMATS.map(f => f.ext) },
    { name: "Image",           extensions: IMAGE_FORMATS.map(f => f.ext) },
];
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
        }
    }
});

let mainWindow;
let activeConversion = null;
let conversionCancelled = false;

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
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));
    // mainWindow.webContents.openDevTools();

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
            nodeIntegration: true,
            contextIsolation: false
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
                    label: "Open File",
                    accelerator: "Ctrl+O",
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ["openFile"],
                            filters: FILE_DIALOG_FILTERS,
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send(IPC.FILE_OPENED_FROM_MENU, result.filePaths[0]);
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

// IPC: base handlers
ipcMain.handle(IPC.GET_VERSION, () => app.getVersion());
ipcMain.handle(IPC.GET_SETTING, (_event, key) => store.get(key));
ipcMain.handle(IPC.SET_SETTING, (_event, key, value) => store.set(key, value));

// IPC: file browser, returns array of paths, or null if cancelled
ipcMain.handle(IPC.BROWSE_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "multiSelections"],
        filters: FILE_DIALOG_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
});

// IPC: open output folder in explorer
ipcMain.handle(IPC.OPEN_FOLDER, (_event, folderPath) => {
    shell.openPath(folderPath);
});

// IPC: show a file in its parent folder (highlights the file)
ipcMain.handle(IPC.SHOW_IN_FOLDER, (_event, filePath) => {
    shell.showItemInFolder(filePath);
});

// IPC: cancel an in progress conversion
ipcMain.handle(IPC.CANCEL_CONVERT, () => {
    if (activeConversion) {
        conversionCancelled = true;
        activeConversion.kill("SIGKILL");
        activeConversion = null;
        log(LOG.INFO, "Conversion cancelled by user");
    }
});

// finds the next available filename: "file (1).ext", "file (2).ext"...
function getUniquePath(filePath) {
    if (!fs.existsSync(filePath)) return filePath;
    const ext = path.extname(filePath);
    const stem = path.basename(filePath, ext);
    const dir = path.dirname(filePath);
    let i = 1;
    let candidate;
    do {
        candidate = path.join(dir, `${stem} (${i})${ext}`);
        i++;
    } while (fs.existsSync(candidate));
    return candidate;
}

// finds the next available directory name: "dir (1)", "dir (2)"...
function getUniqueDirPath(dirPath) {
    if (!fs.existsSync(dirPath)) return dirPath;
    let i = 1;
    let candidate;
    do {
        candidate = `${dirPath} (${i})`;
        i++;
    } while (fs.existsSync(candidate));
    return candidate;
}

// IPC: run a conversion
ipcMain.handle(IPC.CONVERT_FILE, async (_event, filePath, targetExt) => {
    const stem = path.basename(filePath, path.extname(filePath));
    const rawExt = path.extname(filePath).slice(1).toLowerCase();
    const sourceExt = EXT_ALIASES[rawExt] ?? rawExt;

    // GIF -> static image: extract all frames into a folder
    if (isGifToStaticImage(sourceExt, targetExt)) {
        let outputDir = path.join(path.dirname(filePath), stem);

        if (fs.existsSync(outputDir)) {
            const { response } = await dialog.showMessageBox(mainWindow, {
                type: "question",
                title: "Folder Already Exists",
                message: `"${path.basename(outputDir)}" folder already exists.`,
                detail: "What would you like to do?",
                buttons: ["Cancel", "Overwrite", "Save as New"],
                defaultId: 2,
                cancelId: 0
            });
            if (response === 0) return "cancelled";
            if (response === 1) fs.rmSync(outputDir, { recursive: true, force: true });
            if (response === 2) outputDir = getUniqueDirPath(outputDir);
        }

        fs.mkdirSync(outputDir, { recursive: true });
        const outputPattern = path.join(outputDir, `frame_%03d.${targetExt}`);

        conversionCancelled = false;
        return new Promise((resolve) => {
            const command = ffmpeg(filePath);
            activeConversion = command;

            command
                .on("progress", (progress) => {
                    const percent = Math.round(progress.percent || 0);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send(IPC.CONVERSION_PROGRESS, percent);
                    }
                })
                .on("end", () => {
                    activeConversion = null;
                    log(LOG.INFO, `Extracted frames: ${path.basename(filePath)} -> ${path.basename(outputDir)}/`);
                    resolve(outputDir);
                })
                .on("error", (err) => {
                    activeConversion = null;
                    if (fs.existsSync(outputDir)) {
                        try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { log(LOG.WARN, "Could not delete output dir:", e.message); }
                    }
                    if (conversionCancelled) {
                        conversionCancelled = false;
                        resolve(null);
                        return;
                    }
                    log(LOG.ERROR, "Frame extraction error:", err.message);
                    dialog.showMessageBox(mainWindow, {
                        type: "error",
                        title: "Conversion Failed",
                        message: `Failed to extract frames from ${path.basename(filePath)}.`,
                        detail: err.message,
                        buttons: ["OK"]
                    });
                    resolve(null);
                })
                .save(outputPattern);
        });
    }

    let outputPath = path.join(path.dirname(filePath), `${stem}.${targetExt}`);

    // handle file conflict
    if (fs.existsSync(outputPath)) {
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: "question",
            title: "File Already Exists",
            message: `${path.basename(outputPath)} already exists.`,
            detail: "What would you like to do?",
            buttons: ["Cancel", "Overwrite", "Save as New"],
            defaultId: 2,
            cancelId: 0
        });
        if (response === 0) return "cancelled";
        if (response === 2) outputPath = getUniquePath(outputPath);
    }

    conversionCancelled = false;
    return new Promise((resolve) => {
        const command = ffmpeg(filePath);
        activeConversion = command;

        command
            .on("progress", (progress) => {
                const percent = Math.round(progress.percent || 0);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send(IPC.CONVERSION_PROGRESS, percent);
                }
            })
            .on("end", () => {
                activeConversion = null;
                log(LOG.INFO, `Converted: ${path.basename(filePath)} -> ${path.basename(outputPath)}`);
                resolve(outputPath);
            })
            .on("error", (err) => {
                activeConversion = null;
                // clean up partial output file on cancel or failure
                if (fs.existsSync(outputPath)) {
                    try { fs.unlinkSync(outputPath); } catch (e) { log(LOG.WARN, "Could not delete partial file:", e.message); }
                }
                if (conversionCancelled) {
                    conversionCancelled = false;
                    resolve(null);
                    return;
                }
                log(LOG.ERROR, "Conversion error:", err.message);
                dialog.showMessageBox(mainWindow, {
                    type: "error",
                    title: "Conversion Failed",
                    message: `Failed to convert ${path.basename(filePath)} to .${targetExt}.`,
                    detail: err.message,
                    buttons: ["OK"]
                });
                resolve(null);
            })
            .save(outputPath);
    });
});

function setupAutoUpdater() {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on(IPC.UPDATE_AVAILABLE, (info) => {
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

app.whenReady().then(() => {
    log(LOG.INFO, "=== App ready ===");
    ffmpeg.setFfmpegPath(getFfmpegPath());
    createWindow();
    setupMenu();
    if (app.isPackaged) setupAutoUpdater();
});

app.on("second-instance", () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("will-quit", () => {
    globalShortcut.unregisterAll();
});
