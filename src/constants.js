const APP_NAME = "Diamond File Converter";

const LOG = {
    ERROR: "ERROR",
    WARN:  "WARN",
    INFO:  "INFO",
    DEBUG: "DEBUG",
};

// IPC channel names: the app's own, each answered in main.js through
// kit.ipc.handle(), which answers the app's own page only. The shared ones
// (app:get-version, settings:get and :set, shell:open-external, theme:changed,
// view:show) are the kit's, reached through window.kitAPI.
//
// Namespaced by domain. v1 kept a flat map that also carried an
// electron-updater event name ("update-available") alongside real IPC
// channels, which made the two easy to confuse.
const IPC = {
    // Jobs and the queue. Progress and status both carry a jobId, which is
    // what makes concurrency possible at all; v1 pushed a bare integer with
    // no way to tell which file it belonged to.
    JOB_RUN:          "job:run",          // invoke(job)   -> result
    JOB_CANCEL:       "job:cancel",       // invoke(jobId) -> boolean
    JOB_PREVIEW:      "job:preview",      // invoke(spec)  -> ffmpeg argv preview
    JOIN_RUN:         "join:run",         // invoke(spec)  -> result, several clips into one
    JOB_PROGRESS:     "job:progress",     // push { jobId, percent, speed, fps, eta }
    JOB_STATUS:       "job:status",       // push { jobId, status, outputPath?, error? }
    QUEUE_CANCEL_ALL: "queue:cancel-all",
    QUEUE_SET_CONCURRENCY: "queue:set-concurrency",

    // Inspection and ingest.
    PROBE_FILE:     "probe:file",      // invoke(path)          -> metadata
    FS_SCAN:        "fs:scan",         // invoke(paths, opts)   -> { files, skipped, ... }

    // One decoded frame, for choosing which frame to keep.
    PREVIEW_FRAME:        "preview:frame",

    // Dialogs.
    DIALOG_BROWSE_FILES:  "dialog:browse-files",
    DIALOG_BROWSE_FOLDER: "dialog:browse-folder",
    DIALOG_CHOOSE_OUTPUT: "dialog:choose-output",

    // Shell and app.
    SHELL_OPEN_PATH:      "shell:open-path",
    SHELL_SHOW_IN_FOLDER: "shell:show-in-folder",
    APP_GET_FORMATS:      "app:get-formats",

    // Pushed from main.
    FILES_OPENED:  "files:opened",  // push: string[] of paths from menu/argv/shell
};

// Window size constraints. Widened for the card grid — the v1 single column
// was 700px, which fits only two cards per row. Existing users keep their
// saved bounds; this only changes the first-run default.
// The minimum is measured, not guessed: below 800px wide the selection bar
// runs out of room and clips its own buttons, which is what the old 720 let
// happen. 880 keeps 80px of headroom over that, and the height leaves the grid
// enough room for a full card row under the bars.
const WINDOW = {
    DEFAULT_WIDTH:  1100,
    DEFAULT_HEIGHT: 780,
    MIN_WIDTH:      880,
    MIN_HEIGHT:     600,
};

// Windows spawns one process per file when several are selected in Explorer,
// so incoming paths are collected before being handed to the renderer.
const ARGV_BATCH_DEBOUNCE_MS = 500;

// The app's settings and their defaults, which the kit keeps (kit.start()'s
// settings.defaults) under the same "settings" key in config.json that 2.0.0
// used, so saved settings carry over. The kit adds its own navCollapsed. A
// setting whose default is null takes any value, so concurrency keeps the
// number someone picks. v1 persisted nothing but windowBounds.
const SETTINGS_DEFAULTS = {
    outputRouting:   "alongside",
    outputDir:       null,
    onConflict:      "ask",
    concurrency:     null,   // null = derive from the CPU count
    nameTemplate:    "{name}",
    lastTargetByKind: {},
    // Folder ingest. maxDepth and maxFiles are deliberately not here: they are
    // safety rails rather than preferences, and the toast that fires when one
    // bites explains itself at the moment it matters.
    scan: {
        recursive:      true,
        kinds:          ["audio", "video", "image"],
        followSymlinks: false,
    },
};

// Settings v1 wrote that 2.0 has no way to show or change. Every one of them is
// still layered underneath a job in main.js, so a value left over from v1 wins
// over the card's own choice and there is no screen on which to see it, let
// alone correct it: an install carrying onConflict "unique" silently renamed
// every colliding output and never showed the prompt, whatever the card said.
//
// They are pruned rather than merely ignored, so the file on disk stops
// disagreeing with the app. The layering in main.js stays exactly as it is —
// it is the right shape for the day a preferences screen exists, and on that
// day these keys come back as things the user actually chose.
const LEGACY_SETTINGS_KEYS = ["outputRouting", "outputDir", "nameTemplate", "onConflict"];

// Store keys whose code is gone: presets went with the orphaned channels in
// c20826f, pipelines with the editor in 09eaca3.
const LEGACY_STORE_KEYS = ["presets", "pipelines"];

// Bumped whenever this list grows. The migration in main.js runs once per
// version, so a value a future preferences screen writes is not eaten on the
// next launch.
const SETTINGS_SCHEMA_VERSION = 2;

/**
 * Drop the settings 2.0 cannot reach. Returns a new object; the input is left
 * alone. Reports what it removed so the caller can say so in the log rather
 * than deleting a user's data in silence.
 *
 * @param {object|null|undefined} settings
 * @returns {{settings: object, removed: string[]}}
 */
function pruneLegacySettings(settings) {
    const kept = {};
    const removed = [];
    for (const [key, value] of Object.entries(settings ?? {})) {
        if (LEGACY_SETTINGS_KEYS.includes(key)) removed.push(key);
        else kept[key] = value;
    }
    return { settings: kept, removed };
}

module.exports = {
    APP_NAME,
    IPC,
    WINDOW,
    LOG,
    ARGV_BATCH_DEBOUNCE_MS,
    SETTINGS_DEFAULTS,
    LEGACY_SETTINGS_KEYS,
    LEGACY_STORE_KEYS,
    SETTINGS_SCHEMA_VERSION,
    pruneLegacySettings,
};
