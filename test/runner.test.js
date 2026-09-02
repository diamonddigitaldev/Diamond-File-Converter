"use strict";

// The job runner's conflict path, driven for real.
//
// These replace four tests that were assert.match regexes over main.js read as
// a string. Those could not fail for any of the defects below — one of them
// matched the very line that caused the first one, and read it as proof the
// behaviour was right. A pool is a thing you have to run to know about.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { JobRunner } = require("../src/core/runner");
const { createJob, CONFLICT, STATUS } = require("../src/core/job");

/**
 * An ffmpeg that never was. Enough surface for _run to attach its handlers;
 * the test closes it by hand when it wants the job to finish.
 */
function fakeChild() {
    const child = new EventEmitter();
    const silentStream = { setEncoding() {}, on() {} };
    child.stdout = silentStream;
    child.stderr = silentStream;
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("close", 0); };
    return child;
}

/** A promise the test resolves when it chooses, so a prompt can be held open. */
function heldPromise() {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
}

/**
 * A temp dir with `count` inputs and a colliding output for each, so
 * resolveOutputPath genuinely returns action "ask" against the real
 * filesystem rather than being stubbed into it.
 */
function collidingJobs(count) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-runner-"));
    const jobs = [];
    for (let i = 0; i < count; i++) {
        const stem = `clip${i}`;
        fs.writeFileSync(path.join(dir, `${stem}.mov`), "");
        fs.writeFileSync(path.join(dir, `${stem}.mp4`), ""); // the collision
        jobs.push(createJob({
            inputPath: path.join(dir, `${stem}.mov`),
            targetExt: "mp4",
            output: { onConflict: CONFLICT.ASK },
        }));
    }
    return { dir, jobs, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Let queued microtasks settle — _run is async, so nothing is synchronous. */
const settle = () => new Promise(resolve => setImmediate(resolve));

// ---------------------------------------------------------------------------
// The pool has to know about a job that is waiting on an answer
// ---------------------------------------------------------------------------

test("runner: is not idle while a job is parked at a conflict prompt", async () => {
    const { jobs, cleanup } = collidingJobs(2);
    try {
        const held = heldPromise();
        let idleCount = 0;

        const runner = new JobRunner({
            ffmpegPath: "ffmpeg",
            concurrency: 1,
            spawn: () => {
                const child = fakeChild();
                setImmediate(() => child.emit("close", 0));
                return child;
            },
            conflictResolver: () => held.promise,
        });
        runner.on("idle", () => { idleCount++; });

        runner.enqueueAll(jobs);
        runner.start();
        await settle();

        // The prompt is open. Main clears the batch-wide "apply to all
        // remaining" choice on idle, so an idle here throws away an answer the
        // user has already given.
        assert.equal(idleCount, 0, "idle must not fire while a prompt is open");
        assert.equal(runner.running, true);

        held.release({ action: "write" });
        for (let i = 0; i < 20; i++) await settle();

        assert.equal(idleCount, 1, "idle fires exactly once, after everything settles");
    } finally {
        cleanup();
    }
});

test("runner: the concurrency limit applies to jobs that took the ask path", async () => {
    const { jobs, cleanup } = collidingJobs(8);
    try {
        const held = heldPromise();
        let openPrompts = 0;
        let peakPrompts = 0;
        let spawned = 0;
        let closed = 0;
        let peakChildren = 0;

        const runner = new JobRunner({
            ffmpegPath: "ffmpeg",
            concurrency: 2,
            spawn: () => {
                spawned++;
                peakChildren = Math.max(peakChildren, spawned - closed);
                const child = fakeChild();
                setImmediate(() => { closed++; child.emit("close", 0); });
                return child;
            },
            conflictResolver: async () => {
                openPrompts++;
                peakPrompts = Math.max(peakPrompts, openPrompts);
                try { return await held.promise; } finally { openPrompts--; }
            },
        });

        runner.enqueueAll(jobs);
        runner.start();
        await settle();

        // Before the fix every one of the eight reached the resolver at once,
        // because a parked job was in neither `active` nor `queue` and so the
        // pool read as completely empty.
        assert.equal(peakPrompts, 2, "at most `concurrency` prompts may be open at once");

        held.release({ action: "write" });
        for (let i = 0; i < 40; i++) await settle();

        assert.equal(spawned, 8, "every job still runs");
        assert.ok(peakChildren <= 2, `at most 2 ffmpeg processes at once, saw ${peakChildren}`);
    } finally {
        cleanup();
    }
});

test("runner: Cancel All while a prompt is open does not spawn ffmpeg", async () => {
    const { jobs, cleanup } = collidingJobs(1);
    try {
        const held = heldPromise();
        let spawned = 0;
        const statuses = [];

        const runner = new JobRunner({
            ffmpegPath: "ffmpeg",
            concurrency: 2,
            spawn: () => { spawned++; return fakeChild(); },
            conflictResolver: () => held.promise,
        });
        runner.on("status", ({ status }) => statuses.push(status));

        runner.enqueueAll(jobs);
        runner.start();
        await settle();

        runner.cancelAll();
        // The user was looking at the dialog when Cancel All was pressed, and
        // still answers it. The answer must not resurrect the job: _run used to
        // read _cancelledAll only on entry, so it spawned anyway and only
        // noticed it had been cancelled once ffmpeg had finished.
        held.release({ action: "write" });
        for (let i = 0; i < 10; i++) await settle();

        assert.equal(spawned, 0, "nothing may start after Cancel All");
        assert.ok(statuses.includes(STATUS.CANCELLED));
        assert.ok(!statuses.includes(STATUS.RUNNING));
    } finally {
        cleanup();
    }
});

test("runner: a job skipped at the prompt frees its slot", async () => {
    // Holding a pool slot across the prompt means every exit after the await
    // has to release it. Miss one and the queue stalls forever with jobs still
    // in it — the regression the reservation introduces if it is done by half.
    const { jobs, cleanup } = collidingJobs(3);
    try {
        let answered = 0;
        let idleCount = 0;
        const statuses = [];

        const runner = new JobRunner({
            ffmpegPath: "ffmpeg",
            concurrency: 1,
            spawn: () => {
                const child = fakeChild();
                setImmediate(() => child.emit("close", 0));
                return child;
            },
            conflictResolver: async () => (++answered <= 2 ? { action: "skip" } : { action: "write" }),
        });
        runner.on("idle", () => { idleCount++; });
        runner.on("status", ({ status }) => statuses.push(status));

        runner.enqueueAll(jobs);
        runner.start();
        for (let i = 0; i < 40; i++) await settle();

        assert.equal(runner.pending, 0, "the queue must drain");
        assert.equal(statuses.filter(s => s === STATUS.SKIPPED).length, 2);
        assert.ok(statuses.includes(STATUS.DONE), "the third job still runs");
        assert.equal(idleCount, 1);
    } finally {
        cleanup();
    }
});

test("runner: answering cancel settles the job without spawning", async () => {
    const { jobs, cleanup } = collidingJobs(1);
    try {
        let spawned = 0;
        const statuses = [];

        const runner = new JobRunner({
            ffmpegPath: "ffmpeg",
            concurrency: 1,
            spawn: () => { spawned++; return fakeChild(); },
            conflictResolver: async () => ({ action: "cancel" }),
        });
        runner.on("status", ({ status }) => statuses.push(status));

        runner.enqueueAll(jobs);
        runner.start();
        for (let i = 0; i < 10; i++) await settle();

        assert.equal(spawned, 0);
        assert.deepEqual(statuses, [STATUS.CANCELLED]);
        assert.equal(runner.activeCount, 0);
        assert.equal(runner.reserved.size, 0, "the reservation must be released");
    } finally {
        cleanup();
    }
});
