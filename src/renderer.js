// Renderer.
//
// Runs with contextIsolation on and no Node access. Everything that used to be
// a require() now goes through window.electronAPI / window.pathAPI, exposed by
// preload.js.

const api = window.electronAPI;
const p = window.pathAPI;

let jobs = [];
// each job: { id, filePath, ext, type, targetExt, status, progress, outputPath, isDirectory, fileCount, error }
// status: "pending" | "converting" | "done" | "error" | "cancelled"

let selectedFormats = {};
// keyed by type: { audio: "mp3", video: null, image: "jpg" }

let cancelRequested = false;
let activeJobId = null;

// Populated from the main process at startup, so the format graph has a single
// source of truth instead of being duplicated on both sides of the bridge.
let CONVERSION_MAP = {};
let EXT_ALIASES = {};

const actionAreas = ["convert", "progress", "done"];

function generateId() {
    return Math.random().toString(36).slice(2, 9);
}

const TYPE_ORDER = { video: 0, audio: 1, image: 2 };
const TYPE_ICONS  = { audio: "audio_file", video: "video_file", image: "image" };

function sortJobs() {
    jobs.sort((a, b) => {
        const byType = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
        if (byType !== 0) return byType;
        const byExt = a.ext.localeCompare(b.ext);
        if (byExt !== 0) return byExt;
        return p.basename(a.filePath).localeCompare(p.basename(b.filePath), undefined, { sensitivity: "base" });
    });
}

function showAction(name) {
    for (const a of actionAreas) {
        document.getElementById(`action-${a}`).classList.toggle("d-none", a !== name);
    }
}

function showState(name) {
    const isEmpty = name === "empty";
    const isQueue = name === "queue";
    const showDropZone = isEmpty || isQueue;

    document.getElementById("drop-zone").classList.toggle("d-none", !showDropZone);
    document.getElementById("dz-empty").classList.toggle("d-none", !isEmpty);
    document.getElementById("dz-has-files").classList.toggle("d-none", !isQueue);
    document.getElementById("file-list-section").classList.toggle("d-none", !isQueue);
    document.getElementById("format-section").classList.toggle("d-none", !isQueue);

    if (isQueue) {
        showAction("convert");
    } else if (name === "converting") {
        showAction("progress");
    } else if (name === "done") {
        showAction("done");
    } else {
        for (const a of actionAreas) {
            document.getElementById(`action-${a}`).classList.add("d-none");
        }
    }
}

function addFiles(filePaths) {
    let added = 0;
    for (const filePath of filePaths) {
        const raw = p.extname(filePath).slice(1).toLowerCase();
        const ext = EXT_ALIASES[raw] ?? raw;
        const entry = CONVERSION_MAP[ext];
        if (!entry) continue;
        if (jobs.some(j => j.filePath === filePath)) continue; // skip duplicates
        jobs.push({ id: generateId(), filePath, ext, type: entry.type, targetExt: null, status: "pending", progress: 0, outputPath: null });
        added++;
    }
    if (added > 0) {
        sortJobs();
        renderFileList();
        renderFormatGrid();
        updateConvertButton();
        showState("queue");
    }
}

/**
 * Expand whatever was dropped or picked into a flat list of media files.
 * Directory walking happens in the main process now: v1 did a synchronous,
 * one-level-deep readdirSync on the UI thread and silently discarded anything
 * nested.
 */
async function ingestPaths(inputPaths) {
    if (inputPaths.length === 0) return;
    try {
        const result = await api.scanPaths(inputPaths, {});
        addFiles(result.files);
    } catch (_) {
        // Fall back to treating them as plain files rather than dropping the
        // interaction entirely.
        addFiles(inputPaths);
    }
}

function removeJob(id) {
    jobs = jobs.filter(j => j.id !== id);
    if (jobs.length === 0) {
        selectedFormats = {};
        showState("empty");
    } else {
        renderFileList();
        renderFormatGrid();
        updateConvertButton();
    }
}

function renderFileList() {
    const container = document.getElementById("file-list");
    container.innerHTML = "";

    const count = jobs.length;
    document.getElementById("dz-file-count").textContent = `${count} ${count !== 1 ? "Files" : "File"} Queued`;

    let prevType = null;
    for (const job of jobs) {
        if (prevType !== null && job.type !== prevType) {
            const lastRow = container.lastElementChild;
            if (lastRow) lastRow.style.borderBottom = "none";
            const divider = document.createElement("div");
            divider.className = "file-group-divider";
            container.appendChild(divider);
        }
        prevType = job.type;

        const row = document.createElement("div");
        row.className = "file-row";

        const icon = document.createElement("span");
        icon.className = "material-icons-round text-secondary";
        icon.textContent = TYPE_ICONS[job.type] ?? "insert_drive_file";

        const name = document.createElement("span");
        name.className = "file-row-name small";
        name.textContent = p.basename(job.filePath);
        name.title = job.filePath;

        const removeBtn = document.createElement("button");
        removeBtn.className = "file-remove-btn";
        const removeIcon = document.createElement("span");
        removeIcon.className = "material-icons-round";
        removeIcon.textContent = "close";
        removeBtn.appendChild(removeIcon);
        removeBtn.addEventListener("click", () => removeJob(job.id));

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(removeBtn);
        container.appendChild(row);
    }
}

function renderFormatGrid() {
    const container = document.getElementById("format-grid");
    container.innerHTML = "";

    // group jobs by type, but only show each type once in the format grid, since all jobs of the same type share the same target format options
    const seen = new Set();
    const typeEntries = [];
    for (const job of jobs) {
        if (!seen.has(job.type)) {
            seen.add(job.type);
            typeEntries.push({ type: job.type, entry: CONVERSION_MAP[job.ext] });
        }
    }

    for (const { type, entry } of typeEntries) {
        const label = document.createElement("p");
        label.className = "format-group-label";
        label.textContent = type.charAt(0).toUpperCase() + type.slice(1);
        container.appendChild(label);

        const row = document.createElement("div");
        row.className = "format-btn-row";

        for (const t of entry.targets) {
            const btn = document.createElement("button");
            btn.className = "btn-format";
            if (selectedFormats[type] === t.ext) btn.classList.add("selected");
            btn.textContent = t.label;
            btn.dataset.type = type;
            btn.dataset.ext = t.ext;
            btn.addEventListener("click", () => selectFormat(type, t.ext, btn));
            row.appendChild(btn);
        }
        container.appendChild(row);
    }
}

function selectFormat(type, ext, btn) {
    selectedFormats[type] = ext;
    document.querySelectorAll(`.btn-format[data-type="${type}"]`).forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    updateConvertButton();
}

function updateConvertButton() {
    const types = [...new Set(jobs.map(j => j.type))];
    const allSelected = types.length > 0 && types.every(t => selectedFormats[t]);
    document.getElementById("btn-start-convert").disabled = !allSelected;
}

function setProgress(percent) {
    const fill = document.getElementById("progress-bar-fill");
    const label = document.getElementById("progress-label");

    if (percent == null) {
        // No known duration, so show motion rather than the frozen 0% v1 sat at.
        fill.style.width = "100%";
        fill.classList.add("progress-bar-striped", "progress-bar-animated");
        label.textContent = "";
        return;
    }

    fill.classList.remove("progress-bar-striped", "progress-bar-animated");
    fill.style.width = `${percent}%`;
    label.textContent = `${Math.round(percent)}%`;
}

async function startQueue() {
    cancelRequested = false;

    for (const job of jobs) {
        job.targetExt = selectedFormats[job.type];
        job.status = "pending";
    }

    showState("converting");

    const total = jobs.length;

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];

        if (cancelRequested) {
            job.status = "cancelled";
            continue;
        }

        document.getElementById("progress-current-file").textContent = p.basename(job.filePath);
        document.getElementById("progress-status").textContent = `File ${i + 1} of ${total}`;
        setProgress(0);

        job.status = "converting";

        const result = await api.runJob({
            id: job.id,
            inputPath: job.filePath,
            targetExt: job.targetExt,
        });
        activeJobId = null;

        if (result.status === "cancelled" || cancelRequested) {
            job.status = "cancelled";
        } else if (result.status === "done") {
            job.status = "done";
            job.outputPath = result.outputPath;
            job.isDirectory = result.isDirectory === true;
            job.fileCount = result.fileCount ?? 1;
        } else if (result.status === "skipped") {
            job.status = "cancelled";
        } else {
            job.status = "error";
            job.error = result.error ?? null;
        }
    }

    renderDoneList();
    showState("done");
}

function renderDoneList() {
    const doneCount = jobs.filter(j => j.status === "done").length;
    const errorCount = jobs.filter(j => j.status === "error").length;
    const cancelledCount = jobs.filter(j => j.status === "cancelled").length;

    const parts = [];
    if (doneCount > 0) parts.push(`${doneCount} ${doneCount !== 1 ? "files" : "file"} converted`);
    if (errorCount > 0) parts.push(`${errorCount} ${parts.length === 0 ? (errorCount !== 1 ? "files " : "file ") : ""}failed`);
    if (cancelledCount > 0) parts.push(`${cancelledCount} ${parts.length === 0 ? (cancelledCount !== 1 ? "files " : "file ") : ""}cancelled`);
    let summary = parts.join(", ");
    if (!summary) summary = "No files converted";
    document.getElementById("done-summary").textContent = summary;

    const listEl = document.getElementById("done-file-list");
    listEl.innerHTML = "";

    const STATUS_ICON = {
        done:      { text: "check_circle", cls: "text-success"   },
        error:     { text: "error",        cls: "text-danger"     },
        cancelled: { text: "cancel",       cls: "text-secondary"  },
    };

    for (const job of jobs) {
        const row = document.createElement("div");
        row.className = "file-row";

        // v1 called fs.statSync here to find out whether the output was a
        // folder of frames. The job result carries that now, so the renderer
        // needs no filesystem access at all.
        const isDir = job.status === "done" && job.isDirectory === true;

        const { text: iconText, cls } = STATUS_ICON[job.status] ?? STATUS_ICON.cancelled;
        const icon = document.createElement("span");
        icon.className = `material-icons-round ${cls}`;
        icon.textContent = isDir ? "folder" : iconText;

        const name = document.createElement("span");
        name.className = "file-row-name small";
        if (isDir) {
            const frameCount = job.fileCount ?? 0;
            name.textContent = `${p.basename(job.outputPath)}/ (${frameCount} ${frameCount !== 1 ? "frames" : "frame"})`;
        } else {
            name.textContent = p.basename(job.status === "done" ? job.outputPath : job.filePath);
        }
        name.title = job.status === "error" && job.error
            ? job.error
            : (job.status === "done" ? job.outputPath : job.filePath);

        row.appendChild(icon);
        row.appendChild(name);

        if (job.status === "done") {
            const openBtn = document.createElement("button");
            openBtn.className = "file-open-btn";
            openBtn.title = isDir ? "Open folder" : "Show in folder";
            const openIcon = document.createElement("span");
            openIcon.className = "material-icons-round";
            openIcon.textContent = isDir ? "folder_open" : "open_in_new";
            openBtn.appendChild(openIcon);
            openBtn.addEventListener("click", () => {
                if (isDir) api.openPath(job.outputPath);
                else api.showInFolder(job.outputPath);
            });
            row.appendChild(openBtn);
        }

        listEl.appendChild(row);
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    const formats = await api.getFormats();
    CONVERSION_MAP = formats.conversionMap;
    EXT_ALIASES = formats.aliases;

    const dropZone = document.getElementById("drop-zone");

    // A drop anywhere outside the zone would otherwise navigate the window to
    // the dropped file, replacing the app with it. v1 had no such guard.
    for (const type of ["dragover", "drop"]) {
        document.addEventListener(type, (e) => e.preventDefault());
    }

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", (e) => {
        // dragleave fires when crossing onto a child element too, which made
        // the v1 highlight flicker. Ignore those.
        if (e.relatedTarget && dropZone.contains(e.relatedTarget)) return;
        dropZone.classList.remove("drag-over");
    });
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        ingestPaths(api.getPathsForFiles(e.dataTransfer.files));
    });

    dropZone.addEventListener("click", async (e) => {
        if (e.target.closest("button")) return;
        const filePaths = await api.browseFiles();
        if (filePaths) ingestPaths(filePaths);
    });

    async function browseFiles(e) {
        e.stopPropagation();
        const filePaths = await api.browseFiles();
        if (filePaths) ingestPaths(filePaths);
    }
    document.getElementById("browse-btn").addEventListener("click", browseFiles);
    document.getElementById("browse-more-btn").addEventListener("click", browseFiles);

    document.getElementById("btn-start-convert").addEventListener("click", startQueue);

    document.getElementById("btn-cancel").addEventListener("click", async () => {
        cancelRequested = true;
        await api.cancelAll();
    });

    function clearAll() {
        jobs = [];
        selectedFormats = {};
        showState("empty");
    }
    document.getElementById("btn-clear-all").addEventListener("click", (e) => { e.stopPropagation(); clearAll(); });
    document.getElementById("btn-convert-another").addEventListener("click", clearAll);
});

// Progress now carries a jobId, so it can be matched to the file it belongs to
// rather than being applied blindly as v1 did.
api.onJobProgress(({ jobId, percent }) => {
    const job = jobs.find(j => j.id === jobId);
    if (job) job.progress = percent ?? 0;
    if (activeJobId === null || activeJobId === jobId) setProgress(percent);
});

api.onJobStatus(({ jobId, status }) => {
    if (status === "running") activeJobId = jobId;
});

api.onFilesOpened((filePaths) => {
    ingestPaths(Array.isArray(filePaths) ? filePaths : [filePaths]);
});
