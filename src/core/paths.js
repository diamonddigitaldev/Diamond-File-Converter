"use strict";

// Output path resolution.
//
// v1 hardcoded the output directory to the input's own directory in both
// branches of the convert handler, so there was no destination concept at all.
// This module owns routing, name templating and conflict resolution.

const fs = require("fs");
const path = require("path");

const { OUTPUT_ROUTING, CONFLICT } = require("./job");
const formats = require("./formats");

/**
 * The next free filename: "file (1).ext", "file (2).ext", ...
 * Lifted unchanged from main.js so existing behaviour is preserved exactly.
 */
function getUniquePath(filePath) {
    if (!fs.existsSync(filePath)) return filePath;
    const ext = path.extname(filePath);
    const stem = path.basename(filePath, ext);
    const dir = path.dirname(filePath);
    let i = 1;
    let candidate;
    do {
        candidate = path.join(dir, `${stem} (${i})${ext}`);
        i++;
    } while (fs.existsSync(candidate));
    return candidate;
}

/** The next free directory name: "dir (1)", "dir (2)", ... */
function getUniqueDirPath(dirPath) {
    if (!fs.existsSync(dirPath)) return dirPath;
    let i = 1;
    let candidate;
    do {
        candidate = `${dirPath} (${i})`;
        i++;
    } while (fs.existsSync(candidate));
    return candidate;
}

/**
 * Expand a name template. Supported tokens:
 *   {name}   input basename without extension
 *   {ext}    target extension, no dot
 *   {src}    source extension, no dot
 *   {index}  1-based position in the batch
 *   {date}   YYYY-MM-DD
 *   {time}   HHMMSS
 *   {preset} preset name, or "" when the job has none
 * Unknown tokens are left alone rather than silently blanked, so a typo is
 * visible in the output filename instead of vanishing.
 */
function applyNameTemplate(template, context) {
    const now = context.now instanceof Date ? context.now : new Date();
    const pad = (n) => String(n).padStart(2, "0");

    const values = {
        name:   context.name ?? "",
        ext:    context.ext ?? "",
        src:    context.src ?? "",
        index:  context.index != null ? String(context.index) : "",
        date:   `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        time:   `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
        preset: context.preset ?? "",
    };

    return String(template ?? "{name}").replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
    );
}

/** Strip characters Windows will not accept in a filename. */
function sanitiseName(name) {
    return String(name)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/, "")
        .trim() || "output";
}

/** The directory a job's output belongs in, before conflict resolution. */
function resolveOutputDir(job) {
    const inputDir = path.dirname(job.inputPath);
    const routing = job.output?.routing ?? OUTPUT_ROUTING.ALONGSIDE;

    switch (routing) {
        case OUTPUT_ROUTING.FIXED:
            return job.output.dir ?? inputDir;

        case OUTPUT_ROUTING.MIRROR: {
            // Rebuild the input's position under the source root inside the
            // destination, so a nested folder ingest keeps its shape.
            const root = job.output.mirrorRoot;
            const dest = job.output.dir ?? inputDir;
            if (!root) return dest;
            const relative = path.relative(root, inputDir);
            if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return dest;
            return path.join(dest, relative);
        }

        case OUTPUT_ROUTING.ALONGSIDE:
        default:
            return inputDir;
    }
}

/**
 * Resolve the final output path for a job.
 *
 * Returns { outputPath, isDirectory, action } where action is "write",
 * "skip" or "ask". "ask" means the caller has to prompt, which is the one
 * decision this module deliberately does not make on its own.
 */
function resolveOutputPath(job, context = {}) {
    const targetExt = job.output.ext;
    const dir = resolveOutputDir(job);
    const inputExt = path.extname(job.inputPath);
    const stem = path.basename(job.inputPath, inputExt);

    const name = sanitiseName(applyNameTemplate(job.output.nameTemplate, {
        name: stem,
        ext: targetExt,
        src: job.sourceExt ?? inputExt.replace(/^\./, ""),
        index: context.index,
        preset: context.preset,
        now: context.now,
    }));

    const isDirectory = formats.producesDirectory(job.mode);
    const candidate = isDirectory ? path.join(dir, name) : path.join(dir, `${name}.${targetExt}`);

    const exists = fs.existsSync(candidate);
    if (!exists) return { outputPath: candidate, isDirectory, action: "write" };

    switch (job.output.onConflict) {
        case CONFLICT.OVERWRITE:
            return { outputPath: candidate, isDirectory, action: "write" };
        case CONFLICT.SKIP:
            return { outputPath: candidate, isDirectory, action: "skip" };
        case CONFLICT.ASK:
            return { outputPath: candidate, isDirectory, action: "ask" };
        case CONFLICT.UNIQUE:
        default:
            return {
                outputPath: isDirectory ? getUniqueDirPath(candidate) : getUniquePath(candidate),
                isDirectory,
                action: "write",
            };
    }
}

/** Create the directory an output will be written into. */
function ensureParentDir(outputPath, isDirectory) {
    const dir = isDirectory ? outputPath : path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = {
    getUniquePath,
    getUniqueDirPath,
    applyNameTemplate,
    sanitiseName,
    resolveOutputDir,
    resolveOutputPath,
    ensureParentDir,
};
