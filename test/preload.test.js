"use strict";

// Drift guard for the context bridge.
//
// preload.js runs sandboxed, where require() is limited to a small allowlist,
// so it cannot import src/constants.js and has to inline its channel names.
// These tests read the preload source and hold those literals to the real IPC
// map, so a rename in one place cannot silently break the other.
//
// The failure this protects against is nasty: a bad require or a stale channel
// name leaves window.electronAPI undefined and the whole app inert, with no
// error in the main process.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { IPC } = require("../src/constants");

const PRELOAD_PATH = path.join(__dirname, "..", "src", "preload.js");
const source = fs.readFileSync(PRELOAD_PATH, "utf8");

// Only these modules are importable from a sandboxed preload.
const SANDBOX_SAFE_MODULES = new Set(["electron", "events", "timers", "url", "node:events", "node:timers", "node:url"]);

test("preload only requires modules a sandboxed preload can load", () => {
    const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
    assert.ok(required.length > 0, "expected at least one require");

    for (const mod of required) {
        assert.ok(
            SANDBOX_SAFE_MODULES.has(mod),
            `preload requires "${mod}", which a sandboxed preload cannot load. ` +
            `That silently leaves window.electronAPI undefined.`
        );
    }
});

test("every channel the preload uses exists in the IPC map", () => {
    // The channels declared in the preload's CH table.
    const declared = [...source.matchAll(/^\s*[A-Z_]+:\s*["']([^"']+)["'],/gm)].map(m => m[1]);
    assert.ok(declared.length >= 20, `expected the full channel table, found ${declared.length}`);

    const known = new Set(Object.values(IPC));
    for (const channel of declared) {
        assert.ok(known.has(channel), `preload uses channel "${channel}", which is not in constants.js IPC`);
    }
});

test("channel names are namespaced, so updater events cannot be confused for IPC", () => {
    // v1 kept "update-available" (an electron-updater event) in the same flat
    // map as real IPC channels.
    for (const [name, channel] of Object.entries(IPC)) {
        assert.match(channel, /^[a-z]+:[a-z-]+$/, `${name} ("${channel}") is not namespaced`);
    }
});

test("IPC channel names are unique", () => {
    const values = Object.values(IPC);
    assert.equal(new Set(values).size, values.length, "duplicate channel name in the IPC map");
});

test("preload exposes both bridges and nothing else", () => {
    const exposed = [...source.matchAll(/exposeInMainWorld\(\s*["']([^"']+)["']/g)].map(m => m[1]);
    assert.deepEqual(exposed.sort(), ["electronAPI", "pathAPI"]);
});

test("path helpers handle Windows and POSIX separators identically", () => {
    // Mirrors the implementations in preload.js, which cannot be imported here
    // because requiring it would pull in electron.
    const basename = (f) => String(f).split(/[\\/]/).pop() ?? "";
    const extname = (f) => {
        const base = basename(f);
        const dot = base.lastIndexOf(".");
        return dot > 0 ? base.slice(dot) : "";
    };
    const stem = (f) => {
        const base = basename(f);
        const dot = base.lastIndexOf(".");
        return dot > 0 ? base.slice(0, dot) : base;
    };

    assert.equal(basename("C:\\media\\clip.mp4"), "clip.mp4");
    assert.equal(basename("/home/me/clip.mp4"), "clip.mp4");
    assert.equal(extname("C:\\media\\clip.mp4"), ".mp4");
    assert.equal(stem("C:\\media\\clip.mp4"), "clip");
    // A dotfile has no extension, and a bare name has no dot at all.
    assert.equal(extname(".gitignore"), "");
    assert.equal(stem(".gitignore"), ".gitignore");
    assert.equal(extname("README"), "");
});

/** Drop comments so prose about require() is not mistaken for a call to it. */
function stripComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/<!--[\s\S]*?-->/g, "");
}

test("the renderer reaches Node only through the bridge", () => {
    const renderer = stripComments(fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8"));
    assert.ok(!/\brequire\s*\(/.test(renderer), "renderer.js must not call require()");
    assert.ok(!/\bwindow\.process\b/.test(renderer), "renderer.js must not reach for process");

    const credits = stripComments(fs.readFileSync(path.join(__dirname, "..", "src", "credits.html"), "utf8"));
    assert.ok(!/\brequire\s*\(/.test(credits), "credits.html must not call require()");
    assert.ok(!/onclick=/.test(credits), "credits.html should not use inline onclick handlers");

    // Both pages must actually go through the bridge.
    assert.match(renderer, /window\.electronAPI/);
    assert.match(credits, /window\.electronAPI/);
});

test("main enables context isolation and disables node integration", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.ok(!/nodeIntegration:\s*true/.test(main), "nodeIntegration must not be enabled");
    assert.ok(!/contextIsolation:\s*false/.test(main), "contextIsolation must not be disabled");

    // Both windows must set all three, or one of them silently regresses.
    const windows = main.match(/webPreferences:\s*\{[^}]*\}/g) ?? [];
    assert.equal(windows.length, 2, "expected exactly the main and credits windows");
    for (const block of windows) {
        assert.match(block, /preload:/);
        assert.match(block, /contextIsolation:\s*true/);
        assert.match(block, /nodeIntegration:\s*false/);
    }
});
