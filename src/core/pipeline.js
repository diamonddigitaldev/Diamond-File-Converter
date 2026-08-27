"use strict";

// Pipeline schema and compiler.
//
// This slice deliberately ships no flowchart editor. What it ships is the
// thing the editor will draw: a validated node graph, and a compiler that
// turns that graph into an ffmpeg filter_complex plus stream maps. Defining
// the data model first is what lets the editor later be a pure view layer
// over an already-tested representation.

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
        emit: () => null,
    },

    trim: {
        label: "Trim",
        inputs: [{ name: "in", type: PORT.ANY }],
        outputs: [{ name: "out", type: PORT.ANY }],
        required: [],
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
        emit: (params) =>
            `crop=${num(params.width)}:${num(params.height)}:${num(params.x ?? 0)}:${num(params.y ?? 0)}`,
    },

    fps: {
        label: "Frame rate",
        inputs: [{ name: "in", type: PORT.VIDEO }],
        outputs: [{ name: "out", type: PORT.VIDEO }],
        required: ["fps"],
        emit: (params) => `fps=${num(params.fps)}`,
    },

    volume: {
        label: "Volume",
        inputs: [{ name: "in", type: PORT.AUDIO }],
        outputs: [{ name: "out", type: PORT.AUDIO }],
        required: ["volume"],
        emit: (params) => `volume=${num(params.volume)}`,
    },

    concat: {
        label: "Concatenate",
        inputs: [{ name: "a", type: PORT.ANY }, { name: "b", type: PORT.ANY }],
        outputs: [{ name: "out", type: PORT.ANY }],
        variadic: true,
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
        emit: (params) => `overlay=${num(params.x ?? 0)}:${num(params.y ?? 0)}`,
    },

    encode: {
        label: "Encode",
        inputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
        outputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
        // Encoding settings are applied to the job, not the filter graph.
        emit: () => null,
    },

    output: {
        label: "Output",
        inputs: [{ name: "video", type: PORT.VIDEO }, { name: "audio", type: PORT.AUDIO }],
        outputs: [],
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
            outputLabels.set(nodeId, {
                video: { label: "0:v", type: PORT.VIDEO },
                audio: { label: "0:a", type: PORT.AUDIO },
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
        if (upstream) maps.push(`[${upstream.label}]`);
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

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "0";
}

module.exports = {
    PORT,
    NODE_TYPES,
    createPipeline,
    validate,
    compile,
    applyToJob,
    topoSort,
};
