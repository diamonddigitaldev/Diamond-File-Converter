"use strict";

// Format capability graph.
//
// This replaces the within-group cross-product that v1 used (buildEntries in
// constants.js), which made cross-kind conversions such as video -> audio
// structurally impossible to express. Here every format carries its own
// capability flags, and the legal conversions between two formats are derived
// from their kinds rather than assumed.

const KIND = {
    AUDIO: "audio",
    VIDEO: "video",
    IMAGE: "image",
};

// How a conversion is carried out. The mode decides the overall shape of the
// ffmpeg invocation, and whether the output is a single file or a directory.
const MODE = {
    TRANSCODE: "transcode", // same kind in, same kind out
    EXTRACT:   "extract",   // video in, audio out (video streams dropped)
    FRAMES:    "frames",    // moving picture in, image sequence out (dir output)
    THUMBNAIL: "thumbnail", // moving picture in, one still out at a timestamp
    ASSEMBLE:  "assemble",  // image(s) in, video out
};

// Modes whose output is a directory of files rather than a single file.
const DIRECTORY_MODES = new Set([MODE.FRAMES]);

const FORMATS = {
    // -- Audio ---------------------------------------------------------------
    mp3: {
        ext: "mp3", label: "MP3", kind: KIND.AUDIO,
        audioCodecs: ["libmp3lame"], defaultAudioCodec: "libmp3lame",
        supportsStreamCopy: true, lossless: false,
    },
    wav: {
        ext: "wav", label: "WAV", kind: KIND.AUDIO,
        audioCodecs: ["pcm_s16le", "pcm_s24le", "pcm_f32le"], defaultAudioCodec: "pcm_s16le",
        supportsStreamCopy: true, lossless: true,
    },
    flac: {
        ext: "flac", label: "FLAC", kind: KIND.AUDIO,
        audioCodecs: ["flac"], defaultAudioCodec: "flac",
        supportsStreamCopy: true, lossless: true,
    },
    ogg: {
        ext: "ogg", label: "OGG", kind: KIND.AUDIO,
        audioCodecs: ["libvorbis", "libopus"], defaultAudioCodec: "libvorbis",
        supportsStreamCopy: true, lossless: false,
    },
    aac: {
        ext: "aac", label: "AAC", kind: KIND.AUDIO,
        audioCodecs: ["aac"], defaultAudioCodec: "aac",
        supportsStreamCopy: true, lossless: false,
    },
    m4a: {
        ext: "m4a", label: "M4A", kind: KIND.AUDIO,
        audioCodecs: ["aac", "alac"], defaultAudioCodec: "aac",
        supportsStreamCopy: true, lossless: false,
    },
    opus: {
        ext: "opus", label: "OPUS", kind: KIND.AUDIO,
        audioCodecs: ["libopus"], defaultAudioCodec: "libopus",
        supportsStreamCopy: true, lossless: false,
    },
    wma: {
        ext: "wma", label: "WMA", kind: KIND.AUDIO,
        audioCodecs: ["wmav2"], defaultAudioCodec: "wmav2",
        supportsStreamCopy: true, lossless: false,
    },

    // -- Video ---------------------------------------------------------------
    mp4: {
        ext: "mp4", label: "MP4", kind: KIND.VIDEO,
        videoCodecs: ["libx264", "libx265", "libsvtav1", "mpeg4"], defaultVideoCodec: "libx264",
        audioCodecs: ["aac", "libmp3lame", "ac3"], defaultAudioCodec: "aac",
        supportsStreamCopy: true, supportsAlpha: false,
    },
    mkv: {
        ext: "mkv", label: "MKV", kind: KIND.VIDEO,
        videoCodecs: ["libx264", "libx265", "libvpx-vp9", "libsvtav1"], defaultVideoCodec: "libx264",
        audioCodecs: ["aac", "libmp3lame", "libopus", "flac", "ac3"], defaultAudioCodec: "aac",
        supportsStreamCopy: true, supportsAlpha: false,
    },
    webm: {
        ext: "webm", label: "WebM", kind: KIND.VIDEO,
        videoCodecs: ["libvpx-vp9", "libvpx", "libsvtav1"], defaultVideoCodec: "libvpx-vp9",
        audioCodecs: ["libopus", "libvorbis"], defaultAudioCodec: "libopus",
        supportsStreamCopy: true, supportsAlpha: true,
    },
    avi: {
        ext: "avi", label: "AVI", kind: KIND.VIDEO,
        videoCodecs: ["mpeg4", "libx264", "mjpeg"], defaultVideoCodec: "mpeg4",
        audioCodecs: ["libmp3lame", "ac3", "pcm_s16le"], defaultAudioCodec: "libmp3lame",
        supportsStreamCopy: true, supportsAlpha: false,
    },
    mov: {
        ext: "mov", label: "MOV", kind: KIND.VIDEO,
        videoCodecs: ["libx264", "libx265", "prores_ks", "mjpeg"], defaultVideoCodec: "libx264",
        audioCodecs: ["aac", "alac", "pcm_s16le"], defaultAudioCodec: "aac",
        supportsStreamCopy: true, supportsAlpha: false,
    },
    wmv: {
        ext: "wmv", label: "WMV", kind: KIND.VIDEO,
        videoCodecs: ["wmv2", "msmpeg4v3"], defaultVideoCodec: "wmv2",
        audioCodecs: ["wmav2"], defaultAudioCodec: "wmav2",
        supportsStreamCopy: true, supportsAlpha: false,
    },
    flv: {
        ext: "flv", label: "FLV", kind: KIND.VIDEO,
        videoCodecs: ["libx264", "flv"], defaultVideoCodec: "libx264",
        audioCodecs: ["libmp3lame", "aac"], defaultAudioCodec: "libmp3lame",
        supportsStreamCopy: true, supportsAlpha: false,
    },

    // -- Image ---------------------------------------------------------------
    jpg: {
        ext: "jpg", label: "JPG", kind: KIND.IMAGE,
        videoCodecs: ["mjpeg"], defaultVideoCodec: "mjpeg",
        supportsStreamCopy: false, supportsAlpha: false, animated: false,
        // ffmpeg -q:v for mjpeg runs 2 (best) to 31 (worst)
        quality: { flag: "-q:v", min: 2, max: 31, default: 3, inverted: true },
    },
    png: {
        ext: "png", label: "PNG", kind: KIND.IMAGE,
        videoCodecs: ["png"], defaultVideoCodec: "png",
        supportsStreamCopy: false, supportsAlpha: true, animated: false, lossless: true,
        quality: { flag: "-compression_level", min: 0, max: 9, default: 6, inverted: false },
    },
    webp: {
        ext: "webp", label: "WebP", kind: KIND.IMAGE,
        videoCodecs: ["libwebp"], defaultVideoCodec: "libwebp",
        supportsStreamCopy: false, supportsAlpha: true, animated: true,
        quality: { flag: "-quality", min: 0, max: 100, default: 80, inverted: false },
    },
    gif: {
        ext: "gif", label: "GIF", kind: KIND.IMAGE,
        videoCodecs: ["gif"], defaultVideoCodec: "gif",
        supportsStreamCopy: false, supportsAlpha: true, animated: true,
    },
    bmp: {
        ext: "bmp", label: "BMP", kind: KIND.IMAGE,
        videoCodecs: ["bmp"], defaultVideoCodec: "bmp",
        supportsStreamCopy: false, supportsAlpha: false, animated: false, lossless: true,
    },
    tiff: {
        ext: "tiff", label: "TIFF", kind: KIND.IMAGE,
        videoCodecs: ["tiff"], defaultVideoCodec: "tiff",
        supportsStreamCopy: false, supportsAlpha: true, animated: false, lossless: true,
    },
};

// Alternate extensions mapped onto their canonical key. Carried over from v1.
const EXT_ALIASES = {
    jpeg: "jpg",
    tif:  "tiff",
    jfif: "jpg",
};

const SUPPORTED_EXTENSIONS = Object.keys(FORMATS);

/** Resolve a raw extension (with or without a leading dot) to a canonical key. */
function canonicalExt(raw) {
    if (typeof raw !== "string") return null;
    const cleaned = raw.replace(/^\./, "").toLowerCase();
    const resolved = EXT_ALIASES[cleaned] ?? cleaned;
    return FORMATS[resolved] ? resolved : null;
}

function getFormat(ext) {
    const key = canonicalExt(ext);
    return key ? FORMATS[key] : null;
}

function kindOf(ext) {
    return getFormat(ext)?.kind ?? null;
}

function isSupported(ext) {
    return canonicalExt(ext) !== null;
}

/**
 * Every mode by which `fromExt` may legally become `toExt`, most useful first.
 * An empty array means the conversion is not supported.
 */
function allowedModes(fromExt, toExt) {
    const from = getFormat(fromExt);
    const to = getFormat(toExt);
    if (!from || !to) return [];

    const modes = [];

    if (from.kind === to.kind) {
        // An animated source landing in a single-frame target cannot be one
        // file, so it explodes into a sequence instead. This subsumes the
        // gif -> static special case that v1 hardcoded in main.js.
        if (from.kind === KIND.IMAGE && from.animated && !to.animated) {
            modes.push(MODE.FRAMES, MODE.THUMBNAIL);
        } else {
            modes.push(MODE.TRANSCODE);
        }
    } else if (from.kind === KIND.VIDEO && to.kind === KIND.AUDIO) {
        modes.push(MODE.EXTRACT);
    } else if (from.kind === KIND.VIDEO && to.kind === KIND.IMAGE) {
        // A still target gets one frame or all of them; an animated target
        // (gif, animated webp) can hold the motion directly.
        if (to.animated) modes.push(MODE.TRANSCODE, MODE.FRAMES, MODE.THUMBNAIL);
        else modes.push(MODE.FRAMES, MODE.THUMBNAIL);
    } else if (from.kind === KIND.IMAGE && to.kind === KIND.VIDEO) {
        // A container that can hold an animation (gif, webp) is transcoded so
        // the motion survives. Assembling it would treat the whole animation as
        // a single still and loop that instead. A plain still has only the
        // second option, and defaultModeFor() picks between them once a probe
        // has said whether this particular file actually moves.
        if (from.animated) modes.push(MODE.TRANSCODE, MODE.ASSEMBLE);
        else modes.push(MODE.ASSEMBLE);
    }

    return modes;
}

function defaultMode(fromExt, toExt) {
    return allowedModes(fromExt, toExt)[0] ?? null;
}

function canConvert(fromExt, toExt) {
    return allowedModes(fromExt, toExt).length > 0;
}

function producesDirectory(mode) {
    return DIRECTORY_MODES.has(mode);
}

/** Every format `ext` can be converted into, as UI-ready descriptors. */
function targetsFor(ext) {
    const from = getFormat(ext);
    if (!from) return [];

    const targets = [];
    for (const to of Object.values(FORMATS)) {
        const modes = allowedModes(from.ext, to.ext);
        if (modes.length === 0) continue;
        targets.push({
            ext: to.ext,
            label: to.label,
            kind: to.kind,
            group: to.kind.charAt(0).toUpperCase() + to.kind.slice(1),
            modes,
            mode: modes[0],
            sameKind: to.kind === from.kind,
        });
    }
    return targets;
}

/**
 * `{ [ext]: { type } }` — what the renderer needs to decide whether a dropped
 * file is supported at all, and which kind icon to put on its card.
 *
 * It used to carry a same-kind-filtered `targets` array as well, from when the
 * grid was ported from v1. Nothing has read that since target lists moved to
 * the full capability graph in targetsFor(), so it is gone rather than sitting
 * there implying the UI is still same-kind only.
 */
function buildLegacyConversionMap() {
    const map = {};
    for (const from of Object.values(FORMATS)) {
        map[from.ext] = { type: from.kind };
    }
    return map;
}

module.exports = {
    KIND,
    MODE,
    FORMATS,
    EXT_ALIASES,
    SUPPORTED_EXTENSIONS,
    canonicalExt,
    getFormat,
    kindOf,
    isSupported,
    allowedModes,
    defaultMode,
    canConvert,
    producesDirectory,
    targetsFor,
    buildLegacyConversionMap,
};
