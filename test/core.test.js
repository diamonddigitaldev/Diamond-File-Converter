"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const formats = require("../src/core/formats");
const { createJob, patchJob, validateJob, STREAM_MODE, CONFLICT, OUTPUT_ROUTING } = require("../src/core/job");
const { buildArgs, normaliseBitrate, buildScaleFilter } = require("../src/core/ffmpeg-args");
const paths = require("../src/core/paths");
const pipeline = require("../src/core/pipeline");
const { parseProgressLines } = require("../src/core/runner");
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

test("formats: legacy map stays within-group so the v1 grid is unchanged", () => {
    const map = formats.buildLegacyConversionMap();
    assert.equal(Object.keys(map).length, 21);
    assert.equal(map.mp4.type, "video");
    assert.equal(map.mp4.targets.length, 7);
    assert.ok(map.mp4.targets.every(t => t.group === "Video"));
    assert.equal(map.mp3.targets.length, 8);
    assert.equal(map.jpg.targets.length, 6);
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

    assert.ok(args[args.length - 1].endsWith(`frame_%04d.png`));
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
// pipeline
// ---------------------------------------------------------------------------

function linearPipeline() {
    return pipeline.createPipeline({
        name: "scale then output",
        nodes: [
            { id: "in", type: "input" },
            { id: "sc", type: "scale", params: { width: 640, height: 360, fitMode: "contain" } },
            { id: "out", type: "output" },
        ],
        edges: [
            { from: "in", fromPort: "video", to: "sc", toPort: "in" },
            { from: "sc", fromPort: "out", to: "out", toPort: "video" },
            { from: "in", fromPort: "audio", to: "out", toPort: "audio" },
        ],
    });
}

test("pipeline: a linear graph compiles to filter_complex and maps", () => {
    const compiled = pipeline.compile(linearPipeline());
    assert.match(compiled.filterComplex, /^\[0:v\]scale=640:360:force_original_aspect_ratio=decrease\[v\d\]$/);
    assert.equal(compiled.maps.length, 2);
    assert.ok(compiled.maps.some(m => m === "[0:a]"), "audio passes straight through");
});

test("pipeline: cycles are rejected", () => {
    const cyclic = pipeline.createPipeline({
        nodes: [
            { id: "in", type: "input" },
            { id: "a", type: "fps", params: { fps: 30 } },
            { id: "b", type: "fps", params: { fps: 60 } },
            { id: "out", type: "output" },
        ],
        edges: [
            { from: "in", fromPort: "video", to: "a", toPort: "in" },
            { from: "a", fromPort: "out", to: "b", toPort: "in" },
            { from: "b", fromPort: "out", to: "a", toPort: "in" }, // the cycle
            { from: "b", fromPort: "out", to: "out", toPort: "video" },
        ],
    });

    const result = pipeline.validate(cyclic);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /cycle/i.test(e)));
    assert.throws(() => pipeline.compile(cyclic), /not valid/);
});

test("pipeline: mismatched port types are rejected", () => {
    const bad = pipeline.createPipeline({
        nodes: [
            { id: "in", type: "input" },
            { id: "v", type: "volume", params: { volume: 2 } },
            { id: "out", type: "output" },
        ],
        edges: [
            { from: "in", fromPort: "video", to: "v", toPort: "in" }, // video into an audio filter
            { from: "v", fromPort: "out", to: "out", toPort: "audio" },
        ],
    });
    const result = pipeline.validate(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /Cannot connect video output/.test(e)));
});

test("pipeline: missing required settings are rejected", () => {
    const bad = pipeline.createPipeline({
        nodes: [
            { id: "in", type: "input" },
            { id: "c", type: "crop", params: { width: 100 } }, // height missing
            { id: "out", type: "output" },
        ],
        edges: [
            { from: "in", fromPort: "video", to: "c", toPort: "in" },
            { from: "c", fromPort: "out", to: "out", toPort: "video" },
        ],
    });
    const result = pipeline.validate(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => /height/.test(e)));
});

test("pipeline: a graph with no output node is rejected", () => {
    const bad = pipeline.createPipeline({ nodes: [{ id: "in", type: "input" }], edges: [] });
    assert.equal(pipeline.validate(bad).valid, false);
});

test("pipeline: disconnected nodes warn but do not fail", () => {
    const graph = linearPipeline();
    graph.nodes.push({ id: "orphan", type: "fps", params: { fps: 10 } });
    const result = pipeline.validate(graph);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some(w => /orphan/.test(w)));
});

test("pipeline: an ANY-typed node takes its type from what feeds it", () => {
    const graph = pipeline.createPipeline({
        nodes: [
            { id: "in", type: "input" },
            { id: "t", type: "trim", params: { start: 1, end: 4 } },
            { id: "out", type: "output" },
        ],
        edges: [
            { from: "in", fromPort: "audio", to: "t", toPort: "in" },
            { from: "t", fromPort: "out", to: "out", toPort: "audio" },
        ],
    });
    const compiled = pipeline.compile(graph);
    assert.match(compiled.filterComplex, /atrim=start=1:end=4,asetpts=PTS-STARTPTS/);
});

test("pipeline: a no-op node forwards its input instead of emitting an empty link", () => {
    const graph = pipeline.createPipeline({
        nodes: [
            { id: "in", type: "input" },
            { id: "t", type: "trim", params: {} }, // no bounds set
            { id: "out", type: "output" },
        ],
        edges: [
            { from: "in", fromPort: "video", to: "t", toPort: "in" },
            { from: "t", fromPort: "out", to: "out", toPort: "video" },
        ],
    });
    const compiled = pipeline.compile(graph);
    assert.equal(compiled.filterComplex, null);
    assert.deepEqual(compiled.maps, ["[0:v]"]);
});

test("pipeline: applying to a job produces runnable ffmpeg args", () => {
    const job = createJob({ inputPath: "in.mp4", targetExt: "mp4" });
    const piped = pipeline.applyToJob(job, linearPipeline());
    const args = buildArgs(piped, { outputPath: "out.mp4" });

    assert.ok(args.includes("-filter_complex"));
    assert.equal(args.filter(a => a === "-map").length, 2);
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
        assert.equal(all.skipped, 1, "the .txt is skipped");

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

test("scan: deduplicates and reports unreadable paths without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dfc-scan2-"));
    try {
        const file = path.join(root, "a.mp3");
        fs.writeFileSync(file, "");

        const result = await scanPaths([file, file, path.join(root, "missing.mp4")]);
        assert.equal(result.files.length, 1);
        assert.equal(result.errors.length, 1);
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
