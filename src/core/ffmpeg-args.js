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

// Six digits, not four: ffmpeg widens the field rather than truncating, so
// %04d runs frame_9999 straight into frame_10000 and the directory stops
// sorting in capture order exactly when there are enough frames to care.
const FRAME_PATTERN = "frame_%06d";
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

    // A single frame with no position asked for is taken from the middle. Frame
    // zero is a fade-in or a black slate often enough that it is the wrong
    // default for something whose entire purpose is to represent the video.
    const seek = (mode === formats.MODE.THUMBNAIL && start == null && job.inputMeta?.duration > 0)
        ? job.inputMeta.duration / 2
        : start;

    // Input-side seek. Fast and frame-accurate for re-encodes; with -c copy it
    // lands on the nearest preceding keyframe, which is inherent to remuxing.
    if (seek != null && seek > 0) {
        args.push("-ss", formatSeconds(seek));
    }

    if (mode === formats.MODE.ASSEMBLE) {
        // A single still looped into a clip of a fixed length.
        const fps = job.video?.fps ?? DEFAULT_ASSEMBLE_FPS;
        args.push("-loop", "1", "-framerate", String(fps), "-i", job.inputPath);
        args.push("-t", formatSeconds(durationOrDefault(job, DEFAULT_STILL_DURATION)));
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

    if (progress) {
        args.push("-progress", "pipe:1", "-nostats");
    }

    args.push(outputTarget);
    return args;
}

// -- Joining -----------------------------------------------------------------
//
// Two routes, and which one runs is a fact about the clips rather than a
// setting. Where every clip already agrees on container, codecs, size, frame
// rate and time base, the concat *demuxer* stitches them with -c copy: no
// re-encode, no quality loss, near-instant. Where they do not, the concat
// *filter* re-encodes, and every stream has to be normalised on the way in or
// the seams tear.

/**
 * The concat demuxer's playlist file.
 *
 * Kept separate from the argv because the demuxer needs this on disk before
 * ffmpeg starts, and this module does not touch the filesystem — the runner
 * writes what this returns and passes back the path it wrote it to.
 *
 * Trim survives on the copy path through inpoint/outpoint, which snap to the
 * nearest keyframe exactly as -ss does with -c copy elsewhere here.
 */
function buildConcatList(clips) {
    return (clips ?? []).map((clip) => {
        // ffmpeg's own escaping for this file: single quotes around the path,
        // and a quoted apostrophe closes, escapes and reopens.
        const lines = [`file '${String(clip.inputPath).replace(/'/g, "'\\''")}'`];
        const { start, end } = clip.trim ?? {};
        if (start != null && start > 0) lines.push(`inpoint ${formatSeconds(start)}`);
        if (end != null && end > 0) lines.push(`outpoint ${formatSeconds(end)}`);
        return lines.join("\n");
    }).join("\n") + "\n";
}

/**
 * @param {object} spec  { strategy, clips[], output: { ext, video, audio } }
 * @param {object} opts  { outputPath, listPath, progress, overwrite }
 * @returns {string[]}
 */
function buildJoinArgs(spec, opts = {}) {
    const { outputPath, listPath, progress = true, overwrite = true } = opts;
    if (!outputPath) throw new Error("buildJoinArgs requires an outputPath.");

    const target = formats.getFormat(spec.output?.ext);
    if (!target) throw new Error(`Unknown target format: ${spec.output?.ext}`);

    const clips = spec.clips ?? [];
    if (clips.length < 2) throw new Error("A join needs at least two clips.");

    const args = ["-hide_banner", "-nostdin"];
    args.push(overwrite ? "-y" : "-n");

    const wantsVideo = clips.some(c => c.hasVideo !== false);
    const wantsAudio = clips.some(c => c.hasAudio !== false);

    if (spec.strategy === "demuxer") {
        if (!listPath) throw new Error("A demuxer join requires a listPath.");
        // -safe 0 because the playlist holds absolute Windows paths, which the
        // demuxer refuses by default.
        args.push("-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy");
    } else {
        for (const clip of clips) {
            const { start, end } = clip.trim ?? {};
            if (start != null && start > 0) args.push("-ss", formatSeconds(start));
            // -t before -i limits what is read from *this* input, which keeps
            // the trim out of the filter graph entirely.
            if (end != null && end > (start ?? 0)) args.push("-t", formatSeconds(end - (start ?? 0)));
            args.push("-i", clip.inputPath);
        }

        args.push("-filter_complex", buildConcatChain(clips, spec, { wantsVideo, wantsAudio }));
        if (wantsVideo) args.push("-map", "[outv]");
        if (wantsAudio) args.push("-map", "[outa]");

        if (wantsVideo) {
            const codec = spec.output?.video?.codec ?? target.defaultVideoCodec;
            if (codec) args.push("-c:v", codec);
            pushVideoQuality(args, { video: spec.output?.video ?? {} }, codec);
            if (codec && PRESET_CODECS.has(codec) && spec.output?.video?.preset) {
                args.push("-preset", spec.output.video.preset);
            }
            if (codec && NEEDS_YUV420P.has(codec)) args.push("-pix_fmt", "yuv420p");
        }
        if (wantsAudio) {
            const codec = spec.output?.audio?.codec ?? target.defaultAudioCodec;
            if (codec) args.push("-c:a", codec);
            if (spec.output?.audio?.bitrate) args.push("-b:a", normaliseBitrate(spec.output.audio.bitrate));
        }
    }

    if (target.ext === "mp4" || target.ext === "mov") args.push("-movflags", "+faststart");
    if (progress) args.push("-progress", "pipe:1", "-nostats");

    args.push(outputPath);
    return args;
}

/**
 * The concat filter graph.
 *
 * One concat instance taking interleaved [v0][a0][v1][a1]… pairs, not one per
 * stream type — the two-instance v=1:a=0 / v=0:a=1 form belongs to a graph
 * compiler wiring arbitrary nodes together, and using it here would need an
 * extra pass to re-interleave what it split. Where a set is audio-only there is
 * only an audio chain, and that is the one case that reads v=0:a=1.
 *
 * The per-clip normalisation is what makes the re-encode path work at all: a
 * concat filter demands identical width, height, pixel format and sample rate
 * on every input, and simply produces a torn output if it does not get them.
 */
function buildConcatChain(clips, spec, { wantsVideo, wantsAudio }) {
    const width = spec.output?.video?.width ?? largest(clips, c => c.width);
    const height = spec.output?.video?.height ?? largest(clips, c => c.height);
    const fps = spec.output?.video?.fps ?? largest(clips, c => c.fps) ?? DEFAULT_ASSEMBLE_FPS;
    const rate = spec.output?.audio?.sampleRate ?? largest(clips, c => c.sampleRate) ?? 48000;

    const chains = [];
    const inputs = [];

    clips.forEach((_clip, i) => {
        if (wantsVideo) {
            const steps = [];
            if (width && height) {
                // Fit inside the frame and pad, rather than stretching a clip
                // that does not share the others' shape.
                steps.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
                steps.push(`pad=${width}:${height}:-1:-1:color=black`);
            }
            steps.push("setsar=1");
            steps.push(`fps=${fps}`);
            steps.push("format=yuv420p");
            chains.push(`[${i}:v]${steps.join(",")}[v${i}]`);
            inputs.push(`[v${i}]`);
        }
        if (wantsAudio) {
            chains.push(`[${i}:a]aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
            inputs.push(`[a${i}]`);
        }
    });

    const n = clips.length;
    const v = wantsVideo ? 1 : 0;
    const a = wantsAudio ? 1 : 0;
    const outputs = `${wantsVideo ? "[outv]" : ""}${wantsAudio ? "[outa]" : ""}`;
    chains.push(`${inputs.join("")}concat=n=${n}:v=${v}:a=${a}${outputs}`);

    return chains.join(";");
}

function largest(clips, pick) {
    const values = (clips ?? []).map(pick).filter(v => Number.isFinite(v) && v > 0);
    return values.length > 0 ? Math.max(...values) : null;
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
/*
 * Note for anyone adding GIF as a join target: this chain and the concat chain
 * both occupy -filter_complex, and the two cannot simply be stacked — the
 * palette pass would have to consume the concat's output label instead of
 * [0:v], which is a second graph shape to build, test and explain. GIF is left
 * out of joinTargets rather than half-supported.
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

/**
 * A second probe for a moving picture whose container gives no duration (an
 * animated GIF, with the bundled ffprobe): its first video stream's packets,
 * counted without decoding, and its frame rate. Each GIF packet is a frame.
 */
function buildFrameCountArgs(inputPath) {
    return [
        "-v", "quiet",
        "-print_format", "json",
        "-count_packets",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_packets,avg_frame_rate,r_frame_rate",
        inputPath,
    ];
}

module.exports = {
    buildArgs,
    buildJoinArgs,
    buildFrameCountArgs,
    buildConcatList,
    buildProbeArgs,
    buildVideoFilters,
    buildScaleFilter,
    normaliseBitrate,
    FRAME_PATTERN,
};
