"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("fs");
const path = require("path");

const d = require("../src/core/display");
const { STATUS } = require("../src/core/job");
const formats = require("../src/core/formats");

// The renderer receives this map over IPC; display.js takes it as an argument
// because it cannot require core/formats itself.
const TARGETS = Object.fromEntries(
    formats.SUPPORTED_EXTENSIONS.map(ext => [ext, formats.targetsFor(ext)])
);

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

test("display: durations read as clocks, and unknown stays unknown", () => {
    assert.equal(d.formatDuration(0), "0:00");
    assert.equal(d.formatDuration(65), "1:05");
    assert.equal(d.formatDuration(3723), "1:02:03");
    assert.equal(d.formatDuration(59.6), "1:00", "rounds rather than truncating");
    assert.equal(d.formatDuration(null), null);
    assert.equal(d.formatDuration(-1), null);
    assert.equal(d.formatDuration(NaN), null);
});

test("display: a timecode keeps the fraction a duration rounds away", () => {
    assert.equal(d.formatTimecode(65), "1:05");
    assert.equal(d.formatTimecode(65.04), "1:05.04");
    assert.equal(d.formatTimecode(3723.5), "1:02:03.5");
    assert.equal(d.formatTimecode(1.0344), "0:01.034", "to the millisecond, no further");
    assert.equal(d.formatTimecode(0.7000000000000001), "0:00.7", "float noise is not a fraction");
    assert.equal(d.formatTimecode(null), null);
    assert.equal(d.formatTimecode(-1), null);
});

// ---------------------------------------------------------------------------
// trim stepping
// ---------------------------------------------------------------------------

const VIDEO_25 = { ok: true, hasVideo: true, isStill: false, video: { fps: 25 } };
const SONG_WITH_ART = { ok: true, hasVideo: false, isStill: true, video: { fps: null } };

test("trim: a step is a second, or with Shift a frame of video and a tenth of anything else", () => {
    assert.equal(d.trimStep(VIDEO_25, false), 1);
    assert.equal(d.trimStep(VIDEO_25, true), 0.04);
    assert.equal(d.trimStep({ ok: true, hasVideo: false, video: null }, true), 0.1);
    assert.equal(d.trimStep(SONG_WITH_ART, true), 0.1, "cover art has no frames to step through");
    assert.equal(d.trimStep(null, true), 0.1);
});

test("trim: an ordinary drag lands on whole seconds, never a fraction", () => {
    const at = (seconds) => d.placeTrimHandle("start", seconds, { start: 0, end: 60, duration: 60, step: 1 });
    assert.equal(at(3.47), 3);
    assert.equal(at(3.5), 4);
    assert.equal(at(-2), 0);
});

test("trim: a fine step lands on a frame, and never rounds past the frame it was put on", () => {
    // Frame 31 at 29.97fps starts at 1.03437s. Rounded to 1.035 it would be
    // after the frame's own timestamp, and ffmpeg would start a frame later.
    const step = 1 / 29.97;
    const placed = d.snapToStep(31 * step, step);
    assert.equal(placed, 1.034);
    assert.ok(placed <= 31 * step && placed > 30 * step);

    assert.equal(d.snapToStep(3, 0.04), 3, "whole seconds survive a frame grid");
    assert.equal(d.snapToStep(0.7, 0.1), 0.7);
});

test("trim: the two handles always keep at least one step between them", () => {
    const state = { start: 5, end: 10, duration: 60, step: 1 };
    assert.equal(d.placeTrimHandle("start", 12, state), 9, "start stops a second short of the end");
    assert.equal(d.placeTrimHandle("end", 2, state), 6, "end stops a second past the start");

    const fine = { start: 5, end: 10, duration: 60, step: 0.04 };
    assert.equal(d.placeTrimHandle("start", 10, fine), 9.96, "one frame apart, not zero");
    assert.equal(d.placeTrimHandle("end", 5, fine), 5.04);
});

test("trim: the end of a clip that is not a whole number of seconds is still reachable", () => {
    const state = { start: 0, end: 12.48, duration: 12.48, step: 1 };
    assert.equal(d.placeTrimHandle("end", 12.2, state), 12.48, "near enough the end is the end");
    assert.equal(d.placeTrimHandle("end", 11.8, state), 12);
    assert.equal(d.placeTrimHandle("start", 12.48, state), 11, "and the start stays on a whole second below it");
});

test("display: byte sizes stay short", () => {
    assert.equal(d.formatBytes(0), "0 B");
    assert.equal(d.formatBytes(512), "512 B");
    assert.equal(d.formatBytes(1024), "1.0 KB");
    assert.equal(d.formatBytes(1536), "1.5 KB");
    assert.equal(d.formatBytes(1048576), "1.0 MB");
    assert.equal(d.formatBytes(15 * 1048576), "15 MB", "drops the decimal above 10");
    assert.equal(d.formatBytes(null), null);
});

test("display: eta is terse", () => {
    assert.equal(d.formatEta(45), "45s");
    assert.equal(d.formatEta(125), "2m 05s");
    assert.equal(d.formatEta(3700), "1h 01m");
    assert.equal(d.formatEta(null), null);
});

// ---------------------------------------------------------------------------
// card content
// ---------------------------------------------------------------------------

test("display: metadata line is null until the probe lands", () => {
    // The card must render before this returns anything.
    assert.equal(d.describeMeta(null, "mp4"), null);
    assert.equal(d.describeMeta({ pending: true }, "mp4"), null);
});

test("display: a failed probe reads as unreadable, not as still loading", () => {
    // probe() resolves { ok: false } rather than rejecting, so a corrupt file
    // used to be indistinguishable from a slow one and sat on "Reading…"
    // forever — even after a conversion had already failed against it.
    assert.equal(d.describeMeta({ ok: false, error: "Invalid data" }, "mp4"), "MP4 · unreadable");
    assert.equal(d.describeMeta({ ok: false }, null), "Unreadable file");
});

test("display: metadata line covers video and audio differently", () => {
    const video = d.describeMeta({
        ok: true, duration: 65, size: 1048576, hasVideo: true,
        video: { width: 1920, height: 1080, codec: "h264" },
    }, "mp4");
    assert.equal(video, "1920×1080 · 1:05 · h264 · 1.0 MB");

    const audio = d.describeMeta({
        ok: true, duration: 185, size: 5242880, hasVideo: false,
        audio: { codec: "mp3" },
    }, "mp3");
    assert.equal(audio, "3:05 · mp3 · 5.0 MB");
});

test("display: a probe with nothing useful falls back to the extension", () => {
    assert.equal(d.describeMeta({ ok: true }, "png"), "PNG");
});

test("display: status tells the user what to do when no format is chosen", () => {
    const noTarget = d.describeStatus({ status: STATUS.PENDING, targetExt: null });
    assert.equal(noTarget.tone, "warning");
    assert.match(noTarget.text, /format/i);

    assert.equal(d.describeStatus({ status: STATUS.PENDING, targetExt: "mp4" }).tone, "ready");
    assert.equal(d.describeStatus({ status: STATUS.RUNNING }).tone, "running");
    assert.equal(d.describeStatus({ status: STATUS.CANCELLED }).tone, "muted");
});

test("display: a finished job surfaces its real failure reason", () => {
    const failed = d.describeStatus({ status: STATUS.ERROR, error: "Invalid data found" });
    assert.equal(failed.text, "Invalid data found");
    assert.equal(failed.tone, "danger");
});

test("display: a frames job reports its frame count, not just 'Done'", () => {
    const frames = d.describeStatus({ status: STATUS.DONE, isDirectory: true, fileCount: 30 });
    assert.equal(frames.text, "30 frames");

    const single = d.describeStatus({ status: STATUS.DONE, isDirectory: false });
    assert.equal(single.text, "Done");
});

test("display: summary counts every outcome", () => {
    const jobs = [
        { status: STATUS.DONE }, { status: STATUS.DONE },
        { status: STATUS.ERROR },
        { status: STATUS.CANCELLED }, { status: STATUS.SKIPPED },
    ];
    assert.equal(d.summarise(jobs), "2 files converted, 1 failed, 2 cancelled");
    assert.equal(d.summarise([{ status: STATUS.DONE }]), "1 file converted");
    assert.equal(d.summarise([]), "Nothing converted");
});

test("display: overall progress counts finished jobs as complete", () => {
    assert.equal(d.overallProgress([]), 0);
    assert.equal(d.overallProgress([{ status: STATUS.DONE }, { status: STATUS.PENDING, progress: 0 }]), 50);
    assert.equal(d.overallProgress([{ status: STATUS.RUNNING, progress: 50 }]), 50);
    // A failed job is finished, not stuck — it must not hold the bar back.
    assert.equal(d.overallProgress([{ status: STATUS.ERROR }, { status: STATUS.DONE }]), 100);
});

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

const IDS = ["a", "b", "c", "d", "e"];

test("selection: a plain click replaces the selection", () => {
    const r = d.resolveSelection(IDS, new Set(["a"]), "c", {}, "a");
    assert.deepEqual([...r.selection], ["c"]);
    assert.equal(r.anchor, "c");
});

test("selection: ctrl+click toggles", () => {
    const added = d.resolveSelection(IDS, new Set(["a"]), "c", { ctrl: true }, "a");
    assert.deepEqual([...added.selection].sort(), ["a", "c"]);

    const removed = d.resolveSelection(IDS, new Set(["a", "c"]), "c", { ctrl: true }, "a");
    assert.deepEqual([...removed.selection], ["a"]);
});

test("selection: shift+click selects a range in either direction", () => {
    const forward = d.resolveSelection(IDS, new Set(["b"]), "d", { shift: true }, "b");
    assert.deepEqual([...forward.selection], ["b", "c", "d"]);

    const backward = d.resolveSelection(IDS, new Set(["d"]), "b", { shift: true }, "d");
    assert.deepEqual([...backward.selection], ["b", "c", "d"]);

    assert.equal(forward.anchor, "b", "the anchor survives a shift range");
});

test("selection: ctrl+shift extends rather than replacing", () => {
    const r = d.resolveSelection(IDS, new Set(["e"]), "c", { ctrl: true, shift: true }, "b");
    assert.deepEqual([...r.selection].sort(), ["b", "c", "e"]);
});

test("selection: clicking inside a multi-selection keeps it", () => {
    // Otherwise acting on a group would collapse it to one card first.
    const r = d.resolveSelection(IDS, new Set(["a", "b", "c"]), "b", {}, "a");
    assert.deepEqual([...r.selection].sort(), ["a", "b", "c"]);
    assert.equal(r.anchor, "b");
});

test("selection: clicking outside a multi-selection replaces it", () => {
    const r = d.resolveSelection(IDS, new Set(["a", "b"]), "e", {}, "a");
    assert.deepEqual([...r.selection], ["e"]);
});

test("selection: a stale anchor degrades to a plain click", () => {
    const r = d.resolveSelection(IDS, new Set(), "c", { shift: true }, "zzz");
    assert.deepEqual([...r.selection], ["c"]);
});

test("selection: removals cannot strand ids", () => {
    const pruned = d.pruneSelection(new Set(["a", "gone", "c"]), IDS);
    assert.deepEqual([...pruned].sort(), ["a", "c"]);
});

// ---------------------------------------------------------------------------
// bulk target resolution
// ---------------------------------------------------------------------------

test("targets: a single source offers everything it can become", () => {
    const t = d.commonTargets(["mp4"], TARGETS);
    const exts = t.map(x => x.ext);
    assert.ok(exts.includes("mkv"), "same-kind");
    assert.ok(exts.includes("mp3"), "cross-kind extraction");
    assert.ok(exts.includes("png"), "frame export");
});

test("targets: a mixed selection offers only the intersection", () => {
    // Video and audio share audio targets, but a video-only target such as mkv
    // must not be offered, or bulk-setting it would produce invalid jobs.
    const t = d.commonTargets(["mp4", "mp3"], TARGETS).map(x => x.ext);
    assert.ok(t.includes("mp3"));
    assert.ok(t.includes("flac"));
    assert.ok(!t.includes("mkv"), "mp3 cannot become mkv");
    assert.ok(!t.includes("png"), "mp3 cannot become png");
});

test("targets: an impossible mix offers nothing rather than something invalid", () => {
    // Images cannot become audio, audio cannot become images.
    assert.deepEqual(d.commonTargets(["mp3", "png"], TARGETS), []);
});

test("targets: empty and unknown input is handled", () => {
    assert.deepEqual(d.commonTargets([], TARGETS), []);
    assert.deepEqual(d.commonTargets([null, undefined], TARGETS), []);
});

test("targets: grouping puts same-kind formats first", () => {
    const groups = d.groupTargets(d.commonTargets(["mp4"], TARGETS));
    assert.equal(groups[0].group, "Video", "video sources lead with video targets");
    assert.ok(groups.length > 1, "cross-kind groups still offered");
});

test("display: kind icons cover every kind and fall back safely", () => {
    assert.equal(d.iconForKind("audio"), "audio_file");
    assert.equal(d.iconForKind("video"), "video_file");
    assert.equal(d.iconForKind("image"), "image");
    assert.equal(d.iconForKind("nonsense"), "insert_drive_file");
});

// ---------------------------------------------------------------------------
// dual-load guards
//
// display.js is required here in Node AND loaded as a plain <script> by the
// renderer, which has no Node access. Either of these regressing would leave
// the grid unable to render, so they are asserted rather than assumed.
// ---------------------------------------------------------------------------

const DISPLAY_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "core", "display.js"), "utf8");

test("display.js has no requires, so it can load as a plain browser script", () => {
    const code = DISPLAY_SRC
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/\brequire\s*\(/.test(code), "display.js must not call require()");
    assert.match(DISPLAY_SRC, /module\.exports\s*=\s*factory\(\)/, "must still export for Node");
    assert.match(DISPLAY_SRC, /root\.display\s*=\s*factory\(\)/, "must still attach to window for the renderer");
});

test("display.js STATUS mirrors core/job.js exactly", () => {
    // display.js inlines these because it cannot import job.js.
    assert.deepEqual(d.STATUS, STATUS);
});

test("the renderer only reaches display through the global it exports", () => {
    const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
    assert.ok(!/\brequire\s*\(/.test(
        renderer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
    ), "renderer.js must not call require()");
    assert.match(renderer, /window\.display/, "renderer must take display from the global");

    // Compare actual <script src> order, not raw substring positions — prose in
    // a comment can otherwise mention a filename ahead of its real tag.
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);

    const displayAt = srcs.findIndex(s => s.endsWith("core/display.js"));
    const rendererAt = srcs.findIndex(s => s.endsWith("renderer.js"));

    assert.ok(displayAt !== -1, "index.html must load core/display.js");
    assert.ok(rendererAt !== -1, "index.html must load renderer.js");
    assert.ok(displayAt < rendererAt, "display.js must be loaded before renderer.js");
});

test("every target the grid can offer carries what the UI needs to render it", () => {
    for (const [ext, targets] of Object.entries(TARGETS)) {
        for (const t of targets) {
            assert.ok(t.ext && t.label && t.group, `${ext} -> target missing ext/label/group`);
            assert.equal(typeof t.sameKind, "boolean", `${ext} -> ${t.ext} missing sameKind`);
        }
    }
});

// ---------------------------------------------------------------------------
// pluralisation
//
// "1 still need a format" and "1 frames" both shipped because each call site
// wrote its own ternary. Everything counted now goes through these helpers.
// ---------------------------------------------------------------------------

test("plural: picks the singular only at exactly one", () => {
    assert.equal(d.plural(1, "file"), "file");
    assert.equal(d.plural(0, "file"), "files");
    assert.equal(d.plural(2, "file"), "files");
    assert.equal(d.plural(100, "file"), "files");
});

test("plural: takes an explicit plural for irregular words", () => {
    assert.equal(d.plural(1, "needs", "need"), "needs");
    assert.equal(d.plural(3, "needs", "need"), "need");
    assert.equal(d.plural(1, "was", "were"), "was");
    assert.equal(d.plural(0, "was", "were"), "were");
});

test("countOf: pairs the number with the agreeing noun", () => {
    assert.equal(d.countOf(1, "file"), "1 file");
    assert.equal(d.countOf(3, "file"), "3 files");
    assert.equal(d.countOf(0, "file"), "0 files");
    assert.equal(d.countOf(1, "unsupported file"), "1 unsupported file");
    assert.equal(d.countOf(2, "unsupported file"), "2 unsupported files");
});

test("a single extracted frame is '1 frame', not '1 frames'", () => {
    assert.equal(d.describeStatus({ status: STATUS.DONE, isDirectory: true, fileCount: 1 }).text, "1 frame");
    assert.equal(d.describeStatus({ status: STATUS.DONE, isDirectory: true, fileCount: 30 }).text, "30 frames");
});

test("summary agrees at one", () => {
    assert.equal(d.summarise([{ status: STATUS.DONE }]), "1 file converted");
    assert.equal(d.summarise([{ status: STATUS.DONE }, { status: STATUS.DONE }]), "2 files converted");
});

/** Drop comments so an example in a doc block is not read as real code. */
function stripSource(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no inline pluralisation ternaries remain in the UI code", () => {
    // Catches the `n === 1 ? "file" : "files"` shape that caused the bugs.
    const pattern = /\?\s*["'](\w+)["']\s*:\s*["']\1s["']/;
    for (const rel of ["src/renderer.js", "src/core/display.js"]) {
        const code = stripSource(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
        const hit = code.match(pattern);
        assert.equal(hit, null,
            `${rel} still pluralises inline (${hit && hit[0]}) — use display.plural/countOf`);
    }
});

test("every counted string in the renderer goes through the helper", () => {
    const code = stripSource(fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8"));
    // Template literals that interpolate a count straight before a plural noun,
    // e.g. `${n} files`, without going through countOf.
    const raw = [...code.matchAll(/\$\{(?!display\.(countOf|plural))[^}]+\}\s+(files|frames|folders)\b/g)];
    assert.deepEqual(raw.map(m => m[0]), [],
        "found a raw count followed by a plural noun — route it through display.countOf");
});

// ---------------------------------------------------------------------------
// New Job dialog
//
// The dialog is driven entirely from the format capability graph, so an
// invalid combination is unreachable rather than merely rejected on submit.
// ---------------------------------------------------------------------------

const DESCRIPTORS = formats.FORMATS;

test("dialog: an audio target offers no video controls", () => {
    const s = d.applicableSections("mp4", "mp3", DESCRIPTORS, "extract");
    assert.equal(s.video, false);
    assert.equal(s.audio, true);
    assert.equal(s.resize, false);
    assert.equal(s.image, false);
});

test("dialog: an image target offers no audio controls", () => {
    const s = d.applicableSections("jpg", "png", DESCRIPTORS, "transcode");
    assert.equal(s.audio, false);
    assert.equal(s.image, true, "a still image exposes its own quality knob");
    assert.equal(s.trim, false, "trimming a single still is meaningless");
    assert.equal(s.frames, false, "one picture in, one picture out");
});

test("dialog: an animated image target can still be trimmed", () => {
    assert.equal(d.applicableSections("mp4", "gif", DESCRIPTORS, "transcode").trim, true);
    assert.equal(d.applicableSections("mp4", "webp", DESCRIPTORS, "transcode").trim, true);
});

test("dialog: pulling frames out of a video is a span, not a trim", () => {
    // The same still target means different things depending on where it came
    // from: one picture from another picture has nothing to choose, but frames
    // from a video are entirely a question of which ones.
    const frames = d.applicableSections("mp4", "png", DESCRIPTORS, "frames");
    assert.equal(frames.frames, true);
    assert.equal(frames.trim, false, "it is offered as frames instead");

    const single = d.applicableSections("mp4", "png", DESCRIPTORS, "thumbnail");
    assert.equal(single.frames, true);

    // ...and it is not offered where there is nothing moving to pick from.
    assert.equal(d.applicableSections("png", "jpg", DESCRIPTORS, "transcode").frames, false);
});

test("dialog: an image source is never asked about audio", () => {
    // An animated GIF into MP4 transcodes into a video container, which would
    // otherwise show a full Audio section for a source that has none.
    assert.equal(d.applicableSections("gif", "mp4", DESCRIPTORS, "transcode").audio, false);
    assert.equal(d.applicableSections("png", "mp4", DESCRIPTORS, "assemble").audio, false);
    assert.equal(d.applicableSections("mp4", "mkv", DESCRIPTORS, "transcode").audio, true);
});

test("dialog: a picture target is not asked to pick a video codec", () => {
    // Exporting frames to PNG was offering an encoder preset and a target
    // bitrate above the controls that decide anything. Resizing and sampling
    // still apply, so this is narrower than hiding the section outright.
    assert.equal(d.applicableSections("mp4", "png", DESCRIPTORS, "frames").videoEncode, false);
    assert.equal(d.applicableSections("png", "jpg", DESCRIPTORS, "transcode").videoEncode, false);
    assert.equal(d.applicableSections("mp4", "gif", DESCRIPTORS, "transcode").videoEncode, false);
    assert.equal(d.applicableSections("mp4", "mkv", DESCRIPTORS, "transcode").videoEncode, true);
    assert.equal(d.applicableSections("mp4", "mp3", DESCRIPTORS, "extract").videoEncode, false);
});

test("dialog: a video target offers everything", () => {
    const s = d.applicableSections("mp4", "mp4", DESCRIPTORS, "transcode");
    assert.equal(s.video, true);
    assert.equal(s.audio, true);
    assert.equal(s.trim, true);
    assert.equal(s.resize, true);
});

test("dialog: an unknown target offers nothing rather than throwing", () => {
    const s = d.applicableSections("mp4", "nope", DESCRIPTORS, "transcode");
    assert.deepEqual(s, { video: false, videoEncode: false, audio: false, image: false, trim: false, frames: false, resize: false });
});

test("dialog: codec choices come from the container's own capabilities", () => {
    const mp4 = d.codecOptions("mp4", DESCRIPTORS, "video").map(o => o.value);
    assert.ok(mp4.includes("libx264"));
    assert.ok(!mp4.includes("libvpx-vp9"), "MP4 must not offer VP9");

    const webm = d.codecOptions("webm", DESCRIPTORS, "video").map(o => o.value);
    assert.ok(webm.includes("libvpx-vp9"));
    assert.ok(!webm.includes("libx264"), "WebM must not offer H.264");

    // Every offered codec must be one validateJob would accept.
    for (const ext of formats.SUPPORTED_EXTENSIONS) {
        for (const stream of ["video", "audio"]) {
            for (const opt of d.codecOptions(ext, DESCRIPTORS, stream)) {
                const list = stream === "audio" ? DESCRIPTORS[ext].audioCodecs : DESCRIPTORS[ext].videoCodecs;
                assert.ok(list.includes(opt.value), `${ext} offered ${opt.value} for ${stream}`);
            }
        }
    }
});

test("dialog: codecs get readable labels, unknown ones pass through", () => {
    assert.equal(d.CODEC_LABELS.libx264, "H.264");
    assert.equal(d.codecOptions("mp4", DESCRIPTORS, "audio")[0].label, "AAC");
});

test("dialog: stream copy is offered only where the container supports it", () => {
    assert.equal(d.canStreamCopy("mp4", DESCRIPTORS, "transcode"), true);
    assert.equal(d.canStreamCopy("png", DESCRIPTORS, "transcode"), false);
    assert.equal(d.canStreamCopy("nope", DESCRIPTORS, "transcode"), false);
});

test("dialog: extracting audio only copies when the stream already fits", () => {
    // Every audio container claims stream-copy support, so without the codec
    // check an AAC-carrying MP4 offers a copy into MP3, passes validation, and
    // then fails inside ffmpeg.
    const aac = { ok: true, audio: { codec: "aac" } };
    assert.equal(d.canStreamCopy("m4a", DESCRIPTORS, "extract", aac), true, "m4a carries aac");
    assert.equal(d.canStreamCopy("mp3", DESCRIPTORS, "extract", aac), false, "mp3 cannot");

    // The table names encoders, a probe names codecs, and ffmpeg's own
    // -encoders output spells out the three that differ. Comparing them raw
    // would refuse a copy that works perfectly.
    const mp3 = { ok: true, audio: { codec: "mp3" } };
    assert.equal(d.canStreamCopy("mp3", DESCRIPTORS, "extract", mp3), true, "libmp3lame is codec mp3");
    assert.equal(d.canStreamCopy("ogg", DESCRIPTORS, "extract", { ok: true, audio: { codec: "vorbis" } }), true);
    assert.equal(d.canStreamCopy("opus", DESCRIPTORS, "extract", { ok: true, audio: { codec: "opus" } }), true);
    assert.equal(d.canStreamCopy("flac", DESCRIPTORS, "extract", mp3), false, "flac cannot carry mp3");

    // Unprobed, or nothing to copy: refuse rather than offer a maybe.
    assert.equal(d.canStreamCopy("mp3", DESCRIPTORS, "extract", null), false);
    assert.equal(d.canStreamCopy("mp3", DESCRIPTORS, "extract", { ok: false }), false);
});

test("display: a frame count says roughly what you are about to get", () => {
    const meta = { ok: true, duration: 600, video: { fps: 30 } };
    assert.equal(d.describeOutput("frames", null, meta), "about 18,000 images");
    assert.equal(d.describeOutput("frames", { start: 10, end: 15 }, meta), "about 150 images");
    assert.equal(d.describeOutput("thumbnail", null, meta), "1 image");

    // Nothing to say about conversions that do not make images.
    assert.equal(d.describeOutput("transcode", null, meta), null);
    assert.equal(d.describeOutput("extract", null, meta), null);

    // Nor before the probe lands, or without a frame rate to go on.
    assert.equal(d.describeOutput("frames", null, null), null);
    assert.equal(d.describeOutput("frames", null, { ok: true, duration: 10 }), null);
    assert.equal(d.describeOutput("frames", null, { ok: false }), null);
});

test("display: a frame range is clamped to the material that exists", () => {
    const meta = { ok: true, duration: 10, video: { fps: 25 } };
    assert.equal(d.estimateFrames("frames", { start: 0, end: 999 }, meta), 250);
    assert.equal(d.estimateFrames("frames", { start: 8, end: 4 }, meta), 1, "never fewer than one");
});

test("dialog: image quality descriptors carry their real range", () => {
    const jpg = d.qualityDescriptor("jpg", DESCRIPTORS);
    assert.equal(jpg.flag, "-q:v");
    assert.equal(jpg.inverted, true, "JPEG quality runs backwards");

    const webp = d.qualityDescriptor("webp", DESCRIPTORS);
    assert.equal(webp.max, 100);
    assert.equal(d.qualityDescriptor("mp4", DESCRIPTORS), null);
});

test("dialog: settings summary describes only what was changed", () => {
    assert.equal(d.summariseSettings(null), null);
    assert.equal(d.summariseSettings({}), null, "an untouched job has no summary");

    assert.equal(
        d.summariseSettings({ video: { codec: "libx264", crf: 20, width: 1280, height: 720 } }),
        "H.264 · CRF 20 · 1280×720"
    );
    assert.equal(d.summariseSettings({ video: { mode: "copy" } }), "copy video");
    assert.equal(d.summariseSettings({ audio: { mode: "drop" } }), "no audio");
    assert.equal(d.summariseSettings({ audio: { codec: "aac", bitrate: 192, channels: 1 } }), "AAC · 192k · mono");
    assert.equal(d.summariseSettings({ image: { quality: 3 } }), "q3");
    assert.equal(d.summariseSettings({ trim: { start: 5, end: 65 } }), "trim 0:05–1:05");
    assert.equal(d.summariseSettings({ trim: { start: 5 } }), "trim 0:05–end");
    assert.equal(d.summariseSettings({ output: { nameTemplate: "{name}-web" } }), "renamed");
    assert.equal(d.summariseSettings({ output: { nameTemplate: "{name}" } }), null, "the default is not a change");
});

// Found by QA on alpha.5. Setting only "If it already exists" and pressing
// Apply persisted correctly and reopened correctly, but produced no summary
// line — so a setting that had genuinely stuck looked like it had not, which
// is the same complaint the Apply-order bug produced for a different reason.
test("dialog: the summary describes a conflict policy, which is a change like any other", () => {
    assert.equal(d.summariseSettings({ output: { onConflict: "skip" } }), "skip existing");
    assert.equal(d.summariseSettings({ output: { onConflict: "overwrite" } }), "overwrite");
    assert.equal(d.summariseSettings({ output: { onConflict: "unique" } }), "save as new");

    assert.equal(d.summariseSettings({ output: { onConflict: "ask" } }), null,
        "ask is the default and must stay silent, like alongside and {name}");

    // It joins the rest rather than replacing it.
    assert.equal(
        d.summariseSettings({ video: { mode: "copy" }, output: { onConflict: "skip" } }),
        "copy video · skip existing"
    );
});

test("dialog: compacting drops blanks so format defaults still apply", () => {
    const compacted = d.compactSettings({
        video: { codec: "libx264", crf: null, bitrate: "", preset: "slow" },
        audio: { codec: null, bitrate: null },
        trim: { start: null, end: null },
    });
    assert.deepEqual(compacted, { video: { codec: "libx264", preset: "slow" } });
    assert.deepEqual(d.compactSettings({}), {});
    assert.deepEqual(d.compactSettings(null), {});
});

test("dialog: a compacted spec keeps zero, which is a real value", () => {
    // CRF 0 is lossless — dropping it as falsy would silently change the job.
    assert.deepEqual(d.compactSettings({ video: { crf: 0 } }), { video: { crf: 0 } });
    assert.deepEqual(d.compactSettings({ trim: { start: 0 } }), { trim: { start: 0 } });
});

// ---------------------------------------------------------------------------
// alpha.2 test-pass regressions
// ---------------------------------------------------------------------------

test("keys: a focused <select> must not be treated as typing", () => {
    // A <select> keeps focus after an option is picked, so counting it as
    // "typing" made choosing a format on any card silently swallow the next
    // Escape, Delete or Ctrl+A anywhere in the app.
    const renderer = stripSource(fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8"));
    const guard = renderer.match(/const typing = [\s\S]{0,220}?;/);
    assert.ok(guard, "expected a typing guard in the global keydown handler");
    assert.ok(!/SELECT/.test(guard[0]),
        "SELECT must not count as typing — it swallows Escape/Delete/Ctrl+A after a format is chosen");
    assert.match(guard[0], /TEXTAREA/);

    // A checkbox is an INPUT too, so the tag alone is not enough.
    assert.match(guard[0], /el\.type/,
        "INPUT must be narrowed by type, or a focused checkbox swallows the same keys");
});

test("keys: the settings dialog owns the keyboard while it is open", () => {
    const renderer = stripSource(fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8"));
    assert.match(renderer, /\.modal\.show/,
        "Delete must not remove the very cards being edited behind the dialog");
});

test("convert: an already-converted card is not resubmitted", () => {
    // Fixing one failed file and pressing Convert used to resubmit the whole
    // finished batch, colliding with every output the previous run wrote.
    const renderer = stripSource(fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8"));
    const filter = renderer.match(/const runnable = jobs\.filter\([^)]*\)/);
    assert.ok(filter, "expected startConversion to filter the job list");
    assert.match(filter[0], /status !== "done"/,
        "Convert must skip cards that already converted; Retry is what re-runs one");
});

test("dialog: a codec pick is recorded before the controls are rebuilt", () => {
    // syncModalControls repopulates these selects from dataset.wanted, so
    // without this the user's pick was overwritten by the value the dialog
    // opened with — dropping the codec on Apply and leaving Quality stuck on
    // "Target bitrate", because the effective codec fell back to the
    // container default (mpeg4 for AVI), which has no constant-quality mode.
    const renderer = stripSource(fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8"));
    assert.match(renderer, /dataset\.wanted = e\.target\.value/,
        "a change on the codec selects must write dataset.wanted");

    const recordAt = renderer.indexOf("dataset.wanted = e.target.value");
    const syncAt = renderer.indexOf('addEventListener("change", syncModalControls)', recordAt);
    assert.ok(recordAt !== -1 && syncAt !== -1 && recordAt < syncAt,
        "the pick must be recorded before syncModalControls rebuilds the select");
});

test("display: the renderer's mode agrees with the job model's, everywhere", () => {
    // display.js cannot require core/job.js, so effectiveMode() reimplements
    // defaultModeFor(). This is the guard that stops the two drifting — the
    // same treatment STATUS gets, and for the same reason.
    const { defaultModeFor } = require("../src/core/job");
    const metas = [
        null,
        { ok: true, isStill: true, duration: null },
        { ok: true, isStill: false, duration: 5 },
        { ok: true },
        { ok: false },
    ];

    let checked = 0;
    for (const sourceExt of formats.SUPPORTED_EXTENSIONS) {
        for (const target of TARGETS[sourceExt]) {
            for (const meta of metas) {
                const job = { ext: sourceExt, targetExt: target.ext, meta };
                assert.equal(
                    d.effectiveMode(job, TARGETS, DESCRIPTORS),
                    defaultModeFor(sourceExt, target.ext, meta),
                    `${sourceExt} -> ${target.ext} with ${JSON.stringify(meta)}`
                );
                checked++;
            }
        }
    }
    assert.ok(checked > 800, `expected the whole matrix, walked ${checked}`);
});

test("display: a mode chosen by hand is not second-guessed", () => {
    const job = { ext: "mp4", targetExt: "png", meta: { ok: true, isStill: false, duration: 60 }, settings: { mode: "thumbnail" } };
    assert.equal(d.effectiveMode(job, TARGETS, DESCRIPTORS), "thumbnail");
    assert.equal(d.effectiveMode({ ext: "mp4", targetExt: null }, TARGETS, DESCRIPTORS), null);
    assert.equal(d.effectiveMode({ ext: "mp4", targetExt: "nope" }, TARGETS, DESCRIPTORS), null);
});

// ---------------------------------------------------------------------------
// Joining
//
// The choice between the concat demuxer and the concat filter is a fact about
// the clips, not a setting. Getting it wrong in the permissive direction
// produces a file that plays wrongly rather than an error, so these compare
// the fields ffmpeg actually cares about.
// ---------------------------------------------------------------------------

function clip(over = {}) {
    return {
        ok: true, hasVideo: true, hasAudio: true,
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        video: { codec: "h264", width: 1920, height: 1080, fpsExact: { num: 30, den: 1 },
                 timeBase: "1/15360", sar: "1:1", pixelFormat: "yuv420p" },
        audio: { codec: "aac", sampleRate: 48000, channels: 2, sampleFormat: "fltp" },
        ...over,
    };
}

test("join: identical clips are joined without re-encoding", () => {
    const result = d.compareClips([clip(), clip()]);
    assert.equal(result.compatible, true);
    assert.deepEqual(result.differences, []);
    assert.equal(d.describeJoinPlan(result).strategy, "demuxer");
});

test("join: an .mp4 and a .mov are the same container as far as ffmpeg cares", () => {
    // ffprobe reports every name the demuxer handles, so the two are identical
    // strings here. Comparing containers with === would still be wrong for the
    // general case, which is why it is a set intersection.
    assert.equal(d.sameContainer("mov,mp4,m4a,3gp,3g2,mj2", "mov,mp4,m4a,3gp,3g2,mj2"), true);
    assert.equal(d.sameContainer("matroska,webm", "mov,mp4,m4a"), false);
    assert.equal(d.sameContainer("matroska,webm", "webm"), true);
    assert.equal(d.sameContainer(null, "mp4"), false);
});

test("join: frame rates that round the same are still different rates", () => {
    // 30000/1001 and 2997/100 both display as 29.97. Stream-copying them
    // together produces a file whose timestamps drift, so the exact rational
    // is what the comparison uses and `fps` is only ever for showing a person.
    const ntsc = clip({ video: { ...clip().video, fpsExact: { num: 30000, den: 1001 } } });
    const nearly = clip({ video: { ...clip().video, fpsExact: { num: 2997, den: 100 } } });

    const result = d.compareClips([ntsc, nearly]);
    assert.equal(result.compatible, false);
    assert.deepEqual(result.differences.map(x => x.field), ["fps"]);
    assert.equal(d.describeJoinPlan(result).strategy, "filter");

    // ...but the same rate written two ways is the same rate.
    const sixtyOverTwo = clip({ video: { ...clip().video, fpsExact: { num: 60, den: 2 } } });
    assert.equal(d.compareClips([clip(), sixtyOverTwo]).compatible, true);
});

test("join: a time base difference alone forces a re-encode", () => {
    const other = clip({ video: { ...clip().video, timeBase: "1/12800" } });
    const result = d.compareClips([clip(), other]);
    assert.equal(result.compatible, false);
    assert.deepEqual(result.differences.map(x => x.field), ["timeBase"]);
});

test("join: every mismatch is named, so the UI can say why", () => {
    const other = clip({
        video: { ...clip().video, width: 1280, height: 720, pixelFormat: "yuv422p" },
        audio: { ...clip().audio, sampleRate: 44100 },
    });
    const plan = d.describeJoinPlan(d.compareClips([clip(), other]));
    assert.equal(plan.strategy, "filter");
    assert.deepEqual(plan.reasons, ["width", "height", "pixel format", "sample rate"]);
    assert.match(plan.headline, /re-encoded/);
});

test("join: a file ffmpeg cannot read is refused rather than compared", () => {
    // probe returns { ok: false } with no `video` at all, so every field would
    // read undefined and match any other unreadable clip.
    const result = d.compareClips([clip(), { ok: false, error: "cannot read" }]);
    assert.equal(result.compatible, false);
    assert.equal(result.blocked, "unreadable");
    assert.equal(result.blockedIndex, 1);
    assert.equal(d.describeJoinPlan(result).strategy, "blocked");
});

test("join: video and audio-only files cannot be joined to each other", () => {
    const audioOnly = clip({ hasVideo: false, video: null, formatName: "mp3" });
    assert.equal(d.compareClips([clip(), audioOnly]).blocked, "mixed-kinds");

    // A silent clip onto one with sound would need a track synthesising.
    const silent = clip({ hasAudio: false, audio: null });
    assert.equal(d.compareClips([clip(), silent]).blocked, "mixed-audio");

    // Audio-only throughout is a perfectly good join.
    assert.equal(d.compareClips([audioOnly, audioOnly]).blocked, null);
});

test("join: GIF is never offered as a destination", () => {
    // Its palette pass and the concat both want -filter_complex, and the two
    // do not stack. Refused rather than half-supported.
    const targets = d.joinTargets([clip(), clip()], formats.FORMATS);
    assert.ok(!targets.includes("gif"));
    assert.ok(targets.includes("mp4"));

    const audioOnly = clip({ hasVideo: false, video: null });
    const audioTargets = d.joinTargets([audioOnly, audioOnly], formats.FORMATS);
    assert.ok(audioTargets.includes("mp3"));
    assert.ok(!audioTargets.includes("mp4"), "audio cannot be joined into a video container");
});

test("join: one clip needs no comparison", () => {
    assert.equal(d.compareClips([clip()]).compatible, true);
    assert.equal(d.compareClips([]).compatible, true);
});
