const { app, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const { APP_NAME, IPC, WINDOW, SETTINGS_DEFAULTS, LEGACY_STORE_KEYS,
        SETTINGS_SCHEMA_VERSION, CONFLICT_CHOICES, pruneLegacySettings } = require("./constants");
const formats = require("./core/formats");
const { createJob, createJoinJob, validateJob, validateJoin, defaultModeFor, STATUS } = require("./core/job");
const { JobRunner, defaultConcurrency } = require("./core/runner");
const { buildArgs } = require("./core/ffmpeg-args");
const probe = require("./core/probe");
const paths = require("./core/paths");
const scan = require("./core/scan");
const { menuItems } = require("./menu");

// Frame previews are decoration beside a slider, not content.
const PREVIEW_FRAME_HEIGHT = 144;
const PREVIEW_FRAME_TIMEOUT_MS = 5000;
// How far back to step, in seconds, when a seek lands after the last picture.
const PREVIEW_FRAME_BACKOFF = [0.25, 1, 5];

const FILE_DIALOG_FILTERS = [
    { name: "Supported Files", extensions: formats.SUPPORTED_EXTENSIONS },
    { name: "Audio", extensions: extensionsOfKind(formats.KIND.AUDIO) },
    { name: "Video", extensions: extensionsOfKind(formats.KIND.VIDEO) },
    { name: "Image", extensions: extensionsOfKind(formats.KIND.IMAGE) },
];

function extensionsOfKind(kind) {
    return Object.values(formats.FORMATS).filter(f => f.kind === kind).map(f => f.ext);
}

// The house frame (the kit): the shared preload (window.kitAPI) on the
// app's session; the settings, in the same "settings" key of the same
// config.json as 2.0.0, so what was saved carries over, and migrated once per
// version; the log, debug.log in userData, redacted (a path keeps its file
// name only); one instance, and the files it's opened with ("Open with", a
// second launch, the menu), pushed to the page as files:opened; the main
// window with its bounds kept (2.0.0's windowBounds); the Credits tab, the
// menu, the theme push and the updater (Settings > Update).
const kit = require("@diamonddigitaldev/electron-kit/main").start({
    // package.json's name is the npm name, which names the userData folder too.
    name: APP_NAME,
    // electron-builder.cjs's appId: Windows shows the app's notifications, and
    // groups its windows under its pinned icon, only when the two match.
    appId: "com.diamonddigitaldev.diamondfileconverter",
    settings: {
        defaults: SETTINGS_DEFAULTS,
        // Version 2: the settings v1 wrote that 2.0 can't show, and the store
        // keys whose code is gone, removed once (constants.js says why).
        version: SETTINGS_SCHEMA_VERSION,
        migrate: (settings) => pruneLegacySettings(settings).settings,
        obsoleteKeys: LEGACY_STORE_KEYS,
    },
    log: "file",
    files: true,
    credits: {
        lines: [
            ["Created and maintained by ", { text: "Diamond Digital Development", href: "https://diamonddigital.dev" }, "."],
            ["Logo designed by ", { text: "TheFuturisticIdiot", href: "https://github.com/TheFuturisticIdiot" }, "."],
            "This software is licensed under the Apache 2.0 license.",
        ],
        donate: "https://buymeacoff.ee/willtda",
    },
    menu: { items: menuItems({ openFiles, openFolder }) },
    // Packaged, the kit checks 5 seconds after launch, as 2.0.0 did, and when
    // asked; it never offers a downgrade or a release outside the channel.
    updates: {},
});

/**
 * The app-wide settings, with the defaults underneath: the kit reads what's
 * stored merged over SETTINGS_DEFAULTS, so a setting a partial saved object
 * leaves out still has its default.
 */
function appSettings() {
    return kit.settings.get();
}

/** The main window, or null. */
const mainWindow = () => kit.windows.main();

let runner = null;

// Packaged, ffmpeg and ffprobe are this platform's own, in resources/ffmpeg
// (package.json's win and linux extraResources); from source, the packages'.
const EXE = process.platform === "win32" ? ".exe" : "";

function getFfmpegPath() {
    if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg", `ffmpeg${EXE}`);
    return require("ffmpeg-static"); // dev: executable path inside node_modules
}

function getFfprobePath() {
    if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg", `ffprobe${EXE}`);
    return require("ffprobe-static").path;
}

function createWindow() {
    const win = kit.windows.createMain({
        page: path.join(__dirname, "index.html"),
        size: { width: WINDOW.DEFAULT_WIDTH, height: WINDOW.DEFAULT_HEIGHT },
        min: { width: WINDOW.MIN_WIDTH, height: WINDOW.MIN_HEIGHT },
        title: APP_NAME,
        icon: path.join(__dirname, "assets", "diamondfileconverter"),
        webPreferences: { preload: path.join(__dirname, "preload.js") },
    });
    // A question still open when the window goes has no one to answer it.
    win.on("closed", () => answerAllConflicts({ choice: "cancelAll", all: false }));
}

// The menu's own items (menu.js): the kit puts them first in the house menu.
// What they pick reaches the page as files:opened, as files from "Open with"
// and a second launch do: the kit gathers those from argv, second-instance
// and open-file (v1 had none of this, and second-instance threw the paths away).

/**
 * The open dialog for files or a folder, opening where the last pick was made
 * (lastOpenFolder, kept between launches) rather than at the system's choice.
 * After files, their folder is kept; after a folder, the folder it's in, so
 * the next folder pick opens beside it. Returns the paths, or null.
 * @param {"files" | "folder"} what
 */
async function pickToOpen(what) {
    const last = kit.settings.get().lastOpenFolder;
    const result = await dialog.showOpenDialog(mainWindow(), {
        ...(what === "files"
            ? { properties: ["openFile", "multiSelections"], filters: FILE_DIALOG_FILTERS }
            : { properties: ["openDirectory"] }),
        ...(typeof last === "string" && fs.existsSync(last) ? { defaultPath: last } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    kit.settings.set({ lastOpenFolder: path.dirname(result.filePaths[0]) });
    return result.filePaths;
}

async function openFiles() {
    const picked = await pickToOpen("files");
    if (picked) kit.files.open(picked);
}

async function openFolder() {
    const picked = await pickToOpen("folder");
    if (picked) kit.files.open(picked);
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
        mainWindow()?.webContents.send(IPC.JOB_PROGRESS, payload);
    });

    runner.on("status", (payload) => {
        mainWindow()?.webContents.send(IPC.JOB_STATUS, payload);
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

// Serialises the output-exists prompts so only one is ever open.
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
 * The output-exists prompt: "File Already Exists", asked in the page, as a
 * modal through the kit (kit.ui.confirm()'s batch form), never a native box
 * (DESIGN §10). A native box is window-modal: while it was open, Windows
 * blocked every click on the app behind it, including the footer's own
 * Cancel All. The abort lives in the prompt itself for the same reason, and
 * v1's "Cancel" is "Skip This File", which is what it always did to one job.
 *
 * The checkbox matters: jobs run through a concurrency pool, so without a way
 * to answer once for the whole batch, converting fifty files into a folder
 * that already has them would mean fifty prompts.
 */
async function resolveConflict(job, candidatePath) {
    const isDirectory = formats.producesDirectory(job.mode);

    // Prompts are serialised, one at a time. The concurrency pool brings
    // several jobs here at once, and each used to read conflictChoiceForBatch
    // (still null) and open its own prompt *before* the first answer came
    // back — so ticking "apply to all remaining" had no effect on the prompts
    // already queued behind it, and the user was asked again for every file.
    // Chaining means each prompt re-reads the batch choice after the previous
    // one has settled.
    const mine = conflictPromptChain.then(
        () => promptForConflict(candidatePath, isDirectory)
    );
    conflictPromptChain = mine.then(() => {}, () => {});
    return mine;
}

// The prompts the page has been asked and hasn't answered: id -> resolve.
const conflictAsks = new Map();
let conflictAskId = 0;

/**
 * Ask the page, and resolve with its answer, { choice, all }. With no window
 * to ask, or once it closes, the answer is Cancel All: nobody can be asked.
 */
function askPage(candidatePath, isDirectory) {
    const win = mainWindow();
    if (!win) return Promise.resolve({ choice: "cancelAll", all: false });
    const id = ++conflictAskId;
    return new Promise((resolve) => {
        conflictAsks.set(id, resolve);
        win.webContents.send(IPC.CONFLICT_ASK, { id, name: path.basename(candidatePath), isDirectory });
    });
}

/** Answer every prompt still waiting. */
function answerAllConflicts(answer) {
    for (const resolve of conflictAsks.values()) resolve(answer);
    conflictAsks.clear();
}

kit.ipc.handle(IPC.CONFLICT_ANSWER, (_event, id, answer) => {
    const resolve = conflictAsks.get(id);
    if (!resolve) return false;
    conflictAsks.delete(id);
    // Anything but one of the four choices is a dismissed prompt, which is Cancel All, as Escape is.
    const choice = CONFLICT_CHOICES.includes(answer?.choice) ? answer.choice : "cancelAll";
    resolve({ choice, all: answer?.all === true });
    return true;
});

/** The prompt itself. Only ever called one at a time, via resolveConflict. */
async function promptForConflict(candidatePath, isDirectory) {
    // Cancel All ends the batch, not just the file it was answered on. The
    // prompts behind this one were chained before the abort and are already
    // past the runner's own cancelled check, so without this each of them
    // still opened a prompt of its own — six colliding files meant six presses
    // of a button labelled All. Escape and dismissing it arrive here too, as
    // Cancel All.
    if (conflictAbort) return { action: "cancel" };

    if (conflictChoiceForBatch) {
        return applyConflictChoice(conflictChoiceForBatch, candidatePath, isDirectory);
    }

    const { choice, all } = await askPage(candidatePath, isDirectory);

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

    if (all) conflictChoiceForBatch = choice;

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
            kit.log.warn(`Could not probe ${job.inputPath}: ${meta.error}`);
        }
    }

    const validation = validateJob(job);
    if (!validation.valid) {
        kit.log.error(`Invalid job: ${validation.errors.join(" ")}`);
        return { jobId: job.id, status: STATUS.ERROR, error: validation.errors[0] };
    }

    const result = await runJobToCompletion(job);

    // Failures are reported on the card and in a toast, not as a blocking
    // dialog. v1 opened one modal per failed file mid-queue, which with a
    // concurrency pool would stack several at once and halt the whole batch.
    if (result.status === STATUS.ERROR) {
        kit.log.error(`Conversion failed for ${job.inputPath}: ${result.error}`);
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
        kit.log.error(`Invalid join: ${validation.errors.join(" ")}`);
        return { jobId: job.id, status: STATUS.ERROR, error: validation.errors[0] };
    }

    const result = await runJobToCompletion(job);
    if (result.status === STATUS.ERROR) {
        kit.log.error(`Join failed: ${result.error}`);
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

kit.ipc.handle(IPC.DIALOG_BROWSE_FILES, () => pickToOpen("files"));

kit.ipc.handle(IPC.DIALOG_BROWSE_FOLDER, () => pickToOpen("folder"));

kit.ipc.handle(IPC.DIALOG_CHOOSE_OUTPUT, async () => {
    const result = await dialog.showOpenDialog(mainWindow(), {
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
kit.ipc.handle(IPC.PREVIEW_FRAME, async (_event, request) => {
    const inputPath = request && request.inputPath;
    const timestamp = Number(request && request.timestamp) || 0;
    if (!inputPath) return null;

    // The container's duration is often a little past the video's last frame,
    // because the audio runs on longer. A seek into that gap decodes nothing and
    // exits cleanly, which left the end preview blank; the frame worth showing
    // there is the last one, a moment earlier.
    let result = await grabFrame(inputPath, timestamp);
    for (const back of PREVIEW_FRAME_BACKOFF) {
        if (result !== "empty" || timestamp <= 0) break;
        result = await grabFrame(inputPath, Math.max(0, timestamp - back));
    }
    return result === "empty" ? null : result;
});

/**
 * One frame at `timestamp` as a JPEG data URL. "empty" when ffmpeg ran cleanly
 * and found no picture there, which is worth stepping back from; null when it
 * failed, which is not.
 */
function grabFrame(inputPath, timestamp) {
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
            if (code !== 0) return finish(null);
            if (chunks.length === 0) return finish("empty");
            finish(`data:image/jpeg;base64,${Buffer.concat(chunks).toString("base64")}`);
        });
    });
}

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



// ── Lifecycle ────────────────────────────────────────────────────────────────

// kit.ready: the app is ready, and the kit's preload, menu and theme push are
// in place. The settings are migrated as the store is first opened, before
// the page can ask for them. The kit quits the app with its last window, and
// pushes the files it was opened with once the page has loaded.
kit.ready.then(() => {
    kit.log.info("=== App ready ===");
    probe.setFfprobePath(getFfprobePath());
    createWindow();
});

app.on("will-quit", () => {
    if (runner) runner.cancelAll();
});
