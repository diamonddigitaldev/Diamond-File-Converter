const APP_NAME = "Diamond File Converter";

const LOG = {
    ERROR: "ERROR",
    WARN:  "WARN",
    INFO:  "INFO",
    DEBUG: "DEBUG",
};

// ipc channel names
const IPC = {
    GET_VERSION:           "get-version",
    GET_SETTING:           "get-setting",
    SET_SETTING:           "set-setting",
    UPDATE_AVAILABLE:      "update-available",
    BROWSE_FILE:           "browse-file",
    CONVERT_FILE:          "convert-file",
    CANCEL_CONVERT:        "cancel-convert",
    OPEN_FOLDER:           "open-folder",
    SHOW_IN_FOLDER:        "show-in-folder",
    CONVERSION_PROGRESS:   "conversion-progress",   // push: percent (0-100)
    FILE_OPENED_FROM_MENU: "file-opened-from-menu", // push: file path string
};

// window size constraints
const WINDOW = {
    DEFAULT_WIDTH:  700,
    DEFAULT_HEIGHT: 1000,
    MIN_WIDTH:      600,
    MIN_HEIGHT:     600,
};

// to add a new format, add an entry with ext and label to the appropriate array
// to add a new format, group add a new array and call buildEntries in CONVERSION_MAP
const AUDIO_FORMATS = [
    { ext: "mp3",  label: "MP3"  },
    { ext: "wav",  label: "WAV"  },
    { ext: "flac", label: "FLAC" },
    { ext: "ogg",  label: "OGG"  },
    { ext: "aac",  label: "AAC"  },
    { ext: "m4a",  label: "M4A"  },
    { ext: "opus", label: "OPUS" },
    { ext: "wma",  label: "WMA"  },
];

const VIDEO_FORMATS = [
    { ext: "mp4",  label: "MP4"  },
    { ext: "mkv",  label: "MKV"  },
    { ext: "webm", label: "WebM" },
    { ext: "avi",  label: "AVI"  },
    { ext: "mov",  label: "MOV"  },
    { ext: "wmv",  label: "WMV"  },
    { ext: "flv",  label: "FLV"  },
];

const IMAGE_FORMATS = [
    { ext: "jpg",  label: "JPG"  },
    { ext: "png",  label: "PNG"  },
    { ext: "webp", label: "WebP" },
    { ext: "gif",  label: "GIF"  },
    { ext: "bmp",  label: "BMP"  },
    { ext: "tiff", label: "TIFF" },
];

function buildEntries(formats, type, group) {
    const entries = {};
    for (const fmt of formats) {
        entries[fmt.ext] = {
            type,
            targets: formats.map(f => ({ ...f, group }))
        };
    }
    return entries;
}

const CONVERSION_MAP = {
    ...buildEntries(AUDIO_FORMATS, "audio", "Audio"),
    ...buildEntries(VIDEO_FORMATS, "video", "Video"),
    ...buildEntries(IMAGE_FORMATS, "image", "Image"),
};

const SUPPORTED_EXTENSIONS = Object.keys(CONVERSION_MAP);

// extension aliases, maps alternate extensions to their canonical key in CONVERSION_MAP
const EXT_ALIASES = {
    jpeg: "jpg",
    tif:  "tiff",
    jfif: "jpg",
};

const STATIC_IMAGE_EXTS = new Set(["jpg", "png", "webp", "bmp", "tiff"]);

function isGifToStaticImage(sourceExt, targetExt) {
    return sourceExt === "gif" && STATIC_IMAGE_EXTS.has(targetExt);
}

module.exports = { APP_NAME, IPC, WINDOW, LOG, AUDIO_FORMATS, VIDEO_FORMATS, IMAGE_FORMATS, CONVERSION_MAP, SUPPORTED_EXTENSIONS, EXT_ALIASES, isGifToStaticImage };
