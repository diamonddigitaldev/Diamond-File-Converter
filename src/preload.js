"use strict";

// The context bridge.
//
// v1 had no preload at all: the renderer ran with nodeIntegration:true and
// contextIsolation:false and required fs, path and electron directly. This is
// the entire surface the renderer is now allowed to touch, exposed under the
// same `electronAPI` name the Dropgate client uses.
//
// IMPORTANT: this file runs in a sandboxed preload, where require() is limited
// to a small allowlist ("electron", "events", "timers", "url"). Requiring
// ./constants here silently kills the whole bridge, so the channel names are
// inlined below. test/preload.test.js asserts every one of them still matches
// src/constants.js, so the two cannot drift apart unnoticed.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const CH = {
    JOB_RUN:               "job:run",
    JOB_CANCEL:            "job:cancel",
    JOB_PREVIEW:           "job:preview",
    JOIN_RUN:              "join:run",
    JOB_PROGRESS:          "job:progress",
    JOB_STATUS:            "job:status",
    QUEUE_CANCEL_ALL:      "queue:cancel-all",
    QUEUE_SET_CONCURRENCY: "queue:set-concurrency",
    PROBE_FILE:            "probe:file",
    FS_SCAN:               "fs:scan",
    PREVIEW_FRAME:         "preview:frame",
    DIALOG_BROWSE_FILES:   "dialog:browse-files",
    DIALOG_BROWSE_FOLDER:  "dialog:browse-folder",
    DIALOG_CHOOSE_OUTPUT:  "dialog:choose-output",
    SHELL_OPEN_PATH:       "shell:open-path",
    SHELL_SHOW_IN_FOLDER:  "shell:show-in-folder",
    SHELL_OPEN_EXTERNAL:   "shell:open-external",
    APP_GET_VERSION:       "app:get-version",
    APP_GET_FORMATS:       "app:get-formats",
    SETTINGS_GET:          "settings:get",
    SETTINGS_SET:          "settings:set",
    FILES_OPENED:          "files:opened",
    THEME_CHANGED:         "theme:changed",
};

/** Subscribe helper that hands back an unsubscribe function. */
function on(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("electronAPI", {
    // -- Jobs and queue -------------------------------------------------------
    runJob:         (job)   => ipcRenderer.invoke(CH.JOB_RUN, job),
    cancelJob:      (jobId) => ipcRenderer.invoke(CH.JOB_CANCEL, jobId),
    previewJob:     (spec)  => ipcRenderer.invoke(CH.JOB_PREVIEW, spec),
    runJoin:        (spec)  => ipcRenderer.invoke(CH.JOIN_RUN, spec),
    cancelAll:      ()      => ipcRenderer.invoke(CH.QUEUE_CANCEL_ALL),
    setConcurrency: (n)     => ipcRenderer.invoke(CH.QUEUE_SET_CONCURRENCY, n),

    onJobProgress: (cb) => on(CH.JOB_PROGRESS, cb),
    onJobStatus:   (cb) => on(CH.JOB_STATUS, cb),

    // -- Inspection and ingest ------------------------------------------------
    probeFile: (filePath)    => ipcRenderer.invoke(CH.PROBE_FILE, filePath),

    /**
     * One frame, decoded at a timestamp, as a data URL — or null if the source
     * will not give one up. Used to choose a frame by looking at it rather than
     * by guessing a number.
     */
    previewFrame: (request) => ipcRenderer.invoke(CH.PREVIEW_FRAME, request),
    scanPaths: (paths, opts) => ipcRenderer.invoke(CH.FS_SCAN, paths, opts),

    /**
     * Resolve one dropped File to an absolute path. webUtils exists only in the
     * main world and the preload, which is why a drop has to come through here
     * rather than being handled entirely in the renderer.
     *
     * **One file at a time, deliberately.** This used to take the whole
     * `FileList` and iterate it here, which threw "files is not iterable" on
     * every single drop: a FileList is not one of the types the context bridge
     * can carry, so it arrived as a plain object with no iterator. A File does
     * cross intact, so the renderer keeps the iteration where the FileList is
     * still a FileList and calls this per file.
     */
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch (_) {
            // A dragged item with no filesystem path (a browser-sourced drag,
            // say) is simply not something we can convert.
            return "";
        }
    },

    // -- Dialogs --------------------------------------------------------------
    browseFiles:  () => ipcRenderer.invoke(CH.DIALOG_BROWSE_FILES),
    browseFolder: () => ipcRenderer.invoke(CH.DIALOG_BROWSE_FOLDER),
    chooseOutput: () => ipcRenderer.invoke(CH.DIALOG_CHOOSE_OUTPUT),

    // -- Shell and app --------------------------------------------------------
    openPath:     (target) => ipcRenderer.invoke(CH.SHELL_OPEN_PATH, target),
    showInFolder: (target) => ipcRenderer.invoke(CH.SHELL_SHOW_IN_FOLDER, target),
    openExternal: (url)    => ipcRenderer.invoke(CH.SHELL_OPEN_EXTERNAL, url),
    getVersion:   ()       => ipcRenderer.invoke(CH.APP_GET_VERSION),
    getFormats:   ()       => ipcRenderer.invoke(CH.APP_GET_FORMATS),
    getSettings:  ()       => ipcRenderer.invoke(CH.SETTINGS_GET),
    setSettings:  (s)      => ipcRenderer.invoke(CH.SETTINGS_SET, s),

    onFilesOpened:  (cb) => on(CH.FILES_OPENED, cb),
    onThemeChanged: (cb) => on(CH.THEME_CHANGED, cb),
});

// Path helpers. The renderer needs basename, extname and stem for display and
// for working out a file's type; exposing these three beats exposing node:path.
contextBridge.exposeInMainWorld("pathAPI", {
    basename: (filePath) => String(filePath).split(/[\\/]/).pop() ?? "",
    extname: (filePath) => {
        const base = String(filePath).split(/[\\/]/).pop() ?? "";
        const dot = base.lastIndexOf(".");
        return dot > 0 ? base.slice(dot) : "";
    },
    stem: (filePath) => {
        const base = String(filePath).split(/[\\/]/).pop() ?? "";
        const dot = base.lastIndexOf(".");
        return dot > 0 ? base.slice(0, dot) : base;
    },
});
