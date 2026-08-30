"use strict";

// The job model.
//
// v1 had no job concept at all: the convert IPC took two positional strings
// (filePath, targetExt) and every encoding decision was left to ffmpeg's
// extension sniffing. A job is the unit the 2.0 card grid binds to, the unit
// the runner schedules, and the unit ffmpeg-args compiles.

const formats = require("./formats");

const STATUS = {
    PENDING:   "pending",
    RUNNING:   "running",
    DONE:      "done",
    ERROR:     "error",
    CANCELLED: "cancelled",
    SKIPPED:   "skipped",
};

const STREAM_MODE = {
    COPY:   "copy",   // remux without re-encoding
    ENCODE: "encode",
    DROP:   "drop",
};

const CONFLICT = {
    ASK:       "ask",
    OVERWRITE: "overwrite",
    UNIQUE:    "unique",
    SKIP:      "skip",
};

const OUTPUT_ROUTING = {
    ALONGSIDE: "alongside", // next to the input, v1's only behaviour
    FIXED:     "fixed",     // one chosen directory
    MIRROR:    "mirror",    // rebuild the source tree under a chosen root
};

let idCounter = 0;

function generateId() {
    idCounter += 1;
    return `job_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Build a fully-populated job from a sparse spec. Anything not supplied is
 * filled from the target format's own capability defaults, so a job created
 * with nothing but an input path and a target extension is already runnable.
 */
function createJob(spec = {}) {
    const inputPath = spec.inputPath ?? null;
    const sourceExt = spec.sourceExt ?? (inputPath ? formats.canonicalExt(extnameOf(inputPath)) : null);
    const targetExt = formats.canonicalExt(spec.targetExt ?? spec.output?.ext ?? "") ?? null;

    const targetFormat = targetExt ? formats.getFormat(targetExt) : null;
    const mode = spec.mode ?? defaultModeFor(sourceExt, targetExt, spec.inputMeta);

    return {
        id: spec.id ?? generateId(),
        inputPath,
        sourceExt,
        inputMeta: spec.inputMeta ?? null,
        mode,

        output: {
            routing:      spec.output?.routing      ?? OUTPUT_ROUTING.ALONGSIDE,
            dir:          spec.output?.dir          ?? null,
            mirrorRoot:   spec.output?.mirrorRoot   ?? null,
            nameTemplate: spec.output?.nameTemplate ?? "{name}",
            ext:          targetExt,
            onConflict:   spec.output?.onConflict   ?? CONFLICT.ASK,
        },

        video: {
            mode:    spec.video?.mode    ?? defaultVideoMode(targetFormat, mode),
            codec:   spec.video?.codec   ?? targetFormat?.defaultVideoCodec ?? null,
            crf:     spec.video?.crf     ?? null,
            bitrate: spec.video?.bitrate ?? null,
            preset:  spec.video?.preset  ?? null,
            width:   spec.video?.width   ?? null,
            height:  spec.video?.height  ?? null,
            fitMode: spec.video?.fitMode ?? "contain",
            fps:     spec.video?.fps     ?? null,
        },

        audio: {
            mode:       spec.audio?.mode       ?? defaultAudioMode(targetFormat, sourceExt),
            codec:      spec.audio?.codec      ?? targetFormat?.defaultAudioCodec ?? null,
            bitrate:    spec.audio?.bitrate    ?? null,
            sampleRate: spec.audio?.sampleRate ?? null,
            channels:   spec.audio?.channels   ?? null,
        },

        image: {
            quality: spec.image?.quality ?? targetFormat?.quality?.default ?? null,
            scale:   spec.image?.scale   ?? null,
        },

        // Null means "from the start" / "to the end". Seconds, as floats.
        trim: {
            start: spec.trim?.start ?? null,
            end:   spec.trim?.end   ?? null,
        },

        // Extra raw filters carried on the job.
        filters:    spec.filters    ?? [],

        status:     spec.status   ?? STATUS.PENDING,
        progress:   spec.progress ?? 0,
        error:      spec.error    ?? null,
        outputPath: spec.outputPath ?? null,
    };
}

/**
 * The mode a conversion should take when nobody has asked for a specific one.
 *
 * allowedModes() answers what is *possible* from two extensions, which is all it
 * can see. Whether a file actually moves is a property of the file, not its
 * container: gif and webp may hold an animation and usually do not. Without
 * this, a perfectly ordinary still WebP asked for PNG takes the animated path
 * and lands as a *directory* containing one frame.
 *
 * `inputMeta` is optional — a card is configured long before its probe returns,
 * and the answer is re-resolved once one has.
 */
function defaultModeFor(sourceExt, targetExt, inputMeta) {
    if (!sourceExt || !targetExt) return null;

    const modes = formats.allowedModes(sourceExt, targetExt);
    if (modes.length === 0) return null;

    // The probe says this outright: a GIF or WebP holding one picture reports
    // no average frame rate. Duration alone cannot tell them apart, because
    // neither an animated GIF nor a still one carries a container duration.
    const source = formats.getFormat(sourceExt);
    const isStill = source?.kind === formats.KIND.IMAGE
        && inputMeta?.ok === true
        && inputMeta.isStill === true;
    if (!isStill) return modes[0];

    // One frame in means one file out: loop it into a clip for a video target,
    // otherwise write the single image the caller plainly meant.
    const target = formats.getFormat(targetExt);
    const preferred = target?.kind === formats.KIND.VIDEO
        ? [formats.MODE.ASSEMBLE, formats.MODE.TRANSCODE]
        : [formats.MODE.TRANSCODE, formats.MODE.THUMBNAIL];

    for (const candidate of preferred) {
        if (modes.includes(candidate)) return candidate;
    }
    return modes[0];
}

function defaultVideoMode(targetFormat, mode) {
    if (!targetFormat) return STREAM_MODE.ENCODE;
    if (mode === formats.MODE.EXTRACT) return STREAM_MODE.DROP;
    if (targetFormat.kind === formats.KIND.AUDIO) return STREAM_MODE.DROP;
    return STREAM_MODE.ENCODE;
}

function defaultAudioMode(targetFormat, sourceExt) {
    if (!targetFormat) return STREAM_MODE.ENCODE;
    if (targetFormat.kind === formats.KIND.IMAGE) return STREAM_MODE.DROP;
    // An image source has no audio to carry, whichever mode it takes. This used
    // to test for ASSEMBLE, which missed an animated GIF now that one transcodes
    // into a video rather than being looped as a still.
    if (formats.kindOf(sourceExt) === formats.KIND.IMAGE) return STREAM_MODE.DROP;
    return STREAM_MODE.ENCODE;
}

function extnameOf(filePath) {
    const base = String(filePath).split(/[\\/]/).pop() ?? "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1) : "";
}

/**
 * Apply a partial patch to a job, merging nested sections rather than
 * replacing them. This is what bulk-editing a multi-card selection uses.
 */
function patchJob(job, patch = {}) {
    const next = { ...job };
    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === "object" && !Array.isArray(value) && typeof job[key] === "object" && job[key] !== null) {
            next[key] = { ...job[key], ...value };
        } else {
            next[key] = value;
        }
    }
    return next;
}

/**
 * Structural validation. Returns { valid, errors[] }. Metadata is deliberately
 * not required: a job is valid before its probe has returned, so cards can
 * render immediately and enrich later.
 */
function validateJob(job) {
    const errors = [];

    if (!job.inputPath) errors.push("Job has no input path.");
    if (!job.sourceExt) errors.push("Input file type is not recognised.");
    if (!job.output?.ext) errors.push("Job has no target format.");

    if (job.sourceExt && job.output?.ext) {
        if (!formats.canConvert(job.sourceExt, job.output.ext)) {
            errors.push(`Cannot convert ${job.sourceExt} to ${job.output.ext}.`);
        } else if (job.mode && !formats.allowedModes(job.sourceExt, job.output.ext).includes(job.mode)) {
            errors.push(`Mode "${job.mode}" is not valid for ${job.sourceExt} to ${job.output.ext}.`);
        }
    }

    const target = job.output?.ext ? formats.getFormat(job.output.ext) : null;

    if (job.video?.mode === STREAM_MODE.COPY && target && !target.supportsStreamCopy) {
        errors.push(`${target.label} does not support copying the video stream.`);
    }
    if (job.audio?.mode === STREAM_MODE.COPY && target && !target.supportsStreamCopy) {
        errors.push(`${target.label} does not support copying the audio stream.`);
    }
    if (job.video?.mode === STREAM_MODE.DROP && job.audio?.mode === STREAM_MODE.DROP) {
        errors.push("Both video and audio are set to be dropped, so there is nothing to write.");
    }

    if (job.video?.codec && target?.videoCodecs && !target.videoCodecs.includes(job.video.codec)) {
        errors.push(`${target.label} does not support the video codec "${job.video.codec}".`);
    }
    if (job.audio?.mode === STREAM_MODE.ENCODE && job.audio?.codec && target?.audioCodecs && !target.audioCodecs.includes(job.audio.codec)) {
        errors.push(`${target.label} does not support the audio codec "${job.audio.codec}".`);
    }

    const { start, end } = job.trim ?? {};
    if (start !== null && start !== undefined && start < 0) errors.push("Trim start cannot be negative.");
    if (start != null && end != null && end <= start) errors.push("Trim end must be after trim start.");

    if (job.output?.routing === OUTPUT_ROUTING.FIXED && !job.output.dir) {
        errors.push("A fixed output directory was selected but no directory was given.");
    }
    if (job.output?.routing === OUTPUT_ROUTING.MIRROR && !job.output.mirrorRoot) {
        errors.push("Mirrored output was selected but no source root was given.");
    }

    return { valid: errors.length === 0, errors };
}

/** True when this job writes a directory of files rather than a single file. */
function producesDirectory(job) {
    return formats.producesDirectory(job.mode);
}

module.exports = {
    defaultModeFor,
    STATUS,
    STREAM_MODE,
    CONFLICT,
    OUTPUT_ROUTING,
    generateId,
    createJob,
    patchJob,
    validateJob,
    producesDirectory,
};
