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

test("conflict: main.js threads the user's setting into the job", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /onConflict:\s*settings\.onConflict/,
        "main.js must pass settings.onConflict into createJob, or the prompt is unreachable");
    assert.match(main, /conflictResolver:\s*resolveConflict/,
        "the runner must be given the resolver");
});

test("conflict: the prompt offers an escape hatch for a whole batch", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    // Without this, a batch of 50 collisions means 50 modal dialogs.
    assert.match(main, /checkboxLabel:\s*"Apply to all remaining files"/);
    assert.match(main, /conflictChoiceForBatch\s*=\s*null/,
        "the batch-wide choice must be reset so it cannot leak into the next run");
});

test("credits: Escape is handled in the main process, not the page", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /before-input-event/,
        "Escape must be handled via before-input-event, which does not depend on the page script");
    assert.match(main, /input\.key === "Escape"/);

    // The page-level handler was the fragile version that failed when packaged.
    const credits = fs.readFileSync(path.join(__dirname, "..", "src", "credits.html"), "utf8");
    assert.ok(!/addEventListener\(\s*["']keydown["']/.test(credits),
        "credits.html should no longer rely on its own keydown listener");
});

// ---------------------------------------------------------------------------
// alpha.2 test-pass regressions (main process)
// ---------------------------------------------------------------------------

test("credits: only one Credits window can ever be open", () => {
    // Every menu click used to build another modal. Escape closed the top one
    // and uncovered an identical window behind it, which reads as Escape doing
    // nothing at all — the before-input-event handler was never at fault.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const fn = main.slice(main.indexOf("function createCreditsWindow"));
    assert.match(fn.slice(0, 400), /if \(creditsWindow && !creditsWindow\.isDestroyed\(\)\)/,
        "an existing Credits window must be focused rather than duplicated");
    assert.match(fn.slice(0, 2000), /creditsWindow\.on\("closed"/,
        "the reference must be cleared, or Credits can never be reopened");
});

test("conflict: the output-exists prompts are serialised", () => {
    // The concurrency pool brings several jobs to the resolver at once. Each
    // used to read the batch choice (still null) and open its own dialog
    // before the first answer came back, so "apply to all remaining files"
    // had no effect on the prompts already queued behind it.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /conflictPromptChain/,
        "prompts must be chained so only one dialog is open at a time");

    const resolver = main.slice(main.indexOf("async function resolveConflict"),
                                main.indexOf("async function promptForConflict"));
    assert.ok(!/showMessageBox/.test(resolver),
        "resolveConflict must not open the dialog itself; the serialised prompt does");
    assert.match(main, /async function promptForConflict[\s\S]{0,400}?if \(conflictChoiceForBatch\)/,
        "the batch choice must be re-read after the previous prompt settles");
});

test("theme: an OS theme change is pushed to the windows, not only observed", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /nativeTheme\.on\("updated"/,
        "a live OS theme change must reach the renderer without a restart");
    assert.match(main, /IPC\.THEME_CHANGED/);

    // The media query listener in the page stays as the first route.
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
    assert.match(html, /addEventListener\("change", apply\)/,
        "the prefers-color-scheme listener must remain");
});

test("menu: replacing the default menu must not take DevTools with it", () => {
    // Electron's F12 accelerator comes from the default application menu, so a
    // fully custom template silently removed it — leaving no way to open the
    // console. devTools was never disabled in webPreferences.
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /role:\s*"toggleDevTools"/, "DevTools must be reachable");
    assert.ok(!/devTools:\s*false/.test(main),
        "devTools is not meant to be disabled; the loss was an accident of the custom menu");
});
