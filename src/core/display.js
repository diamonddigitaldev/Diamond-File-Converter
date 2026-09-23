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
        return `${groupDigits(n)} ${plural(n, one, many)}`;
    }

    /** 18000 -> "18,000". Frame counts get large enough to be unreadable raw. */
    function groupDigits(n) {
        const num = Number(n);
        if (!Number.isFinite(num)) return String(n);
        const sign = num < 0 ? "-" : "";
        const digits = String(Math.trunc(Math.abs(num)));
        return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

    /**
     * Seconds to a clock that keeps any fraction: 1:05, 1:05.04, 1:02:03.5.
     * formatDuration rounds to the second, which is right for a card and wrong
     * for a trim point someone placed a frame at a time.
     */
    function formatTimecode(seconds) {
        if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
        const ms = Math.round(seconds * 1000);
        const whole = Math.floor(ms / 1000);
        const fraction = ms % 1000;
        const clock = formatDuration(whole);
        return fraction === 0 ? clock : `${clock}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
    }

    /**
     * Read a typed time back: "83", "83.5", "1:23", "1:23.04" or "1:02:03.5".
     * Null for blank, which means "no limit at this end"; NaN for anything that
     * is not a time, so a caller can tell a mistake from an empty box.
     *
     * Only the last part may carry a fraction, and every part after the first
     * must be under 60 — "1:75" is far more likely a typo than 2:15.
     */
    function parseTimecode(text) {
        const value = String(text ?? "").trim();
        if (!value) return null;
        const parts = value.split(":");
        if (parts.length > 3) return NaN;
        const last = parts.length - 1;
        let total = 0;
        for (let i = 0; i < parts.length; i++) {
            const pattern = i === last ? /^\d+(\.\d+)?$|^\.\d+$/ : /^\d+$/;
            if (!pattern.test(parts[i])) return NaN;
            const n = Number(parts[i]);
            if (i > 0 && n >= 60) return NaN;
            total = total * 60 + n;
        }
        // 60 + 23.04 is 83.03999999999999 in floating point.
        return Math.round(total * 1e6) / 1e6;
    }

    /**
     * How far one step of the trim control moves. A whole second by default;
     * held Shift is one frame of anything that moves, and a tenth of a second
     * of anything that does not.
     */
    function trimStep(meta, fine) {
        if (!fine) return 1;
        const moving = meta && meta.hasVideo && !meta.isStill && meta.video;
        const fps = moving ? meta.video.fps : null;
        return fps > 0 ? 1 / fps : 0.1;
    }

    /**
     * Put a trim point on the step's grid: "round" to the nearest step, "floor"
     * or "ceil" to the one below or above.
     *
     * The result is floored to the millisecond rather than rounded. A frame
     * step is rarely a whole number of milliseconds, and ffmpeg keeps frames
     * from the first one at or after -ss — rounding a frame's time up past its
     * own timestamp would quietly drop the frame the handle was put on.
     */
    function snapToStep(seconds, step, how = "round") {
        const EPSILON = 1e-6;   // 3 / (1/25) is 75.00000000000001, not 75
        const n = how === "floor" ? Math.floor(seconds / step + EPSILON)
            : how === "ceil" ? Math.ceil(seconds / step - EPSILON)
            : Math.round(seconds / step);
        return Math.floor(n * step * 1000 + EPSILON) / 1000;
    }

    /**
     * Where a trim handle lands when moved toward `seconds`: on the grid, inside
     * the clip, and at least one step clear of the other handle.
     *
     * The end is the one exception to the grid. A clip is rarely a whole number
     * of seconds long, and snapping its last stretch to the second below would
     * trim off a fraction nobody asked to lose — so near enough the end is the
     * end.
     */
    function placeTrimHandle(handle, seconds, { start, end, duration, step }) {
        if (handle === "start") {
            const latest = snapToStep(Math.max(0, end - step), step, "floor");
            return Math.max(0, Math.min(snapToStep(seconds, step), latest));
        }
        if (seconds >= duration - step / 2) return duration;
        const earliest = Math.min(duration, snapToStep(start + step, step, "ceil"));
        return Math.min(duration, Math.max(snapToStep(seconds, step), earliest));
    }

    /**
     * Check a trim point typed into one of the boxes against the clip and the
     * other end: { value } when it can be used exactly as typed, { error } when
     * it cannot. A blank box means the very start or the very end.
     *
     * The clip's own length is accepted however it was typed. A duration of
     * 9.743673s shows as 0:09.744, and typing back what the box showed must not
     * be refused for being a third of a millisecond too long.
     */
    function checkTrimEntry(which, text, { start, end, duration }) {
        const parsed = parseTimecode(text);
        if (Number.isNaN(parsed)) return { error: "Use a time like 1:23 or 1:23.5." };
        const clip = formatTimecode(duration);
        const exact = (v) => Math.min(duration, Math.round(v * 1000) / 1000);

        if (which === "start") {
            const value = exact(parsed ?? 0);
            if (value >= duration) return { error: `The start must be inside the clip, which is ${clip} long.` };
            if (value >= end) return { error: `The start must be before the end, at ${formatTimecode(end)}.` };
            return { value };
        }
        if (parsed != null && parsed > duration + 0.0005) {
            return { error: `The end cannot be past the end of the clip, at ${clip}.` };
        }
        const value = parsed == null ? duration : exact(parsed);
        if (value <= start) return { error: `The end must be after the start, at ${formatTimecode(start)}.` };
        return { value };
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
        // null means "still reading", and the card renders it as such. A probe
        // that came back and failed is a *terminal* state, so it must not
        // return null too — an unreadable file used to sit on "Reading…"
        // forever, even after a conversion had already failed against it.
        if (!meta || meta.pending) return null;
        if (!meta.ok) {
            return sourceExt ? `${sourceExt.toUpperCase()} · unreadable` : "Unreadable file";
        }

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
                if (!job.targetExt) return { text: "Choose a format", tone: "warning" };
                return { text: "Ready", tone: "ready" };
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

    // -- New Job dialog ------------------------------------------------------
    //
    // Which controls a target format actually supports. The dialog is driven
    // entirely from these, so a container is never offered a codec it cannot
    // carry — invalid combinations are unreachable rather than merely rejected.

    /**
     * The mode a card will actually run in: whatever was chosen for it, or the
     * default for its pair.
     *
     * Mirrors defaultModeFor() in core/job.js, which the renderer cannot
     * require. display.test.js asserts the two agree across every pair, the
     * same way STATUS is policed.
     */
    function effectiveMode(job, targetsByExt, descriptors) {
        if (!job || !job.targetExt) return null;
        if (job.settings && job.settings.mode) return job.settings.mode;

        const list = (targetsByExt && targetsByExt[job.ext]) || [];
        const target = list.filter(t => t.ext === job.targetExt)[0];
        const modes = target && target.modes ? target.modes : [];
        if (modes.length === 0) return null;

        const source = descriptors ? descriptors[job.ext] : null;
        const meta = job.meta;
        const isStill = !!source && source.kind === "image"
            && !!meta && meta.ok === true && meta.isStill === true;
        if (!isStill) return modes[0];

        const targetDesc = descriptors ? descriptors[job.targetExt] : null;
        const preferred = targetDesc && targetDesc.kind === "video"
            ? ["assemble", "transcode"]
            : ["transcode", "thumbnail"];
        for (const candidate of preferred) {
            if (modes.indexOf(candidate) !== -1) return candidate;
        }
        return modes[0];
    }

    const NONE = { video: false, videoEncode: false, audio: false, image: false, trim: false, frames: false, resize: false };

    /**
     * Which sections of the dialog apply.
     *
     * This takes the source and the mode as well as the target, because the
     * same target means different things depending on where it came from. A PNG
     * from another image is one picture and has nothing to trim; a PNG from a
     * video is a choice of *which* frames, which is the same span control under
     * a different name.
     */
    function applicableSections(sourceExt, targetExt, descriptors, mode) {
        const target = descriptors ? descriptors[targetExt] : null;
        const source = descriptors ? descriptors[sourceExt] : null;
        if (!target) return { ...NONE };

        const isImage = target.kind === "image";
        const isAudio = target.kind === "audio";
        const fromImage = source ? source.kind === "image" : false;

        // Picking frames out of something that moves. The span is the whole
        // point of the conversion, so it is offered even for a still target,
        // where a plain trim would make no sense.
        const frames = isImage && (mode === "frames" || mode === "thumbnail");

        return {
            // An audio container has no video stream to configure.
            video: !isAudio,
            // ...and a picture has no video *codec* to choose: the container
            // dictates one, there is no bitrate, preset or stream mode, and it
            // is always encoded. Resizing and sampling still apply, which is
            // why this is narrower than `video`.
            videoEncode: !isAudio && !isImage,
            // An image has no audio stream, and neither has an image source.
            audio: !isImage && !fromImage,
            // Only image targets expose a quality knob of their own.
            image: isImage && !!target.quality,
            // Trimming one still makes no sense; choosing frames from a moving
            // source is not trimming, and gets its own section.
            trim: !isImage || (!!target.animated && !frames),
            frames,
            resize: !isAudio,
        };
    }

    /** Codec choices for a target, as {value,label} options. Empty if none. */
    function codecOptions(targetExt, descriptors, stream) {
        const target = descriptors ? descriptors[targetExt] : null;
        if (!target) return [];
        const list = stream === "audio" ? target.audioCodecs : target.videoCodecs;
        if (!Array.isArray(list)) return [];
        return list.map(c => ({ value: c, label: CODEC_LABELS[c] || c }));
    }

    const CODEC_LABELS = {
        libx264: "H.264", libx265: "H.265 / HEVC", libsvtav1: "AV1",
        "libvpx-vp9": "VP9", libvpx: "VP8", mpeg4: "MPEG-4", mjpeg: "MJPEG",
        prores_ks: "ProRes", wmv2: "WMV", msmpeg4v3: "MS MPEG-4", flv: "Sorenson",
        gif: "GIF", png: "PNG", bmp: "BMP", tiff: "TIFF", libwebp: "WebP",
        aac: "AAC", libmp3lame: "MP3", libopus: "Opus", libvorbis: "Vorbis",
        flac: "FLAC", alac: "ALAC", ac3: "AC-3", wmav2: "WMA",
        pcm_s16le: "PCM 16-bit", pcm_s24le: "PCM 24-bit", pcm_f32le: "PCM 32-bit float",
    };

    /* Terser than the select in the dialog, because a summary line is a list of
       fragments rather than a sentence — "Skip the file" reads oddly with a
       codec either side of it, "skip existing" does not. "ask" has no entry: it
       is the default and never reaches here. */
    const CONFLICT_LABELS = {
        overwrite: "overwrite",
        unique: "save as new",
        skip: "skip existing",
    };

    /** Whether a target can stream-copy, i.e. remux without re-encoding. */
    /**
     * Whether "copy without re-encoding" is worth offering.
     *
     * The container supporting a copy is necessary but not sufficient: pulling
     * the audio out of a video only copies if the stream already sitting in
     * that video is one the target can carry. Every audio container claims
     * stream-copy support, so without the codec check an MP4 holding AAC offers
     * a copy into MP3, passes validation, and fails inside ffmpeg.
     */
    function canStreamCopy(targetExt, descriptors, mode, inputMeta) {
        const target = descriptors ? descriptors[targetExt] : null;
        if (!target || !target.supportsStreamCopy) return false;

        if (mode === "extract") {
            const codec = inputMeta && inputMeta.ok && inputMeta.audio ? inputMeta.audio.codec : null;
            // Unprobed: say no rather than offer something that may not work.
            if (!codec) return false;
            if (!Array.isArray(target.audioCodecs)) return false;
            return target.audioCodecs.some(enc => encoderCodec(enc) === codec);
        }
        return true;
    }

    // The format table names *encoders*; a probe reports the *codec* in the
    // stream. For most they are the same string, but ffmpeg's own -encoders
    // listing spells out the three that differ: "libmp3lame ... (codec mp3)".
    // Comparing them raw would refuse a copy that would have worked perfectly.
    const ENCODER_CODECS = {
        libmp3lame: "mp3",
        libopus: "opus",
        libvorbis: "vorbis",
        libfdk_aac: "aac",
    };

    function encoderCodec(encoder) {
        return ENCODER_CODECS[encoder] ?? encoder;
    }

    /**
     * Roughly how many images a frame-producing conversion will write, or null
     * when that is not what this conversion does or the probe has not landed.
     *
     * Rough is the point: the honest number depends on the source's real frame
     * timing, and the estimate exists so nobody is surprised by a directory
     * holding eighteen thousand files.
     */
    function estimateFrames(mode, trim, inputMeta) {
        if (mode === "thumbnail") return 1;
        if (mode !== "frames") return null;
        if (!inputMeta || !inputMeta.ok) return null;

        const fps = inputMeta.video ? inputMeta.video.fps : null;
        const duration = inputMeta.duration;
        if (!(fps > 0) || !(duration > 0)) return null;

        const start = trim && trim.start != null ? trim.start : 0;
        const end = trim && trim.end != null ? Math.min(trim.end, duration) : duration;
        const span = Math.max(0, end - start);

        return Math.max(1, Math.round(span * fps));
    }

    /** "about 18,000 images" / "1 image", or null when nothing is worth saying. */
    function describeOutput(mode, trim, inputMeta) {
        const frames = estimateFrames(mode, trim, inputMeta);
        if (frames === null) return null;
        if (frames === 1) return "1 image";
        return `about ${countOf(frames, "image")}`;
    }

    /** The image quality knob for a target, or null. */
    function qualityDescriptor(targetExt, descriptors) {
        const target = descriptors ? descriptors[targetExt] : null;
        return target && target.quality ? target.quality : null;
    }

    /**
     * A one-line summary of whatever has been changed from the defaults, shown
     * on the card so a configured job is visibly different from a bare one.
     * Returns null when nothing has been customised.
     */
    function summariseSettings(settings) {
        if (!settings) return null;
        const parts = [];

        if (settings.video) {
            const v = settings.video;
            if (v.mode === "copy") parts.push("copy video");
            else if (v.mode === "drop") parts.push("no video");
            else {
                if (v.codec) parts.push(CODEC_LABELS[v.codec] || v.codec);
                if (v.crf != null) parts.push(`CRF ${v.crf}`);
                else if (v.bitrate) parts.push(`${v.bitrate}k`);
                if (v.preset) parts.push(v.preset);
            }
            if (v.width || v.height) parts.push(`${v.width || "auto"}×${v.height || "auto"}`);
            if (v.fps) parts.push(`${v.fps} fps`);
        }

        if (settings.audio) {
            const a = settings.audio;
            if (a.mode === "copy") parts.push("copy audio");
            else if (a.mode === "drop") parts.push("no audio");
            else {
                if (a.codec) parts.push(CODEC_LABELS[a.codec] || a.codec);
                if (a.bitrate) parts.push(`${a.bitrate}k`);
                if (a.channels) parts.push(a.channels === 1 ? "mono" : `${a.channels}ch`);
            }
        }

        if (settings.image && settings.image.quality != null) {
            parts.push(`q${settings.image.quality}`);
        }

        const trim = settings.trim;
        if (trim && (trim.start != null || trim.end != null)) {
            parts.push(`trim ${formatDuration(trim.start || 0) || "0:00"}–${formatDuration(trim.end) || "end"}`);
        }

        if (settings.output) {
            const o = settings.output;
            if (o.routing && o.routing !== "alongside") parts.push(o.routing === "mirror" ? "mirrored" : "custom folder");
            if (o.nameTemplate && o.nameTemplate !== "{name}") parts.push("renamed");
            // "ask" is the default and stays silent, the same way "alongside"
            // and "{name}" do above. Without this a card whose only change was
            // the conflict policy showed no summary line at all, so a setting
            // that had genuinely been applied looked like it had not stuck.
            if (o.onConflict && o.onConflict !== "ask") parts.push(CONFLICT_LABELS[o.onConflict] || o.onConflict);
        }

        return parts.length > 0 ? parts.join(" · ") : null;
    }

    /**
     * Strip empty sections and null fields so a spec carries only what was
     * actually set. Anything left out falls back to the format's own defaults
     * in createJob, which keeps the dialog from freezing today's defaults in.
     */
    function compactSettings(settings) {
        const out = {};
        for (const [section, values] of Object.entries(settings || {})) {
            if (values === null || values === undefined || values === "") continue;
            // A scalar is a setting in its own right rather than a group of
            // fields to prune — `mode` is one, and dropping it silently threw
            // away the choice between every frame and a single one.
            if (typeof values !== "object") { out[section] = values; continue; }
            const kept = {};
            for (const [key, value] of Object.entries(values)) {
                if (value === null || value === undefined || value === "") continue;
                kept[key] = value;
            }
            if (Object.keys(kept).length > 0) out[section] = kept;
        }
        return out;
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

    // -- Joining -------------------------------------------------------------
    //
    // Whether a set of clips can be stitched together without re-encoding.
    // Lives here rather than in a module of its own because the Join view has
    // to say which of the two routes it is about to take *and why*, and the
    // renderer cannot require() anything.

    /**
     * ffprobe reports a container as a comma-joined list of everything the
     * demuxer handles — an .mp4 and a .mov both say
     * "mov,mp4,m4a,3gp,3g2,mj2". Comparing those with === would call two files
     * different that concatenate together perfectly, so the test is whether the
     * lists overlap at all.
     */
    function sameContainer(a, b) {
        if (!a || !b) return false;
        const left = new Set(String(a).split(","));
        return String(b).split(",").some(name => left.has(name));
    }

    /**
     * Cross-multiplied rather than compared field by field, so 60/2 and 30/1
     * are recognised as one rate. probe reduces what it parses, but this must
     * not depend on having been handed reduced values to be right.
     */
    function sameRational(a, b) {
        if (!a || !b) return false;
        return a.num * b.den === b.num * a.den;
    }

    /** The fields that must match for a stream copy, in the order to report. */
    const CLIP_FIELDS = [
        { key: "container", label: "container",     of: m => m.formatName,        eq: sameContainer },
        { key: "vcodec",    label: "video codec",   of: m => m.video?.codec },
        { key: "width",     label: "width",         of: m => m.video?.width },
        { key: "height",    label: "height",        of: m => m.video?.height },
        { key: "fps",       label: "frame rate",    of: m => m.video?.fpsExact,   eq: sameRational },
        { key: "timeBase",  label: "time base",     of: m => m.video?.timeBase },
        { key: "sar",       label: "pixel shape",   of: m => m.video?.sar },
        { key: "pixfmt",    label: "pixel format",  of: m => m.video?.pixelFormat },
        { key: "acodec",    label: "audio codec",   of: m => m.audio?.codec },
        { key: "rate",      label: "sample rate",   of: m => m.audio?.sampleRate },
        { key: "channels",  label: "channels",      of: m => m.audio?.channels },
        { key: "sampfmt",   label: "sample format", of: m => m.audio?.sampleFormat },
    ];

    /**
     * Compare probed clips. `blocked` means the set cannot be joined at all;
     * `compatible` means it can be joined without re-encoding.
     *
     * @param {object[]} metas normalised probe output, in clip order
     */
    function compareClips(metas) {
        const clips = metas ?? [];
        if (clips.length < 2) {
            return { compatible: true, blocked: null, differences: [] };
        }

        // A clip ffmpeg could not measure is refused outright rather than being
        // compared against — probe returns ok:false with no `video` at all, so
        // every field below would read as undefined and match every other
        // unreadable clip.
        const unreadable = clips.findIndex(m => !m || m.ok === false);
        if (unreadable !== -1) {
            return { compatible: false, blocked: "unreadable", blockedIndex: unreadable, differences: [] };
        }

        // Concatenating a silent video onto one with sound, or a bare audio
        // file onto a video, means synthesising the missing stream for the
        // length of the clip. That is a different feature.
        const withVideo = clips.filter(m => m.hasVideo).length;
        if (withVideo !== 0 && withVideo !== clips.length) {
            return { compatible: false, blocked: "mixed-kinds", differences: [] };
        }
        const withAudio = clips.filter(m => m.hasAudio).length;
        if (withAudio !== 0 && withAudio !== clips.length) {
            return { compatible: false, blocked: "mixed-audio", differences: [] };
        }

        const differences = [];
        for (const field of CLIP_FIELDS) {
            const values = clips.map(field.of);
            if (values.every(v => v == null)) continue;
            const same = field.eq
                ? values.every(v => field.eq(v, values[0]))
                : values.every(v => v === values[0]);
            if (!same) differences.push({ field: field.key, label: field.label, values });
        }

        return { compatible: differences.length === 0, blocked: null, differences };
    }

    const JOIN_BLOCKED = {
        "unreadable":  "One of these files cannot be read, so it cannot be joined.",
        "mixed-kinds": "These are a mix of video and audio-only files. Join files of one kind at a time.",
        "mixed-audio": "Some of these have sound and some do not, which cannot be joined as they are.",
    };

    /**
     * What is about to happen, in the app's own words. The whole point of
     * showing this is that "instant and lossless" and "re-encodes everything"
     * are wildly different things to press the same button for.
     */
    function describeJoinPlan(comparison) {
        if (comparison.blocked) {
            return { strategy: "blocked", headline: JOIN_BLOCKED[comparison.blocked], reasons: [] };
        }
        if (comparison.compatible) {
            return {
                strategy: "demuxer",
                headline: "These match, so they will be joined without re-encoding — quick, and no quality is lost.",
                reasons: [],
            };
        }
        return {
            strategy: "filter",
            headline: "These do not match, so they will be re-encoded to fit together. It takes longer and the result is not identical to the sources.",
            reasons: comparison.differences.map(d => d.label),
        };
    }

    /**
     * Containers a set of clips can be joined into. GIF is deliberately absent:
     * its palette pass and the join both want -filter_complex and the two
     * cannot simply be stacked, so it is refused rather than half-supported.
     */
    function joinTargets(metas, descriptors) {
        const clips = metas ?? [];
        const wantsVideo = clips.length === 0 || clips.some(m => m?.hasVideo);
        return Object.values(descriptors ?? {})
            .filter(d => d.ext !== "gif")
            .filter(d => (wantsVideo ? d.kind === "video" : d.kind === "audio"))
            .map(d => d.ext);
    }

    return {
        STATUS,
        plural,
        countOf,
        sameContainer,
        compareClips,
        describeJoinPlan,
        joinTargets,
        applicableSections,
        effectiveMode,
        estimateFrames,
        describeOutput,
        codecOptions,
        canStreamCopy,
        qualityDescriptor,
        summariseSettings,
        compactSettings,
        CODEC_LABELS,
        formatDuration,
        formatTimecode,
        parseTimecode,
        trimStep,
        snapToStep,
        placeTrimHandle,
        checkTrimEntry,
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
