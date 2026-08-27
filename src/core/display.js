// Display formatting and selection logic.
//
// Dual-loaded on purpose: required by tests in Node, and loaded as a plain
// <script> by the renderer. That rules out require() and any import of the
// other core modules — the renderer runs sandboxed with no Node access, and
// functions cannot cross the IPC bridge. Everything it needs is either inlined
// or passed in as an argument. test/display.test.js enforces this.

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.display = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // Mirrors STATUS in core/job.js. Inlined because this file cannot require
    // it; display.test.js asserts the two stay in step.
    const STATUS = {
        PENDING: "pending",
        RUNNING: "running",
        DONE: "done",
        ERROR: "error",
        CANCELLED: "cancelled",
        SKIPPED: "skipped",
    };

    // -- Pluralisation -------------------------------------------------------
    //
    // Every count shown in the UI goes through these, rather than each call
    // site writing its own ternary. Doing it inline is how "1 still need a
    // format" and "1 frames" got shipped.

    /**
     * The wording that agrees with a count. `one` is used when n is exactly 1;
     * `many` defaults to `one` with an "s" appended.
     *
     *   plural(1, "file")            -> "file"
     *   plural(3, "file")            -> "files"
     *   plural(1, "needs", "need")   -> "needs"
     */
    function plural(n, one, many) {
        return n === 1 ? one : (many === undefined ? one + "s" : many);
    }

    /** The count with its agreeing noun: "1 file", "3 files". */
    function countOf(n, one, many) {
        return `${n} ${plural(n, one, many)}`;
    }

    /** Seconds to a compact clock: 9:05, 1:02:03. Null for unknown. */
    function formatDuration(seconds) {
        if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
        const total = Math.round(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n) => String(n).padStart(2, "0");
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    /** Bytes to a short human size. Binary units, one decimal below 10. */
    function formatBytes(bytes) {
        if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
        if (bytes < 1024) return `${bytes} B`;
        const units = ["KB", "MB", "GB", "TB"];
        let value = bytes / 1024;
        let i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
    }

    /** Remaining seconds to a terse "2m 05s" / "45s". Null for unknown. */
    function formatEta(seconds) {
        if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
        const total = Math.round(seconds);
        if (total < 60) return `${total}s`;
        const m = Math.floor(total / 60);
        const s = total % 60;
        if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
        return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
    }

    /**
     * The one-line metadata summary under a card's filename.
     * Null until the probe lands, so the card can show a placeholder.
     */
    function describeMeta(meta, sourceExt) {
        if (!meta || !meta.ok) return null;

        const parts = [];
        if (meta.hasVideo && meta.video && meta.video.width && meta.video.height) {
            parts.push(`${meta.video.width}×${meta.video.height}`);
        }
        const duration = formatDuration(meta.duration);
        if (duration) parts.push(duration);

        const codec = meta.hasVideo ? meta.video && meta.video.codec : meta.audio && meta.audio.codec;
        if (codec) parts.push(codec);

        const size = formatBytes(meta.size);
        if (size) parts.push(size);

        if (parts.length === 0) return sourceExt ? sourceExt.toUpperCase() : null;
        return parts.join(" · ");
    }

    /** Short status line for a card, plus the semantic tone to colour it with. */
    function describeStatus(job) {
        switch (job.status) {
            case STATUS.RUNNING:
                return { text: "Converting", tone: "running" };
            case STATUS.DONE:
                return {
                    text: job.isDirectory ? countOf(job.fileCount, "frame") : "Done",
                    tone: "success",
                };
            case STATUS.ERROR:
                return { text: job.error || "Failed", tone: "danger" };
            case STATUS.CANCELLED:
                return { text: "Cancelled", tone: "muted" };
            case STATUS.SKIPPED:
                return { text: "Skipped", tone: "muted" };
            default:
                return job.targetExt
                    ? { text: "Ready", tone: "ready" }
                    : { text: "Choose a format", tone: "warning" };
        }
    }

    /** "3 files converted, 1 failed" — the post-run summary. */
    function summarise(jobs) {
        const tally = (status) => jobs.filter(j => j.status === status).length;
        const done = tally(STATUS.DONE);
        const failed = tally(STATUS.ERROR);
        const cancelled = tally(STATUS.CANCELLED) + tally(STATUS.SKIPPED);

        const parts = [];
        if (done > 0) parts.push(`${countOf(done, "file")} converted`);
        if (failed > 0) parts.push(`${failed} failed`);
        if (cancelled > 0) parts.push(`${cancelled} cancelled`);

        if (parts.length === 0) return "Nothing converted";
        return parts.join(", ");
    }

    /** Aggregate percent across a set of jobs, for the overall progress bar. */
    function overallProgress(jobs) {
        if (jobs.length === 0) return 0;
        const finished = [STATUS.DONE, STATUS.ERROR, STATUS.CANCELLED, STATUS.SKIPPED];
        const total = jobs.reduce((sum, j) => {
            if (finished.indexOf(j.status) !== -1) return sum + 100;
            return sum + (typeof j.progress === "number" ? j.progress : 0);
        }, 0);
        return Math.round(total / jobs.length);
    }

    const KIND_ICONS = { audio: "audio_file", video: "video_file", image: "image" };

    function iconForKind(kind) {
        return KIND_ICONS[kind] || "insert_drive_file";
    }

    // -- Selection -----------------------------------------------------------

    /**
     * Resolve a click into a new selection set.
     *
     * @param {string[]} ids        every id in display order
     * @param {Set<string>} current
     * @param {string} clickedId
     * @param {{ctrl?: boolean, shift?: boolean}} modifiers
     * @param {string|null} anchorId  the last plainly-clicked id, for ranges
     * @returns {{selection: Set<string>, anchor: string|null}}
     */
    function resolveSelection(ids, current, clickedId, modifiers, anchorId) {
        modifiers = modifiers || {};
        const ctrl = modifiers.ctrl === true;
        const shift = modifiers.shift === true;
        anchorId = anchorId || null;

        if (shift && anchorId && ids.indexOf(anchorId) !== -1) {
            const from = ids.indexOf(anchorId);
            const to = ids.indexOf(clickedId);
            if (to !== -1) {
                const lo = from <= to ? from : to;
                const hi = from <= to ? to : from;
                const range = ids.slice(lo, hi + 1);
                // Ctrl+Shift extends the existing selection instead of replacing it.
                const next = ctrl ? new Set(current) : new Set();
                for (const id of range) next.add(id);
                return { selection: next, anchor: anchorId };
            }
        }

        if (ctrl) {
            const next = new Set(current);
            if (next.has(clickedId)) next.delete(clickedId);
            else next.add(clickedId);
            return { selection: next, anchor: clickedId };
        }

        // A plain click inside an existing multi-selection keeps it, so acting
        // on a group does not collapse it to one card first.
        if (current.size > 1 && current.has(clickedId)) {
            return { selection: new Set(current), anchor: clickedId };
        }

        return { selection: new Set([clickedId]), anchor: clickedId };
    }

    /** Drop ids that no longer exist, so removals cannot strand a selection. */
    function pruneSelection(selection, ids) {
        const valid = new Set(ids);
        const next = new Set();
        for (const id of selection) if (valid.has(id)) next.add(id);
        return next;
    }

    /**
     * The formats every one of these sources can produce — the intersection, so
     * a bulk change can never create an invalid job.
     *
     * @param {string[]} sourceExts
     * @param {Object<string, Array>} targetsByExt  from the main process
     */
    function commonTargets(sourceExts, targetsByExt) {
        if (!targetsByExt) return [];
        const unique = [];
        for (const ext of sourceExts) {
            if (ext && unique.indexOf(ext) === -1) unique.push(ext);
        }
        if (unique.length === 0) return [];

        let shared = null;
        for (const ext of unique) {
            const list = targetsByExt[ext] || [];
            const map = new Map(list.map(t => [t.ext, t]));
            if (shared === null) {
                shared = map;
                continue;
            }
            for (const key of Array.from(shared.keys())) {
                if (!map.has(key)) shared.delete(key);
            }
        }

        return shared ? Array.from(shared.values()) : [];
    }

    /** Group targets by kind, same-kind groups first. */
    function groupTargets(targets) {
        const groups = new Map();
        for (const t of targets) {
            if (!groups.has(t.group)) groups.set(t.group, []);
            groups.get(t.group).push(t);
        }
        return Array.from(groups.entries())
            .map(([group, items]) => ({
                group,
                items,
                sameKind: items.some(i => i.sameKind),
            }))
            .sort((a, b) => Number(b.sameKind) - Number(a.sameKind));
    }

    return {
        STATUS,
        plural,
        countOf,
        formatDuration,
        formatBytes,
        formatEta,
        describeMeta,
        describeStatus,
        summarise,
        overallProgress,
        iconForKind,
        resolveSelection,
        pruneSelection,
        commonTargets,
        groupTargets,
    };
});
