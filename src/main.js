const { app, BrowserWindow, dialog, shell } = require("electron");
const Store = require("electron-store").default;
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

const { APP_NAME, IPC, WINDOW, LOG, ARGV_BATCH_DEBOUNCE_MS, SETTINGS_DEFAULTS,
        LEGACY_STORE_KEYS, SETTINGS_SCHEMA_VERSION, pruneLegacySettings } = require("./constants");
const formats = require("./core/formats");
const { createJob, createJoinJob, validateJob, validateJoin, defaultModeFor, STATUS } = require("./core/job");
const { JobRunner, defaultConcurrency } = require("./core/runner");
const { buildArgs } = require("./core/ffmpeg-args");
const probe = require("./core/probe");
const paths = require("./core/paths");
const scan = require("./core/scan");
const version = require("./core/version");
const { menuItems } = require("./menu");

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

// Frame previews are decoration beside a slider, not content.
const PREVIEW_FRAME_HEIGHT = 144;
const PREVIEW_FRAME_TIMEOUT_MS = 5000;

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

// The house frame: the shared preload (window.kitAPI) on the app's session,
// the settings, the Credits tab, the menu and the theme push. The settings are
// the kit's to keep, in the same "settings" key of the same config.json as
// 2.0.0, so what was saved carries over; this file's own store below keeps
// the window's bounds and the migration's marker beside them.
const kit = require("@diamonddigitaldev/electron-kit/main").start({
    settings: { defaults: SETTINGS_DEFAULTS },
    credits: {
        lines: [
            ["Created and maintained by ", { text: "Diamond Digital Development", href: "https://diamonddigital.dev" }, "."],
            ["Logo designed by ", { text: "TheFuturisticIdiot", href: "https://github.com/TheFuturisticIdiot" }, "."],
            "This software is licensed under the Apache 2.0 license.",
        ],
        donate: "https://buymeacoff.ee/willtda",
    },
    menu: { items: menuItems({ openFiles, openFolder }) },
});

const store = new Store({
    defaults: {
        windowBounds: {
            width: WINDOW.DEFAULT_WIDTH,
            height: WINDOW.DEFAULT_HEIGHT,
        },
    }
});

/**
 * One-time cleanup of keys v1 wrote and 2.0 cannot reach. See constants.js for
 * why they have to go rather than simply be ignored.
 *
 * Guarded by a version marker so it runs once. An unconditional prune would eat
 * a value a future preferences screen legitimately wrote, on the very next
 * launch, which is the same class of bug in the opposite direction.
 */
function migrateStore() {
    if (store.get("settingsSchema") === SETTINGS_SCHEMA_VERSION) return;

    const { settings, removed } = pruneLegacySettings(store.get("settings"));
    if (removed.length > 0) {
        log(LOG.INFO, `Removing settings 2.0 has no screen for: ${removed.join(", ")}`);
        store.set("settings", settings);
    }
    for (const key of LEGACY_STORE_KEYS) {
        if (store.has(key)) {
            log(LOG.INFO, `Removing the orphaned store key ${key}`);
            store.delete(key);
        }
    }

    store.set("settingsSchema", SETTINGS_SCHEMA_VERSION);
}

/**
 * The app-wide settings, with the defaults underneath: the kit reads what's
 * stored merged over SETTINGS_DEFAULTS, so a setting a partial saved object
 * leaves out still has its default.
 */
function appSettings() {
    return kit.settings.get();
}

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
            sandbox: true,
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

// The menu's own items (menu.js): the kit puts them first in the house menu.

async function openFiles() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "multiSelections"],
        filters: FILE_DIALOG_FILTERS,
    });
    if (!result.canceled && result.filePaths.length > 0) {
        sendFilesToRenderer(result.filePaths);
    }
}

async function openFolder() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths.length > 0) {
        sendFilesToRenderer(result.filePaths);
    }
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

    const settings = appSettings();

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

// The two answers that belong to a whole batch rather than to one file: a
// choice to apply to the rest of it, and the abort that ends it.
//
// A batch is one press of Convert — the renderer submits every card at once
// and awaits them together — and the runner cannot be asked where one ends.
// It goes idle between two files of the same batch whenever the later one is
// still being probed, and start() clears its own _cancelledAll on the way back
// in. Scoping this state to the runner's idle therefore threw it away mid-batch:
// an abort answered on the first dialog was forgotten, and the next file to
// arrive opened a dialog of its own for a run the user had already stopped.
//
// Counting the job:run calls that have not returned yet bounds the batch
// properly, because the file being prompted about is itself one of them — the
// count cannot reach zero while a prompt is open.
let conflictChoiceForBatch = null;
let conflictAbort = false;
let jobsInFlight = 0;

/** Run one submitted job as part of the batch it arrived with. */
async function withBatchJob(work) {
    if (jobsInFlight === 0) {
        conflictChoiceForBatch = null;
        conflictAbort = false;
    }
    jobsInFlight++;
    try {
        return await work();
    } finally {
        jobsInFlight--;
    }
}

// Serialises the output-exists prompts so only one dialog is ever open.
let conflictPromptChain = Promise.resolve();

/** Turn a chosen action into the result the runner expects. */
function applyConflictChoice(choice, candidatePath, isDirectory) {
    if (choice === "cancel") return { action: "cancel" };
    // The runner has always known how to settle a job as Skipped — it is what
    // the per-card "Skip the file" policy resolves to — but nothing ever
    // answered the prompt with it, so choosing not to convert one file left the
    // card reading Cancelled instead. Same status vocabulary, now reachable
    // from the dialog too.
    if (choice === "skip") return { action: "skip" };
    if (choice === "overwrite") return { action: "write", outputPath: candidatePath };
    return {
        action: "write",
        outputPath: isDirectory ? paths.getUniqueDirPath(candidatePath) : paths.getUniquePath(candidatePath),
    };
}

/**
 * The output-exists prompt.
 *
 * This departs from v1's button set, which was kept unchanged until now. It had
 * to: the dialog is window-modal, so while it is open Windows blocks every
 * click on the app behind it — including the footer's own "Cancel All", which
 * left a user who wanted to abort a batch with no reachable way to say so.
 * Dragging the dialog aside does not help, because position was never the
 * problem. The abort therefore lives in the only surface that can receive
 * input, and v1's "Cancel" is renamed to "Skip This File", which is what it
 * always did to a single job.
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
    // Cancel All ends the batch, not just the file it was answered on. The
    // prompts behind this one were chained before the abort and are already
    // past the runner's own cancelled check, so without this each of them
    // still opened a dialog of its own — six colliding files meant six presses
    // of a button labelled All. Escape arrives here too: cancelId is 0, which
    // is that same button.
    if (conflictAbort) return { action: "cancel" };

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
        buttons: ["Cancel All", "Skip This File", "Overwrite", "Save as New"],
        defaultId: 3,
        cancelId: 0,
        checkboxLabel: "Apply to all remaining files",
        checkboxChecked: false,
    });

    // An out-of-range response is a dismissed dialog, which cancelId already
    // defines as Cancel All, so the fallback matches it rather than inventing a
    // gentler answer the button set does not offer.
    const choice = ["cancelAll", "skip", "overwrite", "unique"][result.response] ?? "cancelAll";

    // Cancelling the run is a decision about the batch, not about this file, so
    // it is answered here rather than in applyConflictChoice. It is not kept as
    // the batch *choice* — there is nothing left to apply one to — but it is
    // kept as the batch's abort, which is what stops the prompts already chained
    // behind this one from ever being shown. This job is not settled here
    // either: the runner re-reads _cancelledAll before it looks at the answer,
    // and finishes it as Cancelled on the way past.
    if (choice === "cancelAll") {
        conflictAbort = true;
        if (runner) runner.cancelAll();
        return { action: "cancel" };
    }

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
//
// Every handler goes through kit.ipc.handle(), which answers the app's own
// page only: a window of the app navigated anywhere else still has the
// preload's bridge, and is refused before the handler runs.

async function runSubmittedJob(spec) {
    const settings = appSettings();

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
        if (meta.ok) {
            job.inputMeta = meta;
            // Now that we know whether this file actually moves, the default
            // mode can be settled properly. gif and webp only *may* hold an
            // animation, and createJob had to guess from the extension alone —
            // which turns an ordinary still WebP into a directory of one frame.
            // A mode the card asked for explicitly is never overridden.
            if (!spec.mode) {
                job.mode = defaultModeFor(job.sourceExt, job.output.ext, meta);
            }
        } else {
            log(LOG.WARN, `Could not probe ${job.inputPath}: ${meta.error}`);
        }
    }

    const validation = validateJob(job);
    if (!validation.valid) {
        log(LOG.ERROR, `Invalid job: ${validation.errors.join(" ")}`);
        return { jobId: job.id, status: STATUS.ERROR, error: validation.errors[0] };
    }

    const result = await runJobToCompletion(job);

    // Failures are reported on the card and in a toast, not as a blocking
    // dialog. v1 opened one modal per failed file mid-queue, which with a
    // concurrency pool would stack several at once and halt the whole batch.
    if (result.status === STATUS.ERROR) {
        log(LOG.ERROR, `Conversion failed for ${job.inputPath}: ${result.error}`);
    }

    return result;
}

kit.ipc.handle(IPC.JOB_RUN, (_event, spec) => withBatchJob(() => runSubmittedJob(spec)));

async function runSubmittedJoin(spec) {
    const settings = appSettings();

    // A join always names its own destination, so only the conflict policy is
    // inherited — routing and the name template describe one input becoming one
    // output, which is not what this is.
    const job = createJoinJob({
        ...spec,
        output: { onConflict: settings.onConflict, ...spec.output },
    });

    const validation = validateJoin(job);
    if (!validation.ok) {
        log(LOG.ERROR, `Invalid join: ${validation.errors.join(" ")}`);
        return { jobId: job.id, status: STATUS.ERROR, error: validation.errors[0] };
    }

    const result = await runJobToCompletion(job);
    if (result.status === STATUS.ERROR) {
        log(LOG.ERROR, `Join failed: ${result.error}`);
    }
    return result;
}

kit.ipc.handle(IPC.JOIN_RUN, (_event, spec) => withBatchJob(() => runSubmittedJoin(spec)));

kit.ipc.handle(IPC.JOB_CANCEL, (_event, jobId) => getRunner().cancel(jobId));
// The footer button, reachable only when no prompt is open — but it aborts the
// same batch, so it records it the same way.
kit.ipc.handle(IPC.QUEUE_CANCEL_ALL, () => { conflictAbort = true; getRunner().cancelAll(); });
kit.ipc.handle(IPC.QUEUE_SET_CONCURRENCY, (_event, n) => {
    getRunner().setConcurrency(n);
    kit.settings.set({ concurrency: n });
});

kit.ipc.handle(IPC.PROBE_FILE, (_event, filePath) => probe.probe(filePath));

kit.ipc.handle(IPC.FS_SCAN, (_event, inputPaths, options) => scan.scanPaths(inputPaths ?? [], options ?? {}));

kit.ipc.handle(IPC.DIALOG_BROWSE_FILES, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile", "multiSelections"],
        filters: FILE_DIALOG_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
});

kit.ipc.handle(IPC.DIALOG_BROWSE_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
});

kit.ipc.handle(IPC.DIALOG_CHOOSE_OUTPUT, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory", "createDirectory"],
        title: "Choose an output folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

kit.ipc.handle(IPC.SHELL_OPEN_PATH, (_event, target) => shell.openPath(target));
kit.ipc.handle(IPC.SHELL_SHOW_IN_FOLDER, (_event, target) => { shell.showItemInFolder(target); });
/**
 * Decode a single frame for the dialog to show. Deliberately forgiving: a source
 * that will not seek, will not decode, or simply has no picture there resolves
 * to null and the dialog shows nothing. A missing preview must never be able to
 * block choosing a frame.
 */
kit.ipc.handle(IPC.PREVIEW_FRAME, (_event, request) => {
    const inputPath = request && request.inputPath;
    const timestamp = Number(request && request.timestamp) || 0;
    if (!inputPath) return null;

    return new Promise((resolve) => {
        const child = spawn(getFfmpegPath(), [
            "-hide_banner", "-loglevel", "error",
            // Seeking before -i is the fast path; frame-accurate enough for a
            // thumbnail, and the difference is invisible at this size.
            "-ss", String(timestamp),
            "-i", inputPath,
            "-frames:v", "1",
            "-vf", `scale=-2:${PREVIEW_FRAME_HEIGHT}`,
            "-f", "image2", "-c:v", "mjpeg", "-",
        ], { windowsHide: true });

        const chunks = [];
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        // A pathological source must not leave an ffmpeg running behind a
        // dialog the user has already closed.
        const timer = setTimeout(() => { child.kill(); finish(null); }, PREVIEW_FRAME_TIMEOUT_MS);

        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.on("error", () => finish(null));
        child.on("close", (code) => {
            if (code !== 0 || chunks.length === 0) return finish(null);
            finish(`data:image/jpeg;base64,${Buffer.concat(chunks).toString("base64")}`);
        });
    });
});

kit.ipc.handle(IPC.APP_GET_FORMATS, () => ({
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
kit.ipc.handle(IPC.JOB_PREVIEW, (_event, spec) => {
    try {
        const job = createJob(spec);
        const validation = validateJob(job);
        if (!validation.valid) return { ok: false, errors: validation.errors, args: [] };

        // The destination is resolved for real rather than stubbed with a
        // placeholder. The point of this box is that what it shows is what will
        // be executed, and an output path reading "<output>" broke that for the
        // one argument the user is most likely to be checking. Routing, the
        // name template and the conflict policy all feed it, so "Save as a new
        // file" onto an existing target previews "clip (1).mp4" — which is what
        // will actually be written.
        const { outputPath } = paths.resolveOutputPath(job);
        return { ok: true, errors: [], args: buildArgs(job, { outputPath, progress: false }) };
    } catch (err) {
        return { ok: false, errors: [err.message], args: [] };
    }
});



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

// ── Lifecycle ────────────────────────────────────────────────────────────────

// kit.ready: the app is ready, and the kit's preload, menu and theme push are in place.
kit.ready.then(() => {
    log(LOG.INFO, "=== App ready ===");
    // Before the window, because the renderer asks for settings on load and
    // should never be handed a value the migration is about to remove.
    migrateStore();
    probe.setFfprobePath(getFfprobePath());
    createWindow();
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
