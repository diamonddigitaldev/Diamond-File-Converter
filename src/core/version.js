"use strict";

// Version comparison for the updater.
//
// The app ships pre-releases (2.0.0-alpha.1), and a pre-release must never be
// offered as an update target — the updater only ever looks at the latest
// stable. That creates a case the naive check got wrong: someone running
// 2.0.0-alpha.1 is on a version *newer* than the latest stable 1.0.0, so an
// equality check ("is the found version the same as mine?") reports neither
// "up to date" nor "update available", and the manual check silently does
// nothing.

/** Split a semver string into its parts. Returns null if unparseable. */
function parse(version) {
    if (typeof version !== "string") return null;
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split(".") : [],
    };
}

/** True when the version carries a pre-release tag (alpha, beta, rc...). */
function isPrerelease(version) {
    const parsed = parse(version);
    return parsed ? parsed.prerelease.length > 0 : false;
}

/**
 * Compare two versions: -1 if a < b, 0 if equal, 1 if a > b.
 * Unparseable versions sort as lower than anything parseable.
 */
function compare(a, b) {
    const pa = parse(a);
    const pb = parse(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;

    for (const part of ["major", "minor", "patch"]) {
        if (pa[part] !== pb[part]) return pa[part] < pb[part] ? -1 : 1;
    }

    // A version with a pre-release tag is LOWER than the same version without
    // one: 2.0.0-alpha.1 precedes 2.0.0.
    if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
    if (pa.prerelease.length === 0) return 1;
    if (pb.prerelease.length === 0) return -1;

    const len = Math.max(pa.prerelease.length, pb.prerelease.length);
    for (let i = 0; i < len; i++) {
        const ai = pa.prerelease[i];
        const bi = pb.prerelease[i];
        if (ai === undefined) return -1;
        if (bi === undefined) return 1;
        if (ai === bi) continue;

        const an = /^\d+$/.test(ai);
        const bn = /^\d+$/.test(bi);
        // Numeric identifiers compare numerically and rank below alphanumeric.
        if (an && bn) return Number(ai) < Number(bi) ? -1 : 1;
        if (an) return -1;
        if (bn) return 1;
        return ai < bi ? -1 : 1;
    }
    return 0;
}

/**
 * Should `candidate` be offered to someone running `current`?
 *
 * Only if it is strictly newer AND stable. This is the rule the updater
 * enforces: pre-releases are never an update target, whatever the user is
 * currently running.
 */
function isOfferableUpdate(candidate, current) {
    if (!parse(candidate)) return false;
    if (isPrerelease(candidate)) return false;
    return compare(candidate, current) > 0;
}

module.exports = { parse, isPrerelease, compare, isOfferableUpdate };
