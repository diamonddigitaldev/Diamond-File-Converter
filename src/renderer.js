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
let DESCRIPTORS = null;

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
            processing: "manual",   // "manual" | "pipeline"
            pipelineId: null,
            settings: {},           // kept while in pipeline mode, so switching back is lossless
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

    // Explicit selection affordance. The whole card is still clickable, but a
    // checkbox makes multi-select discoverable without knowing about ctrl+click.
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.className = "form-check-input card-select";
    tick.title = "Select";
    tick.addEventListener("click", (e) => {
        e.stopPropagation();
        // A checkbox always toggles just this card, whatever else is selected.
        handleCardClick(job.id, { ctrlKey: true, shiftKey: false });
    });

    const icon = document.createElement("span");
    icon.className = "material-icons-round kind-icon";
    icon.textContent = display.iconForKind(job.kind);

    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = p.basename(job.filePath);
    name.title = job.filePath;

    const configure = document.createElement("button");
    configure.className = "card-configure";
    configure.title = "Advanced options";
    const configureIcon = document.createElement("span");
    configureIcon.className = "material-icons-round";
    configureIcon.textContent = "tune";
    configure.appendChild(configureIcon);
    configure.addEventListener("click", (e) => {
        e.stopPropagation();
        openJobModal([job.id]);
    });

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

    head.append(tick, icon, name, configure, remove);

    // -- meta
    const meta = document.createElement("div");
    meta.className = "card-meta";

    const settingsLine = document.createElement("div");
    settingsLine.className = "card-settings d-none";

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

    card.append(head, meta, settingsLine, convert, status, progress, actions);
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

    // Show what has been configured, so a customised job is visibly different.
    const settingsLine = card.querySelector(".card-settings");
    const summary = display.describeProcessing(job, pipelines);
    settingsLine.classList.toggle("d-none", !summary);
    if (summary) {
        settingsLine.textContent = summary;
        settingsLine.title = summary;
    }

    const { text, tone } = display.describeStatus(job, pipelines);
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

/** The jobs a bulk action applies to: the selection, or everything if none. */
function bulkScope() {
    return selection.size > 0 ? selectedJobs() : jobs;
}

function renderSelection() {
    for (const card of $("job-grid").children) {
        const isSelected = selection.has(card.dataset.id);
        card.classList.toggle("selected", isSelected);
        const tick = card.querySelector(".card-select");
        if (tick) tick.checked = isSelected;
    }

    const count = selection.size;
    const bar = $("bulk-bar");

    // The bar is present whenever there are cards, not only when something is
    // selected. With no selection it addresses every file, which keeps the old
    // "drop a folder, pick one format, convert" flow to two clicks — selecting
    // first would have made the common case strictly worse.
    bar.classList.toggle("d-none", jobs.length === 0);
    if (jobs.length === 0) return;

    const scope = bulkScope();
    const everything = count === 0;

    $("bulk-count").textContent = everything ? "Select all" : `${count} selected`;
    $("bulk-target-label").textContent = everything ? "Convert all to" : "Convert selected to";

    const selectAllBox = $("bulk-select-all");
    selectAllBox.checked = count > 0 && count === jobs.length;
    selectAllBox.indeterminate = count > 0 && count < jobs.length;

    $("bulk-remove").classList.toggle("d-none", everything);
    $("bulk-deselect").classList.toggle("d-none", everything);
    $("bulk-edit-label").textContent = everything ? "Edit all" : "Bulk edit";

    // Offer only formats every source in scope can actually produce, so a bulk
    // change can never create an invalid job.
    const targets = display.commonTargets(scope.map(j => j.ext), TARGETS);
    const select = $("bulk-target");
    const shared = [...new Set(scope.map(j => j.targetExt))];
    fillTargetSelect(select, targets, shared.length === 1 ? shared[0] : null);

    select.disabled = targets.length === 0 || converting;
    $("bulk-target-note").textContent = targets.length === 0
        ? `No format works for every ${everything ? "queued" : "selected"} file`
        : "";
}

function renderActionBar() {
    const total = jobs.length;
    // A pipeline-mode card whose pipeline no longer exists cannot run.
    const ready = jobs.filter(j => j.targetExt && display.hasUsableProcessing(j, pipelines)).length;
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
    // Enabled only while there is something left to run. `ready` counts cards
    // that *could* run, including ones already converted, and is what the
    // "still need a format" copy is derived from — so the button needs its own
    // count, or it sits enabled doing nothing once a batch has finished.
    $("btn-convert").disabled = jobs.filter(
        j => j.targetExt && j.status !== "done" && display.hasUsableProcessing(j, pipelines)
    ).length === 0;
    $("bulk-edit").disabled = converting;
    $("btn-cancel-all").classList.toggle("d-none", !converting);
    $("btn-clear-all").disabled = converting;
}

// -- New Job dialog ----------------------------------------------------------
//
// Every control is built from the target format's own capabilities, so a
// container is never offered a codec it cannot carry. The dialog edits a
// partial spec: anything left blank is omitted, and createJob fills it from the
// format's defaults rather than the dialog freezing today's defaults in.
//
// It is deliberately not the only way to set a format — the per-card dropdown
// and the bulk bar still work, so the plain "drop a folder, pick a format, go"
// path stays two clicks.

let jobModal = null;
let modalScope = [];        // ids the dialog is editing
let previewTimer = null;
let modalProcessing = "manual";
let pipelines = [];

const ENCODER_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast",
    "medium", "slow", "slower", "veryslow"];

// -- Processing mode ---------------------------------------------------------

/** Paint the tiles from modalProcessing. One source of truth, like Craftbox. */
function renderModeTiles() {
    for (const tile of document.querySelectorAll("#jm-mode .mode-tile")) {
        const active = tile.dataset.mode === modalProcessing;
        tile.classList.toggle("selected", active);
        tile.setAttribute("aria-pressed", String(active));
        // A locked tile stays out of the tab order entirely.
        const locked = tile.classList.contains("mode-tile-locked");
        tile.setAttribute("tabindex", locked ? "-1" : "0");
    }
}

function setProcessingMode(next) {
    // Strictly one or the other: re-clicking the active tile does nothing.
    // (Craftbox's source tiles deselect back to a third state; there is no
    // third state here.)
    if (next === modalProcessing) return;

    // A locked tile is not selectable. pointer-events:none stops a mouse but
    // not a keyboard or a programmatic activation, so the rule lives here as
    // well as in the CSS rather than being purely presentational.
    const tile = document.querySelector(`#jm-mode .mode-tile[data-mode="${next}"]`);
    if (tile && tile.classList.contains("mode-tile-locked")) return;

    modalProcessing = next;
    syncModalControls();
}

/**
 * Load saved pipelines. The Pipeline tile ships locked and is unlocked only
 * once there is something to pick — fail closed, then open.
 */
async function refreshPipelines() {
    pipelines = await api.listPipelines();
    const select = $("jm-pipeline");
    fillSelect(select, pipelines.map(x => ({ value: x.id, label: x.name })),
        select.dataset.wanted || undefined, "Choose a pipeline\u2026");

    const none = pipelines.length === 0;
    $("jm-pipeline-empty").classList.toggle("d-none", !none);
    select.classList.toggle("d-none", none);

    const tile = $("jm-mode-pipeline");
    tile.classList.toggle("mode-tile-locked", none);
    if (none) {
        tile.setAttribute("title", "No pipelines saved yet");
        // Nothing to select, so a card cannot sit in pipeline mode.
        if (modalProcessing === "pipeline") modalProcessing = "manual";
    } else {
        tile.removeAttribute("title");
    }
    renderModeTiles();
}

function initModeTiles() {
    for (const tile of document.querySelectorAll("#jm-mode .mode-tile")) {
        tile.addEventListener("click", () => setProcessingMode(tile.dataset.mode));
        tile.addEventListener("keydown", (e) => {
            // Craftbox's tiles are mouse-only; these are not.
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                e.preventDefault();
                setProcessingMode(tile.dataset.mode);
            }
        });
    }
    $("jm-pipeline").addEventListener("change", () => {
        $("jm-pipeline").dataset.wanted = $("jm-pipeline").value;
        schedulePreview();
    });

    // The editor is a view, not a nested dialog, so the dialog closes on the
    // way there. modalScope is module state and survives, which is what lets
    // the same selection be reopened afterwards.
    $("jm-pipeline-edit").addEventListener("click", () => {
        jobModal?.hide();
        showView("pipelines");
    });
}

// -- Trim slider -------------------------------------------------------------
//
// A two-point slider rather than a pair of text boxes: the useful thing about a
// trim is where the kept span sits relative to the whole clip, which a pair of
// numbers does not show. Holding Shift scales pointer movement down for fine
// adjustment, and the arrow keys do the same with a smaller step.

const trimState = { duration: 0, start: 0, end: 0, pendingEnd: null, available: false };

const TRIM_MIN_SPAN = 0.05;   // never let the two handles cross
const TRIM_KEY_STEP = 1;      // seconds per arrow press
const TRIM_FINE = 0.15;       // Shift multiplier while dragging

/** Longest duration in scope — a selection may hold clips of different lengths. */
function trimScopeDuration() {
    const scoped = jobs.filter(j => modalScope.includes(j.id));
    const durations = scoped
        .map(j => (j.meta && j.meta.ok ? j.meta.duration : null))
        .filter(d => typeof d === "number" && d > 0);
    return durations.length > 0 ? Math.max(...durations) : 0;
}

function setupTrim() {
    const duration = trimScopeDuration();
    trimState.duration = duration;
    trimState.available = duration > 0;

    $("jm-trim-wrap").classList.toggle("d-none", !trimState.available);
    $("jm-trim-unavailable").classList.toggle("d-none", trimState.available);
    if (!trimState.available) return;

    trimState.start = Math.min(trimState.start ?? 0, duration);
    trimState.end = trimState.pendingEnd != null
        ? Math.min(trimState.pendingEnd, duration)
        : duration;
    trimState.pendingEnd = null;
    renderTrim();
}

function renderTrim() {
    const { duration, start, end } = trimState;
    if (!duration) return;
    const pct = (v) => `${(v / duration) * 100}%`;

    $("jm-trim-thumb-start").style.left = pct(start);
    $("jm-trim-thumb-end").style.left = pct(end);
    $("jm-trim-range").style.left = pct(start);
    $("jm-trim-range").style.width = pct(end - start);

    $("jm-trim-start-label").textContent = display.formatDuration(start) ?? "0:00";
    $("jm-trim-end-label").textContent = display.formatDuration(end) ?? "";
    $("jm-trim-kept").textContent = `keeping ${display.formatDuration(end - start) ?? "0:00"}`;

    for (const [id, value] of [["jm-trim-thumb-start", start], ["jm-trim-thumb-end", end]]) {
        const thumb = $(id);
        thumb.setAttribute("aria-valuemin", "0");
        thumb.setAttribute("aria-valuemax", String(Math.round(duration)));
        thumb.setAttribute("aria-valuenow", String(Math.round(value)));
        thumb.setAttribute("aria-valuetext", display.formatDuration(value) ?? "");
    }
}

/** Read the slider back as a spec, omitting bounds that were never moved. */
function readTrim() {
    if (!trimState.available) return null;
    const { duration, start, end } = trimState;
    return {
        start: start > 0 ? Math.round(start * 100) / 100 : null,
        end: end < duration ? Math.round(end * 100) / 100 : null,
    };
}

function moveTrimHandle(handle, seconds) {
    const { duration } = trimState;
    if (handle === "start") {
        trimState.start = Math.max(0, Math.min(seconds, trimState.end - TRIM_MIN_SPAN));
    } else {
        trimState.end = Math.min(duration, Math.max(seconds, trimState.start + TRIM_MIN_SPAN));
    }
    renderTrim();
    schedulePreview();
}

function initTrimSlider() {
    const slider = $("jm-trim-slider");

    for (const handle of ["start", "end"]) {
        const thumb = $(`jm-trim-thumb-${handle}`);

        thumb.addEventListener("pointerdown", (e) => {
            if (!trimState.available) return;
            e.preventDefault();
            thumb.setPointerCapture(e.pointerId);
            const originX = e.clientX;
            const origin = handle === "start" ? trimState.start : trimState.end;

            const onMove = (ev) => {
                const width = slider.getBoundingClientRect().width || 1;
                // Shift shrinks how far the value travels per pixel, which is
                // what "finer control" means for a drag.
                const scale = ev.shiftKey ? TRIM_FINE : 1;
                slider.classList.toggle("fine", ev.shiftKey);
                const delta = ((ev.clientX - originX) / width) * trimState.duration * scale;
                moveTrimHandle(handle, origin + delta);
            };
            const onUp = (ev) => {
                thumb.releasePointerCapture(ev.pointerId);
                thumb.removeEventListener("pointermove", onMove);
                thumb.removeEventListener("pointerup", onUp);
                slider.classList.remove("fine");
            };
            thumb.addEventListener("pointermove", onMove);
            thumb.addEventListener("pointerup", onUp);
        });

        thumb.addEventListener("keydown", (e) => {
            if (!trimState.available) return;
            const step = e.shiftKey ? TRIM_KEY_STEP * TRIM_FINE : TRIM_KEY_STEP;
            const current = handle === "start" ? trimState.start : trimState.end;
            if (e.key === "ArrowLeft") { e.preventDefault(); moveTrimHandle(handle, current - step); }
            else if (e.key === "ArrowRight") { e.preventDefault(); moveTrimHandle(handle, current + step); }
            else if (e.key === "Home") { e.preventDefault(); moveTrimHandle(handle, 0); }
            else if (e.key === "End") { e.preventDefault(); moveTrimHandle(handle, trimState.duration); }
        });
    }
}

function fillSelect(select, options, current, placeholder) {
    select.innerHTML = "";
    if (placeholder !== undefined) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = placeholder;
        select.appendChild(opt);
    }
    for (const o of options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        select.appendChild(opt);
    }
    select.value = current ?? "";
    // Assigning a value no option carries leaves selectedIndex at -1, which
    // renders as a blank control and reads back as "". Fall back to the first
    // entry so a select without a placeholder always shows a real choice.
    if (select.selectedIndex === -1 && select.options.length > 0) {
        select.selectedIndex = 0;
    }
}

/** Open the dialog for a set of job ids. */
function openJobModal(ids) {
    modalScope = ids.filter(id => jobs.some(j => j.id === id));
    if (modalScope.length === 0) return;

    const scoped = jobs.filter(j => modalScope.includes(j.id));
    const single = scoped.length === 1;

    $("jm-title").textContent = single ? "Advanced options" : "Bulk edit";
    $("jm-scope").textContent = single
        ? p.basename(scoped[0].filePath)
        : `Applies to ${display.countOf(scoped.length, "file")}`;

    // Target options are the intersection, exactly as the bulk bar computes it.
    const targets = display.commonTargets(scoped.map(j => j.ext), TARGETS);
    const sharedTarget = [...new Set(scoped.map(j => j.targetExt))];
    fillTargetSelect($("jm-target"), targets, sharedTarget.length === 1 ? sharedTarget[0] : null);
    $("jm-target-note").textContent = targets.length === 0
        ? "These files have no format in common."
        : "";

    // Seed from existing settings so reopening shows what is set. Across a
    // selection this only happens when every file already agrees — otherwise
    // one file's values would be presented as if they applied to all.
    const encoded = scoped.map(j => JSON.stringify(j.settings ?? {}));
    const uniform = encoded.every(x => x === encoded[0]);
    loadSettingsIntoForm(uniform ? (scoped[0].settings ?? {}) : {});

    const modes = [...new Set(scoped.map(j => j.processing ?? "manual"))];
    modalProcessing = modes.length === 1 ? modes[0] : "manual";
    const pipeIds = [...new Set(scoped.map(j => j.pipelineId ?? ""))];
    $("jm-pipeline").dataset.wanted = pipeIds.length === 1 ? pipeIds[0] : "";
    refreshPipelines();
    $("jm-scope").textContent += uniform ? "" : " · these files are currently configured differently";

    syncModalControls();

    if (!jobModal) jobModal = new bootstrap.Modal($("job-modal"));
    jobModal.show();
}

function loadSettingsIntoForm(settings) {
    const s = settings ?? {};
    const v = s.video ?? {}, a = s.audio ?? {}, o = s.output ?? {}, t = s.trim ?? {}, i = s.image ?? {};

    $("jm-routing").value = o.routing ?? "alongside";
    $("jm-outdir").value = o.dir ?? "";
    $("jm-name").value = o.nameTemplate ?? "";
    $("jm-conflict").value = o.onConflict ?? "ask";

    $("jm-vmode").value = v.mode ?? "encode";
    $("jm-crf").value = v.crf ?? "";
    $("jm-vbitrate").value = v.bitrate ?? "";
    $("jm-quality-mode").value = v.bitrate != null && v.crf == null ? "bitrate" : "crf";
    $("jm-width").value = v.width ?? "";
    $("jm-height").value = v.height ?? "";
    $("jm-fit").value = v.fitMode ?? "contain";
    $("jm-fps").value = v.fps ?? "";

    $("jm-amode").value = a.mode ?? "encode";
    $("jm-abitrate").value = a.bitrate ?? "";
    $("jm-arate").value = a.sampleRate ?? "";
    $("jm-achannels").value = a.channels ?? "";

    trimState.start = t.start ?? 0;
    trimState.pendingEnd = t.end ?? null;

    // Codec and quality selects depend on the target, so they are populated by
    // syncModalControls; stash the wanted values for it to apply.
    $("jm-vcodec").dataset.wanted = v.codec ?? "";
    $("jm-acodec").dataset.wanted = a.codec ?? "";
    $("jm-encpreset").dataset.wanted = v.preset ?? "";
    $("jm-iquality").dataset.wanted = i.quality ?? "";
}

/** Rebuild every capability-dependent control for the chosen target. */
function syncModalControls() {
    const target = $("jm-target").value || null;
    const sections = display.applicableSections(target, DESCRIPTORS);

    // A file is configured by hand or handed to a pipeline, never both, so the
    // encoding sections and the pipeline picker are mutually exclusive. Within
    // manual mode the per-target rules still decide which sections apply.
    const manual = modalProcessing === "manual";
    renderModeTiles();

    $("jm-pipeline-section").classList.toggle("d-none", manual);
    $("jm-video-section").classList.toggle("d-none", manual ? !sections.video : true);
    $("jm-audio-section").classList.toggle("d-none", manual ? !sections.audio : true);
    $("jm-image-section").classList.toggle("d-none", manual ? !sections.image : true);
    $("jm-trim-section").classList.toggle("d-none", manual ? !sections.trim : true);

    // Stream modes: copy is only offered where the container supports remuxing.
    const canCopy = display.canStreamCopy(target, DESCRIPTORS);
    const modeOptions = (other) => [
        { value: "encode", label: "Re-encode" },
        ...(canCopy ? [{ value: "copy", label: "Copy without re-encoding" }] : []),
        { value: "drop", label: other },
    ];
    fillSelect($("jm-vmode"), modeOptions("Remove video"), $("jm-vmode").value);
    fillSelect($("jm-amode"), modeOptions("Remove audio"), $("jm-amode").value);

    fillSelect($("jm-vcodec"), display.codecOptions(target, DESCRIPTORS, "video"),
        $("jm-vcodec").dataset.wanted || undefined, "Format default");
    fillSelect($("jm-acodec"), display.codecOptions(target, DESCRIPTORS, "audio"),
        $("jm-acodec").dataset.wanted || undefined, "Format default");

    // "Format default" in the codec select means the container's own default,
    // not "no codec" — resolve it, or CRF gets disabled and silently dropped
    // for every job left on the default.
    const codec = effectiveVideoCodec();
    const supportsPreset = ["libx264", "libx265", "libsvtav1"].includes(codec);
    fillSelect($("jm-encpreset"), ENCODER_PRESETS.map(x => ({ value: x, label: x })),
        $("jm-encpreset").dataset.wanted || undefined, "Encoder default");
    $("jm-encpreset").disabled = !supportsPreset;
    $("jm-encpreset").parentElement.classList.toggle("d-none", !supportsPreset);

    const usesCrf = ["libx264", "libx265", "libsvtav1", "libvpx-vp9", "libvpx"].includes(codec);
    $("jm-crf-note").textContent = usesCrf
        ? "Lower is better quality and a bigger file. 18–28 is the usual range."
        : (codec ? "This codec uses a target bitrate rather than constant quality." : "");
    // Switching to a codec with no constant-quality mode forces bitrate. Coming
    // back to one that has it must restore constant quality — otherwise the
    // control stays stuck on bitrate and the CRF the user typed is discarded
    // on apply. Test the disabled flag before overwriting it.
    if (!usesCrf) {
        $("jm-quality-mode").value = "bitrate";
    } else if ($("jm-quality-mode").disabled) {
        $("jm-quality-mode").value = "crf";
    }
    $("jm-quality-mode").disabled = !usesCrf;

    const byBitrate = $("jm-quality-mode").value === "bitrate";
    $("jm-crf").classList.toggle("d-none", byBitrate);
    $("jm-vbitrate").classList.toggle("d-none", !byBitrate);
    $("jm-vbitrate-unit").classList.toggle("d-none", !byBitrate);

    // Encode-only controls hide when the stream is copied or dropped.
    const vEncoding = $("jm-vmode").value === "encode";
    for (const el of document.querySelectorAll(".jm-vencode")) el.classList.toggle("d-none", !vEncoding);
    const aEncoding = $("jm-amode").value === "encode";
    for (const el of document.querySelectorAll(".jm-aencode")) el.classList.toggle("d-none", !aEncoding);

    // Image quality range comes from the format's own descriptor.
    const q = display.qualityDescriptor(target, DESCRIPTORS);
    if (q) {
        const slider = $("jm-iquality");
        slider.min = q.min;
        slider.max = q.max;
        slider.step = 1;
        const wanted = slider.dataset.wanted;
        slider.value = wanted !== "" && wanted !== undefined ? wanted : q.default;
        $("jm-iquality-value").textContent = slider.value;
        $("jm-iquality-note").textContent = q.inverted
            ? `${q.min} is best quality, ${q.max} is smallest file.`
            : `${q.max} is best quality, ${q.min} is smallest file.`;
    }

    if (manual && sections.trim) setupTrim();

    // The output folder only matters when a folder was chosen.
    const needsDir = $("jm-routing").value !== "alongside";
    $("jm-outdir").parentElement.parentElement.classList.toggle("d-none", !needsDir);

    schedulePreview();
}

/**
 * The codec that will actually be used: whatever is chosen, or the target
 * format's own default when the select is left on "Format default".
 */
function effectiveVideoCodec() {
    const chosen = $("jm-vcodec").value;
    if (chosen) return chosen;
    const target = $("jm-target").value;
    return (DESCRIPTORS && DESCRIPTORS[target] && DESCRIPTORS[target].defaultVideoCodec) || null;
}

/** Read the form back into a partial job spec. */
function readSettingsFromForm() {
    const target = $("jm-target").value || null;
    const sections = display.applicableSections(target, DESCRIPTORS);
    const num = (id) => { const v = $(id).value; return v === "" ? null : Number(v); };
    // Match syncModalControls: quality mode is only meaningful once the
    // effective codec is known.
    const usesCrf = ["libx264", "libx265", "libsvtav1", "libvpx-vp9", "libvpx"]
        .includes(effectiveVideoCodec());
    const byBitrate = !usesCrf || $("jm-quality-mode").value === "bitrate";

    const settings = {
        output: {
            routing: $("jm-routing").value,
            dir: $("jm-outdir").value || null,
            nameTemplate: $("jm-name").value || null,
            onConflict: $("jm-conflict").value,
        },
        video: sections.video ? {
            mode: $("jm-vmode").value,
            codec: $("jm-vcodec").value || null,
            crf: byBitrate ? null : num("jm-crf"),
            bitrate: byBitrate ? num("jm-vbitrate") : null,
            preset: $("jm-encpreset").disabled ? null : ($("jm-encpreset").value || null),
            width: num("jm-width"),
            height: num("jm-height"),
            fitMode: $("jm-fit").value,
            fps: num("jm-fps"),
        } : null,
        audio: sections.audio ? {
            mode: $("jm-amode").value,
            codec: $("jm-acodec").value || null,
            bitrate: num("jm-abitrate"),
            sampleRate: num("jm-arate"),
            channels: num("jm-achannels"),
        } : null,
        image: sections.image ? { quality: num("jm-iquality") } : null,
        trim: sections.trim ? readTrim() : null,
    };

    // Defaults that were never touched are dropped, so the format keeps
    // control of anything the user did not explicitly choose.
    if (settings.output.routing === "alongside") settings.output.routing = null;
    if (settings.output.onConflict === "ask") settings.output.onConflict = null;
    if (settings.video && settings.video.mode === "encode") settings.video.mode = null;
    if (settings.video && settings.video.fitMode === "contain") settings.video.fitMode = null;
    if (settings.audio && settings.audio.mode === "encode") settings.audio.mode = null;

    return display.compactSettings(settings);
}

/** Debounced live preview, built by the real argument builder in main. */
function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
        const target = $("jm-target").value;
        const sample = jobs.find(j => modalScope.includes(j.id));
        if (!target || !sample) {
            $("jm-preview").textContent = "Choose a format to see the command.";
            $("jm-errors").textContent = "";
            return;
        }
        const result = await api.previewJob(modalProcessing === "pipeline"
            ? { inputPath: sample.filePath, targetExt: target, pipelineId: $("jm-pipeline").value || null }
            : { inputPath: sample.filePath, targetExt: target, ...readSettingsFromForm() });
        $("jm-preview").textContent = `ffmpeg ${result.args.join(" ")}`;
        $("jm-errors").textContent = result.ok ? "" : result.errors.join(" ");
        $("jm-apply").disabled = !result.ok;
    }, 180);
}

function applyJobModal() {
    const target = $("jm-target").value || null;
    const settings = readSettingsFromForm();

    for (const job of jobs) {
        if (!modalScope.includes(job.id)) continue;
        if (job.status === "running") continue;

        job.processing = modalProcessing;
        if (modalProcessing === "pipeline") {
            job.pipelineId = $("jm-pipeline").value || null;
            // Manual settings are deliberately NOT cleared — switching back
            // restores them rather than losing the work.
        } else {
            job.settings = settings;
        }
        updateCard(job);
    }
    if (target) setTarget(modalScope, target);

    jobModal.hide();
    const n = modalScope.length;
    toast(`Settings applied to ${display.countOf(n, "file")}.`, "success");
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
    // Already-converted cards are left alone. This used to take every card
    // with a format, so fixing one failed file and pressing Convert again
    // resubmitted the whole finished batch — and every one of those outputs
    // then collided with the file the previous run had just written.
    // Re-running a finished card is what its own Retry button is for.
    const runnable = jobs.filter(j => j.targetExt && j.status !== "done");
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
        const result = await api.runJob(job.processing === "pipeline"
            ? { id: job.id, inputPath: job.filePath, targetExt: job.targetExt, pipelineId: job.pipelineId }
            : { id: job.id, inputPath: job.filePath, targetExt: job.targetExt, ...(job.settings ?? {}) });
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


// -- Views ---------------------------------------------------------------------
//
// Files and Pipelines are siblings behind a rail, not a stack. Everything the
// files view owns keeps its own d-none state while hidden, so switching back
// restores the grid exactly as it was rather than rebuilding it.

let currentView = "files";
let confirmModal = null;

/**
 * Promise-wrapped confirm, per the house pattern. Resolves true only on the
 * confirm button; every other way out resolves false, and both listeners are
 * removed in one shared cleanup either way.
 */
function confirmDialog({ title, body, confirmLabel = "Confirm", variant = "primary", icon = "help_outline" }) {
    return new Promise((resolve) => {
        const modalEl = $("confirm-modal");
        const okBtn = $("confirm-ok");

        $("confirm-title").textContent = title;
        $("confirm-body").textContent = body;
        $("confirm-icon").textContent = icon;
        okBtn.textContent = confirmLabel;
        okBtn.className = `btn btn-${variant}`;

        if (!confirmModal) confirmModal = new bootstrap.Modal(modalEl);

        let confirmed = false;
        const cleanup = () => {
            okBtn.removeEventListener("click", onOk);
            modalEl.removeEventListener("hidden.bs.modal", onHidden);
        };
        const onOk = () => {
            confirmed = true;
            cleanup();
            confirmModal.hide();
            resolve(true);
        };
        const onHidden = () => {
            cleanup();
            if (!confirmed) resolve(false);
        };

        okBtn.addEventListener("click", onOk);
        modalEl.addEventListener("hidden.bs.modal", onHidden);
        confirmModal.show();
    });
}

/**
 * The single route between views. A rail click, the advanced dialog's link and
 * a file drop all come through here, so the unsaved-work guard cannot be
 * sidestepped by arriving a different way.
 */
async function showView(name) {
    if (name === currentView) return;
    if (currentView === "pipelines" && !(await confirmLeaveEditor())) return;

    currentView = name;
    document.querySelector(".app-shell").dataset.view = name;

    for (const item of document.querySelectorAll(".nav-item")) {
        const active = item.dataset.view === name;
        item.classList.toggle("active", active);
        if (active) item.setAttribute("aria-current", "page");
        else item.removeAttribute("aria-current");
    }

    if (name === "pipelines") {
        await openEditor();
    } else {
        // A pipeline may have been saved, renamed or deleted while away, so the
        // cards have to re-resolve — that is what clears or raises the amber
        // "Pipeline missing" state.
        pipelines = await api.listPipelines();
        render();
    }
}

function setNavCollapsed(collapsed) {
    $("nav-rail").classList.toggle("collapsed", collapsed);
    $("nav-collapse").title = collapsed ? "Expand" : "Collapse";
}

// -- Pipeline editor -----------------------------------------------------------
//
// A pure view layer: core/pipeline.js already owns the schema, the compiler and
// the validator, and is loaded here as a plain script so validation and the
// command preview are synchronous. What the editor adds is the handful of rules
// the model tolerates but ffmpeg does not — see canConnect.

/** Loaded as a plain script by index.html, like display. */
const pl = window.pipeline;

/** Mirrors .pl-node in the stylesheet; edges are drawn from these, not measured. */
const NODE_W = 150;
const PORT_TOP = 30;
const PORT_GAP = 18;

let editorGraph = null;      // working copy; Save is what writes it back
let editorSelection = null;  // selected node id
let editorDirty = false;
let linking = null;          // { from, fromPort, type } while dragging a connection

/** Input and Output are structural — every pipeline needs exactly one of each. */
function paletteTypes() {
    return Object.entries(pl.NODE_TYPES)
        .filter(([type, spec]) => !spec.hidden && type !== "input" && type !== "output")
        .map(([type, spec]) => ({ type, label: spec.label }));
}

function getByPath(obj, path) {
    return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setByPath(obj, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    let target = obj;
    for (const key of keys) {
        if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
        target = target[key];
    }
    if (value === null || value === undefined) delete target[last];
    else target[last] = value;
}

function uniqueNodeId() {
    let id;
    do { id = `n${Math.random().toString(36).slice(2, 8)}`; }
    while (editorGraph.nodes.some(n => n.id === id));
    return id;
}

function markDirty() {
    editorDirty = true;
    $("pl-dirty").classList.remove("d-none");
    $("pl-save").disabled = false;
}

async function confirmLeaveEditor() {
    if (!editorDirty) return true;
    return confirmDialog({
        title: "Discard unsaved changes?",
        body: `"${editorGraph?.name ?? "This pipeline"}" has changes that have not been saved.`,
        confirmLabel: "Discard",
        variant: "danger",
        icon: "warning",
    });
}

async function openEditor() {
    pipelines = await api.listPipelines();

    // The graph left open last time may have been deleted from another route.
    if (editorGraph && !editorDirty && !pipelines.some(x => x.id === editorGraph.id)) {
        editorGraph = null;
    }
    if (!editorGraph && pipelines.length > 0) {
        loadIntoEditor(pipelines[0]);
        return;
    }
    renderPipelineList();
    renderEditor();
}

function loadIntoEditor(graph) {
    // A working copy, so abandoning changes really does abandon them.
    editorGraph = JSON.parse(JSON.stringify(graph));
    pl.autoLayout(editorGraph);
    editorSelection = null;
    editorDirty = false;
    renderPipelineList();
    renderEditor();
}

async function selectPipeline(id) {
    if (editorGraph?.id === id) return;
    if (!(await confirmLeaveEditor())) return;
    const found = pipelines.find(x => x.id === id);
    if (found) loadIntoEditor(found);
}

function uniqueName(base) {
    const taken = new Set(pipelines.map(x => x.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

async function newPipeline() {
    if (!(await confirmLeaveEditor())) return;

    // A pipeline is meaningless without its two ends and nothing can stand in
    // for them, so a new one arrives with both placed and already passing both
    // streams through — which is a valid, if inert, pipeline.
    editorGraph = pl.createPipeline({
        name: uniqueName("New pipeline"),
        nodes: [
            { id: "in", type: "input", params: {} },
            { id: "out", type: "output", params: {} },
        ],
        edges: [
            { from: "in", fromPort: "video", to: "out", toPort: "video" },
            { from: "in", fromPort: "audio", to: "out", toPort: "audio" },
        ],
    });
    pl.autoLayout(editorGraph);
    editorSelection = null;
    editorDirty = false;
    renderPipelineList();
    renderEditor();
    markDirty();
    $("pl-name").focus();
    $("pl-name").select();
}

function addNode(type) {
    if (!editorGraph) return;
    const spec = pl.NODE_TYPES[type];
    const node = { id: uniqueNodeId(), type, params: {} };
    for (const param of spec.params ?? []) {
        if (param.default !== undefined) setByPath(node.params, param.key, param.default);
    }

    // Placed in view rather than left to autoLayout, which would put an
    // as-yet-unconnected node in the leftmost column — behind the Input, so
    // wiring it up then draws the graph backwards.
    node.ui = freeSpotForNewNode();

    editorGraph.nodes.push(node);
    editorSelection = node.id;
    markDirty();
    renderEditor();
}

/** Middle of what the user is actually looking at, cascading clear of anything
 *  already there so repeated adds do not stack into one pile. */
function freeSpotForNewNode() {
    const canvas = $("pl-canvas");
    const x = Math.round(canvas.scrollLeft + Math.max(40, canvas.clientWidth / 2 - NODE_W / 2));
    let y = Math.round(canvas.scrollTop + 50);
    while (editorGraph.nodes.some(n =>
        n.ui && Math.abs(n.ui.x - x) < NODE_W && Math.abs(n.ui.y - y) < 72)) {
        y += 78;
    }
    return { x, y };
}

function removeSelectedNode() {
    if (!editorGraph || !editorSelection) return;
    const node = editorGraph.nodes.find(n => n.id === editorSelection);
    if (!node) return;

    if (node.type === "input" || node.type === "output") {
        toast("Every pipeline needs its Input and its Output.", "warning");
        return;
    }

    editorGraph.nodes = editorGraph.nodes.filter(n => n.id !== node.id);
    editorGraph.edges = editorGraph.edges.filter(e => e.from !== node.id && e.to !== node.id);
    editorSelection = null;
    markDirty();
    renderEditor();
}

function tidyLayout() {
    if (!editorGraph) return;
    for (const node of editorGraph.nodes) delete node.ui;
    pl.autoLayout(editorGraph);
    markDirty();
    renderCanvas();
}

async function duplicatePipeline() {
    if (!editorGraph) return;
    if (!(await confirmLeaveEditor())) return;

    const copy = JSON.parse(JSON.stringify(editorGraph));
    copy.id = `pl_${Date.now().toString(36)}`;
    copy.name = uniqueName(`${editorGraph.name} copy`);
    editorGraph = copy;
    editorSelection = null;
    editorDirty = false;
    renderPipelineList();
    renderEditor();
    markDirty();
}

async function saveCurrentPipeline() {
    if (!editorGraph) return;

    const name = $("pl-name").value.trim();
    editorGraph.name = name || "Untitled pipeline";

    // The renderer already validated to paint the messages panel; this is the
    // authoritative pass, through the same module main.js will use to run it.
    const result = await api.validatePipeline(editorGraph);
    if (!result.valid) {
        toast(result.errors[0], "warning");
        return;
    }

    pipelines = await api.savePipeline(editorGraph);
    editorDirty = false;
    renderPipelineList();
    renderEditor();
    toast(`Saved "${editorGraph.name}".`, "success");
}

async function deleteCurrentPipeline() {
    if (!editorGraph) return;

    const inUse = jobs.filter(j => j.pipelineId === editorGraph.id).length;
    const ok = await confirmDialog({
        title: "Delete this pipeline?",
        body: inUse > 0
            ? `"${editorGraph.name}" is assigned to ${display.countOf(inUse, "file")}. Those files will need another pipeline before they can convert.`
            : `"${editorGraph.name}" will be removed. This cannot be undone.`,
        confirmLabel: "Delete",
        variant: "danger",
        icon: "delete",
    });
    if (!ok) return;

    pipelines = await api.deletePipeline(editorGraph.id);
    editorGraph = null;
    editorSelection = null;
    editorDirty = false;
    renderPipelineList();
    renderEditor();
    toast("Pipeline deleted.", "info");
}

// -- Editor painting -----------------------------------------------------------

function renderPipelineList() {
    const list = $("pl-list");
    list.innerHTML = "";

    const entries = pipelines.map(x => ({ id: x.id, name: x.name, saved: true }));
    // A pipeline that has never been saved still belongs in the list, or it
    // looks as though New did nothing.
    if (editorGraph && !pipelines.some(x => x.id === editorGraph.id)) {
        entries.unshift({ id: editorGraph.id, name: editorGraph.name, saved: false });
    }

    for (const entry of entries) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pl-list-item";
        item.classList.toggle("active", editorGraph?.id === entry.id);

        const icon = document.createElement("span");
        icon.className = "material-icons-round";
        icon.style.fontSize = "15px";
        icon.textContent = "account_tree";

        const name = document.createElement("span");
        name.className = "pl-list-name";
        name.textContent = entry.saved ? entry.name : `${entry.name} (unsaved)`;

        item.append(icon, name);
        item.addEventListener("click", () => selectPipeline(entry.id));
        list.appendChild(item);
    }

    $("pl-library-empty").classList.toggle("d-none", entries.length > 0);
}

function renderEditor() {
    const has = !!editorGraph;

    $("pl-name").disabled = !has;
    $("pl-name").value = has ? editorGraph.name : "";
    $("pl-tidy").disabled = !has;
    $("pl-duplicate").disabled = !has;
    $("pl-delete").disabled = !has || !pipelines.some(x => x.id === editorGraph.id);
    $("pl-save").disabled = !has || !editorDirty;
    $("pl-dirty").classList.toggle("d-none", !editorDirty);
    $("pl-palette-section").classList.toggle("d-none", !has);

    renderCanvas();
    renderInspector();
    renderValidation();
}

function summariseNode(node) {
    if (node.type === "input") return "The file being converted";
    if (node.type === "output") return "The converted file";

    const spec = pl.NODE_TYPES[node.type];
    const parts = [];
    for (const param of spec.params ?? []) {
        const value = getByPath(node.params ?? {}, param.key);
        if (value === null || value === undefined || value === "") continue;
        parts.push(param.type === "enum"
            ? (param.options.find(o => o.value === value)?.label ?? String(value))
            : `${value}${param.unit ? ` ${param.unit}` : ""}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "Not set";
}

function nodeIsIncomplete(node) {
    const spec = pl.NODE_TYPES[node.type];
    return (spec?.required ?? []).some(key => getByPath(node.params ?? {}, key) == null);
}

function buildNode(node) {
    const spec = pl.NODE_TYPES[node.type];
    const box = document.createElement("div");
    box.className = "pl-node";
    box.dataset.id = node.id;
    box.style.left = `${node.ui.x}px`;
    box.style.top = `${node.ui.y}px`;
    box.classList.toggle("selected", editorSelection === node.id);
    box.classList.toggle("incomplete", nodeIsIncomplete(node));

    const title = document.createElement("div");
    title.className = "pl-node-title";
    title.textContent = spec.label;

    const summary = document.createElement("div");
    summary.className = "pl-node-summary";
    summary.textContent = summariseNode(node);

    box.append(title, summary);

    spec.inputs.forEach((port, i) => box.appendChild(buildPort(node, port, "in", i)));
    spec.outputs.forEach((port, i) => box.appendChild(buildPort(node, port, "out", i)));

    box.addEventListener("pointerdown", (e) => {
        if (e.target.classList.contains("pl-port")) return;
        startNodeDrag(e, node, box);
    });

    return box;
}

function buildPort(node, port, direction, index) {
    const dot = document.createElement("div");
    dot.className = `pl-port ${direction} ${port.type}`;
    dot.dataset.node = node.id;
    dot.dataset.port = port.name;
    dot.dataset.dir = direction;
    dot.dataset.type = port.type;
    dot.style.top = `${PORT_TOP + index * PORT_GAP - 5}px`;
    dot.title = `${port.name} (${port.type})`;

    if (direction === "out") {
        dot.addEventListener("pointerdown", (e) => startLink(e, node, port));
    } else {
        // Clicking a connected input is how a connection is undone; there is no
        // other affordance for an edge, which is not itself clickable.
        dot.addEventListener("click", (e) => {
            e.stopPropagation();
            const before = editorGraph.edges.length;
            editorGraph.edges = editorGraph.edges.filter(
                edge => !(edge.to === node.id && edge.toPort === port.name));
            if (editorGraph.edges.length !== before) {
                markDirty();
                renderCanvas();
                renderValidation();
            }
        });
    }
    return dot;
}

function portCentre(nodeId, portName, direction) {
    const node = editorGraph.nodes.find(n => n.id === nodeId);
    if (!node) return null;
    const spec = pl.NODE_TYPES[node.type];
    const list = direction === "out" ? spec.outputs : spec.inputs;
    const index = list.findIndex(p => p.name === portName);
    if (index < 0) return null;
    return {
        x: node.ui.x + (direction === "out" ? NODE_W : 0),
        y: node.ui.y + PORT_TOP + index * PORT_GAP,
    };
}

function edgePath(a, b) {
    const dx = Math.max(30, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function renderCanvas() {
    const nodesLayer = $("pl-nodes");
    const edgesLayer = $("pl-edges");
    nodesLayer.innerHTML = "";
    while (edgesLayer.firstChild) edgesLayer.removeChild(edgesLayer.firstChild);

    $("pl-canvas-empty").classList.toggle("d-none", !!editorGraph);
    if (!editorGraph) return;

    for (const node of editorGraph.nodes) nodesLayer.appendChild(buildNode(node));

    // Both layers are sized to the extent of the graph, so a node dragged past
    // the fold scrolls into view instead of being clipped. Filling the canvas
    // when the graph is smaller is left to min-width/min-height in CSS —
    // measuring the canvas here instead would be a feedback loop, since the
    // layer that fills it is what makes a scrollbar appear and shrinks it.
    const width = Math.max(...editorGraph.nodes.map(n => n.ui.x + NODE_W), 0) + 40;
    const height = Math.max(...editorGraph.nodes.map(n => n.ui.y), 0) + 140;
    nodesLayer.style.width = `${width}px`;
    nodesLayer.style.height = `${height}px`;
    edgesLayer.setAttribute("width", width);
    edgesLayer.setAttribute("height", height);

    drawEdges();
}

function drawEdges() {
    const edgesLayer = $("pl-edges");
    while (edgesLayer.firstChild) edgesLayer.removeChild(edgesLayer.firstChild);
    if (!editorGraph) return;

    for (const edge of editorGraph.edges) {
        const a = portCentre(edge.from, edge.fromPort, "out");
        const b = portCentre(edge.to, edge.toPort, "in");
        if (!a || !b) continue;

        const node = editorGraph.nodes.find(n => n.id === edge.from);
        const type = pl.NODE_TYPES[node?.type]?.outputs.find(p => p.name === edge.fromPort)?.type;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("class", `pl-edge ${type ?? ""}`);
        path.setAttribute("d", edgePath(a, b));
        edgesLayer.appendChild(path);
    }

    if (linking?.cursor) {
        const a = portCentre(linking.from, linking.fromPort, "out");
        if (a) {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("class", `pl-edge pl-edge-live ${linking.type}`);
            path.setAttribute("d", edgePath(a, linking.cursor));
            edgesLayer.appendChild(path);
        }
    }
}

// -- Editor interaction --------------------------------------------------------

/** Pointer capture and delta-from-origin, the same idiom as the trim slider. */
function startNodeDrag(e, node, box) {
    e.preventDefault();
    selectNode(node.id);
    box.setPointerCapture(e.pointerId);

    const originX = e.clientX;
    const originY = e.clientY;
    const startPos = { x: node.ui.x, y: node.ui.y };
    let moved = false;

    const onMove = (ev) => {
        const x = Math.max(0, startPos.x + (ev.clientX - originX));
        const y = Math.max(0, startPos.y + (ev.clientY - originY));
        if (x !== node.ui.x || y !== node.ui.y) moved = true;
        node.ui.x = x;
        node.ui.y = y;
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        drawEdges();
    };
    const onUp = (ev) => {
        box.releasePointerCapture(ev.pointerId);
        box.removeEventListener("pointermove", onMove);
        box.removeEventListener("pointerup", onUp);
        if (moved) {
            markDirty();
            renderCanvas();
        }
    };

    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
}

function startLink(e, node, port) {
    e.preventDefault();
    e.stopPropagation();

    linking = { from: node.id, fromPort: port.name, type: port.type, cursor: null };
    markLinkCandidates();

    const canvas = $("pl-canvas");
    const onMove = (ev) => {
        const rect = canvas.getBoundingClientRect();
        linking.cursor = {
            x: ev.clientX - rect.left + canvas.scrollLeft,
            y: ev.clientY - rect.top + canvas.scrollTop,
        };
        drawEdges();
    };
    const onUp = (ev) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);

        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        finishLink(target);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
}

/** Only the ports a connection could legally land on stay lit while dragging. */
function markLinkCandidates() {
    for (const dot of document.querySelectorAll(".pl-port.in")) {
        const check = pl.canConnect(editorGraph, {
            from: linking.from,
            fromPort: linking.fromPort,
            to: dot.dataset.node,
            toPort: dot.dataset.port,
        });
        dot.classList.toggle("candidate", check.ok);
        dot.classList.toggle("blocked", !check.ok);
    }
}

function clearLinkCandidates() {
    for (const dot of document.querySelectorAll(".pl-port")) {
        dot.classList.remove("candidate", "blocked");
    }
}

function finishLink(target) {
    const wanted = linking;
    linking = null;
    clearLinkCandidates();

    if (!target || !target.classList.contains("pl-port") || target.dataset.dir !== "in") {
        drawEdges();
        return;
    }

    const edge = {
        from: wanted.from,
        fromPort: wanted.fromPort,
        to: target.dataset.node,
        toPort: target.dataset.port,
    };

    const check = pl.canConnect(editorGraph, edge);
    if (!check.ok) {
        toast(check.reason, "warning");
        drawEdges();
        return;
    }

    editorGraph.edges.push(edge);
    markDirty();
    renderCanvas();
    renderValidation();
}

function selectNode(id) {
    if (editorSelection === id) return;
    editorSelection = id;
    for (const box of document.querySelectorAll(".pl-node")) {
        box.classList.toggle("selected", box.dataset.id === id);
    }
    renderInspector();
}

function handleEditorKey(e) {
    if (e.key === "Delete" && editorSelection) {
        e.preventDefault();
        removeSelectedNode();
    } else if (e.key === "Escape") {
        selectNode(null);
    }
}

// -- Inspector -----------------------------------------------------------------

function renderInspector() {
    const host = $("pl-settings");
    host.innerHTML = "";

    if (!editorGraph) {
        host.appendChild(hint("No pipeline open."));
        return;
    }
    const node = editorGraph.nodes.find(n => n.id === editorSelection);
    if (!node) {
        host.appendChild(hint("Select a step to change its settings."));
        return;
    }

    const spec = pl.NODE_TYPES[node.type];
    const heading = document.createElement("div");
    heading.className = "fw-semibold mb-2";
    heading.textContent = spec.label;
    host.appendChild(heading);

    if ((spec.params ?? []).length === 0) {
        host.appendChild(hint(summariseNode(node)));
    }

    for (const param of spec.params ?? []) {
        host.appendChild(buildParamField(node, param, spec));
    }

    if (node.type !== "input" && node.type !== "output") {
        const remove = document.createElement("button");
        remove.className = "btn btn-sm btn-outline-danger w-100 pl-remove-node";
        remove.textContent = "Remove this step";
        remove.addEventListener("click", removeSelectedNode);
        host.appendChild(remove);
    }
}

function hint(text) {
    const p = document.createElement("p");
    p.className = "pl-hint";
    p.textContent = text;
    return p;
}

function buildParamField(node, param, spec) {
    const wrap = document.createElement("div");
    wrap.className = "pl-field";

    const label = document.createElement("label");
    label.className = "form-label";
    label.textContent = param.unit ? `${param.label} (${param.unit})` : param.label;
    wrap.appendChild(label);

    const current = getByPath(node.params ?? {}, param.key);
    const required = (spec.required ?? []).includes(param.key);

    let control;
    if (param.type === "enum") {
        control = document.createElement("select");
        control.className = "form-select form-select-sm";
        fillSelect(control, param.options, current ?? param.default ?? "",
            param.default === undefined ? "Not set" : undefined);
    } else {
        control = document.createElement("input");
        control.type = "number";
        control.className = "form-control form-control-sm";
        control.value = current ?? "";
        if (param.min !== undefined) control.min = String(param.min);
        if (param.max !== undefined) control.max = String(param.max);
        control.step = String(param.step ?? (param.type === "seconds" ? 0.1 : 1));
    }

    label.htmlFor = control.id = `plp-${node.id}-${param.key.replace(/\./g, "-")}`;

    control.addEventListener("change", () => {
        const raw = control.value;
        const value = raw === "" ? null : (param.type === "enum" ? raw : Number(raw));
        if (value !== null && param.type !== "enum" && !Number.isFinite(value)) return;

        node.params = node.params ?? {};
        setByPath(node.params, param.key, value);
        markDirty();
        renderCanvas();
        renderValidation();
    });
    wrap.appendChild(control);

    const help = document.createElement("div");
    help.className = "form-text";
    help.textContent = param.help ?? (required && current == null ? "Required." : "");
    if (required && current == null) help.classList.add("text-warning");
    wrap.appendChild(help);

    return wrap;
}

// -- Validation and command preview --------------------------------------------

function renderValidation() {
    const box = $("pl-messages");
    const pre = $("pl-preview");
    box.innerHTML = "";
    pre.textContent = "";

    if (!editorGraph) return;

    const result = pl.validate(editorGraph);
    for (const error of result.errors) box.appendChild(message(error, "error"));
    for (const warning of result.warnings) box.appendChild(message(warning, "warning"));
    if (result.valid && result.warnings.length === 0) {
        box.appendChild(message("Ready to use.", "ok"));
    }
    if (!result.valid) return;

    try {
        const compiled = pl.compile(editorGraph);
        const parts = [];
        if (compiled.filterComplex) parts.push(`-filter_complex ${compiled.filterComplex}`);
        for (const map of compiled.maps) parts.push(`-map ${map}`);
        pre.textContent = parts.length > 0
            ? parts.join("\n")
            : "Nothing is filtered — both streams pass straight through.";
    } catch {
        // validate() already said why; the preview simply has nothing to show.
    }
}

function message(text, tone) {
    const line = document.createElement("div");
    line.className = `pl-message ${tone}`;
    line.textContent = text;
    return line;
}

function initEditor() {
    const palette = $("pl-palette");
    for (const entry of paletteTypes()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pl-palette-btn";
        button.textContent = entry.label;
        button.addEventListener("click", () => addNode(entry.type));
        palette.appendChild(button);
    }

    $("pl-new").addEventListener("click", newPipeline);
    $("pl-save").addEventListener("click", saveCurrentPipeline);
    $("pl-delete").addEventListener("click", deleteCurrentPipeline);
    $("pl-duplicate").addEventListener("click", duplicatePipeline);
    $("pl-tidy").addEventListener("click", tidyLayout);

    $("pl-name").addEventListener("input", () => {
        if (!editorGraph) return;
        editorGraph.name = $("pl-name").value;
        markDirty();
        renderPipelineList();
    });

    // Clicking the canvas background deselects, matching the card grid.
    $("pl-canvas").addEventListener("click", (e) => {
        if (e.target === $("pl-canvas") || e.target === $("pl-nodes")) selectNode(null);
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    FORMATS = await api.getFormats();
    TARGETS = FORMATS.targetsByExt;
    DESCRIPTORS = FORMATS.descriptors;
    pipelines = await api.listPipelines();

    // Navigation rail. Collapse is remembered, because a narrow window is
    // exactly where someone collapses it and exactly where it would be most
    // annoying to have to do so again every launch.
    const settings = await api.getSettings();
    setNavCollapsed(settings?.navCollapsed === true);

    for (const item of document.querySelectorAll(".nav-item")) {
        item.addEventListener("click", () => showView(item.dataset.view));
    }
    $("nav-collapse").addEventListener("click", async () => {
        const collapsed = !$("nav-rail").classList.contains("collapsed");
        setNavCollapsed(collapsed);
        await api.setSettings({ ...(await api.getSettings()), navCollapsed: collapsed });
    });

    initEditor();

    // Drag and drop. The document-level guard stops a stray drop navigating the
    // window to the file and replacing the app with it.
    const shell = document.querySelector(".app-shell");
    let dragDepth = 0;

    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth++;
        // The highlight belongs to the grid, so it stays off while the editor
        // is showing — the drop still works, it just switches view first.
        if (currentView !== "files") return;
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
    document.addEventListener("drop", async (e) => {
        dragDepth = 0;
        shell.classList.remove("drag-over");
        $("drop-zone").classList.remove("drag-over");

        // Read the paths before any await — dataTransfer does not survive one.
        const paths = api.getPathsForFiles(e.dataTransfer.files);

        // A drop is a request for the Files view, so it takes the same route a
        // rail click does: unsaved editor work is never lost silently, and a
        // declined guard cancels the drop rather than ingesting behind it.
        if (currentView !== "files") {
            await showView("files");
            if (currentView !== "files") return;
        }
        ingestPaths(paths);
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
        setTarget(bulkScope().map(j => j.id), e.target.value);
    });
    $("bulk-remove").addEventListener("click", () => removeJobs([...selection]));
    $("bulk-deselect").addEventListener("click", clearSelection);
    // Bulk edit lives in the selection bar and follows the same scope rule as
    // the format dropdown beside it: the selection, or everything when nothing
    // is selected.
    $("bulk-edit").addEventListener("click", () => {
        openJobModal(bulkScope().map(j => j.id));
    });

    $("jm-target").addEventListener("change", syncModalControls);

    // syncModalControls rebuilds these selects from dataset.wanted, which was
    // only ever written when the dialog opened. Picking a codec therefore
    // survived only until the next rebuild — which the pick itself triggers —
    // so the control snapped back to "Format default" and the codec was
    // dropped on Apply. Worse, the effective codec then fell back to the
    // container's own default (mpeg4 for AVI), which has no constant-quality
    // mode, so Quality looked permanently stuck on "Target bitrate".
    // Registered before the sync listener so the pick is recorded first.
    for (const id of ["jm-vcodec", "jm-acodec", "jm-encpreset"]) {
        $(id).addEventListener("change", (e) => { e.target.dataset.wanted = e.target.value; });
    }

    for (const id of ["jm-vmode", "jm-amode", "jm-vcodec", "jm-acodec", "jm-quality-mode", "jm-routing"]) {
        $(id).addEventListener("change", syncModalControls);
    }
    initModeTiles();
    initTrimSlider();
    for (const id of ["jm-crf", "jm-vbitrate", "jm-width", "jm-height", "jm-fit", "jm-fps",
                      "jm-abitrate", "jm-arate", "jm-achannels", "jm-encpreset",
                      "jm-name", "jm-conflict"]) {
        $(id).addEventListener("input", schedulePreview);
        $(id).addEventListener("change", schedulePreview);
    }
    $("jm-iquality").addEventListener("input", (e) => {
        $("jm-iquality-value").textContent = e.target.value;
        schedulePreview();
    });
    $("jm-outdir-browse").addEventListener("click", async () => {
        const dir = await api.chooseOutput();
        if (dir) { $("jm-outdir").value = dir; schedulePreview(); }
    });
    $("jm-apply").addEventListener("click", applyJobModal);

    $("bulk-select-all").addEventListener("change", (e) => {
        if (e.target.checked) selectAll();
        else clearSelection();
    });

    // Clicking the grid background clears the selection.
    $("grid-scroll").addEventListener("click", (e) => {
        if (e.target === $("grid-scroll") || e.target === $("job-grid")) clearSelection();
    });

    document.addEventListener("keydown", (e) => {
        // Only a control the user can actually type into should swallow these.
        // This used to include SELECT, and a <select> keeps focus after you
        // pick an option — so choosing a format on any card silently ate the
        // next Escape, Delete or Ctrl+A anywhere in the app until you happened
        // to click something non-focusable. A checkbox is an INPUT too, which
        // is why the type is tested rather than just the tag.
        const el = document.activeElement;
        const tag = el?.tagName ?? "";
        const typing = tag === "TEXTAREA"
            || (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|file)$/.test(el.type));
        if (typing) return;

        // The settings dialog owns the keyboard while it is open, or Delete
        // would remove the very cards being edited behind it.
        if (document.querySelector(".modal.show")) return;

        // Same reasoning one level up: the editor owns these keys while it is
        // showing, or Delete would remove cards on a view you cannot even see.
        if (currentView !== "files") {
            handleEditorKey(e);
            return;
        }

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

// The page already follows the OS theme through its own prefers-color-scheme
// listener in index.html. This is the second route: main pushes the change
// from nativeTheme, so a live switch does not depend on the media query
// notification arriving. Whichever lands first wins; the other is a no-op.
api.onThemeChanged((theme) => {
    document.documentElement.setAttribute("data-bs-theme", theme);
});
