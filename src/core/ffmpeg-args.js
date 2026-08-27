"use strict";

// ffmpeg argv construction.
//
// v1 delegated everything to fluent-ffmpeg and a single `.save(outputPath)`
// call, so the entire command was "read this, write that" and the output
// format was inferred from the file extension. This module builds the argv
// explicitly instead. It is a pure function of the job: no filesystem access,
// no spawning, no Electron. That is what makes it testable.

const path = require("path");
const formats = require("./formats");
const { STREAM_MODE } = require("./job");

// Codecs that take a constant-quality value via -crf. Everything else that
// supports a quality knob uses -q:v, which runs on an inverted scale.
const CRF_CODECS = new Set(["libx264", "libx265", "libsvtav1", "libvpx-vp9", "libvpx"]);
// Codecs whose -preset flag ffmpeg understands.
const PRESET_CODECS = new Set(["libx264", "libx265", "libsvtav1"]);
// Codecs that need an explicit 8-bit 4:2:0 pixel format for player compatibility.
const NEEDS_YUV420P = new Set(["libx264", "libx265"]);

const FRAME_PATTERN = "frame_%04d";
const DEFAULT_ASSEMBLE_FPS = 25;
const DEFAULT_STILL_DURATION = 5; // seconds, for one image looped into a video

/**
 * Build the complete ffmpeg argument list for a job.
 *
 * @param {object} job          a job from core/job.js
 * @param {object} opts
 * @param {string} opts.outputPath  resolved by core/paths.js. For frame
 *                                  extraction this is the output *directory*.
 * @param {boolean} [opts.progress] emit machine-readable progress on stdout
 * @param {boolean} [opts.overwrite] pass -y (default true; the conflict policy
 *                                  is resolved before we ever get here)
 * @returns {string[]}
 */
function buildArgs(job, opts = {}) {
    const { outputPath, progress = true, overwrite = true } = opts;
    if (!outputPath) throw new Error("buildArgs requires an outputPath.");

    const mode = job.mode ?? formats.MODE.TRANSCODE;
    const target = formats.getFormat(job.output.ext);
    if (!target) throw new Error(`Unknown target format: ${job.output.ext}`);

    const args = ["-hide_banner", "-nostdin"];
    args.push(overwrite ? "-y" : "-n");

    // -- Input ---------------------------------------------------------------

    const { start, end } = job.trim ?? {};

    // Input-side seek. Fast and frame-accurate for re-encodes; with -c copy it
    // lands on the nearest preceding keyframe, which is inherent to remuxing.
    if (start != null && start > 0) {
        args.push("-ss", formatSeconds(start));
    }

    if (mode === formats.MODE.ASSEMBLE) {
        const fps = job.video?.fps ?? DEFAULT_ASSEMBLE_FPS;
        if (job.inputIsSequence) {
            args.push("-framerate", String(fps), "-i", job.inputPath);
        } else {
            // A single still looped into a clip of a fixed length.
            args.push("-loop", "1", "-framerate", String(fps), "-i", job.inputPath);
            args.push("-t", formatSeconds(durationOrDefault(job, DEFAULT_STILL_DURATION)));
        }
    } else {
        args.push("-i", job.inputPath);
    }

    // Output-side duration. Paired with the input seek above, so it counts from
    // the seek point rather than from the start of the source.
    if (end != null && mode !== formats.MODE.ASSEMBLE) {
        const from = start ?? 0;
        if (end > from) args.push("-t", formatSeconds(end - from));
    }

    // -- Stream selection and filtering --------------------------------------

    const videoMode = job.video?.mode ?? STREAM_MODE.ENCODE;
    const audioMode = job.audio?.mode ?? STREAM_MODE.ENCODE;

    const wantsPalette = target.ext === "gif" && videoMode !== STREAM_MODE.DROP;
    const videoFilters = buildVideoFilters(job, mode);

    if (wantsPalette) {
        // A generated palette is the difference between a usable GIF and a
        // 256-colour mess, and it is the one place the simple -vf chain cannot
        // express what we need.
        args.push("-filter_complex", buildPaletteChain(videoFilters));
    } else if (videoFilters.length > 0 && videoMode !== STREAM_MODE.DROP) {
        args.push("-vf", videoFilters.join(","));
    }

    // -- Video ---------------------------------------------------------------

    if (videoMode === STREAM_MODE.DROP || mode === formats.MODE.EXTRACT) {
        args.push("-vn");
    } else if (videoMode === STREAM_MODE.COPY) {
        args.push("-c:v", "copy");
    } else {
        const codec = job.video?.codec ?? target.defaultVideoCodec;
        if (codec) args.push("-c:v", codec);

        if (target.kind === formats.KIND.IMAGE) {
            pushImageQuality(args, job, target);
        } else {
            pushVideoQuality(args, job, codec);
        }

        if (codec && PRESET_CODECS.has(codec) && job.video?.preset) {
            args.push("-preset", job.video.preset);
        }
        if (codec && NEEDS_YUV420P.has(codec)) {
            args.push("-pix_fmt", "yuv420p");
        }
    }

    // -- Audio ---------------------------------------------------------------

    const targetTakesAudio = target.kind !== formats.KIND.IMAGE;

    if (!targetTakesAudio || audioMode === STREAM_MODE.DROP) {
        args.push("-an");
    } else if (audioMode === STREAM_MODE.COPY) {
        args.push("-c:a", "copy");
    } else {
        const codec = job.audio?.codec ?? target.defaultAudioCodec;
        if (codec) args.push("-c:a", codec);
        if (job.audio?.bitrate) args.push("-b:a", normaliseBitrate(job.audio.bitrate));
        if (job.audio?.sampleRate) args.push("-ar", String(job.audio.sampleRate));
        if (job.audio?.channels) args.push("-ac", String(job.audio.channels));
    }

    // -- Mode-specific output shaping ----------------------------------------

    let outputTarget = outputPath;

    if (mode === formats.MODE.FRAMES) {
        // Every frame, written into a directory. -fps_mode passthrough keeps
        // the source cadence instead of resampling it.
        args.push("-fps_mode", "passthrough");
        outputTarget = path.join(outputPath, `${FRAME_PATTERN}.${target.ext}`);
    } else if (mode === formats.MODE.THUMBNAIL) {
        args.push("-frames:v", "1", "-update", "1");
    }

    if (target.ext === "mp4" || target.ext === "mov") {
        // Move the index to the front so the file is streamable / seekable
        // before it has fully downloaded.
        args.push("-movflags", "+faststart");
    }

    // Extra raw filters carried on the job, and anything a pipeline appended.
    if (Array.isArray(job.extraArgs) && job.extraArgs.length > 0) {
        args.push(...job.extraArgs.map(String));
    }

    if (progress) {
        args.push("-progress", "pipe:1", "-nostats");
    }

    args.push(outputTarget);
    return args;
}

/** The video filter chain, in application order. */
function buildVideoFilters(job, mode) {
    const filters = [];

    const scale = buildScaleFilter(job);
    if (scale) filters.push(scale);

    // fps is an input flag for assembly, so only apply it as a filter elsewhere.
    if (job.video?.fps && mode !== formats.MODE.ASSEMBLE) {
        filters.push(`fps=${job.video.fps}`);
    }

    if (Array.isArray(job.filters)) {
        for (const f of job.filters) {
            if (typeof f === "string" && f.trim()) filters.push(f.trim());
        }
    }

    return filters;
}

function buildScaleFilter(job) {
    const width = job.video?.width ?? null;
    const height = job.video?.height ?? null;
    const scale = job.image?.scale ?? null;

    if (scale && !width && !height) {
        // Proportional resize. -2 keeps the result divisible by two, which
        // most codecs require.
        return `scale=iw*${scale}:-2`;
    }
    if (!width && !height) return null;

    // -2 rather than -1 on the free axis, for the same divisibility reason.
    if (width && !height) return `scale=${width}:-2`;
    if (!width && height) return `scale=-2:${height}`;

    switch (job.video?.fitMode) {
        case "stretch":
            return `scale=${width}:${height}`;
        case "cover":
            return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
        case "contain":
        default:
            return `scale=${width}:${height}:force_original_aspect_ratio=decrease`;
    }
}

/**
 * GIF output split into a palette pass and an application pass. With no
 * preceding filters the chain still needs an explicit [0:v] label.
 */
function buildPaletteChain(videoFilters) {
    const pre = videoFilters.length > 0 ? `${videoFilters.join(",")},` : "";
    return `[0:v] ${pre}split[pal_a][pal_b];[pal_a]palettegen[pal];[pal_b][pal]paletteuse`;
}

function pushVideoQuality(args, job, codec) {
    const crf = job.video?.crf;
    const bitrate = job.video?.bitrate;

    if (crf != null && codec && CRF_CODECS.has(codec)) {
        args.push("-crf", String(crf));
        // VP9 treats -crf as a cap unless the target bitrate is released.
        if (codec === "libvpx-vp9" || codec === "libvpx") args.push("-b:v", "0");
        return;
    }
    if (bitrate) {
        args.push("-b:v", normaliseBitrate(bitrate));
        return;
    }
    if (crf != null) {
        // Codecs without -crf still take the inverted -q:v scale.
        args.push("-q:v", String(crf));
    }
}

function pushImageQuality(args, job, target) {
    const quality = job.image?.quality;
    if (quality == null || !target.quality) return;
    const { flag, min, max } = target.quality;
    args.push(flag, String(clamp(quality, min, max)));
}

/** Accepts 320, "320", "320k" or "320000" and returns an ffmpeg bitrate string. */
function normaliseBitrate(value) {
    if (typeof value === "string" && /[km]$/i.test(value.trim())) return value.trim().toLowerCase();
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    // Anything this large was given in bits per second already.
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    return `${Math.round(n)}k`;
}

/** Seconds as a plain decimal; ffmpeg accepts this everywhere it accepts a time. */
function formatSeconds(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return "0";
    return String(Math.round(n * 1000) / 1000);
}

function durationOrDefault(job, fallback) {
    const { start, end } = job.trim ?? {};
    if (start != null && end != null && end > start) return end - start;
    if (end != null) return end;
    return fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value)));
}

/** ffprobe argv for a single file. Kept here so both binaries are described together. */
function buildProbeArgs(inputPath) {
    return [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        inputPath,
    ];
}

module.exports = {
    buildArgs,
    buildProbeArgs,
    buildVideoFilters,
    buildScaleFilter,
    normaliseBitrate,
    FRAME_PATTERN,
};
