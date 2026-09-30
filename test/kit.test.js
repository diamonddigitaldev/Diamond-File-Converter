"use strict";

// What DFC takes from the house kit, checked with the kit's own helpers: the
// accent meets WCAG 2.2 AA in both themes, the app's menu items need a
// modifier, every one of the app's own IPC handlers goes through
// kit.ipc.handle() (which answers the app's own page only), and the page loads
// the kit's styles and scripts in the order they need.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { assertAccentContrast, assertNoBareAccelerators } = require("@diamonddigitaldev/electron-kit/testing");

const { IPC, SETTINGS_DEFAULTS } = require("../src/constants");
const { menuItems } = require("../src/menu");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");

test("the accent meets WCAG 2.2 AA in both themes", () => {
    assertAccentContrast(path.join(__dirname, "..", "src", "styles", "accent.css"));
});

test("the app's menu items each need a modifier", () => {
    const items = menuItems({ openFiles: () => {}, openFolder: () => {} });
    assertNoBareAccelerators(items);
    assert.deepEqual(items.map(i => [i.label, i.accelerator]), [
        ["Open Files", "CmdOrCtrl+O"],
        ["Open Folder", "CmdOrCtrl+Shift+O"],
    ]);
});

test("every one of the app's own handlers goes through kit.ipc.handle()", () => {
    const main = read("main.js");
    assert.ok(!/ipcMain/.test(main), "main.js must not register a handler straight on ipcMain: it would answer any page");

    // Every channel the page invokes has its handler, and pushes have none.
    const pushes = [IPC.JOB_PROGRESS, IPC.JOB_STATUS, IPC.FILES_OPENED];
    const handled = [...main.matchAll(/kit\.ipc\.handle\(IPC\.([A-Z_]+)/g)].map(m => IPC[m[1]]);
    assert.deepEqual(handled.sort(), Object.values(IPC).filter(c => !pushes.includes(c)).sort());
});

test("the Credits tab is given the app's name, not package.json's npm name", () => {
    // app.getName() is "diamond-file-converter", which also names the userData folder, so it stays.
    assert.match(read("main.js"), /\.start\(\{[^]*?name: APP_NAME,/);
    assert.equal(require("../package.json").name, "diamond-file-converter");
    assert.ok(!("productName" in require("../package.json")), "a top-level productName would move userData, and every saved setting");
});

test("the settings defaults are ones the kit takes", () => {
    // kit.start() throws at launch on either; this says so before then.
    assert.ok(!Object.hasOwn(SETTINGS_DEFAULTS, "navCollapsed"), "navCollapsed is the kit's own setting");
    assert.deepEqual(JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)), SETTINGS_DEFAULTS, "every default is a JSON value");
});

test("the page links the kit's styles after Bootstrap's and before its own, and loads kit.js before renderer.js", () => {
    const html = read("index.html");
    const order = (list) => list.map(needle => {
        const at = html.indexOf(needle);
        assert.ok(at >= 0, `index.html loads ${needle}`);
        return at;
    });
    const styles = order([
        "bootstrap/dist/css/bootstrap.min.css",
        "material-icons/iconfont/round.css",
        "electron-kit/css/kit.css",
        "styles/accent.css",
        "\"styles.css\"",
    ]);
    assert.deepEqual(styles, [...styles].sort((a, b) => a - b), "Bootstrap, Material Icons, kit.css, accent.css, then styles.css");
    const scripts = order(["bootstrap.bundle.min.js\"", "src=\"core/display.js\"", "electron-kit/page/kit.js\"", "src=\"renderer.js\""]);
    assert.deepEqual(scripts, [...scripts].sort((a, b) => a - b));
    assert.ok(!/styles\/tokens\.css/.test(html), "the kit's kit.css holds the tokens now");
});

test("renderer.js declares nothing named after a global the bridges or the kit set", () => {
    // It's a classic script, so a top-level const kitAPI collides with
    // window.kitAPI: "Identifier 'kitAPI' has already been declared", and the
    // whole script never runs.
    const renderer = read("renderer.js");
    for (const name of ["kitAPI", "electronAPI", "pathAPI", "kit"]) {
        assert.ok(!new RegExp(`^(const|let|var|function|class)\\s+${name}\\b`, "m").test(renderer), `renderer.js declares ${name}`);
    }
});

test("the app's styles leave the kit's shell alone", () => {
    // The rail, the header and the view switching are the kit's (kit.css).
    const css = read("styles.css");
    for (const selector of [".nav-rail", ".nav-item", ".nav-collapse", ".app-frame", ".app-header", ".app-title", "popup-window"]) {
        assert.ok(!css.includes(selector), `styles.css must not restyle ${selector}`);
    }
    // The fill as text fails AA in one theme: text in the accent uses its text shade.
    assert.ok(!/(^|[\s{;])color:\s*var\(--accent\)/m.test(css), "accent text uses var(--accent-text)");
});
