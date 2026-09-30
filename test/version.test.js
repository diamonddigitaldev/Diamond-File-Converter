"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const v = require("../src/core/version");

test("version: parses plain and pre-release versions", () => {
    assert.deepEqual(v.parse("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
    assert.deepEqual(v.parse("2.0.0-alpha.1"), { major: 2, minor: 0, patch: 0, prerelease: ["alpha", "1"] });
    assert.deepEqual(v.parse("v1.0.0"), { major: 1, minor: 0, patch: 0, prerelease: [] });
    assert.equal(v.parse("not-a-version"), null);
    assert.equal(v.parse(null), null);
});

test("version: identifies pre-releases", () => {
    assert.equal(v.isPrerelease("2.0.0-alpha.1"), true);
    assert.equal(v.isPrerelease("2.0.0-beta"), true);
    assert.equal(v.isPrerelease("2.0.0-rc.2"), true);
    assert.equal(v.isPrerelease("2.0.0"), false);
    assert.equal(v.isPrerelease("1.0.0"), false);
});

test("version: orders by major, minor, patch", () => {
    assert.equal(v.compare("1.0.0", "2.0.0"), -1);
    assert.equal(v.compare("2.0.0", "1.0.0"), 1);
    assert.equal(v.compare("1.2.0", "1.10.0"), -1, "compares numerically, not as strings");
    assert.equal(v.compare("1.0.10", "1.0.9"), 1);
    assert.equal(v.compare("1.0.0", "1.0.0"), 0);
});

test("version: a pre-release precedes its own release", () => {
    assert.equal(v.compare("2.0.0-alpha.1", "2.0.0"), -1);
    assert.equal(v.compare("2.0.0", "2.0.0-alpha.1"), 1);
    assert.equal(v.compare("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
    assert.equal(v.compare("2.0.0-alpha.2", "2.0.0-beta.1"), -1);
    assert.equal(v.compare("2.0.0-alpha.1", "2.0.0-alpha.1"), 0);
    // A longer pre-release chain is greater when the prefix matches.
    assert.equal(v.compare("2.0.0-alpha", "2.0.0-alpha.1"), -1);
});

test("version: numeric pre-release parts rank below alphanumeric ones", () => {
    assert.equal(v.compare("1.0.0-1", "1.0.0-alpha"), -1);
});

// ---------------------------------------------------------------------------
// The rule the updater enforces
// ---------------------------------------------------------------------------

test("update: a newer stable release is offered", () => {
    assert.equal(v.isOfferableUpdate("1.1.0", "1.0.0"), true);
    assert.equal(v.isOfferableUpdate("2.0.0", "1.0.0"), true);
});

test("update: a pre-release is NEVER offered, whatever the user is running", () => {
    assert.equal(v.isOfferableUpdate("2.0.0-alpha.1", "1.0.0"), false, "stable user");
    assert.equal(v.isOfferableUpdate("2.0.0-alpha.2", "2.0.0-alpha.1"), false, "pre-release user");
    assert.equal(v.isOfferableUpdate("3.0.0-rc.1", "2.0.0"), false, "even a much newer one");
});

test("update: someone on a pre-release is offered the stable that supersedes it", () => {
    // 2.0.0 final supersedes 2.0.0-alpha.1, so it IS offered.
    assert.equal(v.isOfferableUpdate("2.0.0", "2.0.0-alpha.1"), true);
});

test("update: an older stable is not offered to a pre-release user", () => {
    // The case that silently did nothing: running 2.0.0-alpha.1 while the
    // latest stable is 1.0.0. That is a downgrade and must be refused.
    assert.equal(v.isOfferableUpdate("1.0.0", "2.0.0-alpha.1"), false);
});

test("update: the same version is not an update", () => {
    assert.equal(v.isOfferableUpdate("1.0.0", "1.0.0"), false);
    assert.equal(v.isOfferableUpdate("2.0.0-alpha.1", "2.0.0-alpha.1"), false);
});

test("update: garbage is never offered", () => {
    assert.equal(v.isOfferableUpdate(null, "1.0.0"), false);
    assert.equal(v.isOfferableUpdate("", "1.0.0"), false);
    assert.equal(v.isOfferableUpdate("latest", "1.0.0"), false);
});

// ---------------------------------------------------------------------------
// The updater configuration itself
// ---------------------------------------------------------------------------

test("updater: pre-releases are explicitly disallowed in main.js", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    // electron-updater turns allowPrerelease ON BY ITSELF when the running
    // version is a pre-release, which would make an alpha update to the next
    // alpha. It has to be pinned off explicitly.
    assert.match(main, /allowPrerelease\s*=\s*false/,
        "main.js must set autoUpdater.allowPrerelease = false");
    assert.match(main, /allowDowngrade\s*=\s*false/,
        "main.js must set autoUpdater.allowDowngrade = false");
    assert.match(main, /channel\s*=\s*"latest"/,
        "main.js must pin the updater to the latest stable channel");
    assert.ok(!/allowPrerelease\s*=\s*true/.test(main),
        "main.js must never enable pre-release updates");
});

test("updater: the version currently shipping matches package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert.ok(v.parse(pkg.version), `package.json version "${pkg.version}" is not valid semver`);
});

// ---------------------------------------------------------------------------
// Conflict policy wiring
//
// The resolver in main.js was unreachable because the job was built without
// the user's conflict setting, so createJob's default silently renamed every
// collision to "name (1).ext". The prompt is only reachable if the setting is
// actually threaded through.
// ---------------------------------------------------------------------------

test("conflict: the documented default is to ask, not to rename silently", () => {
    const { SETTINGS_DEFAULTS } = require("../src/constants");
    const { createJob, CONFLICT } = require("../src/core/job");

    assert.equal(SETTINGS_DEFAULTS.onConflict, "ask");
    assert.equal(createJob({ inputPath: "a.mp4", targetExt: "mkv" }).output.onConflict, CONFLICT.ASK);
});

// A wiring guard, not a behaviour test — it reads main.js as text and can only
// say the two ends are still tied together. It stays because untying them is
// the exact bug that shipped in alpha.1, and main has no seam to test through.
// The behaviour on the other side of this wiring is in test/runner.test.js.
test("conflict: main.js still threads the user's setting into the job", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /onConflict:\s*settings\.onConflict/,
        "main.js must pass settings.onConflict into createJob, or the prompt is unreachable");
    assert.match(main, /conflictResolver:\s*resolveConflict/,
        "the runner must be given the resolver");
});

// ---------------------------------------------------------------------------
// The other half of the same defect, found by QA on alpha.5 and reproduced by
// driving the running app. The card's own conflict choice was being defeated by
// a settings key v1 wrote and 2.0 has no screen for: an install carrying
// onConflict "unique" renamed every collision silently, whatever the card said
// and however many times the prompt was asked for.
// ---------------------------------------------------------------------------

test("settings: the keys 2.0 cannot reach are pruned, and nothing else is", () => {
    const { pruneLegacySettings } = require("../src/constants");

    const { settings, removed } = pruneLegacySettings({
        outputRouting: "alongside",
        outputDir: null,
        nameTemplate: "{name}",
        onConflict: "unique",
        navCollapsed: true,
        concurrency: 3,
        scan: { recursive: false },
    });

    assert.deepEqual(settings, { navCollapsed: true, concurrency: 3, scan: { recursive: false } });
    assert.deepEqual(removed.sort(), ["nameTemplate", "onConflict", "outputDir", "outputRouting"]);
});

test("settings: pruning survives an empty or missing object", () => {
    const { pruneLegacySettings } = require("../src/constants");

    assert.deepEqual(pruneLegacySettings(undefined), { settings: {}, removed: [] });
    assert.deepEqual(pruneLegacySettings(null), { settings: {}, removed: [] });
    assert.deepEqual(pruneLegacySettings({}), { settings: {}, removed: [] });
});

test("settings: the input is not mutated", () => {
    const { pruneLegacySettings } = require("../src/constants");

    const original = { onConflict: "unique", navCollapsed: true };
    pruneLegacySettings(original);
    assert.deepEqual(original, { onConflict: "unique", navCollapsed: true });
});

// The real-world shape this had to survive: electron-store's `defaults` replace
// the whole `settings` key the moment anything writes to it, and the renderer
// only ever writes `scan` and `navCollapsed`. Reading the key raw then hands
// back an object missing everything else, while `?? SETTINGS_DEFAULTS` never
// fires because the object it guards is present. Merging is the fix, and this
// pins the direction of the merge — persisted values must win over defaults.
test("settings: defaults fill the gaps a partial saved object leaves", () => {
    const { SETTINGS_DEFAULTS } = require("../src/constants");

    const persisted = { navCollapsed: true, scan: { recursive: false } };
    const merged = { ...SETTINGS_DEFAULTS, ...persisted };

    assert.equal(merged.onConflict, "ask", "a missing conflict policy must fall back to ask");
    assert.equal(merged.outputRouting, "alongside");
    assert.equal(merged.navCollapsed, true, "what was saved must win over the default");
    assert.deepEqual(merged.scan, { recursive: false });
});

// A wiring guard like the one above it. The migration is what makes the merge
// mean anything on an install that already carries a v1 value, and it must stay
// version-guarded — an unconditional prune would eat whatever a preferences
// screen writes, on the very next launch.
test("settings: main.js still runs the migration, once, before the window", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /migrateStore\(\);\s*probe\.setFfprobePath/,
        "migrateStore must run before the window is created");
    assert.match(main, /store\.get\("settingsSchema"\) === SETTINGS_SCHEMA_VERSION/,
        "the migration must be guarded by the schema version, or it runs every launch");
    // The kit reads the settings merged over SETTINGS_DEFAULTS; main.js must read them from it.
    assert.match(main, /settings:\s*\{\s*defaults:\s*SETTINGS_DEFAULTS\s*\}/,
        "the kit must be given the defaults to merge underneath");
    assert.match(main, /function appSettings\(\) \{\s*return kit\.settings\.get\(\);/,
        "settings must be read through the kit, with the defaults merged underneath");
});

// Credits used to be a window of its own, with a guard against a second one,
// Escape handled in main, and a top-level Credits menu item. It's the last tab
// of the kit's Settings view now, from kit.start()'s credits.
test("credits: a tab of Settings, not a window or a menu item", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.ok(!fs.existsSync(path.join(__dirname, "..", "src", "credits.html")), "credits.html is gone");
    assert.ok(!/credits\.html|createCreditsWindow/.test(main), "main.js opens no Credits window");
    assert.match(main, /credits:\s*\{\s*lines:/, "the Credits tab gets DFC's credit lines");
    assert.match(main, /donate:\s*"https:\/\/buymeacoff\.ee\/willtda"/);

    const menu = fs.readFileSync(path.join(__dirname, "..", "src", "menu.js"), "utf8");
    assert.ok(!/label:\s*"Credits"/.test(menu + main), "no Credits menu item");
});

// Prompt serialisation used to be asserted here by matching three identifiers
// inside main.js as text. It never awaited a promise or observed an ordering,
// so a reordering that reintroduced the race would still have passed. Dialog
// ordering needs a real dialog; it is checked by hand instead — see the
// "Apply to all remaining files" cases in docs/MANUAL-TESTING.md. What the
// pool does around those prompts is covered properly in test/runner.test.js.

// The kit pushes an OS theme change to every window (theme:changed from
// nativeTheme), and its theme.js applies it, beside the media query.
test("theme: the page follows the OS theme through the kit, not code of its own", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.ok(!/nativeTheme|broadcastTheme/.test(main), "main.js leaves the theme push to the kit");

    const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(head, /<script src="\.\.\/node_modules\/@diamonddigitaldev\/electron-kit\/page\/theme\.js"><\/script>/,
        "the kit's theme.js must be in <head>, so the first paint is already in the OS theme");
    assert.ok(!/<script>/.test(head), "no inline theme script of its own");
});

test("menu: DevTools is never disabled", () => {
    // The kit's menu has Toggle Developer Tools (F12) on a pre-release such as
    // 2.0.0-beta.2; devTools was never meant to be off in webPreferences.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.ok(!/devTools:\s*false/.test(main),
        "devTools is not meant to be disabled; the loss was an accident of the custom menu");
});

// ---------------------------------------------------------------------------
// The three defects QA found on alpha.5 that were not the settings bug above.
// All three are guarded here rather than in a unit test because all three are
// wiring in main.js: what the menu registers, what the preview is handed, and
// what the prompt offers.
// ---------------------------------------------------------------------------

test("menu: an accelerator with no modifier steals every keystroke of that letter", () => {
    // Electron registers menu accelerators globally, whatever holds focus, so a
    // bare "C" opened Credits on every "c" typed into any text field in the app
    // — found by QA typing into the Name template box. Function keys are the
    // legitimate exception: F12 is a shortcut, not a character anyone types.
    //
    // Written as a scan rather than a check for the one binding, because the
    // same mistake is sitting in two sibling apps and would come back here the
    // moment a menu item is added without thinking about focus.
    // The app's items are in menu.js; the kit builds the rest of the menu, and refuses a bare one itself.
    const main = ["main.js", "menu.js"].map(f => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).join("\n");

    const bare = [...main.matchAll(/accelerator:\s*"([^"]+)"/g)]
        .map(m => m[1])
        .filter(a => !a.includes("+") && !/^F\d{1,2}$/.test(a));

    assert.deepEqual(bare, [],
        `an accelerator needs a modifier or a function key; found: ${bare.join(", ")}`);
});

test("preview: the command shown resolves a real destination, not a placeholder", () => {
    // The box exists to promise that what it shows is what will be executed,
    // and the output path — the argument a user is most likely to be checking —
    // was the one part of it that was stubbed.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.ok(!/outputPath:\s*"<output>"/.test(main),
        "the preview must not stub the output path");
    assert.match(main, /paths\.resolveOutputPath\(job\)/,
        "the preview must resolve the destination with the same code the run uses");
});

test("conflict: the prompt carries the abort, because nothing behind it can be clicked", () => {
    // The dialog is window-modal: while it is open Windows blocks every click
    // on the app behind it, so the footer's own "Cancel All" was unreachable.
    // Position was never the problem, which is why dragging the dialog clear
    // changed nothing. The only surface that can take the answer is the dialog.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.match(main, /buttons:\s*\["Cancel All", "Skip This File", "Overwrite", "Save as New"\]/,
        "the prompt must offer a whole-run abort as well as a per-file answer");
    assert.match(main, /if \(runner\) runner\.cancelAll\(\);/,
        "Cancel All must actually reach the runner");
    assert.match(main, /if \(choice === "skip"\) return \{ action: "skip" \};/,
        "Skip must settle the card as Skipped, which the runner already knows how to do");
});

test("conflict: Cancel All ends the run, not just the file it was answered on", () => {
    // Re-QA found the button above still declining one file at a time. Two
    // holes, both about where a batch ends: the prompts behind the answered one
    // were chained before the abort and so were already past the runner's own
    // cancelled check, and the runner clears that check on its next start() —
    // which happens whenever a batch goes idle waiting for a later file to
    // finish probing. Both let a fresh dialog open for a run already stopped.
    //
    // Escape is not a separate path to fix: cancelId picks button 0, which is
    // Cancel All, so it lands on the same branch.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.match(main, /if \(conflictAbort\) return \{ action: "cancel" \};/,
        "no dialog may open for a batch that has already been aborted");
    assert.match(main, /conflictAbort = true;\s+if \(runner\) runner\.cancelAll\(\);/,
        "answering Cancel All must record the abort as well as tell the runner");
    assert.match(main, /jobsInFlight === 0/,
        "the batch is bounded by the job:run calls still outstanding, not by the runner going idle");
    assert.ok(!/runner\.on\("idle",[^)]*conflictChoiceForBatch/.test(main),
        "batch state cannot be scoped to idle: a batch outlives an idle whenever a later file is still being probed");
    assert.match(main, /cancelId:\s*0,/,
        "Escape must resolve to Cancel All, which is what the checklist promises it does");
});
