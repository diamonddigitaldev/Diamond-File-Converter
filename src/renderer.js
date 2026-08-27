// Renderer — job card grid.
//
// Runs with contextIsolation on and no Node access. Everything reaches the main
// process through window.electronAPI, exposed by preload.js.
//
// The v1 UI was a single-column list with one shared target format per media
// kind and a strictly sequential convert loop. This is a grid of independently
// configurable job cards that run through the runner's concurrency pool.

const api = window.electronAPI;
const p = window.pathAPI;

// -- State -------------------------------------------------------------------

/** @type {Array<{id,filePath,ext,kind,targetExt,meta,status,progress,error,outputPath,isDirectory,fileCount}>} */
let jobs = [];
let selection = new Set();
let selectionAnchor = null;
let converting = false;

// Loaded as a plain script by index.html — the renderer has no Node access,
// and functions cannot cross the IPC bridge, so it cannot be required.
const display = window.display;

// Populated from main at startup so the format graph has one source of truth.
let FORMATS = null;
let TARGETS = null;

const el = {};

function $(id) {
    if (!el[id]) el[id] = document.getElementById(id);
    return el[id];
}

function generateId() {
    return `c${Math.random().toString(36).slice(2, 9)}`;
}

// -- Ingest ------------------------------------------------------------------

function addFiles(filePaths) {
    let added = 0;
    let rejected = 0;

    for (const filePath of filePaths) {
        const raw = p.extname(filePath).slice(1).toLowerCase();
        const ext = FORMATS.aliases[raw] ?? raw;
        const entry = FORMATS.conversionMap[ext];

        if (!entry) { rejected++; continue; }
        if (jobs.some(j => j.filePath === filePath)) continue;

        jobs.push({
            id: generateId(),
            filePath,
            ext,
            kind: entry.type,
            targetExt: null,
            meta: null,
            status: "pending",
            progress: 0,
            error: null,
            outputPath: null,
            isDirectory: false,
            fileCount: 0,
        });
        added++;
    }

    if (added > 0) {
        render();
        probeNewJobs();
    }

    // v1 discarded unsupported files in silence, which read as the app being
    // broken. Say so.
    if (rejected > 0) {
        toast(
            `${display.countOf(rejected, "file")} ${display.plural(rejected, "was", "were")} skipped — not a supported format.`,
            added > 0 ? "warning" : "danger"
        );
    }
    return added;
}

/** Expand folders in the main process, then queue whatever came back. */
async function ingestPaths(inputPaths) {
    if (!inputPaths || inputPaths.length === 0) return;
    try {
        const result = await api.scanPaths(inputPaths, {});
        const added = addFiles(result.files);

        if (result.truncated) {
            toast(`Stopped after ${display.countOf(result.files.length, "file")} — the folder is very large.`, "warning");
        } else if (added > 0 && result.skipped > 0) {
            toast(`Added ${display.countOf(added, "file")}, skipped ${display.countOf(result.skipped, "unsupported file")}.`, "info");
        } else if (added === 0 && result.files.length === 0 && result.skipped > 0) {
            toast("No supported media found in that folder.", "warning");
        }
        for (const err of result.errors ?? []) {
            toast(`Could not read ${p.basename(err.path)}: ${err.error}`, "danger");
        }
    } catch (_) {
        addFiles(inputPaths);
    }
}

/**
 * Probe anything that has not been probed yet. Cards are already on screen by
 * this point — metadata only enriches them, so a slow or failing probe never
 * blocks the UI.
 */
async function probeNewJobs() {
    const pending = jobs.filter(j => j.meta === null);
    for (const job of pending) {
        job.meta = { pending: true };
        api.probeFile(job.filePath).then((meta) => {
            const current = jobs.find(j => j.id === job.id);
            if (!current) return;
            current.meta = meta;
            updateCard(current);
        }).catch(() => {
            const current = jobs.find(j => j.id === job.id);
            if (current) { current.meta = { ok: false }; updateCard(current); }
        });
    }
}

// -- Selection ---------------------------------------------------------------

function orderedIds() {
    return jobs.map(j => j.id);
}

function handleCardClick(jobId, event) {
    const { selection: next, anchor } = display.resolveSelection(
        orderedIds(), selection, jobId,
        { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
        selectionAnchor
    );
    selection = next;
    selectionAnchor = anchor;
    renderSelection();
}

function selectAll() {
    selection = new Set(orderedIds());
    selectionAnchor = jobs.length > 0 ? jobs[0].id : null;
    renderSelection();
}

function clearSelection() {
    selection = new Set();
    selectionAnchor = null;
    renderSelection();
}

function selectedJobs() {
    return jobs.filter(j => selection.has(j.id));
}

// -- Mutation ----------------------------------------------------------------

function removeJobs(ids) {
    const set = new Set(ids);
    jobs = jobs.filter(j => !set.has(j.id));
    selection = display.pruneSelection(selection, orderedIds());
    render();
}

/** Can this source actually produce that format? */
function canTarget(job, targetExt) {
    return display.commonTargets([job.ext], TARGETS).some(t => t.ext === targetExt);
}

/**
 * Set — or clear — the target format on a set of jobs.
 *
 * `targetExt` may be null or "", which is the "Choose format…" placeholder and
 * means "no format chosen". Clearing is always allowed and must skip the
 * validity guard below, which only applies to real formats.
 */
function setTarget(ids, targetExt) {
    const set = new Set(ids);
    const next = targetExt || null;

    for (const job of jobs) {
        if (!set.has(job.id)) continue;
        // The per-card select is disabled mid-run, but the bulk bar can still
        // reach a running job.
        if (job.status === "running") continue;
        // Guard against a stale bulk option: never assign a format the source
        // cannot produce. Does not apply when clearing.
        if (next !== null && !canTarget(job, next)) continue;
        if (job.targetExt === next) continue;

        job.targetExt = next;

        // A job that already finished, failed or was cancelled becomes runnable
        // again under a new target, so send it back to pending rather than
        // leaving a stale "Done" or an old error sitting on the card.
        if (job.status !== "pending") {
            job.status = "pending";
            job.error = null;
            job.progress = 0;
            job.outputPath = null;
            job.isDirectory = false;
            job.fileCount = 0;
        }

        updateCard(job);
    }
    renderActionBar();
}

// -- Rendering ---------------------------------------------------------------

function render() {
    const hasJobs = jobs.length > 0;

    $("empty-state").classList.toggle("d-none", hasJobs);
    $("grid-scroll").classList.toggle("d-none", !hasJobs);
    $("action-bar").classList.toggle("d-none", !hasJobs);

    const grid = $("job-grid");
    grid.innerHTML = "";
    for (const job of jobs) grid.appendChild(buildCard(job));

    renderSelection();
    renderActionBar();
}

function buildCard(job) {
    const card = document.createElement("div");
    card.className = "job-card";
    card.dataset.id = job.id;

    // -- head
    const head = document.createElement("div");
    head.className = "card-head";

    const icon = document.createElement("span");
    icon.className = "material-icons-round kind-icon";
    icon.textContent = display.iconForKind(job.kind);

    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = p.basename(job.filePath);
    name.title = job.filePath;

    const remove = document.createElement("button");
    remove.className = "card-remove";
    remove.title = "Remove";
    const removeIcon = document.createElement("span");
    removeIcon.className = "material-icons-round";
    removeIcon.textContent = "close";
    remove.appendChild(removeIcon);
    remove.addEventListener("click", (e) => {
        e.stopPropagation();
        removeJobs([job.id]);
    });

    head.append(icon, name, remove);

    // -- meta
    const meta = document.createElement("div");
    meta.className = "card-meta";

    // -- convert row
    const convert = document.createElement("div");
    convert.className = "card-convert";

    const from = document.createElement("span");
    from.className = "card-from";
    from.textContent = job.ext.toUpperCase();

    const arrow = document.createElement("span");
    arrow.className = "material-icons-round card-arrow";
    arrow.textContent = "arrow_forward";

    const select = document.createElement("select");
    select.className = "form-select form-select-sm card-target";
    fillTargetSelect(select, display.commonTargets([job.ext], TARGETS), job.targetExt);
    select.addEventListener("click", (e) => e.stopPropagation());
    select.addEventListener("change", () => setTarget([job.id], select.value || null));

    convert.append(from, arrow, select);

    // -- status
    const status = document.createElement("div");
    status.className = "card-status";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const statusText = document.createElement("span");
    statusText.className = "status-text";
    status.append(dot, statusText);

    // -- progress
    const progress = document.createElement("div");
    progress.className = "card-progress d-none";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = "0%";
    progress.appendChild(bar);

    // -- actions (revealed once a job finishes)
    const actions = document.createElement("div");
    actions.className = "card-actions d-none";

    card.append(head, meta, convert, status, progress, actions);
    card.addEventListener("click", (e) => handleCardClick(job.id, e));

    paintCard(card, job);
    return card;
}

function fillTargetSelect(select, targets, current) {
    select.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose format…";
    select.appendChild(placeholder);

    for (const { group, items } of display.groupTargets(targets)) {
        const optgroup = document.createElement("optgroup");
        optgroup.label = group;
        for (const t of items) {
            const option = document.createElement("option");
            option.value = t.ext;
            option.textContent = t.label;
            optgroup.appendChild(option);
        }
        select.appendChild(optgroup);
    }

    select.value = current ?? "";
}

/** Update one card in place, without rebuilding the grid. */
function updateCard(job) {
    const card = $("job-grid").querySelector(`[data-id="${job.id}"]`);
    if (card) paintCard(card, job);
    renderActionBar();
}

function paintCard(card, job) {
    const meta = card.querySelector(".card-meta");
    const described = display.describeMeta(job.meta, job.ext);
    meta.textContent = described ?? "Reading…";
    meta.classList.toggle("pending", described === null);
    if (described) meta.title = described;

    const { text, tone } = display.describeStatus(job);
    const status = card.querySelector(".card-status");
    status.className = `card-status tone-${tone}`;
    const statusText = status.querySelector(".status-text");
    statusText.textContent = text;
    statusText.title = text;

    const running = job.status === "running";
    const progress = card.querySelector(".card-progress");
    progress.classList.toggle("d-none", !running);
    progress.classList.toggle("indeterminate", running && job.progress === null);
    if (running && typeof job.progress === "number") {
        progress.querySelector(".bar").style.width = `${job.progress}%`;
    }

    // The target select locks while the job is in flight.
    const select = card.querySelector(".card-target");
    select.disabled = running;
    if (select.value !== (job.targetExt ?? "")) select.value = job.targetExt ?? "";

    renderCardActions(card, job);
}

function renderCardActions(card, job) {
    const actions = card.querySelector(".card-actions");
    actions.innerHTML = "";

    const buttons = [];

    if (job.status === "running") {
        buttons.push(makeAction("Cancel", "btn-outline-danger", () => api.cancelJob(job.id)));
    } else if (job.status === "done" && job.outputPath) {
        buttons.push(makeAction(
            job.isDirectory ? "Open folder" : "Show in folder",
            "btn-outline-secondary",
            () => (job.isDirectory ? api.openPath(job.outputPath) : api.showInFolder(job.outputPath))
        ));
    } else if (job.status === "error") {
        buttons.push(makeAction("Retry", "btn-outline-secondary", () => {
            job.status = "pending";
            job.error = null;
            job.progress = 0;
            updateCard(job);
        }));
    }

    actions.classList.toggle("d-none", buttons.length === 0);
    for (const b of buttons) actions.appendChild(b);
}

function makeAction(label, variant, onClick) {
    const btn = document.createElement("button");
    btn.className = `btn btn-sm ${variant}`;
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
    });
    return btn;
}

function renderSelection() {
    for (const card of $("job-grid").children) {
        card.classList.toggle("selected", selection.has(card.dataset.id));
    }

    const count = selection.size;
    const bar = $("bulk-bar");
    bar.classList.toggle("d-none", count === 0);
    if (count === 0) return;

    $("bulk-count").textContent = `${count} selected`;

    // Offer only formats every selected source can actually produce, so a bulk
    // change can never create an invalid job.
    const targets = display.commonTargets(selectedJobs().map(j => j.ext), TARGETS);
    const select = $("bulk-target");
    const shared = [...new Set(selectedJobs().map(j => j.targetExt))];
    fillTargetSelect(select, targets, shared.length === 1 ? shared[0] : null);

    select.disabled = targets.length === 0 || converting;
    $("bulk-target-note").textContent = targets.length === 0
        ? "No format works for every selected file"
        : "";
}

function renderActionBar() {
    const total = jobs.length;
    const ready = jobs.filter(j => j.targetExt).length;
    const withoutTarget = total - ready;
    const running = jobs.filter(j => j.status === "running").length;
    const settled = jobs.filter(j => j.status !== "pending" && j.status !== "running").length;

    // Once anything has finished, the outcome is what matters. This used to be
    // tied to `converting`, so the moment a run ended the bar snapped back to
    // "1 file queued" — describing files that had just been converted as still
    // waiting. And while a run was under way with nothing finished yet, the
    // summary read "Nothing converted", which is true but reads like a failure.
    if (settled > 0) {
        $("queue-summary").textContent = display.summarise(jobs);
    } else if (converting) {
        $("queue-summary").textContent = `Converting ${display.countOf(ready, "file")}…`;
    } else {
        $("queue-summary").textContent = `${display.countOf(total, "file")} queued`;
    }

    if (converting) {
        $("queue-detail").textContent = `${running} running`;
    } else if (withoutTarget > 0) {
        $("queue-detail").textContent =
            `${display.countOf(withoutTarget, "file")} still ${display.plural(withoutTarget, "needs", "need")} a format`;
    } else {
        // After a finished run "Ready to convert" would be misleading, so the
        // outcome in the summary is left to speak for itself.
        $("queue-detail").textContent = settled > 0 ? "" : "Ready to convert";
    }

    const percent = display.overallProgress(jobs);
    $("overall-bar").style.width = `${percent}%`;

    // House pattern: the primary action and its abort share one slot rather
    // than sitting side by side, so only one is ever visible.
    $("btn-convert").classList.toggle("d-none", converting);
    $("btn-convert").disabled = ready === 0;
    $("btn-cancel-all").classList.toggle("d-none", !converting);
    $("btn-clear-all").disabled = converting;
}

// -- Toasts ------------------------------------------------------------------

const TOAST_ICONS = { info: "info", success: "check_circle", warning: "warning", danger: "error" };

function toast(message, type = "info", timeoutMs = 4500) {
    const host = $("toast-host");

    const note = document.createElement("div");
    note.className = `toast-note toast-${type}`;

    const icon = document.createElement("span");
    icon.className = "material-icons-round";
    icon.textContent = TOAST_ICONS[type] ?? "info";

    const body = document.createElement("span");
    body.className = "toast-body";
    body.textContent = message;

    const close = document.createElement("button");
    close.className = "toast-close material-icons-round";
    close.textContent = "close";
    close.title = "Dismiss";
    close.addEventListener("click", () => dismiss());

    note.append(icon, body, close);
    host.appendChild(note);

    let timer = null;
    function dismiss() {
        if (!note.isConnected) return;
        clearTimeout(timer);
        note.classList.add("leaving");
        setTimeout(() => note.remove(), 200);
    }

    if (timeoutMs > 0) timer = setTimeout(dismiss, timeoutMs);
    return dismiss;
}

// -- Conversion --------------------------------------------------------------

async function startConversion() {
    const runnable = jobs.filter(j => j.targetExt);
    if (runnable.length === 0) return;

    converting = true;
    for (const job of runnable) {
        job.status = "pending";
        job.progress = 0;
        job.error = null;
        updateCard(job);
    }
    renderActionBar();

    // Every job is submitted at once; the runner's pool decides how many
    // actually run in parallel. v1 awaited them one at a time.
    const results = await Promise.all(runnable.map(async (job) => {
        const result = await api.runJob({
            id: job.id,
            inputPath: job.filePath,
            targetExt: job.targetExt,
        });
        applyResult(job, result);
        return result;
    }));

    converting = false;
    render();
    announce(results);
}

function applyResult(job, result) {
    job.status = result.status;
    job.error = result.error ?? null;
    job.outputPath = result.outputPath ?? null;
    job.isDirectory = result.isDirectory === true;
    job.fileCount = result.fileCount ?? 0;
    if (result.status === "done") job.progress = 100;
    updateCard(job);
}

function announce(results) {
    const failed = results.filter(r => r.status === "error");
    const done = results.filter(r => r.status === "done").length;
    const cancelled = results.filter(r => r.status === "cancelled" || r.status === "skipped").length;

    if (failed.length > 0) {
        // One toast, not one blocking dialog per failure. The per-card status
        // carries each individual reason.
        const detail = failed.length === 1 ? ` — ${failed[0].error ?? "unknown error"}` : "";
        toast(
            `${display.countOf(failed.length, "file")} failed to convert${detail}`,
            "danger",
            0
        );
    }
    if (done > 0) {
        toast(`${display.countOf(done, "file")} converted.`, "success");
    } else if (failed.length === 0 && cancelled > 0) {
        toast("Conversion cancelled.", "info");
    }
}

// -- Wiring ------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
    FORMATS = await api.getFormats();
    TARGETS = FORMATS.targetsByExt;

    // Drag and drop. The document-level guard stops a stray drop navigating the
    // window to the file and replacing the app with it.
    const shell = document.querySelector(".app-shell");
    let dragDepth = 0;

    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth++;
        shell.classList.add("drag-over");
        if (jobs.length === 0) $("drop-zone").classList.add("drag-over");
    });
    document.addEventListener("dragleave", () => {
        // dragleave also fires crossing onto child elements, so count depth
        // rather than clearing on the first one — that is what made the v1
        // highlight flicker.
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            shell.classList.remove("drag-over");
            $("drop-zone").classList.remove("drag-over");
        }
    });
    document.addEventListener("drop", (e) => {
        dragDepth = 0;
        shell.classList.remove("drag-over");
        $("drop-zone").classList.remove("drag-over");
        ingestPaths(api.getPathsForFiles(e.dataTransfer.files));
    });

    async function browseFiles() {
        const filePaths = await api.browseFiles();
        if (filePaths) ingestPaths(filePaths);
    }
    async function browseFolder() {
        const folders = await api.browseFolder();
        if (folders) ingestPaths(folders);
    }

    $("browse-btn").addEventListener("click", browseFiles);
    $("btn-add-files").addEventListener("click", browseFiles);
    $("btn-add-folder").addEventListener("click", browseFolder);
    $("drop-zone").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        browseFiles();
    });

    $("btn-convert").addEventListener("click", startConversion);
    $("btn-cancel-all").addEventListener("click", () => api.cancelAll());
    $("btn-clear-all").addEventListener("click", () => {
        jobs = [];
        clearSelection();
        render();
    });

    // An empty value is the placeholder, which clears the target across the
    // selection — pass it through rather than ignoring it.
    $("bulk-target").addEventListener("change", (e) => {
        setTarget([...selection], e.target.value);
    });
    $("bulk-remove").addEventListener("click", () => removeJobs([...selection]));
    $("bulk-deselect").addEventListener("click", clearSelection);

    // Clicking the grid background clears the selection.
    $("grid-scroll").addEventListener("click", (e) => {
        if (e.target === $("grid-scroll") || e.target === $("job-grid")) clearSelection();
    });

    document.addEventListener("keydown", (e) => {
        const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
        if (typing) return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            selectAll();
        } else if (e.key === "Delete" && selection.size > 0 && !converting) {
            e.preventDefault();
            removeJobs([...selection]);
        } else if (e.key === "Escape") {
            clearSelection();
        }
    });

    render();
});

// Progress carries a jobId, so it lands on the right card. v1 pushed a bare
// integer with no way to tell which file it belonged to.
api.onJobProgress(({ jobId, percent }) => {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    job.progress = percent;
    updateCard(job);
});

api.onJobStatus(({ jobId, status }) => {
    const job = jobs.find(j => j.id === jobId);
    if (!job || status === undefined) return;
    if (status === "running") {
        job.status = "running";
        updateCard(job);
    }
});

api.onFilesOpened((filePaths) => {
    ingestPaths(Array.isArray(filePaths) ? filePaths : [filePaths]);
});
