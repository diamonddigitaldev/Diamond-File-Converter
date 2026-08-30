"use strict";

// ffprobe wrapper.
//
// v1 never set an ffprobe path and never shipped the binary, so no metadata
// was available anywhere in the app. Probing here is treated as *enrichment*,
// not a precondition: a failed probe returns a result with `ok: false` and the
// job stays runnable. Cards render filename and size immediately and fill in
// duration, resolution and codecs when this resolves.

const { execFile } = require("child_process");
const { buildProbeArgs } = require("./ffmpeg-args");

const PROBE_TIMEOUT_MS = 30000;
const MAX_BUFFER = 8 * 1024 * 1024;

let ffprobePath = null;

function setFfprobePath(binaryPath) {
    ffprobePath = binaryPath;
}

function getFfprobePath() {
    return ffprobePath;
}

/**
 * Probe a single file.
 * Always resolves; never rejects. Check `.ok` before trusting the fields.
 */
function probe(inputPath) {
    return new Promise((resolve) => {
        if (!ffprobePath) {
            resolve({ ok: false, error: "ffprobe path has not been configured.", inputPath });
            return;
        }

        execFile(
            ffprobePath,
            buildProbeArgs(inputPath),
            { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
            (err, stdout) => {
                if (err) {
                    resolve({ ok: false, error: err.message, inputPath });
                    return;
                }
                try {
                    resolve(normalise(JSON.parse(stdout), inputPath));
                } catch (parseErr) {
                    resolve({ ok: false, error: `Could not parse ffprobe output: ${parseErr.message}`, inputPath });
                }
            }
        );
    });
}

/** Flatten ffprobe's raw JSON into the shape the UI actually binds to. */
function normalise(raw, inputPath) {
    const streams = Array.isArray(raw.streams) ? raw.streams : [];
    const format = raw.format ?? {};

    const videoStreams = streams.filter(s => s.codec_type === "video");
    const audioStreams = streams.filter(s => s.codec_type === "audio");
    const subtitleStreams = streams.filter(s => s.codec_type === "subtitle");

    // Cover art and other attached stills report as video streams with a
    // single frame. Treating those as "this file has video" would put a
    // resolution badge on an MP3, so they are separated out.
    const motionStreams = videoStreams.filter(s => !isAttachedPicture(s));
    const primaryVideo = motionStreams[0] ?? null;
    const primaryAudio = audioStreams[0] ?? null;

    const duration = toNumber(format.duration)
        ?? toNumber(primaryVideo?.duration)
        ?? toNumber(primaryAudio?.duration)
        ?? null;

    return {
        ok: true,
        inputPath,
        duration,
        size: toNumber(format.size),
        bitrate: toNumber(format.bit_rate),
        formatName: format.format_name ?? null,
        hasVideo: motionStreams.length > 0,
        // Whether this file actually moves, which decides how a conversion out
        // of it should behave. Read from the raw stream rather than from
        // `hasVideo`, so it stays right regardless of how cover art is judged:
        // a single frame has no average frame rate and no duration.
        isStill: videoStreams.length > 0
            && !(parseFrameRate(videoStreams[0].avg_frame_rate) > 0)
            && !(duration > 0),
        hasAudio: audioStreams.length > 0,
        hasSubtitles: subtitleStreams.length > 0,

        video: primaryVideo ? {
            codec: primaryVideo.codec_name ?? null,
            width: toNumber(primaryVideo.width),
            height: toNumber(primaryVideo.height),
            fps: parseFrameRate(primaryVideo.avg_frame_rate) ?? parseFrameRate(primaryVideo.r_frame_rate),
            pixelFormat: primaryVideo.pix_fmt ?? null,
            bitrate: toNumber(primaryVideo.bit_rate),
        } : null,

        audio: primaryAudio ? {
            codec: primaryAudio.codec_name ?? null,
            sampleRate: toNumber(primaryAudio.sample_rate),
            channels: toNumber(primaryAudio.channels),
            channelLayout: primaryAudio.channel_layout ?? null,
            bitrate: toNumber(primaryAudio.bit_rate),
        } : null,

        streamCounts: {
            video: motionStreams.length,
            audio: audioStreams.length,
            subtitle: subtitleStreams.length,
        },
    };
}

// Codecs that may carry either one picture or many, so the frame rate has to
// decide which this is.
const STILL_CODECS = ["mjpeg", "png", "bmp", "gif", "webp", "tiff"];

function isAttachedPicture(stream) {
    if (stream.disposition?.attached_pic === 1) return true;
    // A still carried inside a media container reports as a video stream with
    // no meaningful average frame rate — ffprobe writes "0/0". That is what
    // keeps a resolution badge off an MP3 which happens to embed cover art.
    //
    // This test used to be inverted: it called a stream cover art precisely
    // when it *did* have a frame rate, so an animated GIF was reported as
    // having no video at all while a still WebP was credited with 25fps from
    // the r_frame_rate fallback below.
    return STILL_CODECS.includes(stream.codec_name) && !(parseFrameRate(stream.avg_frame_rate) > 0);
}

/** ffprobe reports frame rates as "30000/1001" rationals. */
function parseFrameRate(value) {
    if (typeof value !== "string" || !value.includes("/")) return null;
    const [num, den] = value.split("/").map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
    const fps = num / den;
    if (fps <= 0) return null;
    return Math.round(fps * 1000) / 1000;
}

function toNumber(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

module.exports = {
    setFfprobePath,
    getFfprobePath,
    probe,
    normalise,
    parseFrameRate,
};
