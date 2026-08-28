const APP_NAME = "Diamond File Converter";

const LOG = {
    ERROR: "ERROR",
    WARN:  "WARN",
    INFO:  "INFO",
    DEBUG: "DEBUG",
};

// IPC channel names.
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
    JOB_PROGRESS:     "job:progress",     // push { jobId, percent, speed, fps, eta }
    JOB_STATUS:       "job:status",       // push { jobId, status, outputPath?, error? }
    QUEUE_CANCEL_ALL: "queue:cancel-all",
    QUEUE_SET_CONCURRENCY: "queue:set-concurrency",

    // Inspection and ingest.
    PROBE_FILE:     "probe:file",      // invoke(path)          -> metadata
    FS_SCAN:        "fs:scan",         // invoke(paths, opts)   -> { files, skipped, ... }

    // Dialogs.
    DIALOG_BROWSE_FILES:  "dialog:browse-files",
    DIALOG_BROWSE_FOLDER: "dialog:browse-folder",
    DIALOG_CHOOSE_OUTPUT: "dialog:choose-output",

    // Presets and pipelines. The store is wired; the editors are TODO.
    PRESET_LIST:      "preset:list",
    PRESET_SAVE:      "preset:save",
    PRESET_DELETE:    "preset:delete",
    PIPELINE_LIST:     "pipeline:list",
    PIPELINE_SAVE:     "pipeline:save",
    PIPELINE_DELETE:   "pipeline:delete",
    PIPELINE_VALIDATE: "pipeline:validate",

    // Shell and app.
    SHELL_OPEN_PATH:      "shell:open-path",
    SHELL_SHOW_IN_FOLDER: "shell:show-in-folder",
    SHELL_OPEN_EXTERNAL:  "shell:open-external",
    APP_GET_VERSION:      "app:get-version",
    APP_GET_FORMATS:      "app:get-formats",
    SETTINGS_GET:         "settings:get",
    SETTINGS_SET:         "settings:set",

    // Pushed from main.
    FILES_OPENED: "files:opened", // push: string[] of paths from menu/argv/shell
};

// Window size constraints. Widened for the card grid — the v1 single column
// was 700px, which fits only two cards per row. Existing users keep their
// saved bounds; this only changes the first-run default.
const WINDOW = {
    DEFAULT_WIDTH:  1100,
    DEFAULT_HEIGHT: 780,
    MIN_WIDTH:      720,
    MIN_HEIGHT:     560,
};

// Windows spawns one process per file when several are selected in Explorer,
// so incoming paths are collected before being handed to the renderer.
const ARGV_BATCH_DEBOUNCE_MS = 500;

// Defaults written into electron-store on first run. v1 persisted nothing but
// windowBounds, so there were no user settings at all.
const SETTINGS_DEFAULTS = {
    outputRouting:   "alongside",
    outputDir:       null,
    onConflict:      "ask",
    concurrency:     null,   // null = derive from the CPU count
    nameTemplate:    "{name}",
    lastTargetByKind: {},
};

module.exports = {
    APP_NAME,
    IPC,
    WINDOW,
    LOG,
    ARGV_BATCH_DEBOUNCE_MS,
    SETTINGS_DEFAULTS,
};
