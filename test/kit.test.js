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
const { assertAccentContrast, assertNoBareAccelerators, assertBuildExtendsKit } = require("@diamonddigitaldev/electron-kit/testing");

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
    const pushes = [IPC.JOB_PROGRESS, IPC.JOB_STATUS, IPC.CONFLICT_ASK];
    const handled = [...main.matchAll(/kit\.ipc\.handle\(IPC\.([A-Z_]+)/g)].map(m => IPC[m[1]]);
    assert.deepEqual(handled.sort(), Object.values(IPC).filter(c => !pushes.includes(c)).sort());
});

test("the updater is the kit's: DFC passes updates, and has no updater or update boxes of its own", () => {
    const main = read("main.js");
    assert.match(main, /\.start\(\{[^]*?updates: \{\},/, "kit.start() gets the updates option");
    assert.ok(!/electron-updater|autoUpdater|setupAutoUpdater/.test(main), "main.js leaves electron-updater to the kit");
    assert.ok(!/Update Available|Update Ready/.test(main), "no native update boxes");
    assert.ok(!fs.existsSync(path.join(__dirname, "..", "src", "core", "version.js")), "the version rules are the kit's (its main exports them as version)");
    // The kit's own rule, as DFC relied on it: a pre-release never reaches Stable, and nothing older is offered.
    const { version } = require("@diamonddigitaldev/electron-kit/main");
    assert.equal(version.isOfferableUpdate("2.0.0", "2.0.0-beta.2", "beta"), true);
    assert.equal(version.isOfferableUpdate("2.1.0-beta.1", "2.0.0", "stable"), false);
    assert.equal(version.isOfferableUpdate("1.0.0", "2.0.0-alpha.1", "stable"), false);
});

test("the build extends the kit's base config, and keeps DFC's own", () => {
    const pkg = require("../package.json");
    assertBuildExtendsKit(pkg);
    assert.deepEqual(pkg.build.publish, { provider: "github", owner: "diamonddigitaldev", repo: "Diamond-File-Converter" });
    assert.equal(pkg.build.nsis.perMachine, true);
    assert.equal(pkg.build.nsis.include, "installer.nsh");
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

test("the page links the kit's styles after Bootstrap's and before its own, and loads kit.js before display.js and renderer.js", () => {
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
    // kit.js before display.js, which takes the house's wording from its kit.format.
    const scripts = order(["bootstrap.bundle.min.js\"", "electron-kit/page/kit.js\"", "src=\"core/display.js\"", "src=\"renderer.js\""]);
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

test("the shared parts are the kit's: no toast, prompt, drop zone, action bar or progress bar of DFC's own", () => {
    const renderer = read("renderer.js");
    const html = read("index.html");
    const css = read("styles.css");
    for (const own of ["function toast(", "function confirmDialog(", "dragDepth", "getPathForFile"]) {
        assert.ok(!renderer.includes(own), `renderer.js has ${own}`);
    }
    for (const call of ["kit.ui.toast(", "kit.ui.confirm(", "kit.ui.dropZone(", "kit.ui.actionBar(", "kit.ui.progress(", "kit.keys.onKey(", "kit.format.countOf("]) {
        assert.ok(renderer.includes(call), `renderer.js uses ${call}`);
    }
    for (const markup of ["confirm-modal", "toast-host", "drop-zone", "join-drop", "overall-bar", "btn-convert"]) {
        assert.ok(!html.includes(markup), `index.html has ${markup}`);
    }
    for (const rule of [".toast-", ".drop-zone", ".drop-label", ".action-status", ".card-progress .bar", "@keyframes slide"]) {
        assert.ok(!css.includes(rule), `styles.css has ${rule}`);
    }
});

test("the Title Case slips DESIGN.md lists are fixed: buttons and titles are Title Case", () => {
    const text = read("renderer.js") + read("index.html");
    for (const slip of ["Bulk edit", "Add more", "Write them", "Show in folder", "Open folder", "Show them", "Advanced options", "That is a lot of images", "Folder options"]) {
        assert.ok(!text.includes(slip), `"${slip}" is still sentence case`);
    }
});

test("progress of null is \"not known\": a card's and Join's bars slide, never sit at 0% or read null%", () => {
    const renderer = read("renderer.js");
    assert.match(renderer, /progress\.set\(typeof job\.progress === "number" \? job\.progress : null\)/);
    assert.match(renderer, /joinProgress\?\.set\(typeof percent === "number" \? percent : null\)/);
    assert.ok(!/style\.width = `\$\{percent\}%`/.test(renderer), "Join's bar used to read \"null%\"");
});

test("every icon is hidden from screen readers, and every icon-only button has a name", () => {
    const html = read("index.html");
    const spans = html.match(/<span class="material-icons-round[^>]*>/g) ?? [];
    assert.ok(spans.length > 0);
    for (const span of spans) assert.match(span, /aria-hidden="true"/, span);
    const renderer = read("renderer.js");
    const made = renderer.match(/(\w+)\.className = "material-icons-round[^"]*";/g) ?? [];
    for (const line of made) {
        const name = line.split(".")[0];
        assert.ok(renderer.includes(`${name}.setAttribute("aria-hidden", "true");`), `${name} isn't aria-hidden`);
    }
});
