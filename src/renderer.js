// Renderer — job card grid.
//
// Runs with contextIsolation on and no Node access. Everything reaches the main
// process through window.electronAPI, exposed by preload.js, except the
// settings, which go through the kit's window.kitAPI. The frame, the nav rail,
// the Settings view and the theme are the kit's (kit.ui.mountShell() below).
//
// The v1 UI was a single-column list with one shared target format per media
// kind and a strictly sequential convert loop. This is a grid of independently
// configurable job cards that run through the runner's concurrency pool.

const api = window.electronAPI;
const kitApi = window.kitAPI;
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

/**
 * @returns {{added: number, rejected: object[], duplicates: number}} — the same
 * { path, reason } shape the scanner uses, so a caller can merge the two lists
 * and report them as the one thing a user sees.
 */
/**
 * Two spellings of one Windows path are the same file: the separators can go
 * either way and the case is not significant. The scanner has always keyed its
 * own dedupe that way; this compared the raw strings, so a file already queued
 * from a folder walk could be queued a second time by being added directly.
 */
const samePath = (a, b) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

function addFiles(filePaths, mirrorRoot = null) {
    let added = 0;
    let duplicates = 0;
    const rejected = [];

    for (const filePath of filePaths) {
        const raw = p.extname(filePath).slice(1).toLowerCase();
        const ext = FORMATS.aliases[raw] ?? raw;
        const entry = FORMATS.conversionMap[ext];

        if (!entry) { rejected.push({ path: filePath, reason: "unsupported" }); continue; }
        if (jobs.some(j => samePath(j.filePath, filePath))) { duplicates++; continue; }

        jobs.push({
            id: generateId(),
            filePath,
            ext,
            kind: entry.type,
            // Which folder this card was ingested from, for mirrored output.
            // It belongs to the card rather than to settings, because settings
            // are written across a whole modal selection in one go while the
            // root is a property of the ingest that produced each card.
            mirrorRoot,
            targetExt: null,
            settings: {},
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

    // Reporting belongs to whoever called this. There used to be a toast here
    // as well as one in ingestPaths, so a folder holding one unreadable file
    // could produce two different sentences about the same thing.
    return { added, rejected, duplicates };
}

const SKIP_REASONS = {
    "unsupported":  "not a supported format",
    "not-included": "turned off in folder options",
    "excluded":     "turned off in folder options",
};

/** The list behind "Show them", built only if the button is actually pressed. */
function buildSkippedDetail(skipped) {
    const list = document.createElement("ul");
    list.className = "toast-detail";

    for (const item of skipped.slice(0, 50)) {
        const row = document.createElement("li");
        const name = document.createElement("span");
        name.className = "toast-detail-name";
        name.textContent = p.basename(item.path);
        row.append(name, document.createTextNode(` — ${SKIP_REASONS[item.reason] ?? item.reason}`));
        list.appendChild(row);
    }
    if (skipped.length > 50) {
        const more = document.createElement("li");
        more.className = "toast-detail-more";
        more.textContent = `and ${display.countOf(skipped.length - 50, "more file")}`;
        list.appendChild(more);
    }
    return list;
}

/**
 * The output settings for one card, with its mirror root attached.
 *
 * MIRROR routing has been in the dropdown since alpha.2 and has never once
 * worked: paths.js needs output.mirrorRoot to rebuild the tree, nothing ever
 * set it, and validateJob rejects the job without it — so choosing it left
 * Apply disabled and an error where the command preview should be. The root is
 * known at ingest; this is the only thing that was missing.
 */
function withMirrorRoot(job, output) {
    return { ...(output ?? job.settings?.output ?? {}), mirrorRoot: job.mirrorRoot ?? null };
}

const ALL_KINDS = ["audio", "video", "image"];

/** What the folder-options popover currently says. Seeded on startup. */
let scanPrefs = { recursive: true, kinds: [...ALL_KINDS], followSymlinks: false };

/**
 * The popover's three checkboxes translated into what the scanner takes.
 *
 * These apply to every ingest route, not only the Add Folder button. A plain
 * drop can contain folders too, and having the settings cover one folder route
 * but not the other would be baffling. It does mean a dropped .jpg is skipped
 * while Images is unticked — which is only acceptable because the toast now
 * names that as the reason rather than dropping it in silence.
 */
function buildScanOptions() {
    const kinds = scanPrefs.kinds ?? ALL_KINDS;
    const everything = ALL_KINDS.every(k => kinds.includes(k));
    return {
        recursive: scanPrefs.recursive !== false,
        followSymlinks: scanPrefs.followSymlinks === true,
        // No filter at all is cheaper than a filter that admits everything, and
        // it keeps "not-included" out of the skip reasons when nothing is off.
        include: everything ? null : Object.entries(DESCRIPTORS)
            .filter(([, d]) => kinds.includes(d.kind))
            .map(([ext]) => ext),
    };
}

/** Expand folders in the main process, then queue whatever came back. */
async function ingestPaths(inputPaths) {
    if (!inputPaths || inputPaths.length === 0) return;
    try {
        const result = await api.scanPaths(inputPaths, buildScanOptions());
        const { added, rejected, duplicates } = addFiles(result.files, result.root ?? null);

        // The scanner's rejections and the format map's are one thing as far as
        // anyone reading this is concerned, so they are reported as one thing.
        const skipped = [...(result.skipped ?? []), ...rejected];
        reportIngest({ added, skipped, duplicates, truncated: result.truncated, found: result.files.length });

        for (const err of result.errors ?? []) {
            toast(`Could not read ${p.basename(err.path)}: ${err.error}`, "danger");
        }
    } catch (_) {
        // The scan itself failed, so folders cannot be expanded. Queue whatever
        // was handed over as plain files and report on that alone.
        const fallback = addFiles(inputPaths);
        reportIngest({
            added: fallback.added,
            skipped: fallback.rejected,
            duplicates: fallback.duplicates,
            truncated: false,
            found: inputPaths.length,
        });
    }
}

/**
 * One sentence for one ingest, assembled from clauses rather than chosen from a
 * chain of branches. The chain used to lose the skipped count whenever a scan
 * also truncated, and said nothing at all when everything found was already in
 * the list — which reads exactly like a drop that did not register.
 */
function reportIngest({ added, skipped, duplicates, truncated, found }) {
    const clauses = [];
    if (added > 0) clauses.push(`Added ${display.countOf(added, "file")}`);
    if (skipped.length > 0) clauses.push(`skipped ${skipped.length}`);
    if (duplicates > 0) clauses.push(`${duplicates} already in the list`);
    if (truncated) clauses.push(`stopped at ${display.countOf(found, "file")} — the folder is very large`);

    if (clauses.length === 0) return;

    let type = "info";
    if (added === 0) type = skipped.length > 0 || truncated ? "warning" : "info";
    else if (truncated) type = "warning";

    let message;
    if (added === 0 && skipped.length === 0 && duplicates > 0) {
        message = duplicates === 1
            ? "That file is already in the list."
            : "Those files are already in the list.";
    } else if (added === 0 && skipped.length > 0 && duplicates === 0) {
        message = "No supported media found there.";
    } else {
        message = `${clauses.join(", ")}.`;
    }

    toast(message, type, 4500, skipped.length > 0
        ? { actionLabel: "Show them", onAction: () => buildSkippedDetail(skipped) }
        : {});
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

// Enough images that writing them without asking would be a nasty surprise.
const FRAME_CONFIRM_THRESHOLD = 1000;

/** "about 18,000 images", for a card whose conversion writes a pile of them. */
function describeJobOutput(job) {
    if (!job.targetExt) return null;
    const mode = display.effectiveMode(job, TARGETS, DESCRIPTORS);
    return display.describeOutput(mode, job.settings?.trim ?? null, job.meta);
}

/** How many images a job will write, or 0 when it writes none. */
function frameCountOf(job) {
    if (!job.targetExt) return 0;
    const mode = display.effectiveMode(job, TARGETS, DESCRIPTORS);
    return display.estimateFrames(mode, job.settings?.trim ?? null, job.meta) ?? 0;
}

/** The kind of output a format produces, or null when there is none chosen. */
function kindOfTarget(ext) {
    return ext && DESCRIPTORS && DESCRIPTORS[ext] ? DESCRIPTORS[ext].kind : null;
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

        // Codecs, quality and stream modes were chosen for the old target and
        // mean nothing against a different kind of output. Carrying them across
        // is what makes retargeting a configured MP4 card to PNG fail with
        // "PNG does not support the video codec libx264" — a setting the user
        // never asked to apply to a picture.
        if (kindOfTarget(job.targetExt) !== kindOfTarget(next)) job.settings = {};

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

    const outputLine = document.createElement("button");
    outputLine.type = "button";
    outputLine.className = "card-output d-none";
    // Clickable, because the answer to "that is far too many images" is the
    // span control, and this is the only thing pointing at it.
    outputLine.addEventListener("click", (e) => {
        e.stopPropagation();
        openJobModal([job.id]);
    });

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

    card.append(head, meta, outputLine, settingsLine, convert, status, progress, actions);
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
    const output = describeJobOutput(job);
    const outputLine = card.querySelector(".card-output");
    outputLine.classList.toggle("d-none", !output);
    if (output) outputLine.textContent = output;

    const summary = display.summariseSettings(job.settings);
    settingsLine.classList.toggle("d-none", !summary);
    if (summary) {
        settingsLine.textContent = summary;
        settingsLine.title = summary;
    }

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

    // With nothing selected the bar exists to say "all N files" and offer one
    // format — that is the two-click flow and it must stay. The actions that
    // operate on a selection only appear once there is one.
    $("bulk-remove").classList.toggle("d-none", everything);
    $("bulk-deselect").classList.toggle("d-none", everything);
    $("bulk-edit").classList.toggle("d-none", everything);

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
    // Enabled only while there is something left to run. `ready` counts cards
    // that *could* run, including ones already converted, and is what the
    // "still need a format" copy is derived from — so the button needs its own
    // count, or it sits enabled doing nothing once a batch has finished.
    $("btn-convert").disabled = jobs.filter(
        j => j.targetExt && j.status !== "done"
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
let modalChosenMode = null; // frames vs a single frame, when that is a choice
let modalFramesMode = false; // whether this conversion picks frames at all
let previewTimer = null;

const ENCODER_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast",
    "medium", "slow", "slower", "veryslow"];

// -- Trim slider -------------------------------------------------------------
//
// A two-point slider, because the useful thing about a trim is where the kept
// span sits relative to the whole clip, which a pair of numbers does not show.
// A box over each end takes an exact time for anything a drag cannot reach.
//
// Both handles move in whole seconds. Held Shift steps one frame at a time for
// anything that moves and a tenth of a second for anything that does not —
// while dragging and on the arrow keys alike — so a command only ever carries a
// fraction when someone deliberately asked for one.

const trimState = { duration: 0, start: 0, end: 0, pendingEnd: null, available: false };

// What is wrong with each typed box, if anything. Held apart from trimState:
// a bad entry is never applied, so the slider keeps describing the last good
// span while the box says why the new one was refused.
const trimEntryErrors = { start: null, end: null };

const TRIM_FINE_PX = 4;       // pixels of Shift-drag per fine step

const FRAME_PREVIEW_DEBOUNCE = 220;   // ms after the slider settles

let framePreviewTimer = null;
let framePreviewToken = 0;

/**
 * Where to actually decode a preview from. Seeking to exactly the duration
 * lands past the last frame and decodes nothing, which is precisely where the
 * end handle sits until someone drags it.
 */
function previewAt(seconds) {
    const limit = Math.max(0, trimState.duration - 0.05);
    return Math.max(0, Math.min(seconds, limit));
}

/**
 * Does the span being chosen have pictures to show? Audio has none, and nor
 * does a song whose only "video" is its cover art.
 */
function trimHasPictures() {
    const meta = modalSample()?.meta;
    return !!(meta && meta.ok && meta.hasVideo && !meta.isStill);
}

/** How long one frame of the sample lasts, for stepping back off the end. */
function sampleFrameLength() {
    const fps = modalSample()?.meta?.video?.fps;
    return fps > 0 ? 1 / fps : 0.04;
}

/**
 * Show the frames at either end of the span.
 *
 * Debounced and token-guarded: dragging a handle asks for a great many frames
 * in quick succession, and a slow decode that lands after the user has moved on
 * must not paint a frame they are no longer looking at.
 */
function requestFramePreviews() {
    const sample = modalSample();
    const visible = !$("jm-frame-previews").classList.contains("d-none");
    if (!visible || !sample || !trimState.available) return;

    // The end of a span is where it stops, so the frame sitting exactly there
    // is the first one left out. The last one kept is a frame earlier, and that
    // is the one worth seeing when deciding where a clip ends.
    const lastKept = Math.max(trimState.start, trimState.end - sampleFrameLength());
    const wanted = isSingleFrame()
        ? [["jm-frame-start", trimState.start]]
        : [["jm-frame-start", trimState.start], ["jm-frame-end", lastKept]];

    clearTimeout(framePreviewTimer);
    framePreviewTimer = setTimeout(async () => {
        const token = ++framePreviewToken;
        for (const [id, seconds] of wanted) {
            let data = null;
            try {
                data = await api.previewFrame({ inputPath: sample.filePath, timestamp: previewAt(seconds) });
            } catch (_) {
                // A source that will not decode simply shows no preview.
            }
            if (token !== framePreviewToken) return;
            if (data) $(id).src = data;
            else $(id).removeAttribute("src");
        }
    }, FRAME_PREVIEW_DEBOUNCE);
}

/**
 * Is the dialog choosing frames out of a moving source, rather than trimming?
 *
 * Held as state rather than read back off a CSS class: the slider paints before
 * the frames choice does, so on the first open the class still described the
 * previous conversion and the readout said "keeping" until something moved.
 */
function framesMode() {
    return modalFramesMode;
}

/**
 * Is the dialog currently set to pull out one frame rather than a span?
 *
 * Gated on there being frames to choose at all. The choice is deliberately kept
 * when the target changes, so switching away and back remembers it — but a
 * video target is a trim, and reading the stale choice there blanked the
 * readout and silently dropped the trim's end.
 */
function isSingleFrame() {
    return framesMode() && modalChosenMode === "thumbnail";
}

/**
 * Paint the "how many frames" choice and adapt the span control to it.
 *
 * There is no mode dropdown anywhere: a range means every frame in it, a single
 * point means one frame, and that is the whole of the mode decision the user
 * ever has to make. Everything else has only one sensible answer.
 */
function renderFramesChoice(sections) {
    const on = !!sections.frames;
    const single = on && isSingleFrame();

    $("jm-trim-title").textContent = on ? "Frames" : "Trim";
    $("jm-frames-choice").classList.toggle("d-none", !on);
    $("jm-frames-estimate").classList.toggle("d-none", !on);
    // A trim of anything that moves gets the same two frames as a frame range:
    // where a clip starts and ends is far easier to judge by picture than by
    // clock. Audio keeps the slider alone.
    $("jm-frame-previews").classList.toggle("d-none", !(on || trimHasPictures()) || !trimState.available);

    for (const button of document.querySelectorAll("#jm-frames-choice [data-frame-mode]")) {
        const active = button.dataset.frameMode === (modalChosenMode ?? "frames");
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", String(active));
    }

    // One handle for one frame: the second would have nothing to mean. Nor may
    // it linger where it was left, or the one handle there is could not be
    // dragged past a point that is no longer on screen.
    if (single && trimState.available) trimState.end = trimState.duration;
    $("jm-trim-thumb-end").classList.toggle("d-none", single);
    $("jm-trim-slider").classList.toggle("single", single);
    $("jm-trim-end-field").classList.toggle("d-none", single);
    $("jm-frame-end-wrap").classList.toggle("d-none", single);
    $("jm-trim-range").classList.toggle("d-none", single);
    $("jm-trim-start-name").textContent = single ? "Frame at" : "Start";
    $("jm-frame-start-cap").textContent = single ? "This frame" : "First frame";
    $("jm-trim-help").textContent = single
        ? "Drag to choose the frame, or type an exact time. Hold Shift to move one frame at a time."
        : trimHasPictures()
            ? "Drag either end, or type an exact time. It moves in whole seconds; hold Shift to move one frame at a time."
            : "Drag either end, or type an exact time. It moves in whole seconds; hold Shift to move a tenth of a second at a time.";

    renderFramesEstimate();
    requestFramePreviews();
}

/** How many images this is about to write, live as the span changes. */
function renderFramesEstimate() {
    const sample = modalSample();
    const mode = modalMode($("jm-target").value || null);
    $("jm-frames-estimate").textContent =
        display.describeOutput(mode, readTrim(), sample?.meta) ?? "";
}

function setFrameMode(next) {
    if (modalChosenMode === next) return;
    modalChosenMode = next;
    syncModalControls();
}

function initFramesChoice() {
    for (const button of document.querySelectorAll("#jm-frames-choice [data-frame-mode]")) {
        button.addEventListener("click", () => setFrameMode(button.dataset.frameMode));
    }
}

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

    // A refusal belongs to the box it was typed in, not to the next file.
    setTrimEntryError("start", null);
    setTrimEntryError("end", null);
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

    // The boxes follow the handles. Whatever was typed and refused is replaced
    // by the span actually in force, which is also what the slider shows.
    $("jm-trim-start-input").value = display.formatTimecode(start) ?? "0:00";
    $("jm-trim-end-input").value = display.formatTimecode(end) ?? "";
    setTrimEntryError("start", null);
    setTrimEntryError("end", null);
    // The same span means different things: a trim keeps a stretch of the
    // result, a frame range covers a stretch of the source.
    const span = display.formatTimecode(end - start) ?? "0:00";
    $("jm-trim-kept").textContent = isSingleFrame() ? "" : `${framesMode() ? "covering" : "keeping"} ${span}`;

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
    // Handles already sit on a step, so this only trims float noise. To the
    // millisecond, not the hundredth: a frame at 29.97fps is 33.4ms long.
    const round = (v) => Math.round(v * 1000) / 1000;
    return {
        start: start > 0 ? round(start) : null,
        // One frame is a position, not a span, so it carries no end. Leaving one
        // on would put a pointless -t beside the -frames:v 1 that already says
        // how much is wanted.
        end: isSingleFrame() || end >= duration ? null : round(end),
    };
}

function setTrimEntryError(which, message) {
    trimEntryErrors[which] = message;
    $(`jm-trim-${which}-input`).classList.toggle("is-invalid", !!message);
    const shown = [trimEntryErrors.start, trimEntryErrors.end].filter(Boolean);
    $("jm-trim-error").textContent = shown.join(" ");
    $("jm-trim-error").classList.toggle("d-none", shown.length === 0);
}

/** Is a typed trim point being refused? Apply waits until it is fixed. */
function trimHasErrors() {
    return !$("jm-trim-section").classList.contains("d-none")
        && !!(trimEntryErrors.start || trimEntryErrors.end);
}

/**
 * Take a typed time. It lands exactly as typed, not on the slider's grid —
 * being able to say 1:23.04 and mean it is the whole reason the box exists.
 */
function commitTrimEntry(which) {
    if (!trimState.available) return;
    const result = display.checkTrimEntry(which, $(`jm-trim-${which}-input`).value, trimState);
    if (result.error) {
        setTrimEntryError(which, result.error);
        schedulePreview();
        return;
    }
    trimState[which] = result.value;
    renderTrim();
    renderFramesEstimate();
    requestFramePreviews();
    schedulePreview();
}

/** One step of the trim control for the file on show, coarse or fine. */
function currentTrimStep(fine) {
    return display.trimStep(modalSample()?.meta, fine);
}

function moveTrimHandle(handle, seconds, fine = false) {
    const step = currentTrimStep(fine);
    trimState[handle] = display.placeTrimHandle(handle, seconds, { ...trimState, step });
    renderTrim();
    renderFramesEstimate();
    requestFramePreviews();
    schedulePreview();
}

function initTrimSlider() {
    const slider = $("jm-trim-slider");

    for (const which of ["start", "end"]) {
        const input = $(`jm-trim-${which}-input`);
        // Checked when the box is left or Enter is pressed, not on every
        // keystroke — "1:" on the way to "1:23" is not a mistake yet.
        input.addEventListener("change", () => commitTrimEntry(which));
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); commitTrimEntry(which); }
        });
    }

    for (const handle of ["start", "end"]) {
        const thumb = $(`jm-trim-thumb-${handle}`);

        thumb.addEventListener("pointerdown", (e) => {
            if (!trimState.available) return;
            e.preventDefault();
            thumb.setPointerCapture(e.pointerId);
            // Tracked unsnapped and moved by each pointer event's own
            // distance, not the distance from where the drag began. Shift can
            // go down or up mid-drag, and measuring from the origin at the new
            // rate would throw the handle to somewhere else entirely.
            let lastX = e.clientX;
            let raw = trimState[handle];

            const onMove = (ev) => {
                const width = slider.getBoundingClientRect().width || 1;
                const perPixel = trimState.duration / width;
                // Shift slows the drag to a few pixels per frame, however long
                // the clip, so single frames can actually be reached by hand.
                const rate = ev.shiftKey
                    ? Math.min(perPixel, currentTrimStep(true) / TRIM_FINE_PX)
                    : perPixel;
                slider.classList.toggle("fine", ev.shiftKey);
                raw = Math.max(0, Math.min(trimState.duration, raw + (ev.clientX - lastX) * rate));
                lastX = ev.clientX;
                moveTrimHandle(handle, raw, ev.shiftKey);
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
            const fine = e.shiftKey;
            const step = currentTrimStep(fine);
            const current = trimState[handle];
            if (e.key === "ArrowLeft") { e.preventDefault(); moveTrimHandle(handle, current - step, fine); }
            else if (e.key === "ArrowRight") { e.preventDefault(); moveTrimHandle(handle, current + step, fine); }
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
    const chosen = [...new Set(scoped.map(j => j.settings?.mode ?? null))];
    modalChosenMode = chosen.length === 1 ? chosen[0] : null;

    const encoded = scoped.map(j => JSON.stringify(j.settings ?? {}));
    const uniform = encoded.every(x => x === encoded[0]);
    loadSettingsIntoForm(uniform ? (scoped[0].settings ?? {}) : {});

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

/**
 * The card the dialog describes when it has to speak about one file. Sections
 * and modes depend on where a conversion is coming from, not only where it is
 * going, and across a mixed selection the first is as good an answer as exists.
 */
function modalSample() {
    return jobs.find(j => modalScope.includes(j.id)) ?? null;
}

/** The mode the dialog is currently configuring, for a candidate target. */
function modalMode(target) {
    const sample = modalSample();
    if (!sample || !target) return null;
    return display.effectiveMode(
        { ...sample, targetExt: target, settings: { mode: modalChosenMode } }, TARGETS, DESCRIPTORS);
}

/** Rebuild every capability-dependent control for the chosen target. */
function syncModalControls() {
    const target = $("jm-target").value || null;
    const sample = modalSample();
    const mode = modalMode(target);
    const sections = display.applicableSections(sample?.ext, target, DESCRIPTORS, mode);
    // Set before anything paints: renderTrim reads it, and runs first.
    modalFramesMode = !!sections.frames;

    // Which sections apply depends on the pair and the mode, not the target
    // alone — frames out of a video are a span, not a trim.
    $("jm-video-section").classList.toggle("d-none", !sections.video);
    $("jm-audio-section").classList.toggle("d-none", !sections.audio);
    $("jm-image-section").classList.toggle("d-none", !sections.image);
    $("jm-trim-section").classList.toggle("d-none", !sections.trim && !sections.frames);

    // Stream modes: copy is only offered where the container supports remuxing
    // and, when extracting, where the source stream already fits it.
    const canCopy = display.canStreamCopy(target, DESCRIPTORS, mode, sample?.meta);
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
    // Codec, bitrate, preset and the stream mode itself mean nothing when the
    // output is a picture — an export to PNG was offering an encoder preset and
    // a target bitrate above the controls that actually decide anything.
    for (const el of document.querySelectorAll(".jm-vcodec-only")) {
        el.classList.toggle("d-none", !sections.videoEncode || (!vEncoding && el.classList.contains("jm-vencode")));
    }
    $("jm-video-title").textContent = sections.videoEncode ? "Video" : "Picture";
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

    // Frames and trim are the same span control, and a frames conversion sets
    // sections.trim false — without this the slider is never wired up at all.
    // The frames choice is painted after it, not before: the previews and the
    // count describe the span, so they need one to exist first.
    if (sections.trim || sections.frames) setupTrim();
    renderFramesChoice(sections);

    // The output folder only matters when a folder was chosen.
    const needsDir = $("jm-routing").value !== "alongside";
    $("jm-outdir").parentElement.parentElement.classList.toggle("d-none", !needsDir);

    // There is nothing to mirror where the cards did not come from a folder, or
    // came from folders on different drives. Offering it and then failing
    // validation is how it behaved for three releases; better not to offer it.
    const mirror = $("jm-routing").querySelector('option[value="mirror"]');
    const canMirror = modalScope.length > 0
        && jobs.filter(j => modalScope.includes(j.id)).every(j => j.mirrorRoot);
    mirror.disabled = !canMirror;
    mirror.textContent = canMirror
        ? "Mirror the source folders"
        : "Mirror the source folders (add a folder to use this)";
    if (!canMirror && $("jm-routing").value === "mirror") $("jm-routing").value = "alongside";

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
    const sections = display.applicableSections(modalSample()?.ext, target, DESCRIPTORS, modalMode(target));
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
        trim: sections.trim || sections.frames ? readTrim() : null,
        // Only ever set where there is genuinely a choice; everywhere else the
        // pair has exactly one sensible mode and the job model picks it.
        mode: sections.frames ? (modalChosenMode ?? "frames") : null,
    };

    // Defaults that were never touched are dropped, so the format keeps
    // control of anything the user did not explicitly choose.
    //
    // onConflict is deliberately NOT dropped, unlike routing. Dropping a value
    // only works where something downstream will reinstate the same one, and
    // main layers the app-wide setting underneath whatever arrives here. Both
    // are "ask" today so the two behave alike, but the moment a global conflict
    // preference exists, stripping "ask" would mean a card explicitly set back
    // to Ask me silently inherits a global Overwrite instead.
    if (settings.output.routing === "alongside") settings.output.routing = null;
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
            $("jm-preview-note").textContent = "";
            $("jm-errors").textContent = "";
            return;
        }
        // The preview needs the mirror root as much as the run does. Without it
        // choosing "Mirror the source folders" fails validation, the preview
        // comes back not-ok, and Apply stays disabled with no way forward.
        const settings = readSettingsFromForm();
        const result = await api.previewJob(
            { inputPath: sample.filePath, targetExt: target, ...settings,
              output: withMirrorRoot(sample, settings.output) });
        $("jm-preview").textContent = `ffmpeg ${result.args.join(" ")}`;

        // One command can only describe one file, and a bulk edit is usually
        // several. Saying whose it is beats silently showing the first card's
        // and letting it be read as the whole batch — every other file differs
        // only in the paths, which are exactly the part that is not shared.
        const others = modalScope.length - 1;
        $("jm-preview-note").textContent =
            others <= 0 ? ""
            : others === 1 ? `Showing ${p.basename(sample.filePath)}. One other file uses these settings with its own paths.`
            : `Showing ${p.basename(sample.filePath)}. ${others} other files use these settings with their own paths.`;

        $("jm-errors").textContent = result.ok ? "" : result.errors.join(" ");
        $("jm-apply").disabled = !result.ok || trimHasErrors();
    }, 180);
}

function applyJobModal() {
    const target = $("jm-target").value || null;
    const settings = readSettingsFromForm();

    // The format is set FIRST, and the order is load-bearing. setTarget clears
    // job.settings whenever the output kind changes, and a card that has no
    // format yet counts as a change from every kind — so applying settings
    // before it threw away everything the user had just chosen, on every first
    // Apply. It read as intermittent because a card already sitting on the
    // chosen format takes setTarget's early return and kept its settings.
    if (target) setTarget(modalScope, target);

    for (const job of jobs) {
        if (!modalScope.includes(job.id)) continue;
        if (job.status === "running") continue;

        // Each card gets its own copy. One shared object across a bulk edit
        // works only for as long as nothing ever edits a single card's settings
        // in place, which is not a property worth relying on.
        job.settings = structuredClone(settings);
        updateCard(job);
    }

    jobModal.hide();
    const n = modalScope.length;
    toast(`Settings applied to ${display.countOf(n, "file")}.`, "success");
}

// -- Toasts ------------------------------------------------------------------

const TOAST_ICONS = { info: "info", success: "check_circle", warning: "warning", danger: "error" };

/**
 * @param {object} [options]
 * @param {string}   [options.actionLabel] adds a button beside the message
 * @param {() => (Node|null)} [options.onAction] builds what the button reveals,
 *        appended inside this same toast. A toast carrying an action does not
 *        time out by default — an action nobody can reach is not an action.
 *
 * Everything here is set with textContent. A toast reports filenames and
 * ffmpeg's own words, neither of which this app gets to trust as markup.
 */
function toast(message, type = "info", timeoutMs = 4500, options = {}) {
    const host = $("toast-host");
    const { actionLabel = null, onAction = null } = options;
    if (actionLabel && timeoutMs === 4500) timeoutMs = 0;

    const note = document.createElement("div");
    note.className = `toast-note toast-${type}`;

    const icon = document.createElement("span");
    icon.className = "material-icons-round";
    icon.textContent = TOAST_ICONS[type] ?? "info";

    const body = document.createElement("span");
    body.className = "toast-body";
    body.textContent = message;

    if (actionLabel && onAction) {
        const action = document.createElement("button");
        action.className = "toast-action";
        action.type = "button";
        action.textContent = actionLabel;

        // Both the button and whatever it reveals live inside the body. The
        // toast itself is a flex row of icon | body | dismiss, so anything
        // appended to it directly becomes a fourth column instead.
        let detail = null;
        action.addEventListener("click", () => {
            if (detail) {
                detail.remove();
                detail = null;
                action.textContent = actionLabel;
                return;
            }
            detail = onAction();
            if (!detail) return;
            body.appendChild(detail);
            action.textContent = "Hide";
        });
        body.append(" ", action);
    }

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

    // Frame extraction can write thousands of files from one click, and the
    // only hint beforehand is a line on the card. Ask once, with the number.
    const frames = runnable.reduce((total, job) => total + frameCountOf(job), 0);
    if (frames >= FRAME_CONFIRM_THRESHOLD) {
        const ok = await confirmDialog({
            title: "That is a lot of images",
            body: `This writes about ${display.countOf(frames, "image")}. Narrow the range in `
                + `Advanced options if that is more than you meant.`,
            confirmLabel: "Write them",
            variant: "warning",
            icon: "burst_mode",
        });
        if (!ok) return;
    }

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
        const result = await api.runJob(
            { id: job.id, inputPath: job.filePath, targetExt: job.targetExt, ...(job.settings ?? {}),
              output: withMirrorRoot(job) });
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

// -- Views ---------------------------------------------------------------------
//
// Convert and Join. Everything the file grid owns keeps its own d-none state
// while hidden, so arriving back restores the grid exactly as it was rather
// than rebuilding it.

let currentView = "convert";

/** The kit's shell, once mounted: showView() is the single route between views. */
let shell = null;

/** What arriving at a view does: the kit shows it, and this brings it up to date. */
function onViewChange(name) {
    currentView = name;
    // The first view is shown as the shell is mounted, before the formats have arrived.
    if (!FORMATS) return;
    if (name === "convert") render();
    else if (name === "join") renderJoin();
}

// -- Join --------------------------------------------------------------------
//
// An ordered list of clips that becomes one file. The order is the entire
// model, which is why this is a list and not a canvas.

let joinClips = [];          // { id, filePath, meta, trim: { start, end } }
let joinRunning = null;      // the id of the job in flight

/**
 * "1:23" or "83" both mean 83 seconds. Blank means "no limit at this end", and
 * so, as it always has here, does anything that is not a time.
 */
function parseTime(text) {
    const value = display.parseTimecode(text);
    return Number.isNaN(value) ? null : value;
}

/**
 * Join's counterpart to ingestPaths: expand folders in the main process, then
 * list whatever came back. The header's Add Folder and a dropped directory both
 * land here, and both follow the folder options — the scanner is the one place
 * that knows what a folder contains, and it walks a directory in name order,
 * which for a set of numbered clips is the order they want joining in.
 */
async function addJoinPaths(inputPaths) {
    if (!inputPaths || inputPaths.length === 0) return;
    try {
        const result = await api.scanPaths(inputPaths, buildScanOptions());
        const added = await addJoinClips(result.files);
        reportIngest({
            added,
            skipped: result.skipped ?? [],
            duplicates: 0,
            truncated: result.truncated,
            found: result.files.length,
        });
        for (const err of result.errors ?? []) {
            toast(`Could not read ${p.basename(err.path)}: ${err.error}`, "danger");
        }
    } catch (_) {
        // The scan itself failed, so folders cannot be expanded. List whatever
        // was handed over as plain files.
        const added = await addJoinClips(inputPaths);
        if (added === 0) toast("None of those are files this can join.", "warning");
    }
}

/** List the clips and probe them. Returns how many were listed. */
async function addJoinClips(filePaths) {
    const added = [];
    for (const filePath of filePaths ?? []) {
        const raw = p.extname(filePath).slice(1).toLowerCase();
        const ext = FORMATS.aliases[raw] ?? raw;
        if (!FORMATS.conversionMap[ext]) continue;
        // Unlike the queue, the same file twice is legitimate here — repeating
        // a clip is a real thing to want from a join.
        const clip = { id: generateId(), filePath, meta: null, trim: { start: null, end: null } };
        joinClips.push(clip);
        added.push(clip);
    }
    if (added.length === 0) return 0;
    renderJoin();

    // Every clip has to be probed before the copy-or-re-encode question can be
    // answered, so unlike the grid — where metadata only enriches a card that
    // is already useful — Join genuinely waits on it.
    await Promise.all(added.map(async (clip) => {
        clip.meta = await api.probeFile(clip.filePath);
    }));
    renderJoin();
    return added.length;
}

function removeJoinClip(id) {
    joinClips = joinClips.filter(c => c.id !== id);
    renderJoin();
}

function moveJoinClip(id, delta) {
    const i = joinClips.findIndex(c => c.id === id);
    const j = i + delta;
    if (i === -1 || j < 0 || j >= joinClips.length) return;
    [joinClips[i], joinClips[j]] = [joinClips[j], joinClips[i]];
    renderJoin();
}

/** What each clip contributes once its trim is applied. */
function joinClipSpan(clip) {
    const total = clip.meta?.ok ? clip.meta.duration : null;
    const start = clip.trim.start ?? 0;
    const end = clip.trim.end ?? total;
    if (!Number.isFinite(end)) return null;
    return end > start ? end - start : null;
}

function renderJoin() {
    const hasClips = joinClips.length > 0;
    $("join-empty").classList.toggle("d-none", hasClips);
    $("join-body").classList.toggle("d-none", !hasClips);
    if (!hasClips) {
        $("join-plan").className = "join-plan";
        $("join-plan").textContent = "";
        return;
    }

    const list = $("join-list");
    list.innerHTML = "";
    joinClips.forEach((clip, i) => list.appendChild(buildJoinRow(clip, i)));

    renderJoinFormats();
    renderJoinPlan();
    renderJoinActions();
}

function buildJoinRow(clip, index) {
    const row = document.createElement("li");
    row.className = "join-clip";

    const badge = document.createElement("span");
    badge.className = "join-index";
    badge.textContent = String(index + 1);

    const main = document.createElement("div");
    main.className = "join-clip-main";
    const name = document.createElement("span");
    name.className = "join-clip-name";
    name.textContent = p.basename(clip.filePath);
    name.title = clip.filePath;
    const meta = document.createElement("span");
    meta.className = "join-clip-meta";
    if (!clip.meta) meta.textContent = "Reading…";
    else if (!clip.meta.ok) { meta.textContent = "unreadable"; meta.classList.add("is-bad"); }
    else {
        const span = joinClipSpan(clip);
        const bits = [display.formatDuration(clip.meta.duration)];
        if (clip.meta.video) bits.push(`${clip.meta.video.width}×${clip.meta.video.height}`);
        if (span != null && Math.abs(span - clip.meta.duration) > 0.05) {
            bits.push(`keeping ${display.formatDuration(span)}`);
        }
        meta.textContent = bits.join(" · ");
    }
    main.append(name, meta);

    const trim = document.createElement("div");
    trim.className = "join-trim";
    trim.append(
        timeInput(clip, "start", "from"),
        Object.assign(document.createElement("span"), { className: "join-trim-sep", textContent: "→" }),
        timeInput(clip, "end", "to"),
    );

    const move = document.createElement("div");
    move.className = "join-move";
    move.append(
        iconButton("keyboard_arrow_up", "Move up", () => moveJoinClip(clip.id, -1), index === 0),
        iconButton("keyboard_arrow_down", "Move down", () => moveJoinClip(clip.id, 1), index === joinClips.length - 1),
    );

    const remove = iconButton("close", "Remove", () => removeJoinClip(clip.id));
    remove.className = "join-remove";

    row.append(badge, main, trim, move, remove);
    return row;
}

function timeInput(clip, which, placeholder) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.value = clip.trim[which] != null ? display.formatDuration(clip.trim[which]) : "";
    input.addEventListener("change", () => {
        clip.trim[which] = parseTime(input.value);
        renderJoin();
    });
    return input;
}

function iconButton(icon, title, onClick, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.disabled = disabled;
    const glyph = document.createElement("span");
    glyph.className = "material-icons-round";
    glyph.textContent = icon;
    button.appendChild(glyph);
    button.addEventListener("click", onClick);
    return button;
}

function joinMetas() {
    return joinClips.map(c => c.meta).filter(Boolean);
}

function renderJoinFormats() {
    const select = $("join-format");
    const metas = joinMetas();
    if (metas.length < joinClips.length) return;   // still probing

    const targets = display.joinTargets(metas, DESCRIPTORS);
    const chosen = select.value;
    select.innerHTML = "";
    for (const ext of targets) {
        const option = document.createElement("option");
        option.value = ext;
        option.textContent = DESCRIPTORS[ext]?.label ?? ext.toUpperCase();
        select.appendChild(option);
    }
    if (targets.includes(chosen)) select.value = chosen;
}

/** The plan, stated rather than implied. */
function renderJoinPlan() {
    const box = $("join-plan");
    const metas = joinMetas();

    if (metas.length < joinClips.length) {
        box.className = "join-plan";
        box.textContent = "Reading the files…";
        return;
    }
    if (joinClips.length < 2) {
        box.className = "join-plan";
        box.textContent = "Add another file — a join needs at least two.";
        return;
    }

    const plan = display.describeJoinPlan(display.compareClips(metas));
    box.className = `join-plan is-${plan.strategy === "demuxer" ? "copy" : plan.strategy === "filter" ? "encode" : "blocked"}`;
    box.textContent = "";
    box.appendChild(Object.assign(document.createElement("div"), { textContent: plan.headline }));
    if (plan.reasons.length > 0) {
        box.appendChild(Object.assign(document.createElement("p"), {
            className: "join-plan-why",
            textContent: `They differ in: ${plan.reasons.join(", ")}.`,
        }));
    }
}

function joinStrategy() {
    const metas = joinMetas();
    if (metas.length < joinClips.length || joinClips.length < 2) return null;
    const comparison = display.compareClips(metas);
    if (comparison.blocked) return null;
    return comparison.compatible ? "demuxer" : "filter";
}

function renderJoinActions() {
    const errors = [];
    const strategy = joinStrategy();

    if (joinClips.length >= 2 && strategy === null && joinMetas().length === joinClips.length) {
        errors.push("");   // the plan box already says why
    }
    if (!$("join-name").value.trim()) errors.push("Give the joined file a name.");
    if (!$("join-dir").value) errors.push("Choose where to save it.");
    for (const clip of joinClips) {
        if (clip.trim.start != null && clip.trim.end != null && clip.trim.end <= clip.trim.start) {
            errors.push(`${p.basename(clip.filePath)} ends before it starts.`);
            break;
        }
    }

    $("join-errors").textContent = errors.filter(Boolean).join(" ");
    $("btn-join-run").disabled = Boolean(joinRunning) || strategy === null || errors.length > 0;
    $("btn-join-run").classList.toggle("d-none", Boolean(joinRunning));
    $("btn-join-cancel").classList.toggle("d-none", !joinRunning);
    $("btn-join-clear").disabled = Boolean(joinRunning);
    document.querySelector(".join-progress").classList.toggle("d-none", !joinRunning);
}

async function runJoin() {
    const strategy = joinStrategy();
    if (!strategy || joinRunning) return;

    const spec = {
        strategy,
        clips: joinClips.map(clip => ({
            inputPath: clip.filePath,
            trim: clip.trim,
            duration: clip.meta?.duration ?? null,
            hasVideo: clip.meta?.hasVideo ?? false,
            hasAudio: clip.meta?.hasAudio ?? false,
            width: clip.meta?.video?.width ?? null,
            height: clip.meta?.video?.height ?? null,
            fps: clip.meta?.video?.fps ?? null,
            sampleRate: clip.meta?.audio?.sampleRate ?? null,
        })),
        targetExt: $("join-format").value,
        output: { dir: $("join-dir").value, nameTemplate: $("join-name").value.trim() },
    };

    joinRunning = generateId();
    spec.id = joinRunning;
    $("join-bar").style.width = "0%";
    renderJoinActions();

    const result = await api.runJoin(spec);
    joinRunning = null;
    renderJoinActions();

    if (result.status === "done") {
        toast(`Joined ${display.countOf(joinClips.length, "file")} into ${p.basename(result.outputPath)}.`, "success");
    } else if (result.status === "cancelled") {
        toast("Join cancelled.", "info");
    } else if (result.status === "skipped") {
        toast("That file already exists, so the join was skipped.", "warning");
    } else {
        toast(result.error || "The join failed.", "danger");
    }
}

function setupJoin() {
    $("btn-join-add").addEventListener("click", browseJoinFiles);
    $("btn-join-add-more").addEventListener("click", browseJoinFiles);
    // The whole zone is a click target, as Convert's is — with the same guard,
    // or the button inside it opens the dialog twice.
    $("join-drop").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        browseJoinFiles();
    });
    $("btn-join-clear").addEventListener("click", () => { joinClips = []; renderJoin(); });
    $("btn-join-run").addEventListener("click", runJoin);
    $("btn-join-cancel").addEventListener("click", () => { if (joinRunning) api.cancelJob(joinRunning); });
    $("btn-join-browse").addEventListener("click", async () => {
        const dir = await api.chooseOutput();
        if (dir) { $("join-dir").value = dir; renderJoinActions(); }
    });
    $("join-name").addEventListener("input", renderJoinActions);
    $("join-format").addEventListener("change", renderJoinActions);

    const zone = $("join-drop");
    zone.addEventListener("dragenter", () => zone.classList.add("drag-over"));
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", () => zone.classList.remove("drag-over"));

    async function browseJoinFiles() {
        const filePaths = await api.browseFiles();
        if (filePaths) addJoinPaths(filePaths);
    }
}

// -- Folder options ----------------------------------------------------------

/**
 * Three checkboxes, saved as they are changed. No save button, and no dialog:
 * these are preferences about the next ingest, so they sit on the control that
 * starts one. The scanner also supports a depth limit and a file cap, which are
 * deliberately not offered — they are safety rails, and the toast that fires
 * when one bites explains itself better than a number in a popover would.
 */
function setupScanOptions() {
    const popover = $("scan-popover");
    const toggle = $("btn-scan-options");
    const kindBoxes = [...popover.querySelectorAll("[data-kind]")];

    function load() {
        $("scan-recursive").checked = scanPrefs.recursive !== false;
        $("scan-symlinks").checked = scanPrefs.followSymlinks === true;
        const kinds = scanPrefs.kinds ?? ALL_KINDS;
        for (const box of kindBoxes) box.checked = kinds.includes(box.dataset.kind);
    }

    async function save() {
        const kinds = kindBoxes.filter(b => b.checked).map(b => b.dataset.kind);
        scanPrefs = {
            recursive: $("scan-recursive").checked,
            followSymlinks: $("scan-symlinks").checked,
            kinds,
        };
        await kitApi.setSettings({ scan: scanPrefs });
    }

    function setOpen(open) {
        popover.classList.toggle("d-none", !open);
        toggle.setAttribute("aria-expanded", String(open));
    }
    const isOpen = () => !popover.classList.contains("d-none");

    toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        setOpen(!isOpen());
    });
    popover.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { if (isOpen()) setOpen(false); });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen()) { setOpen(false); e.stopPropagation(); }
    }, true);

    for (const box of kindBoxes) {
        box.addEventListener("change", () => {
            // Turning everything off would skip every file in the folder and
            // then explain why, which is technically honest and useless. The
            // last one on stays on.
            if (!kindBoxes.some(b => b.checked)) {
                box.checked = true;
                return;
            }
            save();
        });
    }
    $("scan-recursive").addEventListener("change", save);
    $("scan-symlinks").addEventListener("change", save);

    load();
}

document.addEventListener("DOMContentLoaded", async () => {
    // The frame around the two sections. The kit adds Settings (with its
    // Update and Credits tabs) and Collapse to the rail, and remembers
    // Collapse, because a narrow window is exactly where someone collapses it
    // and exactly where it would be most annoying to have to do so again.
    // Mounted first, so the page is never seen without its frame.
    shell = kit.ui.mountShell({
        title: "Diamond File Converter",
        sections: [
            { view: "convert", label: "Convert", icon: "swap_horiz", element: $("convert-view") },
            { view: "join", label: "Join", icon: "merge_type", element: $("join-view") },
        ],
        toolbar: $("toolbar"),
        credits: { logo: "assets/diamondfileconverter.png" },
        onViewChange,
    });

    FORMATS = await api.getFormats();
    TARGETS = FORMATS.targetsByExt;
    DESCRIPTORS = FORMATS.descriptors;

    const settings = await kitApi.getSettings();
    if (settings?.scan) scanPrefs = { ...scanPrefs, ...settings.scan };
    setupScanOptions();
    setupJoin();

    // Drag and drop. The document-level guard stops a stray drop navigating the
    // window to the file and replacing the app with it.
    const appShell = document.querySelector(".app-shell");
    let dragDepth = 0;

    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth++;
        // The highlight belongs to the grid, so it stays off while Join is
        // showing — Join's own zone lights itself.
        if (currentView !== "convert") return;
        appShell.classList.add("drag-over");
        if (jobs.length === 0) $("drop-zone").classList.add("drag-over");
    });
    document.addEventListener("dragleave", () => {
        // dragleave also fires crossing onto child elements, so count depth
        // rather than clearing on the first one — that is what made the v1
        // highlight flicker.
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            appShell.classList.remove("drag-over");
            $("drop-zone").classList.remove("drag-over");
        }
    });
    document.addEventListener("drop", async (e) => {
        dragDepth = 0;
        appShell.classList.remove("drag-over");
        $("drop-zone").classList.remove("drag-over");

        // Read the paths before any await — dataTransfer does not survive one.
        // The FileList is iterated here rather than in the preload: it cannot
        // cross the context bridge, but the individual File objects can.
        const paths = Array.from(e.dataTransfer?.files ?? [])
            .map(file => api.getPathForFile(file))
            .filter(Boolean);

        // A drop means "take these", and where they go is whichever view is
        // showing. Switching to Convert under someone who is assembling a join
        // would be the surprising reading of the same gesture.
        takePaths(paths);
    });

    // The header's Add Files and Add Folder serve both sections, so they take
    // the same reading as a drop: whichever section is showing gets the files.
    // Settings isn't one, so files arriving there go to Convert, shown.
    function takePaths(paths) {
        if (currentView === "join") addJoinPaths(paths);
        else ingestFromAnywhere(paths);
    }
    async function browseFiles() {
        const filePaths = await api.browseFiles();
        if (filePaths) takePaths(filePaths);
    }
    async function browseFolder() {
        const folders = await api.browseFolder();
        if (folders) takePaths(folders);
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
    initTrimSlider();
    initFramesChoice();
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

        // Card shortcuts belong to the file grid, so they do nothing while
        // another section is showing.
        if (currentView !== "convert") return;

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
    // A join is a job too, and it is the only one with no card to land on.
    if (jobId === joinRunning) {
        $("join-bar").style.width = `${percent}%`;
        return;
    }
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

/** Files for Convert, from wherever they came: shown on Convert if Settings is showing. */
function ingestFromAnywhere(paths) {
    if (currentView === "settings") shell?.showView("convert");
    ingestPaths(paths);
}

api.onFilesOpened((filePaths) => {
    ingestFromAnywhere(Array.isArray(filePaths) ? filePaths : [filePaths]);
});
