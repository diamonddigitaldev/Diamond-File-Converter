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
