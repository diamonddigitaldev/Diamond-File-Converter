"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const formats = require("../src/core/formats");
const { createJob, patchJob, validateJob, defaultModeFor, STREAM_MODE, CONFLICT, OUTPUT_ROUTING } = require("../src/core/job");
const { buildArgs, normaliseBitrate, buildScaleFilter } = require("../src/core/ffmpeg-args");
const paths = require("../src/core/paths");
const { parseProgressLines, lastMeaningfulLine } = require("../src/core/runner");
const { scanPaths, commonRoot } = require("../src/core/scan");
const probe = require("../src/core/probe");

// Find the flag/value pair for a flag, so assertions do not depend on argv order.
function valueOf(args, flag) {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
}

// ---------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------

test("formats: canonicalises aliases and rejects unknowns", () => {
    assert.equal(formats.canonicalExt(".JPEG"), "jpg");
    assert.equal(formats.canonicalExt("tif"), "tiff");
    assert.equal(formats.canonicalExt("mp4"), "mp4");
    assert.equal(formats.canonicalExt("exe"), null);
    assert.equal(formats.canonicalExt(null), null);
});

test("formats: expresses the cross-kind conversions v1 could not", () => {
    // The whole point of replacing the within-group cross-product.
    assert.deepEqual(formats.allowedModes("mp4", "mp3"), [formats.MODE.EXTRACT]);
    assert.ok(formats.allowedModes("mp4", "png").includes(formats.MODE.FRAMES));
    assert.deepEqual(formats.allowedModes("png", "mp4"), [formats.MODE.ASSEMBLE]);
});

test("formats: animated source into a still target explodes into frames", () => {
    // This subsumes v1's hardcoded isGifToStaticImage special case.
    assert.equal(formats.defaultMode("gif", "png"), formats.MODE.FRAMES);
    assert.ok(formats.producesDirectory(formats.MODE.FRAMES));
    // ...but gif -> animated webp stays a single file.
    assert.equal(formats.defaultMode("gif", "webp"), formats.MODE.TRANSCODE);
    assert.equal(formats.producesDirectory(formats.MODE.TRANSCODE), false);
});

test("formats: audio cannot become video or images", () => {
    assert.equal(formats.canConvert("mp3", "mp4"), false);
    assert.equal(formats.canConvert("mp3", "png"), false);
    assert.equal(formats.canConvert("mp3", "flac"), true);
});

test("formats: the ingest map says what is supported and nothing more", () => {
    // It answers two questions for the renderer: may this file be dropped at
    // all, and which kind icon goes on its card. It used to carry a same-kind
    // target list too, which nothing has read since target lists moved to the
    // full graph — carrying it implied the UI was still same-kind only.
    const map = formats.buildLegacyConversionMap();
    assert.equal(Object.keys(map).length, 21);
    assert.equal(map.mp4.type, "video");
    assert.equal(map.mp3.type, "audio");
    assert.equal(map.jpg.type, "image");
    assert.ok(Object.values(map).every(e => Object.keys(e).join() === "type"));
});

// ---------------------------------------------------------------------------
// job
// ---------------------------------------------------------------------------

test("job: fills defaults from the target format", () => {
    const job = createJob({ inputPath: "C:\\in\\clip.mov", targetExt: "mp4" });
    assert.equal(job.sourceExt, "mov");
    assert.equal(job.output.ext, "mp4");
    assert.equal(job.mode, formats.MODE.TRANSCODE);
    assert.equal(job.video.codec, "libx264");
    assert.equal(job.audio.codec, "aac");
    assert.equal(job.video.mode, STREAM_MODE.ENCODE);
});

test("job: audio target drops video automatically", () => {
    const job = createJob({ inputPath: "C:\\in\\clip.mp4", targetExt: "mp3" });
    assert.equal(job.mode, formats.MODE.EXTRACT);
    assert.equal(job.video.mode, STREAM_MODE.DROP);
    assert.equal(job.audio.mode, STREAM_MODE.ENCODE);
});

test("job: image target drops audio automatically", () => {
    const job = createJob({ inputPath: "C:\\in\\clip.mp4", targetExt: "png" });
    assert.equal(job.audio.mode, STREAM_MODE.DROP);
});

test("job: patch merges nested sections rather than replacing them", () => {
    const job = createJob({ inputPath: "a.mp4", targetExt: "mp4" });
    const patched = patchJob(job, { video: { crf: 20 } });
    assert.equal(patched.video.crf, 20);
    assert.equal(patched.video.codec, "libx264", "sibling fields must survive the patch");
});

test("job: validation catches impossible combinations", () => {
    assert.ok(validateJob(createJob({ inputPath: "a.mp4", targetExt: "mp4" })).valid);

    const noTarget = validateJob(createJob({ inputPath: "a.mp4" }));
    assert.equal(noTarget.valid, false);

    const bothDropped = createJob({ inputPath: "a.mp4", targetExt: "mp4" });
    bothDropped.video.mode = STREAM_MODE.DROP;
    bothDropped.audio.mode = STREAM_MODE.DROP;
    assert.equal(validateJob(bothDropped).valid, false);

    const badCopy = createJob({ inputPath: "a.mp4", targetExt: "png" });
    badCopy.video.mode = STREAM_MODE.COPY;
    assert.equal(validateJob(badCopy).valid, false, "PNG cannot stream-copy");

    const badCodec = createJob({ inputPath: "a.mp4", targetExt: "webm" });
    badCodec.video.codec = "libx264";
    assert.equal(validateJob(badCodec).valid, false, "WebM cannot carry H.264");

    const badTrim = createJob({ inputPath: "a.mp4", targetExt: "mp4", trim: { start: 10, end: 5 } });
    assert.equal(validateJob(badTrim).valid, false);
});

test("job: validation does not require metadata", () => {
    // Cards must be valid before the probe returns.
    const job = createJob({ inputPath: "a.mp4", targetExt: "mp4" });
    assert.equal(job.inputMeta, null);
    assert.ok(validateJob(job).valid);
});

// ---------------------------------------------------------------------------
// ffmpeg-args
// ---------------------------------------------------------------------------

test("args: stream copy remuxes without re-encoding", () => {
    const job = createJob({ inputPath: "in.mkv", targetExt: "mp4" });
    job.video.mode = STREAM_MODE.COPY;
    job.audio.mode = STREAM_MODE.COPY;
    const args = buildArgs(job, { outputPath: "out.mp4" });

    assert.equal(valueOf(args, "-c:v"), "copy");
    assert.equal(valueOf(args, "-c:a"), "copy");
    assert.ok(!args.includes("-crf"));
    assert.equal(args[args.length - 1], "out.mp4");
});

test("args: re-encode carries crf, preset and a compatible pixel format", () => {
    const job = createJob({ inputPath: "in.mov", targetExt: "mp4" });
    job.video.crf = 21;
    job.video.preset = "slow";
    job.audio.bitrate = 192;
    const args = buildArgs(job, { outputPath: "out.mp4" });

    assert.equal(valueOf(args, "-c:v"), "libx264");
    assert.equal(valueOf(args, "-crf"), "21");
    assert.equal(valueOf(args, "-preset"), "slow");
    assert.equal(valueOf(args, "-pix_fmt"), "yuv420p");
    assert.equal(valueOf(args, "-b:a"), "192k");
    assert.equal(valueOf(args, "-movflags"), "+faststart");
});

test("args: VP9 releases the bitrate cap so -crf is constant quality", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "webm" });
    job.video.crf = 30;
    const args = buildArgs(job, { outputPath: "out.webm" });
    assert.equal(valueOf(args, "-crf"), "30");
    assert.equal(valueOf(args, "-b:v"), "0");
});

test("args: trim seeks on the input and bounds with a duration", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "mp4", trim: { start: 5, end: 12.5 } });
    const args = buildArgs(job, { outputPath: "out.mp4" });

    assert.equal(valueOf(args, "-ss"), "5");
    assert.equal(valueOf(args, "-t"), "7.5", "duration counts from the seek point");
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss must precede -i for a fast seek");
    assert.ok(args.indexOf("-t") > args.indexOf("-i"), "-t must follow -i");
});

test("args: audio extraction drops video entirely", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "mp3" });
    const args = buildArgs(job, { outputPath: "out.mp3" });
    assert.ok(args.includes("-vn"));
    assert.equal(valueOf(args, "-c:a"), "libmp3lame");
});

test("args: resize honours the fit mode", () => {
    const contain = createJob({ inputPath: "in.mp4", targetExt: "mp4" });
    contain.video.width = 1280; contain.video.height = 720;
    assert.equal(valueOf(buildArgs(contain, { outputPath: "o.mp4" }), "-vf"),
        "scale=1280:720:force_original_aspect_ratio=decrease");

    const cover = patchJob(contain, { video: { fitMode: "cover" } });
    assert.equal(valueOf(buildArgs(cover, { outputPath: "o.mp4" }), "-vf"),
        "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720");

    const stretch = patchJob(contain, { video: { fitMode: "stretch" } });
    assert.equal(valueOf(buildArgs(stretch, { outputPath: "o.mp4" }), "-vf"), "scale=1280:720");
});

test("args: a single axis keeps the result divisible by two", () => {
    assert.equal(buildScaleFilter({ video: { width: 640 } }), "scale=640:-2");
    assert.equal(buildScaleFilter({ video: { height: 480 } }), "scale=-2:480");
    assert.equal(buildScaleFilter({ video: {} }), null);
});

test("args: image quality uses the target format's own flag and scale", () => {
    const jpg = createJob({ inputPath: "in.png", targetExt: "jpg" });
    assert.equal(valueOf(buildArgs(jpg, { outputPath: "o.jpg" }), "-q:v"), "3");

    const png = createJob({ inputPath: "in.jpg", targetExt: "png" });
    assert.equal(valueOf(buildArgs(png, { outputPath: "o.png" }), "-compression_level"), "6");

    const webp = createJob({ inputPath: "in.png", targetExt: "webp" });
    assert.equal(valueOf(buildArgs(webp, { outputPath: "o.webp" }), "-quality"), "80");

    // Out-of-range values are clamped to the format's own bounds.
    const clamped = patchJob(jpg, { image: { quality: 99 } });
    assert.equal(valueOf(buildArgs(clamped, { outputPath: "o.jpg" }), "-q:v"), "31");
});

test("args: frame extraction writes a numbered pattern inside the output dir", () => {
    const job = createJob({ inputPath: "in.gif", targetExt: "png" });
    assert.equal(job.mode, formats.MODE.FRAMES);
    const args = buildArgs(job, { outputPath: path.join("C:", "out", "clip") });

    // Six digits: ffmpeg widens rather than truncates, so %04d runs frame_9999
    // into frame_10000 and the directory stops sorting in capture order.
    assert.ok(args[args.length - 1].endsWith(`frame_%06d.png`));
    assert.equal(valueOf(args, "-fps_mode"), "passthrough");
});

test("args: GIF output builds a palette so it is not a 256-colour mess", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "gif" });
    job.video.fps = 15;
    const args = buildArgs(job, { outputPath: "out.gif" });
    const fc = valueOf(args, "-filter_complex");

    assert.ok(fc.includes("palettegen"));
    assert.ok(fc.includes("paletteuse"));
    assert.ok(fc.includes("fps=15"), "preceding filters must survive into the palette chain");
    assert.ok(!args.includes("-vf"), "the palette chain replaces -vf, it does not coexist with it");
});

test("args: assembling stills into video loops a single image", () => {
    const job = createJob({ inputPath: "still.png", targetExt: "mp4" });
    assert.equal(job.mode, formats.MODE.ASSEMBLE);
    const args = buildArgs(job, { outputPath: "out.mp4" });
    assert.ok(args.includes("-loop"));
    assert.equal(valueOf(args, "-framerate"), "25");
});

test("args: progress is machine-readable by default", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "mp4" });
    const args = buildArgs(job, { outputPath: "o.mp4" });
    assert.equal(valueOf(args, "-progress"), "pipe:1");
    assert.ok(args.includes("-nostats"));

    const quiet = buildArgs(job, { outputPath: "o.mp4", progress: false });
    assert.ok(!quiet.includes("-progress"));
});

test("args: bitrate accepts the forms a UI will actually produce", () => {
    assert.equal(normaliseBitrate(192), "192k");
    assert.equal(normaliseBitrate("192k"), "192k");
    assert.equal(normaliseBitrate(192000), "192k");
    assert.equal(normaliseBitrate("320K"), "320k");
});

test("args: an unresolvable output path is a hard error, not a silent skip", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "mp4" });
    assert.throws(() => buildArgs(job, {}), /outputPath/);
});

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

test("paths: name templating expands the documented tokens", () => {
    const now = new Date(2026, 7, 27, 14, 5, 9);
    const out = paths.applyNameTemplate("{name}_{src}-to-{ext}_{index}_{date}_{time}", {
        name: "holiday", src: "mov", ext: "mp4", index: 3, now,
    });
    assert.equal(out, "holiday_mov-to-mp4_3_2026-08-27_140509");
});

test("paths: unknown tokens are left visible rather than silently blanked", () => {
    assert.equal(paths.applyNameTemplate("{name}-{nope}", { name: "a" }), "a-{nope}");
});

test("paths: names are made safe for Windows", () => {
    assert.equal(paths.sanitiseName('a<b>c:d"e/f\\g|h?i*j'), "a_b_c_d_e_f_g_h_i_j");
    assert.equal(paths.sanitiseName("trailing dots..."), "trailing dots");
    assert.equal(paths.sanitiseName("   "), "output");
});

test("paths: mirror routing rebuilds the source tree under the destination", () => {
    const job = createJob({
        inputPath: path.join("C:", "src", "a", "b", "clip.mov"),
        targetExt: "mp4",
        output: {
            routing: OUTPUT_ROUTING.MIRROR,
            mirrorRoot: path.join("C:", "src"),
            dir: path.join("D:", "out"),
        },
    });
    assert.equal(paths.resolveOutputDir(job), path.join("D:", "out", "a", "b"));
});

test("paths: alongside routing reproduces v1 behaviour exactly", () => {
    const job = createJob({ inputPath: path.join("C:", "src", "clip.mov"), targetExt: "mp4" });
    assert.equal(paths.resolveOutputDir(job), path.join("C:", "src"));
});

test("paths: conflict policies resolve against the real filesystem", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-paths-"));
    try {
        const input = path.join(dir, "clip.mov");
        fs.writeFileSync(input, "");
        fs.writeFileSync(path.join(dir, "clip.mp4"), ""); // the collision

        const base = { inputPath: input, targetExt: "mp4" };

        const unique = paths.resolveOutputPath(createJob({ ...base, output: { onConflict: CONFLICT.UNIQUE } }));
        assert.equal(unique.action, "write");
        assert.equal(path.basename(unique.outputPath), "clip (1).mp4");

        const overwrite = paths.resolveOutputPath(createJob({ ...base, output: { onConflict: CONFLICT.OVERWRITE } }));
        assert.equal(overwrite.action, "write");
        assert.equal(path.basename(overwrite.outputPath), "clip.mp4");

        assert.equal(paths.resolveOutputPath(createJob({ ...base, output: { onConflict: CONFLICT.SKIP } })).action, "skip");
        assert.equal(paths.resolveOutputPath(createJob({ ...base, output: { onConflict: CONFLICT.ASK } })).action, "ask");

        // No collision at all, so the policy never comes into play.
        const clean = paths.resolveOutputPath(createJob({ ...base, targetExt: "mkv" }));
        assert.equal(clean.action, "write");
        assert.equal(path.basename(clean.outputPath), "clip.mkv");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("paths: frame extraction resolves to a directory, not a file", () => {
    const job = createJob({ inputPath: path.join("C:", "src", "loop.gif"), targetExt: "png" });
    const resolved = paths.resolveOutputPath(job);
    assert.equal(resolved.isDirectory, true);
    assert.equal(path.basename(resolved.outputPath), "loop");
});

// ---------------------------------------------------------------------------
// runner progress parsing
// ---------------------------------------------------------------------------

test("runner: progress is derived from out_time against a known duration", () => {
    const update = parseProgressLines(
        ["out_time_us=5000000", "speed=2.0x", "fps=48.0", "progress=continue"],
        10
    );
    assert.equal(update.percent, 50);
    assert.equal(update.speed, 2);
    assert.equal(update.fps, 48);
    assert.equal(update.eta, 2.5);
});

test("runner: unknown duration yields indeterminate progress, not a frozen zero", () => {
    // This is exactly the case where v1's bar sat at 0% for the whole job.
    const update = parseProgressLines(["out_time_us=1000000", "progress=continue"], null);
    assert.equal(update.percent, null);
    assert.equal(update.outSeconds, 1);
});

test("runner: the end marker completes even without a duration", () => {
    assert.equal(parseProgressLines(["progress=end"], null).percent, 100);
});

test("runner: progress never reaches 100 before the end marker", () => {
    const update = parseProgressLines(["out_time_us=20000000", "progress=continue"], 10);
    assert.ok(update.percent < 100);
});

test("runner: uninteresting blocks are dropped", () => {
    assert.equal(parseProgressLines(["bitrate=N/A", "garbage"], 10), null);
});

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

test("scan: walks recursively and filters by the format graph", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-scan-"));
    try {
        fs.mkdirSync(path.join(root, "nested", "deep"), { recursive: true });
        fs.writeFileSync(path.join(root, "a.mp3"), "");
        fs.writeFileSync(path.join(root, "notes.txt"), "");
        fs.writeFileSync(path.join(root, "nested", "b.mp4"), "");
        fs.writeFileSync(path.join(root, "nested", "deep", "c.png"), "");

        const all = await scanPaths([root]);
        assert.equal(all.files.length, 3, "v1 would have found only the top-level file");
        assert.equal(all.skipped.length, 1, "the .txt is skipped");

        const shallow = await scanPaths([root], { recursive: false });
        assert.equal(shallow.files.length, 1);

        const depthOne = await scanPaths([root], { maxDepth: 1 });
        assert.equal(depthOne.files.length, 2);

        const onlyAudio = await scanPaths([root], { include: ["mp3"] });
        assert.equal(onlyAudio.files.length, 1);

        const noImages = await scanPaths([root], { exclude: ["png"] });
        assert.equal(noImages.files.length, 2);

        const capped = await scanPaths([root], { maxFiles: 2 });
        assert.equal(capped.files.length, 2);
        assert.equal(capped.truncated, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("scan: says which file was skipped and why", async () => {
    // A count alone cannot tell "this app cannot read that" apart from "you
    // turned that type off", and those want very different reactions.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-scan-why-"));
    try {
        fs.writeFileSync(path.join(root, "a.mp3"), "");
        fs.writeFileSync(path.join(root, "b.png"), "");
        fs.writeFileSync(path.join(root, "notes.txt"), "");

        const plain = await scanPaths([root]);
        assert.deepEqual(plain.skipped.map(s => path.basename(s.path)), ["notes.txt"]);
        assert.equal(plain.skipped[0].reason, "unsupported");

        const onlyAudio = await scanPaths([root], { include: ["mp3"] });
        const byName = Object.fromEntries(onlyAudio.skipped.map(s => [path.basename(s.path), s.reason]));
        assert.equal(byName["b.png"], "not-included", "a filtered-out file is not the same as an unreadable one");
        assert.equal(byName["notes.txt"], "unsupported");

        const noImages = await scanPaths([root], { exclude: ["png"] });
        assert.equal(noImages.skipped.find(s => path.basename(s.path) === "b.png").reason, "excluded");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("scan: deduplicates and reports unreadable paths without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-scan2-"));
    try {
        const file = path.join(root, "a.mp3");
        fs.writeFileSync(file, "");

        const result = await scanPaths([file, file, path.join(root, "missing.mp4")]);
        assert.equal(result.files.length, 1);
        assert.equal(result.errors.length, 1);
        assert.deepEqual(result.errors[0].path, path.join(root, "missing.mp4"));
        assert.equal(typeof result.errors[0].error, "string");
        // The same file twice is not a skip. Nothing was dropped, so there is
        // nothing to report, and counting it would put a scary number in a
        // toast for a drop that did exactly what the user asked.
        assert.equal(result.skipped.length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("scan: common root finds the shared ancestor for mirrored output", () => {
    const a = path.join("C:", "media", "a", "one.mp4");
    const b = path.join("C:", "media", "b", "two.mp4");
    assert.equal(commonRoot([a, b]), path.join("C:", "media"));
    assert.equal(commonRoot([a]), path.join("C:", "media", "a"));
    assert.equal(commonRoot([]), null);

    // Separate drives have no shared root at all. resolveOutputDir treats null
    // as plain fixed output rather than throwing, so this must be null and not
    // something creative.
    assert.equal(commonRoot([path.join("C:", "one.mp4"), path.join("D:", "two.mp4")]), null);

    // A drive-letter-only result has to come back as a path. "E:" alone is a
    // drive-relative reference, not the root of the drive.
    const sameDrive = commonRoot([path.join("E:", "a.mp4"), path.join("E:", "sub", "b.mp4")]);
    assert.equal(sameDrive, `E:${path.sep}`);
});

test("scan: a folder ingest mirrors from the folder, not from what it found", async () => {
    // The root has to be the folder pointed at. Deriving it from the files
    // found collapses any level that happens to hold everything: point at
    // <root> containing only <root>/2024/a.mp3 and the shared ancestor of the
    // files is <root>/2024, so the mirror silently drops the level the user
    // asked to preserve.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-root-"));
    try {
        fs.mkdirSync(path.join(root, "2024"), { recursive: true });
        fs.writeFileSync(path.join(root, "2024", "a.mp3"), "");

        const scanned = await scanPaths([root]);
        assert.equal(scanned.files.length, 1);
        assert.equal(scanned.root, path.resolve(root), "the folder pointed at is the root");
        assert.notEqual(scanned.root, path.join(root, "2024"));

        // Loose files have no folder to speak of, so their shared ancestor is
        // the only answer available.
        const loose = await scanPaths([path.join(root, "2024", "a.mp3")]);
        assert.equal(loose.root, path.join(root, "2024"));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("scan: mirrored output rebuilds the tree the scan reported", async () => {
    // scan.js finds the root and paths.js consumes it; this is the seam where
    // mirroring was broken for three releases, because nothing joined them up.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-mirror-"));
    try {
        fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
        const input = path.join(root, "a", "b", "clip.mov");
        fs.writeFileSync(input, "");

        const scanned = await scanPaths([root]);
        const job = createJob({
            inputPath: scanned.files[0],
            targetExt: "mp4",
            output: { routing: OUTPUT_ROUTING.MIRROR, dir: path.join("D:", "out"), mirrorRoot: scanned.root },
        });

        assert.deepEqual(validateJob(job).errors ?? [], [], "a scanned root must satisfy validation");
        assert.equal(paths.resolveOutputDir(job), path.join("D:", "out", "a", "b"));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

test("probe: normalises ffprobe JSON into the shape the UI binds to", () => {
    const raw = {
        format: { duration: "12.5", size: "1048576", bit_rate: "800000", format_name: "mov,mp4,m4a" },
        streams: [
            { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", pix_fmt: "yuv420p" },
            { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo" },
        ],
    };
    const meta = probe.normalise(raw, "clip.mp4");

    assert.equal(meta.ok, true);
    assert.equal(meta.duration, 12.5);
    assert.equal(meta.hasVideo, true);
    assert.equal(meta.hasAudio, true);
    assert.equal(meta.video.width, 1920);
    assert.equal(meta.video.fps, 29.97);
    assert.equal(meta.audio.channels, 2);
});

test("probe: cover art does not make an MP3 look like a video", () => {
    const raw = {
        format: { duration: "180" },
        streams: [
            { codec_type: "video", codec_name: "mjpeg", width: 600, height: 600, disposition: { attached_pic: 1 } },
            { codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 },
        ],
    };
    const meta = probe.normalise(raw, "song.mp3");
    assert.equal(meta.hasVideo, false);
    assert.equal(meta.streamCounts.video, 0);
});

test("probe: rational frame rates parse, degenerate ones do not", () => {
    assert.equal(probe.parseFrameRate("30000/1001"), 29.97);
    assert.equal(probe.parseFrameRate("25/1"), 25);
    assert.equal(probe.parseFrameRate("0/0"), null);
    assert.equal(probe.parseFrameRate("N/A"), null);
});

test("probe: an unconfigured binary degrades instead of throwing", async () => {
    const before = probe.getFfprobePath();
    probe.setFfprobePath(null);
    const result = await probe.probe("anything.mp4");
    assert.equal(result.ok, false);
    assert.match(result.error, /not been configured/);
    probe.setFfprobePath(before);
});

// ---------------------------------------------------------------------------
// cross-kind conversions
// ---------------------------------------------------------------------------

// A still reports no average frame rate; an animated GIF has one but still no
// container duration, which is why isStill is an explicit signal.
const STILL = { ok: true, isStill: true, duration: null };
const MOVING = { ok: true, isStill: false, duration: 3.2 };

test("formats: an animated source keeps its motion into a video container", () => {
    // gif -> mp4 used to be ASSEMBLE on kind alone, which treats the whole
    // animation as one still and loops it for five seconds.
    assert.deepEqual(formats.allowedModes("gif", "mp4"), [formats.MODE.TRANSCODE, formats.MODE.ASSEMBLE]);
    assert.deepEqual(formats.allowedModes("webp", "mp4"), [formats.MODE.TRANSCODE, formats.MODE.ASSEMBLE]);

    // A container that can only ever hold one frame still assembles.
    assert.deepEqual(formats.allowedModes("png", "mp4"), [formats.MODE.ASSEMBLE]);
    assert.deepEqual(formats.allowedModes("jpg", "mkv"), [formats.MODE.ASSEMBLE]);
});

test("job: whether a file moves is decided by the probe, not its extension", () => {
    // The bug this exists to stop: an ordinary still WebP asked for PNG takes
    // the animated path and lands as a directory containing one frame.
    assert.equal(defaultModeFor("webp", "png", STILL), formats.MODE.THUMBNAIL);
    assert.equal(defaultModeFor("webp", "png", MOVING), formats.MODE.FRAMES);

    // A still in a container that could animate still loops into a clip.
    assert.equal(defaultModeFor("gif", "mp4", STILL), formats.MODE.ASSEMBLE);
    assert.equal(defaultModeFor("gif", "mp4", MOVING), formats.MODE.TRANSCODE);

    // Video sources are unaffected — they always move.
    assert.equal(defaultModeFor("mp4", "png", MOVING), formats.MODE.FRAMES);
    assert.equal(defaultModeFor("mp4", "mp3", MOVING), formats.MODE.EXTRACT);
});

test("job: with no probe yet, the static default stands", () => {
    // Cards are configurable long before their probe returns, so this must not
    // throw or guess wrongly in the meantime.
    assert.equal(defaultModeFor("webp", "png", null), formats.MODE.FRAMES);
    assert.equal(defaultModeFor("webp", "png", { ok: false }), formats.MODE.FRAMES);
    assert.equal(defaultModeFor("webp", "png", { ok: true }), formats.MODE.FRAMES,
        "a probe that says nothing about stillness is not evidence of it");
    assert.equal(defaultModeFor(null, "png", STILL), null);
    assert.equal(defaultModeFor("mp3", "png", MOVING), null, "an impossible pair has no mode");
});

test("job: createJob takes the mode it is given over any default", () => {
    const job = createJob({ inputPath: "clip.mp4", targetExt: "png", mode: formats.MODE.THUMBNAIL });
    assert.equal(job.mode, formats.MODE.THUMBNAIL);
    assert.equal(validateJob(job).valid, true);

    // ...but not one the pair does not allow.
    const bogus = createJob({ inputPath: "clip.mp4", targetExt: "png", mode: formats.MODE.EXTRACT });
    const result = validateJob(bogus);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /not valid for/);
});

test("args: a single frame is taken from the middle, not from black", () => {
    const job = createJob({ inputPath: "clip.mp4", targetExt: "jpg", mode: formats.MODE.THUMBNAIL });
    job.inputMeta = { ok: true, duration: 60 };
    const args = buildArgs(job, { outputPath: "out.jpg", progress: false });

    assert.equal(valueOf(args, "-ss"), "30");
    assert.equal(valueOf(args, "-frames:v"), "1");
    assert.equal(valueOf(args, "-update"), "1");
    assert.ok(!args.includes("-fps_mode"), "one frame is not a sequence");
});

test("args: an explicit position beats the midpoint", () => {
    const job = createJob({
        inputPath: "clip.mp4", targetExt: "jpg",
        mode: formats.MODE.THUMBNAIL, trim: { start: 12, end: null },
    });
    job.inputMeta = { ok: true, duration: 60 };
    assert.equal(valueOf(buildArgs(job, { outputPath: "out.jpg", progress: false }), "-ss"), "12");
});

test("args: an unprobed thumbnail does not invent a seek", () => {
    const job = createJob({ inputPath: "clip.mp4", targetExt: "jpg", mode: formats.MODE.THUMBNAIL });
    assert.ok(!buildArgs(job, { outputPath: "out.jpg", progress: false }).includes("-ss"));
});

test("args: an animated source transcodes into video rather than looping", () => {
    const job = createJob({ inputPath: "anim.gif", targetExt: "mp4", inputMeta: MOVING });
    assert.equal(job.mode, formats.MODE.TRANSCODE);

    const args = buildArgs(job, { outputPath: "out.mp4", progress: false });
    assert.ok(!args.includes("-loop"), "-loop belongs to the image2 demuxer, not gif");
    assert.equal(valueOf(args, "-c:v"), "libx264");
    // An image source has no audio, whichever mode it takes.
    assert.ok(args.includes("-an"));
    assert.ok(!args.includes("-c:a"));
});

test("args: a still assembled into video is still looped", () => {
    const job = createJob({ inputPath: "still.png", targetExt: "mp4" });
    assert.equal(job.mode, formats.MODE.ASSEMBLE);
    const args = buildArgs(job, { outputPath: "out.mp4", progress: false });
    assert.ok(args.includes("-loop"));
    assert.equal(valueOf(args, "-framerate"), "25");
    assert.equal(valueOf(args, "-t"), "5");
});

test("args: a real video keeps its audio", () => {
    // Guards the image-source audio drop above from over-reaching.
    const args = buildArgs(createJob({ inputPath: "clip.mp4", targetExt: "mkv" }),
        { outputPath: "out.mkv", progress: false });
    assert.equal(valueOf(args, "-c:a"), "aac");
    assert.ok(!args.includes("-an"));
});

test("args: a frame range seeks and bounds like a trim", () => {
    // Choosing which frames is the same mechanism as trimming, which is what
    // lets the dialog reuse the trim slider for it.
    const job = createJob({
        inputPath: "clip.mp4", targetExt: "png",
        mode: formats.MODE.FRAMES, trim: { start: 5, end: 8 },
    });
    const args = buildArgs(job, { outputPath: path.join("C:", "out", "clip"), progress: false });
    assert.equal(valueOf(args, "-ss"), "5");
    assert.equal(valueOf(args, "-t"), "3");
    assert.ok(args[args.length - 1].endsWith("frame_%06d.png"));
});

// ---------------------------------------------------------------------------
// reporting why a conversion failed
// ---------------------------------------------------------------------------

test("runner: a failure reports its cause, not ffmpeg's closing verdict", () => {
    // Verbatim from the bundled build refusing an animated WebP. Taking the
    // last line — which is what this used to do — yields "Conversion failed!",
    // so the card said nothing at all about why.
    const stderr = [
        "Error marking filters as finished",
        "Error while filtering: Invalid data found when processing input",
        "[vist#0:0/webp @ 000002ae13bd53c0] Decode error rate 1 exceeds maximum 0.666667",
        "[out#0/image2 @ 000002ae13bc3d80] Nothing was written into output file, "
            + "because at least one of its streams received no packets.",
        "frame=    0 fps=0.0 q=0.0 Lsize=       0kB time=N/A bitrate=N/A speed=N/A",
        "Conversion failed!",
    ].join("\n");

    assert.equal(lastMeaningfulLine(stderr),
        "Error while filtering: Invalid data found when processing input");
});

test("runner: the component prefix is stripped from a reason", () => {
    assert.equal(
        lastMeaningfulLine("[mp4 @ 0x55f1c8] Could not find tag for codec vp9 in stream #0\nConversion failed!"),
        "Could not find tag for codec vp9 in stream #0");
});

test("runner: progress counters and the verdict are never the reason", () => {
    assert.equal(lastMeaningfulLine("Conversion failed!"), null);
    assert.equal(lastMeaningfulLine("frame=  102 fps=25 q=28.0 size=  1024kB\nConversion failed!"), null);
    assert.equal(lastMeaningfulLine(""), null);
    assert.equal(lastMeaningfulLine(null), null);
});

test("runner: with nothing that names a cause, the last real line still stands", () => {
    // Better an unexplained line than no message at all.
    assert.equal(lastMeaningfulLine("something odd happened\nConversion failed!"), "something odd happened");
});

test("probe: a picture stream it cannot measure is reported as unreadable", () => {
    // The bundled ffmpeg (6.1.1) reads no animated WebP and describes one as
    // 0x0. Catching it here means the card says so before the conversion is
    // configured, rather than after it fails.
    const result = probe.normalise({
        format: { duration: null },
        streams: [{ codec_type: "video", codec_name: "webp", width: 0, height: 0, avg_frame_rate: "0/0" }],
    }, "anim.webp");

    assert.equal(result.ok, false);
    assert.match(result.error, /cannot read this file/i);
    assert.match(result.error, /animated webp/i);
});

test("probe: a still image with real dimensions is fine", () => {
    const result = probe.normalise({
        format: { duration: null },
        streams: [{ codec_type: "video", codec_name: "webp", width: 160, height: 120, avg_frame_rate: "0/0" }],
    }, "photo.webp");

    assert.equal(result.ok, true);
    assert.equal(result.isStill, true);
});

test("probe: an audio-only file has no picture stream to measure", () => {
    // The unreadable check must not fire on something that simply has no video.
    const result = probe.normalise({
        format: { duration: 180 },
        streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 }],
    }, "song.mp3");

    assert.equal(result.ok, true);
    assert.equal(result.hasVideo, false);
    assert.equal(result.isStill, false);
});
