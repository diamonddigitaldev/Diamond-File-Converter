"use strict";

// Directory ingest.
//
// v1's only folder handling was a synchronous fs.readdirSync one level deep,
// inside the drop handler, on the UI thread, with nested subfolders enumerated
// and then silently discarded by the format lookup. This walks properly:
// async, recursive, depth-limited, and filtered by the format graph.

const fs = require("fs/promises");
const path = require("path");
const formats = require("./formats");

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_FILES = 20000;

/**
 * Walk a set of input paths and return the supported media files beneath them.
 *
 * @param {string[]} inputPaths  files and/or directories
 * @param {object}  [options]
 * @param {number}  [options.maxDepth]      how far to recurse (0 = the given dir only)
 * @param {number}  [options.maxFiles]      stop after this many matches
 * @param {string[]} [options.include]      extensions to keep (default: all supported)
 * @param {string[]} [options.exclude]      extensions to drop
 * @param {boolean} [options.followSymlinks]
 * @param {boolean} [options.recursive]     default true
 * @returns {Promise<{files: string[], skipped: object[], truncated: boolean, errors: object[], root: string|null}>}
 *
 * `skipped` carries a reason per file, not just a count — the caller has to be
 * able to say *which* files were dropped and why, and "unsupported" reads very
 * differently from "you turned that type off". Reason codes only: this module
 * has no business deciding how any of it is worded.
 */
async function scanPaths(inputPaths, options = {}) {
    const {
        maxDepth = DEFAULT_MAX_DEPTH,
        maxFiles = DEFAULT_MAX_FILES,
        include = null,
        exclude = null,
        followSymlinks = false,
        recursive = true,
    } = options;

    const includeSet = include ? new Set(include.map(e => formats.canonicalExt(e)).filter(Boolean)) : null;
    const excludeSet = exclude ? new Set(exclude.map(e => formats.canonicalExt(e)).filter(Boolean)) : null;

    const files = [];
    const errors = [];
    const skipped = [];
    const seen = new Set();
    let truncated = false;

    const accept = (filePath) => {
        const ext = formats.canonicalExt(path.extname(filePath));
        if (!ext) { skipped.push({ path: filePath, reason: "unsupported" }); return; }
        if (includeSet && !includeSet.has(ext)) { skipped.push({ path: filePath, reason: "not-included" }); return; }
        if (excludeSet && excludeSet.has(ext)) { skipped.push({ path: filePath, reason: "excluded" }); return; }

        // A file reached twice is not skipped. Nothing was dropped and there is
        // nothing to tell anyone — reporting it would be noise wearing the
        // clothes of thoroughness.
        const key = path.resolve(filePath).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);

        if (files.length >= maxFiles) { truncated = true; return; }
        files.push(filePath);
    };

    async function walk(dir, depth) {
        if (truncated) return;

        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
            errors.push({ path: dir, error: err.message });
            return;
        }

        // Files before directories, so a shallow ingest surfaces usable results
        // before it disappears into deep subtrees.
        const dirs = [];
        for (const entry of entries) {
            if (truncated) return;
            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                dirs.push(full);
            } else if (entry.isFile()) {
                accept(full);
            } else if (entry.isSymbolicLink() && followSymlinks) {
                try {
                    const stat = await fs.stat(full);
                    if (stat.isDirectory()) dirs.push(full);
                    else if (stat.isFile()) accept(full);
                } catch (err) {
                    errors.push({ path: full, error: err.message });
                }
            }
        }

        if (!recursive || depth >= maxDepth) return;
        for (const sub of dirs) {
            if (truncated) return;
            await walk(sub, depth + 1);
        }
    }

    const directories = [];
    for (const inputPath of inputPaths) {
        if (truncated) break;
        let stat;
        try {
            stat = await fs.stat(inputPath);
        } catch (err) {
            errors.push({ path: inputPath, error: err.message });
            continue;
        }
        if (stat.isDirectory()) { directories.push(inputPath); await walk(inputPath, 0); }
        else if (stat.isFile()) accept(inputPath);
    }

    // The root a mirrored output should rebuild from.
    //
    // Where a directory was handed in, that directory *is* the root — deriving
    // it from what was found gives the wrong answer in the ordinary case. Point
    // at E:\Photos holding only E:\Photos\2024\a.jpg and the common root of the
    // files is E:\Photos\2024, so the mirror silently drops the 2024 level,
    // which is the very structure the user asked to keep. Only a set of loose
    // files has no better answer than their shared ancestor.
    const root = directories.length > 0 ? commonDir(directories) : commonRoot(files);

    return { files, skipped, truncated, errors, root };
}

/** The shared leading path of a set of directories, or null if there is none. */
function commonDir(dirs) {
    if (!dirs || dirs.length === 0) return null;
    if (dirs.length === 1) return path.resolve(dirs[0]);

    const split = dirs.map(d => path.resolve(d).split(/[\\/]/));
    const first = split[0];
    const shared = [];

    for (let i = 0; i < first.length; i++) {
        const segment = first[i];
        if (split.every(parts => parts[i]?.toLowerCase() === segment.toLowerCase())) shared.push(segment);
        else break;
    }

    // Nothing shared means separate drives, which cannot be mirrored under one
    // root at all. resolveOutputDir treats a null root as plain fixed output.
    if (shared.length === 0) return null;
    // A drive-letter-only result ("E:") needs its separator back to be a path.
    return shared.length === 1 ? `${shared[0]}${path.sep}` : shared.join(path.sep);
}

/**
 * The common root of a set of *files*, used as the mirror root when an ingest
 * was a loose selection rather than a folder.
 */
function commonRoot(paths) {
    if (!paths || paths.length === 0) return null;
    return commonDir(paths.map(p => path.dirname(p)));
}

module.exports = {
    scanPaths,
    commonRoot,
    commonDir,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_FILES,
};
