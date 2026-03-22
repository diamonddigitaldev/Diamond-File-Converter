const path = require("path");
const fs = require("fs");
const { ipcRenderer, webUtils } = require("electron");
const { IPC, CONVERSION_MAP, EXT_ALIASES } = require("./constants");

let jobs = [];
// each job: { id, filePath, ext, type, targetExt, status, progress, outputPath }
// status: "pending" | "converting" | "done" | "error" | "cancelled"

let selectedFormats = {};
// keyed by type: { audio: "mp3", video: null, image: "jpg" }

let cancelRequested = false;

const actionAreas = ["convert", "progress", "done"];

function generateId() {
    return Math.random().toString(36).slice(2, 9);
}

const pluralFiles = n => `${n} file${n !== 1 ? "s" : ""}`;

const TYPE_ORDER = { video: 0, audio: 1, image: 2 };
const TYPE_ICONS  = { audio: "audio_file", video: "video_file", image: "image" };

function sortJobs() {
    jobs.sort((a, b) => {
        const byType = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
        if (byType !== 0) return byType;
        const byExt = a.ext.localeCompare(b.ext);
        if (byExt !== 0) return byExt;
        return path.basename(a.filePath).localeCompare(path.basename(b.filePath), undefined, { sensitivity: "base" });
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
        const raw = path.extname(filePath).slice(1).toLowerCase();
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
    document.getElementById("dz-file-count").textContent = `${pluralFiles(count)} queued`;

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
        name.textContent = path.basename(job.filePath);
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

        document.getElementById("progress-current-file").textContent = path.basename(job.filePath);
        document.getElementById("progress-status").textContent = `File ${i + 1} of ${total}`;
        document.getElementById("progress-bar-fill").style.width = "0%";
        document.getElementById("progress-label").textContent = "0%";

        job.status = "converting";
        const outputPath = await ipcRenderer.invoke(IPC.CONVERT_FILE, job.filePath, job.targetExt);

        if (outputPath) {
            job.status = "done";
            job.outputPath = outputPath;
        } else {
            job.status = cancelRequested ? "cancelled" : "error";
        }
    }

    renderDoneList();
    showState("done");
}

function renderDoneList() {
    const doneCount = jobs.filter(j => j.status === "done").length;
    const errorCount = jobs.filter(j => j.status === "error").length;
    const cancelledCount = jobs.filter(j => j.status === "cancelled").length;

    let summary = `${pluralFiles(doneCount)} converted`;
    if (errorCount > 0) summary += `, ${errorCount} failed`;
    if (cancelledCount > 0) summary += `, ${cancelledCount} cancelled`;
    document.getElementById("done-summary").textContent = summary;

    const listEl = document.getElementById("done-file-list");
    listEl.innerHTML = "";

    for (const job of jobs) {
        const row = document.createElement("div");
        row.className = "done-file-row";

        const STATUS_ICON = {
            done:      { text: "check_circle", cls: "text-success"   },
            error:     { text: "error",        cls: "text-danger"     },
            cancelled: { text: "cancel",       cls: "text-secondary"  },
        };
        const { text: iconText, cls } = STATUS_ICON[job.status] ?? STATUS_ICON.cancelled;
        const icon = document.createElement("span");
        icon.className = `material-icons-round ${cls}`;
        icon.textContent = iconText;

        const name = document.createElement("span");
        name.className = "small text-truncate";
        name.textContent = path.basename(job.status === "done" ? job.outputPath : job.filePath);
        name.title = job.status === "done" ? job.outputPath : job.filePath;

        row.appendChild(icon);
        row.appendChild(name);
        listEl.appendChild(row);
    }

    const foldersEl = document.getElementById("done-folder-btns");
    foldersEl.innerHTML = "";
    const folders = [...new Set(
        jobs.filter(j => j.status === "done").map(j => path.dirname(j.outputPath))
    )];

    for (const folder of folders) {
        const btn = document.createElement("button");
        btn.className = "btn btn-sm btn-primary";
        btn.innerHTML = `<span class="material-icons-round me-1" style="vertical-align:middle;font-size:15px">folder_open</span>Open Folder`;
        if (folders.length > 1) btn.title = folder;
        btn.addEventListener("click", () => ipcRenderer.invoke(IPC.OPEN_FOLDER, folder));
        foldersEl.appendChild(btn);
    }
}

function getFilesFromDrop(e) {
    const filePaths = [];
    for (const file of e.dataTransfer.files) {
        try {
            const filePath = webUtils.getPathForFile(file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                for (const name of fs.readdirSync(filePath)) {
                    filePaths.push(path.join(filePath, name));
                }
            } else {
                filePaths.push(filePath);
            }
        } catch (_) {}
    }
    return filePaths;
}

document.addEventListener("DOMContentLoaded", () => {
    const dropZone = document.getElementById("drop-zone");

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("drag-over");
    });
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        addFiles(getFilesFromDrop(e));
    });

    dropZone.addEventListener("click", async (e) => {
        if (e.target.id === "browse-btn" || e.target.id === "browse-more-btn") return;
        const filePaths = await ipcRenderer.invoke(IPC.BROWSE_FILE);
        if (filePaths) addFiles(filePaths);
    });

    async function browseFiles(e) {
        e.stopPropagation();
        const filePaths = await ipcRenderer.invoke(IPC.BROWSE_FILE);
        if (filePaths) addFiles(filePaths);
    }
    document.getElementById("browse-btn").addEventListener("click", browseFiles);
    document.getElementById("browse-more-btn").addEventListener("click", browseFiles);

    document.getElementById("btn-start-convert").addEventListener("click", startQueue);

    document.getElementById("btn-cancel").addEventListener("click", async () => {
        cancelRequested = true;
        await ipcRenderer.invoke(IPC.CANCEL_CONVERT);
    });

    function clearAll() {
        jobs = [];
        selectedFormats = {};
        showState("empty");
    }
    document.getElementById("btn-clear-all").addEventListener("click", (e) => { e.stopPropagation(); clearAll(); });
    document.getElementById("btn-convert-another").addEventListener("click", clearAll);
});

ipcRenderer.on(IPC.CONVERSION_PROGRESS, (_event, percent) => {
    document.getElementById("progress-bar-fill").style.width = `${percent}%`;
    document.getElementById("progress-label").textContent = `${percent}%`;
});

ipcRenderer.on(IPC.FILE_OPENED_FROM_MENU, (_event, filePath) => {
    addFiles([filePath]);
});
