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

const { loadPreload } = require("@diamonddigitaldev/electron-kit/testing");
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
    assert.ok(declared.length >= 15, `expected the full channel table, found ${declared.length}`);

    const known = new Set(Object.values(IPC));
    for (const channel of declared) {
        assert.ok(known.has(channel), `preload uses channel "${channel}", which is not in constants.js IPC`);
    }
});

// The kit's loadPreload() runs the preload as a sandboxed renderer would, so
// this follows each call of the bridge to the channel it really uses, rather
// than reading the table.
test("the preload runs sandboxed, and every call of the bridge reaches a channel in the IPC map", () => {
    const { required, exposed, calls } = loadPreload(PRELOAD_PATH);
    assert.deepEqual([...new Set(required)], ["electron"]);

    const known = new Set(Object.values(IPC));
    for (const [name, fn] of Object.entries(exposed.electronAPI)) {
        if (name === "getPathForFile") continue; // no IPC: webUtils, in the preload itself
        const before = calls.length;
        fn(() => {});
        const made = calls.slice(before);
        assert.equal(made.length, 1, `electronAPI.${name}() makes one IPC call`);
        assert.ok(known.has(made[0].channel), `electronAPI.${name}() uses "${made[0].channel}", which is not in constants.js IPC`);
    }
    // And every channel in the map is one the bridge uses.
    const used = new Set(calls.map(c => c.channel));
    for (const channel of known) assert.ok(used.has(channel), `nothing in the preload uses "${channel}"`);
});

test("the preload leaves the kit's shared channels to the kit's own bridge", () => {
    // window.kitAPI has these; the kit answers them, and kit.ipc.handle() refuses to.
    for (const channel of ["app:get-version", "app:get-info", "settings:get", "settings:set", "shell:open-external", "theme:changed", "view:show"]) {
        assert.ok(!Object.values(IPC).includes(channel), `${channel} is the kit's`);
        assert.ok(!source.includes(`"${channel}"`), `the preload must not use ${channel}`);
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

    // The page goes through its own bridge, and the kit's for the settings.
    assert.match(renderer, /window\.electronAPI/);
    assert.match(renderer, /window\.kitAPI/);
});

test("main enables context isolation and disables node integration", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.ok(!/nodeIntegration:\s*true/.test(main), "nodeIntegration must not be enabled");
    assert.ok(!/contextIsolation:\s*false/.test(main), "contextIsolation must not be disabled");

    // The one window (Credits is a tab of Settings now) is the kit's main
    // window, which lays the house's sandbox, isolation and no Node over the
    // app's own web preferences, and throws on anything weaker (the kit's
    // tests). DFC gives it its preload, and no BrowserWindow of its own.
    const windows = main.match(/webPreferences:\s*\{[^}]*\}/g) ?? [];
    assert.equal(windows.length, 1, "expected exactly the main window");
    assert.match(windows[0], /^webPreferences:\s*\{\s*preload:\s*path\.join\(__dirname, "preload\.js"\)\s*\}$/);
    assert.match(main, /kit\.windows\.createMain\(\{/);
    assert.ok(!/new BrowserWindow|BrowserWindow\s*\}/.test(main), "main.js makes no window of its own");
});
