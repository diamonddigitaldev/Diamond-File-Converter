// Pipeline schema and compiler.
//
// This slice deliberately ships no flowchart editor. What it ships is the
// thing the editor will draw: a validated node graph, and a compiler that
// turns that graph into an ffmpeg filter_complex plus stream maps. Defining
// the data model first is what lets the editor later be a pure view layer
// over an already-tested representation.
//
// Dual-loaded, like display.js: required by main.js and the tests in Node,
// and loaded as a plain <script> by the renderer so the editor can read
// NODE_TYPES and validate a graph without an IPC round trip. That is only
// safe because this module requires nothing; core.test.js enforces it.

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.pipeline = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const PORT = {
        VIDEO: "video",
        AUDIO: "audio",
        ANY:   "any",
    };

    /**
     * Node type registry. `inputs`/`outputs` describe ports; `emit` renders the
     * ffmpeg filter body for that node, or returns null for nodes that carry no
     * filter of their own (input, output, encode).
     */
    const NODE_TYPES = {
        input: {
            label: "Input",
            inputs: [],
            outputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
            params: [],
            emit: () => null,
        },

        trim: {
            label: "Trim",
            inputs: [{ name: "in", type: PORT.ANY }],
            outputs: [{ name: "out", type: PORT.ANY }],
            required: [],
            params: [
                { key: "start", label: "Start", type: "seconds", min: 0,
                  help: "Blank starts at the beginning." },
                { key: "end", label: "End", type: "seconds", min: 0,
                  help: "Blank runs to the end." },
            ],
            emit: (params, portType) => {
                const parts = [];
                if (params.start != null) parts.push(`start=${num(params.start)}`);
                if (params.end != null) parts.push(`end=${num(params.end)}`);
                if (parts.length === 0) return null;
                const filter = portType === PORT.AUDIO ? "atrim" : "trim";
                const reset = portType === PORT.AUDIO ? "asetpts=PTS-STARTPTS" : "setpts=PTS-STARTPTS";
                return `${filter}=${parts.join(":")},${reset}`;
            },
        },

        scale: {
            label: "Scale",
            inputs: [{ name: "in", type: PORT.VIDEO }],
            outputs: [{ name: "out", type: PORT.VIDEO }],
            required: [],
            params: [
                { key: "width", label: "Width", type: "number", unit: "px", min: 1,
                  help: "Leave one side blank and it is worked out from the other." },
                { key: "height", label: "Height", type: "number", unit: "px", min: 1 },
                { key: "fitMode", label: "Fit", type: "enum", default: "contain", options: [
                    { value: "contain", label: "Fit inside" },
                    { value: "cover", label: "Fill and crop" },
                    { value: "stretch", label: "Stretch" },
                ] },
            ],
            emit: (params) => {
                const w = params.width ?? -2;
                const h = params.height ?? -2;
                if (params.width == null && params.height == null) return null;
                switch (params.fitMode) {
                    case "stretch": return `scale=${w}:${h}`;
                    case "cover":   return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
                    default:        return `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
                }
            },
        },

        crop: {
            label: "Crop",
            inputs: [{ name: "in", type: PORT.VIDEO }],
            outputs: [{ name: "out", type: PORT.VIDEO }],
            required: ["width", "height"],
            params: [
                { key: "width", label: "Width", type: "number", unit: "px", min: 1 },
                { key: "height", label: "Height", type: "number", unit: "px", min: 1 },
                { key: "x", label: "X offset", type: "number", unit: "px", min: 0, default: 0 },
                { key: "y", label: "Y offset", type: "number", unit: "px", min: 0, default: 0 },
            ],
            emit: (params) =>
                `crop=${num(params.width)}:${num(params.height)}:${num(params.x ?? 0)}:${num(params.y ?? 0)}`,
        },

        fps: {
            label: "Frame rate",
            inputs: [{ name: "in", type: PORT.VIDEO }],
            outputs: [{ name: "out", type: PORT.VIDEO }],
            required: ["fps"],
            params: [
                { key: "fps", label: "Frames per second", type: "number", unit: "fps", min: 1, step: 1 },
            ],
            emit: (params) => `fps=${num(params.fps)}`,
        },

        volume: {
            label: "Volume",
            inputs: [{ name: "in", type: PORT.AUDIO }],
            outputs: [{ name: "out", type: PORT.AUDIO }],
            required: ["volume"],
            params: [
                { key: "volume", label: "Level", type: "number", min: 0, step: 0.1, default: 1,
                  help: "A multiplier: 1 leaves it alone, 0.5 halves it, 2 doubles it." },
            ],
            emit: (params) => `volume=${num(params.volume)}`,
        },

        concat: {
            label: "Concatenate",
            inputs: [{ name: "a", type: PORT.ANY }, { name: "b", type: PORT.ANY }],
            outputs: [{ name: "out", type: PORT.ANY }],
            variadic: true,
            hidden: true,
            params: [],
            emit: (_params, portType, arity) => {
                const n = arity ?? 2;
                return portType === PORT.AUDIO
                    ? `concat=n=${n}:v=0:a=1`
                    : `concat=n=${n}:v=1:a=0`;
            },
        },

        overlay: {
            label: "Overlay",
            inputs: [{ name: "base", type: PORT.VIDEO }, { name: "overlay", type: PORT.VIDEO }],
            outputs: [{ name: "out", type: PORT.VIDEO }],
            required: [],
            hidden: true,
            params: [
                { key: "x", label: "X", type: "number", unit: "px", default: 0 },
                { key: "y", label: "Y", type: "number", unit: "px", default: 0 },
            ],
            emit: (params) => `overlay=${num(params.x ?? 0)}:${num(params.y ?? 0)}`,
        },

        encode: {
            label: "Encode",
            inputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
            outputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
            // Encoding settings are applied to the job, not the filter graph.
            params: [
                { key: "video.codec", label: "Video codec", type: "enum", options: [
                    { value: "libx264", label: "H.264" },
                    { value: "libx265", label: "H.265 / HEVC" },
                    { value: "libsvtav1", label: "AV1" },
                    { value: "libvpx-vp9", label: "VP9" },
                    { value: "libvpx", label: "VP8" },
                    { value: "mpeg4", label: "MPEG-4" },
                    { value: "mjpeg", label: "Motion JPEG" },
                    { value: "prores_ks", label: "ProRes" },
                ], help: "The container has the last word — a file whose format cannot carry this will say so." },
                { key: "video.crf", label: "Quality (CRF)", type: "number", min: 0, max: 51, step: 1,
                  help: "Lower is better quality and a larger file. Codecs without CRF ignore it." },
                { key: "video.bitrate", label: "Video bitrate", type: "number", unit: "kbps", min: 1 },
                { key: "video.preset", label: "Encoder preset", type: "enum", options: [
                    { value: "ultrafast", label: "ultrafast" },
                    { value: "superfast", label: "superfast" },
                    { value: "veryfast", label: "veryfast" },
                    { value: "faster", label: "faster" },
                    { value: "fast", label: "fast" },
                    { value: "medium", label: "medium" },
                    { value: "slow", label: "slow" },
                    { value: "slower", label: "slower" },
                    { value: "veryslow", label: "veryslow" },
                ], help: "Only x264, x265 and AV1 use presets." },
                { key: "audio.codec", label: "Audio codec", type: "enum", options: [
                    { value: "aac", label: "AAC" },
                    { value: "libmp3lame", label: "MP3" },
                    { value: "libopus", label: "Opus" },
                    { value: "libvorbis", label: "Vorbis" },
                    { value: "flac", label: "FLAC" },
                    { value: "ac3", label: "AC-3" },
                    { value: "alac", label: "ALAC" },
                    { value: "pcm_s16le", label: "PCM 16-bit" },
                ] },
                { key: "audio.bitrate", label: "Audio bitrate", type: "number", unit: "kbps", min: 1 },
            ],
            emit: () => null,
        },

        output: {
            label: "Output",
            inputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
            outputs: [],
            params: [],
            emit: () => null,
        },
    };

    function createPipeline(spec = {}) {
        return {
            id: spec.id ?? `pl_${Date.now().toString(36)}`,
            name: spec.name ?? "Untitled pipeline",
            version: 1,
            nodes: spec.nodes ?? [],
            edges: spec.edges ?? [],
        };
    }

    /**
     * Structural validation of a graph.
     * @returns {{valid: boolean, errors: string[], warnings: string[], order: string[]|null}}
     */
    function validate(pipeline) {
        const errors = [];
        const warnings = [];

        const nodes = Array.isArray(pipeline?.nodes) ? pipeline.nodes : [];
        const edges = Array.isArray(pipeline?.edges) ? pipeline.edges : [];

        if (nodes.length === 0) {
            return { valid: false, errors: ["Pipeline has no nodes."], warnings, order: null };
        }

        const byId = new Map();
        for (const node of nodes) {
            if (!node.id) { errors.push("A node is missing an id."); continue; }
            if (byId.has(node.id)) errors.push(`Duplicate node id "${node.id}".`);
            if (!NODE_TYPES[node.type]) errors.push(`Node "${node.id}" has unknown type "${node.type}".`);
            byId.set(node.id, node);
        }

        const inputs = nodes.filter(n => n.type === "input");
        const outputs = nodes.filter(n => n.type === "output");
        if (inputs.length === 0) errors.push("Pipeline has no input node.");
        if (outputs.length === 0) errors.push("Pipeline has no output node.");
        if (outputs.length > 1) errors.push("Pipeline has more than one output node.");

        // -- Edge integrity and port types ---------------------------------------
        for (const edge of edges) {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from) { errors.push(`Edge references unknown source node "${edge.from}".`); continue; }
            if (!to)   { errors.push(`Edge references unknown target node "${edge.to}".`); continue; }

            const fromSpec = NODE_TYPES[from.type];
            const toSpec = NODE_TYPES[to.type];
            if (!fromSpec || !toSpec) continue;

            const outPort = fromSpec.outputs.find(p => p.name === edge.fromPort);
            const inPort = toSpec.inputs.find(p => p.name === edge.toPort);

            if (!outPort) errors.push(`Node "${from.id}" has no output port "${edge.fromPort}".`);
            if (!inPort && !toSpec.variadic) errors.push(`Node "${to.id}" has no input port "${edge.toPort}".`);

            if (outPort && inPort) {
                const compatible =
                    outPort.type === inPort.type ||
                    outPort.type === PORT.ANY ||
                    inPort.type === PORT.ANY;
                if (!compatible) {
                    errors.push(`Cannot connect ${outPort.type} output of "${from.id}" to ${inPort.type} input of "${to.id}".`);
                }
            }
        }

        // -- Required params -----------------------------------------------------
        for (const node of nodes) {
            const spec = NODE_TYPES[node.type];
            if (!spec?.required) continue;
            for (const key of spec.required) {
                if (node.params?.[key] == null) {
                    errors.push(`Node "${node.id}" (${spec.label}) is missing required setting "${key}".`);
                }
            }
        }

        // -- Cycles --------------------------------------------------------------
        const order = topoSort(nodes, edges);
        if (order === null) {
            errors.push("Pipeline contains a cycle, so it cannot be run.");
        }

        // -- Reachability --------------------------------------------------------
        if (order && outputs.length === 1) {
            const reaching = collectAncestors(outputs[0].id, edges);
            for (const node of nodes) {
                if (node.id === outputs[0].id) continue;
                if (!reaching.has(node.id)) {
                    warnings.push(`Node "${node.id}" (${NODE_TYPES[node.type]?.label ?? node.type}) is not connected to the output and will be ignored.`);
                }
            }
        }

        return { valid: errors.length === 0, errors, warnings, order };
    }

    /** Kahn's algorithm. Returns node ids in dependency order, or null on a cycle. */
    function topoSort(nodes, edges) {
        const indegree = new Map(nodes.map(n => [n.id, 0]));
        const adjacency = new Map(nodes.map(n => [n.id, []]));

        for (const edge of edges) {
            if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
            adjacency.get(edge.from).push(edge.to);
            indegree.set(edge.to, indegree.get(edge.to) + 1);
        }

        const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
        const order = [];

        while (queue.length > 0) {
            const id = queue.shift();
            order.push(id);
            for (const next of adjacency.get(id) ?? []) {
                indegree.set(next, indegree.get(next) - 1);
                if (indegree.get(next) === 0) queue.push(next);
            }
        }

        return order.length === nodes.length ? order : null;
    }

    function collectAncestors(nodeId, edges) {
        const seen = new Set([nodeId]);
        const stack = [nodeId];
        while (stack.length > 0) {
            const current = stack.pop();
            for (const edge of edges) {
                if (edge.to === current && !seen.has(edge.from)) {
                    seen.add(edge.from);
                    stack.push(edge.from);
                }
            }
        }
        return seen;
    }

    /**
     * Compile a validated pipeline into ffmpeg pieces.
     *
     * @returns {{filterComplex: string|null, maps: string[], extraArgs: string[], encode: object|null}}
     *          `maps` are ready to be paired with -map. `encode` carries any
     *          settings from an encode node for the job to absorb.
     */
    function compile(pipeline) {
        const result = validate(pipeline);
        if (!result.valid) {
            const err = new Error(`Pipeline is not valid: ${result.errors[0]}`);
            err.errors = result.errors;
            throw err;
        }

        const byId = new Map(pipeline.nodes.map(n => [n.id, n]));
        const chains = [];
        // nodeId -> { portName -> { label, type } }
        const outputLabels = new Map();

        let labelCounter = 0;
        const nextLabel = (hint) => `${hint}${labelCounter++}`;

        const incomingFor = (nodeId, portName) =>
            pipeline.edges.filter(e => e.to === nodeId && (portName == null || e.toPort === portName));

        for (const nodeId of result.order) {
            const node = byId.get(nodeId);
            const spec = NODE_TYPES[node.type];

            if (node.type === "input") {
                // The single source file is always ffmpeg input 0.
                // `raw` marks a real input stream rather than a filter output.
                // Inside filter_complex both are written [label]; as a -map target
                // only a filter output takes brackets, so the two must be told
                // apart or ffmpeg looks for a label that does not exist.
                outputLabels.set(nodeId, {
                    video: { label: "0:v", type: PORT.VIDEO, raw: true },
                    audio: { label: "0:a", type: PORT.AUDIO, raw: true },
                });
                continue;
            }

            if (node.type === "output") continue;

            if (node.type === "encode") {
                // Passthrough in the graph; its params are read separately below.
                const ports = {};
                for (const port of spec.inputs) {
                    const edge = incomingFor(nodeId, port.name)[0];
                    if (!edge) continue;
                    const upstream = outputLabels.get(edge.from)?.[edge.fromPort];
                    if (upstream) ports[port.name] = upstream;
                }
                outputLabels.set(nodeId, ports);
                continue;
            }

            // Gather this node's inputs in declared port order.
            const incoming = spec.variadic
                ? incomingFor(nodeId)
                : spec.inputs.map(p => incomingFor(nodeId, p.name)[0]).filter(Boolean);

            if (incoming.length === 0) {
                // Nothing feeds it, so it contributes nothing.
                outputLabels.set(nodeId, {});
                continue;
            }

            const sources = incoming
                .map(edge => outputLabels.get(edge.from)?.[edge.fromPort])
                .filter(Boolean);

            if (sources.length === 0) {
                outputLabels.set(nodeId, {});
                continue;
            }

            // An ANY-typed node takes its concrete type from what it is fed.
            const portType = sources[0].type;
            const body = spec.emit(node.params ?? {}, portType, sources.length);

            if (!body) {
                // A no-op node (a trim with no bounds set) forwards its input
                // rather than inserting an empty link into the chain.
                outputLabels.set(nodeId, { [spec.outputs[0]?.name ?? "out"]: sources[0] });
                continue;
            }

            const outLabel = nextLabel(portType === PORT.AUDIO ? "a" : "v");
            chains.push(`${sources.map(s => `[${s.label}]`).join("")}${body}[${outLabel}]`);

            const outPortName = spec.outputs[0]?.name ?? "out";
            outputLabels.set(nodeId, { [outPortName]: { label: outLabel, type: portType } });
        }

        // -- Resolve what the output node is actually fed -------------------------
        const outputNode = pipeline.nodes.find(n => n.type === "output");
        const maps = [];
        for (const port of NODE_TYPES.output.inputs) {
            const edge = incomingFor(outputNode.id, port.name)[0];
            if (!edge) continue;
            const upstream = outputLabels.get(edge.from)?.[edge.fromPort];
            if (upstream) maps.push(upstream.raw ? upstream.label : `[${upstream.label}]`);
        }

        const encodeNode = pipeline.nodes.find(n => n.type === "encode");

        return {
            filterComplex: chains.length > 0 ? chains.join(";") : null,
            maps,
            extraArgs: [],
            encode: encodeNode?.params ?? null,
            warnings: result.warnings,
        };
    }

    /**
     * Fold a compiled pipeline into a job, so the runner needs to know nothing
     * about pipelines at all.
     */
    function applyToJob(job, pipeline) {
        const compiled = compile(pipeline);
        const extraArgs = [];

        if (compiled.filterComplex) extraArgs.push("-filter_complex", compiled.filterComplex);
        for (const map of compiled.maps) extraArgs.push("-map", map);

        return {
            ...job,
            pipelineId: pipeline.id,
            extraArgs: [...(job.extraArgs ?? []), ...extraArgs],
            video: { ...job.video, ...(compiled.encode?.video ?? {}) },
            audio: { ...job.audio, ...(compiled.encode?.audio ?? {}) },
        };
    }

    // Canvas geometry for autoLayout, kept beside the model so a generated
    // layout and a hand-dragged one share the same rhythm.
    const LAYOUT = { COL_WIDTH: 220, ROW_HEIGHT: 130, ORIGIN_X: 40, ORIGIN_Y: 40 };

    const refuse = (reason) => ({ ok: false, reason });

    /**
     * Whether an edge may be added to a graph.
     *
     * validate() is deliberately permissive about several things the compiler
     * then handles badly, or that ffmpeg refuses outright — so those have to be
     * caught at the moment of connection instead, or the user ends up with a
     * graph that validates cleanly and still will not run.
     *
     * @returns {{ok: boolean, reason: string|null}}
     */
    function canConnect(graph, edge) {
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];

        const from = nodes.find(n => n.id === edge?.from);
        const to = nodes.find(n => n.id === edge?.to);
        if (!from) return refuse(`No such node "${edge?.from}".`);
        if (!to) return refuse(`No such node "${edge?.to}".`);
        if (from.id === to.id) return refuse("A node cannot connect to itself.");

        const fromSpec = NODE_TYPES[from.type];
        const toSpec = NODE_TYPES[to.type];
        if (!fromSpec) return refuse(`Unknown node type "${from.type}".`);
        if (!toSpec) return refuse(`Unknown node type "${to.type}".`);

        const outPort = fromSpec.outputs.find(p => p.name === edge.fromPort);
        if (!outPort) return refuse(`${fromSpec.label} has no ${edge.fromPort} output.`);

        const inPort = toSpec.inputs.find(p => p.name === edge.toPort);
        if (!inPort && !toSpec.variadic) return refuse(`${toSpec.label} has no ${edge.toPort} input.`);

        if (inPort) {
            const compatible =
                outPort.type === inPort.type ||
                outPort.type === PORT.ANY ||
                inPort.type === PORT.ANY;
            if (!compatible) return refuse(`${outPort.type} cannot feed ${toSpec.label}'s ${inPort.type} input.`);
        }

        // compile() takes the first edge into a port and drops the rest in
        // silence, so a second one would simply go missing at run time.
        if (!toSpec.variadic && edges.some(e => e.to === to.id && e.toPort === edge.toPort)) {
            return refuse("That input is already connected.");
        }

        // An ffmpeg filter label can only be consumed once. Fanning one output
        // into two nodes needs split/asplit, which the compiler does not emit,
        // so ffmpeg fails on a graph validate() is perfectly happy with.
        if (edges.some(e => e.from === from.id && e.fromPort === edge.fromPort)) {
            return refuse("An output can only feed one node.");
        }

        // A cycle is a validate() error too, but it reads as "Pipeline contains
        // a cycle" long after the fact. Refusing the edge names the cause.
        const prospective = [...edges, { from: from.id, fromPort: edge.fromPort, to: to.id, toPort: edge.toPort }];
        if (topoSort(nodes, prospective) === null) return refuse("That would make a loop.");

        return { ok: true, reason: null };
    }

    /**
     * Give every node without coordinates a place to sit: a column per
     * dependency depth, rows within it, so a node always lands to the right of
     * everything feeding it. Nodes that already carry ui coordinates keep them.
     *
     * Positions live on node.ui, which validate() and compile() ignore and the
     * store round-trips untouched — that is what lets the editor persist a
     * layout without the model needing to know about one.
     *
     * Mutates and returns the graph.
     */
    function autoLayout(graph, options = {}) {
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];

        const colWidth = options.colWidth ?? LAYOUT.COL_WIDTH;
        const rowHeight = options.rowHeight ?? LAYOUT.ROW_HEIGHT;
        const originX = options.originX ?? LAYOUT.ORIGIN_X;
        const originY = options.originY ?? LAYOUT.ORIGIN_Y;

        // Longest path from a source. Falls back to declaration order on a
        // cycle, so a broken graph still draws something the user can fix.
        const order = topoSort(nodes, edges) ?? nodes.map(n => n.id);
        const depth = new Map(nodes.map(n => [n.id, 0]));
        for (const id of order) {
            for (const edge of edges) {
                if (edge.from !== id || !depth.has(edge.to)) continue;
                depth.set(edge.to, Math.max(depth.get(edge.to), depth.get(id) + 1));
            }
        }

        // Row slots are consumed by positioned nodes as well, so a generated
        // node never lands underneath one the user has already placed.
        const rows = new Map();
        for (const node of nodes) {
            const column = depth.get(node.id) ?? 0;
            const row = rows.get(column) ?? 0;
            rows.set(column, row + 1);

            if (node.ui && Number.isFinite(node.ui.x) && Number.isFinite(node.ui.y)) continue;
            node.ui = { x: originX + column * colWidth, y: originY + row * rowHeight };
        }

        return graph;
    }

    function num(value) {
        const n = Number(value);
        return Number.isFinite(n) ? String(n) : "0";
    }

    return {
        PORT,
        NODE_TYPES,
        LAYOUT,
        createPipeline,
        validate,
        compile,
        applyToJob,
        topoSort,
        canConnect,
        autoLayout,
    };
});
