"use strict";

// The job runner.
//
// v1 ran a strictly sequential `for await` loop in the renderer against a
// single `activeConversion` global in main, so there was exactly one ffmpeg
// process, no per-job identity, and cancel was all-or-nothing. This runner
// owns a concurrency pool, gives every job an id, and can cancel one job
// without touching the others.

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");

const { STATUS } = require("./job");
const { buildArgs } = require("./ffmpeg-args");
const paths = require("./paths");

function defaultConcurrency() {
    const cpus = os.cpus()?.length ?? 2;
    return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
}

class JobRunner extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.ffmpegPath
     * @param {number} [options.concurrency]
     * @param {(job, candidatePath) => Promise<{action: string, outputPath?: string}>} [options.conflictResolver]
     *        Called when a job's conflict policy is "ask". Must resolve to
     *        { action: "write" | "skip" | "cancel", outputPath }.
     */
    constructor(options = {}) {
        super();
        this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
        this.concurrency = options.concurrency ?? defaultConcurrency();
        this.conflictResolver = options.conflictResolver ?? null;

        this.queue = [];              // jobs waiting to start
        this.active = new Map();      // jobId -> { job, child, outputPath, isDirectory }
        this.results = new Map();     // jobId -> result
        this.running = false;
        this.paused = false;
        this._cancelledAll = false;
    }

    setConcurrency(n) {
        this.concurrency = Math.max(1, Number(n) || 1);
        if (this.running && !this.paused) this._pump();
    }

    enqueue(job) {
        this.queue.push(job);
        if (this.running && !this.paused) this._pump();
        return job.id;
    }

    enqueueAll(jobs) {
        for (const job of jobs) this.queue.push(job);
        if (this.running && !this.paused) this._pump();
        return jobs.map(j => j.id);
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.paused = false;
        this._cancelledAll = false;
        this._pump();
    }

    /** Stop starting new jobs. Jobs already running are left to finish. */
    pause() {
        this.paused = true;
        this.emit("paused");
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.emit("resumed");
        this._pump();
    }

    /** Cancel one job, whether it is running or still queued. */
    cancel(jobId) {
        const entry = this.active.get(jobId);
        if (entry) {
            entry.cancelled = true;
            try { entry.child.kill(); } catch (_) { /* already gone */ }
            return true;
        }

        const index = this.queue.findIndex(j => j.id === jobId);
        if (index !== -1) {
            const [job] = this.queue.splice(index, 1);
            this._finish(job, { status: STATUS.CANCELLED });
            return true;
        }
        return false;
    }

    cancelAll() {
        this._cancelledAll = true;

        const queued = this.queue.splice(0, this.queue.length);
        for (const job of queued) this._finish(job, { status: STATUS.CANCELLED });

        for (const jobId of [...this.active.keys()]) this.cancel(jobId);

        if (this.active.size === 0) this._checkIdle();
    }

    get pending() { return this.queue.length; }
    get activeCount() { return this.active.size; }

    _pump() {
        if (!this.running || this.paused) return;
        while (this.active.size < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            this._run(job).catch((err) => {
                this._finish(job, { status: STATUS.ERROR, error: err.message });
            });
        }
        this._checkIdle();
    }

    async _run(job) {
        if (this._cancelledAll) {
            this._finish(job, { status: STATUS.CANCELLED });
            return;
        }

        // -- Decide where this is going ---------------------------------------
        let resolved;
        try {
            resolved = paths.resolveOutputPath(job);
        } catch (err) {
            this._finish(job, { status: STATUS.ERROR, error: err.message });
            return;
        }

        if (resolved.action === "skip") {
            this._finish(job, { status: STATUS.SKIPPED, outputPath: resolved.outputPath });
            return;
        }

        if (resolved.action === "ask") {
            if (!this.conflictResolver) {
                // Without a resolver, falling back to a unique name is safer
                // than overwriting something the user did not agree to lose.
                resolved = { ...resolved, outputPath: resolved.isDirectory
                    ? paths.getUniqueDirPath(resolved.outputPath)
                    : paths.getUniquePath(resolved.outputPath) };
            } else {
                const answer = await this.conflictResolver(job, resolved.outputPath);
                if (!answer || answer.action === "cancel") {
                    this._finish(job, { status: STATUS.CANCELLED });
                    return;
                }
                if (answer.action === "skip") {
                    this._finish(job, { status: STATUS.SKIPPED, outputPath: resolved.outputPath });
                    return;
                }
                if (answer.outputPath) resolved = { ...resolved, outputPath: answer.outputPath };
            }
        }

        const { outputPath, isDirectory } = resolved;

        try {
            paths.ensureParentDir(outputPath, isDirectory);
        } catch (err) {
            this._finish(job, { status: STATUS.ERROR, error: `Could not create the output folder: ${err.message}` });
            return;
        }

        // -- Spawn -------------------------------------------------------------
        let args;
        try {
            args = buildArgs(job, { outputPath });
        } catch (err) {
            this._finish(job, { status: STATUS.ERROR, error: err.message });
            return;
        }

        const child = spawn(this.ffmpegPath, args, { windowsHide: true });
        const entry = { job, child, outputPath, isDirectory, cancelled: false, stderr: "" };
        this.active.set(job.id, entry);

        job.status = STATUS.RUNNING;
        this.emit("status", { jobId: job.id, status: STATUS.RUNNING });

        const duration = durationOf(job);
        let carry = "";

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            carry += chunk;
            const lines = carry.split("\n");
            carry = lines.pop() ?? "";
            const update = parseProgressLines(lines, duration);
            if (update) this.emit("progress", { jobId: job.id, ...update });
        });

        // ffmpeg writes all diagnostics to stderr; keep only the tail so a
        // failure has a usable message without buffering an entire log.
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            entry.stderr = (entry.stderr + chunk).slice(-4000);
        });

        child.on("error", (err) => {
            this.active.delete(job.id);
            this._cleanupPartial(outputPath, isDirectory);
            this._finish(job, { status: STATUS.ERROR, error: `Could not start ffmpeg: ${err.message}` });
            this._pump();
        });

        child.on("close", (code) => {
            this.active.delete(job.id);

            if (entry.cancelled || this._cancelledAll) {
                this._cleanupPartial(outputPath, isDirectory);
                this._finish(job, { status: STATUS.CANCELLED });
            } else if (code === 0) {
                this.emit("progress", { jobId: job.id, percent: 100 });
                this._finish(job, {
                    status: STATUS.DONE,
                    outputPath,
                    isDirectory,
                    fileCount: isDirectory ? countFiles(outputPath) : 1,
                });
            } else {
                this._cleanupPartial(outputPath, isDirectory);
                this._finish(job, {
                    status: STATUS.ERROR,
                    error: lastMeaningfulLine(entry.stderr) || `ffmpeg exited with code ${code}.`,
                });
            }

            this._pump();
        });
    }

    _finish(job, result) {
        job.status = result.status;
        if (result.outputPath) job.outputPath = result.outputPath;
        if (result.error) job.error = result.error;

        const payload = { jobId: job.id, ...result };
        this.results.set(job.id, payload);
        this.emit("status", payload);
    }

    _cleanupPartial(outputPath, isDirectory) {
        try {
            if (!fs.existsSync(outputPath)) return;
            if (isDirectory) fs.rmSync(outputPath, { recursive: true, force: true });
            else fs.unlinkSync(outputPath);
        } catch (_) {
            // A partial file we cannot remove is not worth failing the job over.
        }
    }

    _checkIdle() {
        if (this.running && this.active.size === 0 && this.queue.length === 0) {
            this.running = false;
            this.emit("idle", { results: [...this.results.values()] });
        }
    }
}

/**
 * Parse a block of `-progress pipe:1` key=value lines.
 * Returns null when the block carried nothing worth emitting.
 */
function parseProgressLines(lines, durationSeconds) {
    let outTimeUs = null;
    let speed = null;
    let fps = null;
    let ended = false;

    for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();

        switch (key) {
            case "out_time_us":
            case "out_time_ms": {
                // Despite the name, ffmpeg reports out_time_ms in microseconds.
                const n = Number(value);
                if (Number.isFinite(n) && n >= 0) outTimeUs = n;
                break;
            }
            case "speed": {
                const n = parseFloat(value);
                if (Number.isFinite(n)) speed = n;
                break;
            }
            case "fps": {
                const n = parseFloat(value);
                if (Number.isFinite(n)) fps = n;
                break;
            }
            case "progress":
                if (value === "end") ended = true;
                break;
        }
    }

    if (outTimeUs === null && !ended) return null;

    const outSeconds = outTimeUs != null ? outTimeUs / 1e6 : null;

    // Without a known duration (still images, some streams) there is nothing
    // to divide by, so percent stays null and the UI shows indeterminate
    // rather than the frozen 0% v1 displayed.
    let percent = null;
    if (ended) {
        percent = 100;
    } else if (durationSeconds && durationSeconds > 0 && outSeconds != null) {
        percent = Math.min(99.9, (outSeconds / durationSeconds) * 100);
    }

    let eta = null;
    if (percent != null && percent < 100 && durationSeconds && speed && speed > 0 && outSeconds != null) {
        eta = Math.max(0, (durationSeconds - outSeconds) / speed);
    }

    return {
        percent: percent != null ? Math.round(percent * 10) / 10 : null,
        outSeconds,
        speed,
        fps,
        eta,
    };
}

function durationOf(job) {
    const meta = job.inputMeta;
    const { start, end } = job.trim ?? {};

    if (start != null && end != null && end > start) return end - start;

    const full = meta?.duration ?? null;
    if (!full) return end ?? null;
    if (start != null) return Math.max(0, full - start);
    if (end != null) return Math.min(full, end);
    return full;
}

function countFiles(dirPath) {
    try {
        return fs.readdirSync(dirPath).length;
    } catch (_) {
        return 0;
    }
}

/** The last non-empty stderr line, which is where ffmpeg puts the real reason. */
function lastMeaningfulLine(stderr) {
    if (!stderr) return null;
    const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines[lines.length - 1] : null;
}

module.exports = {
    JobRunner,
    parseProgressLines,
    defaultConcurrency,
};
