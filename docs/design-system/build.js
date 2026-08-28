"use strict";

/**
 * Builds the Diamond Digital Electron house-style artboards.
 *
 * Every card is a self-contained HTML page (no external CSS, no Bootstrap) so
 * it renders standalone in the Claude Design pane. The first line carries a
 * `@dsCard` marker, which is what the pane indexes.
 *
 *   node docs/design-system/build.js
 *
 * Source of truth for the values below: Diamond Media Player, the Dropgate
 * client and server, and Diamond File Converter, surveyed 2026-08-27.
 */

const fs = require("fs");
const path = require("path");

const OUT = __dirname;

// ── Shared page chrome ───────────────────────────────────────────────────────

const BASE_CSS = `
:root{
  --accent:#9740fb; --accent-hover:#b06cff; --accent-muted:#c796ff; --accent-rgb:151,64,251;
  --bg:#212529; --surface:#2b3035; --surface-2:#343a40; --border:#495057;
  --text:#dee2e6; --text-dim:rgba(222,226,230,.75); --text-faint:rgba(222,226,230,.5);
  --success:#198754; --warning:#ffc107; --danger:#dc3545; --info:#0dcaf0;
  --success-rgb:25,135,84; --warning-rgb:255,193,7; --danger-rgb:220,53,69;
  --radius-control:5px; --radius-card:8px; --radius-zone:12px;
  --dur-micro:120ms; --dur-state:.2s; --dur-default:.3s;
  --ease-standard:cubic-bezier(.4,0,.2,1);
}
*{box-sizing:border-box}
body{
  margin:0;padding:40px;background:var(--bg);color:var(--text);
  font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:16px;line-height:1.5;
}
h1{font-size:24px;margin:0 0 6px;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--text-dim);font-size:14px;margin:0 0 32px;max-width:70ch}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--text-faint);
   margin:36px 0 14px;font-weight:600}
h2:first-of-type{margin-top:0}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.stack{display:flex;flex-direction:column;gap:10px}
.grid{display:grid;gap:14px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-card);padding:18px}
code,.mono{font-family:Consolas,'Courier New',monospace;font-size:12.5px}
code{background:rgba(255,255,255,.07);padding:2px 6px;border-radius:4px;color:var(--accent-muted)}
.note{font-size:13px;color:var(--text-dim);margin-top:10px;max-width:74ch}
.note b{color:var(--text);font-weight:600}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;color:var(--text-faint);font-weight:600;font-size:11px;
   text-transform:uppercase;letter-spacing:.08em;padding:0 14px 8px 0;border-bottom:1px solid var(--border)}
td{padding:9px 14px 9px 0;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:middle}
tr:last-child td{border-bottom:none}
.swatch{width:26px;height:26px;border-radius:5px;border:1px solid rgba(255,255,255,.16);display:inline-block;vertical-align:middle}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:50rem;
     background:var(--surface-2);color:var(--text-dim);border:1px solid var(--border)}
.caption{font-size:11.5px;color:var(--text-faint);margin-top:8px}
`;

function page(title, subtitle, group, body, extraCss = "") {
    return `<!-- @dsCard group="${group}" -->
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>${title}</title>
<style>${BASE_CSS}${extraCss}</style>
</head><body>
<h1>${title}</h1>
<p class="sub">${subtitle}</p>
${body}
</body></html>
`;
}

const cards = [];
function card(file, title, subtitle, group, body, extraCss) {
    cards.push({ file, title, group });
    const full = path.join(OUT, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, page(title, subtitle, group, body, extraCss), "utf8");
}

// ── Foundations ──────────────────────────────────────────────────────────────

card("foundations/colour.html", "Colour & Accent",
    "Bootstrap 5.3's custom properties are the semantic base in all three apps. The house adds one thing on top: a per-app accent, bound into --bs-primary in both themes.",
    "Foundations", `
<h2>The per-app accent</h2>
<p class="note">House rule: <b>per-app accent, everything else shared.</b> An app overrides these four values and nothing else. Accent is the app's identity in the taskbar; structure, motion and components stay identical.</p>
<table>
<tr><th>App</th><th></th><th>--accent</th><th>--accent-hover</th><th>--accent-muted</th></tr>
<tr><td>Diamond File Converter</td><td><span class="swatch" style="background:#28a745"></span></td><td><code>#28a745</code></td><td><code>#34d058</code></td><td><code>#5dd879</code></td></tr>
<tr><td>Diamond Media Player</td><td><span class="swatch" style="background:#9740fb"></span></td><td><code>#9740fb</code></td><td><code>#b06cff</code></td><td><code>#c796ff</code></td></tr>
<tr><td>Dropgate client</td><td><span class="swatch" style="background:#0d6efd"></span></td><td><code>#0d6efd</code></td><td><code>#0a58ca</code></td><td><code>#6ea8fe</code></td></tr>
</table>

<h2>Binding the accent into Bootstrap</h2>
<div class="panel"><pre class="mono" style="margin:0;white-space:pre-wrap;color:var(--text-dim)">:root,
[data-bs-theme="light"],
[data-bs-theme="dark"] {
    --bs-primary:     var(--accent);
    --bs-primary-rgb: var(--accent-rgb);
    --bs-link-color:  var(--accent);
}</pre></div>
<p class="note"><b>Both themes, and the bare :root.</b> File Converter v1 remapped <code>--bs-primary</code> only inside <code>[data-bs-theme="dark"]</code>, so its primary button rendered Bootstrap blue in light mode and green in dark. Listing the bare <code>:root</code> alongside both themes also covers the "system" case, where neither attribute is set. Bootstrap derives <code>.btn-primary</code> from its own component variables rather than from <code>--bs-primary</code>, so the button additionally needs <code>--bs-btn-bg</code> set.</p>

<h2>Semantic colours</h2>
<table>
<tr><th>Role</th><th></th><th>Hex</th><th>RGB triplet</th></tr>
<tr><td>Success</td><td><span class="swatch" style="background:#198754"></span></td><td><code>#198754</code></td><td><code>25, 135, 84</code></td></tr>
<tr><td>Warning</td><td><span class="swatch" style="background:#ffc107"></span></td><td><code>#ffc107</code></td><td><code>255, 193, 7</code></td></tr>
<tr><td>Danger</td><td><span class="swatch" style="background:#dc3545"></span></td><td><code>#dc3545</code></td><td><code>220, 53, 69</code></td></tr>
<tr><td>Info</td><td><span class="swatch" style="background:#0dcaf0"></span></td><td><code>#0dcaf0</code></td><td><code>13, 202, 240</code></td></tr>
</table>

<h2>Surfaces</h2>
<table>
<tr><th>Token</th><th>Light</th><th>Dark</th></tr>
<tr><td><code>--bs-body-bg</code></td><td><span class="swatch" style="background:#fff"></span> <code>#fff</code></td><td><span class="swatch" style="background:#212529"></span> <code>#212529</code></td></tr>
<tr><td><code>--bs-secondary-bg</code></td><td><span class="swatch" style="background:#e9ecef"></span> <code>#e9ecef</code></td><td><span class="swatch" style="background:#343a40"></span> <code>#343a40</code></td></tr>
<tr><td><code>--bs-tertiary-bg</code></td><td><span class="swatch" style="background:#f8f9fa"></span> <code>#f8f9fa</code></td><td><span class="swatch" style="background:#2b3035"></span> <code>#2b3035</code></td></tr>
<tr><td><code>--bs-border-color</code></td><td><span class="swatch" style="background:#dee2e6"></span> <code>#dee2e6</code></td><td><span class="swatch" style="background:#495057"></span> <code>#495057</code></td></tr>
</table>
<p class="note">Theme is driven by <code>data-bs-theme</code> on <code>&lt;html&gt;</code>, set by an inline script in <code>&lt;head&gt;</code> before the stylesheet parses so there is no flash. All three apps follow the OS only — <b>none has an in-app theme toggle or persists a preference.</b></p>
`);

card("foundations/wash-ladder.html", "Wash Formulas",
    "Two formulas cover every tinted surface in the house style. Both are alpha over a token's RGB triplet, never a new hex value.",
    "Foundations", `
<h2>Interaction ladder</h2>
<div class="grid" style="grid-template-columns:repeat(2,1fr)">
  <div class="panel" style="border-color:rgba(var(--accent-rgb),.5);background:rgba(var(--accent-rgb),.04)">
    <div class="tag">hover</div><div style="margin-top:10px">fill <code>.04</code> · border <code>.5</code></div></div>
  <div class="panel" style="border-color:rgba(var(--accent-rgb),1);background:rgba(var(--accent-rgb),.06)">
    <div class="tag">active / drag-over</div><div style="margin-top:10px">fill <code>.06</code> · border <code>1</code></div></div>
</div>
<p class="note">Applied as <code>rgba(var(--accent-rgb), &lt;alpha&gt;)</code>. The drop zone is the canonical user: idle border is the neutral <code>--bs-border-color</code>, hover tints it halfway, an active drag takes it to full accent.</p>

<h2>Semantic wash</h2>
<div class="stack">
  <div class="panel" style="background:rgba(var(--success-rgb),.1);border-color:rgba(var(--success-rgb),.3)">Success — <code>rgba(25,135,84,.1)</code> fill, <code>rgba(25,135,84,.3)</code> border</div>
  <div class="panel" style="background:rgba(var(--warning-rgb),.1);border-color:rgba(var(--warning-rgb),.3)">Warning — <code>rgba(255,193,7,.1)</code> fill, <code>rgba(255,193,7,.3)</code> border</div>
  <div class="panel" style="background:rgba(var(--danger-rgb),.1);border-color:rgba(var(--danger-rgb),.3)">Danger — <code>rgba(220,53,69,.1)</code> fill, <code>rgba(220,53,69,.3)</code> border</div>
</div>
<p class="note"><b>The formula is fill <code>0.1</code>, border <code>0.3</code>, always.</b> Because both derive from the token's RGB triplet, a semantic state needs no new colour value and stays correct in both themes.</p>
`);

card("foundations/type.html", "Typography",
    "One font stack, no webfonts, one custom weight. The scale is small because these are dense utility apps, not content sites.",
    "Foundations", `
<h2>Stack</h2>
<div class="panel">
  <div style="font-size:22px;margin-bottom:6px">Diamond Digital Development</div>
  <code>'Segoe UI', Tahoma, Geneva, Verdana, sans-serif</code>
  <p class="note" style="margin-top:12px">Windows system stack, no webfont loaded. Dropgate's main window omits the declaration entirely and inherits Bootstrap's <code>--bs-font-sans-serif</code>; its popup pages pin the stack above. <b>Standardise on the explicit stack.</b></p>
</div>

<h2>Scale</h2>
<table>
<tr><th>Use</th><th>Size</th><th>Sample</th></tr>
<tr><td>Section label (uppercase)</td><td><code>0.7rem</code></td><td><span style="font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--text-faint)">Video</span></td></tr>
<tr><td>Meta / secondary</td><td><code>0.875rem</code></td><td><span style="font-size:.875rem;color:var(--text-dim)">3 Files Queued</span></td></tr>
<tr><td>Body</td><td><code>1rem</code></td><td><span style="font-size:1rem">Drag &amp; Drop Files Here</span></td></tr>
<tr><td>Drop label</td><td><code>1rem</code> / 500</td><td><span style="font-size:1rem;font-weight:500">Drag &amp; Drop Files Here</span></td></tr>
<tr><td>Page heading</td><td><code>1.25rem</code></td><td><span style="font-size:1.25rem">Diamond File Converter</span></td></tr>
<tr><td>Popup heading</td><td><code>24px</code></td><td><span style="font-size:24px">Preferences</span></td></tr>
</table>
<p class="note"><b>500 is the only custom weight in the entire house style.</b> Everything else is Bootstrap's default 400 or a heading default. Media Player sizes in px; Dropgate sizes in rem — <b>rem is the one to standardise on.</b> Letter-spacing appears exactly twice: <code>.1em</code> on uppercase section labels and <code>.5px</code> on Media Player's slider labels.</p>

<h2>Icons</h2>
<div class="panel">
  <p style="margin:0 0 10px"><b>Material Icons Round</b>, bundled locally from <code>node_modules/material-icons/iconfont/round.css</code> — never the Google Fonts CDN.</p>
  <table style="margin-top:6px">
  <tr><th>Size</th><th>Use</th></tr>
  <tr><td><code>48px</code></td><td>Hero / empty-state drop icon</td></tr>
  <tr><td><code>28px</code></td><td>Secondary hero (populated drop zone)</td></tr>
  <tr><td><code>24px</code></td><td>Default — status cards, transport controls</td></tr>
  <tr><td><code>18px</code></td><td>List row leading icon</td></tr>
  <tr><td><code>14px</code></td><td>Inside a 20px circular button</td></tr>
  </table>
  <p class="note">Media Player uses <code>&lt;i&gt;</code>, Dropgate uses <code>&lt;span&gt;</code> — <b>an inconsistency worth settling on <code>&lt;span&gt;</code>.</b> Icons are recoloured with text utilities (<code>text-success</code>, <code>text-danger</code>), never custom hexes.</p>
</div>
`);

card("foundations/spacing-radii.html", "Spacing & Radii",
    "Three radii carry almost everything. Spacing is Bootstrap's utility scale in newer code and ad-hoc pixels in older code.",
    "Foundations", `
<h2>Radii</h2>
<div class="row">
  <div style="width:120px;height:80px;background:var(--surface);border:1px solid var(--border);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:12px">5px</div>
  <div style="width:120px;height:80px;background:var(--surface);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px">8px</div>
  <div style="width:120px;height:80px;background:var(--surface);border:1px solid var(--border);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:12px">12px</div>
  <div style="width:80px;height:80px;background:var(--surface);border:1px solid var(--border);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px">50%</div>
</div>
<table style="margin-top:18px">
<tr><th>Token</th><th>Value</th><th>Applies to</th></tr>
<tr><td><code>--radius-control</code></td><td><code>5px</code></td><td>Buttons, selects, popup controls</td></tr>
<tr><td><code>--radius-card</code></td><td><code>8px</code></td><td>File lists, cards, panels</td></tr>
<tr><td><code>--radius-zone</code></td><td><code>12px</code></td><td>Drop zone</td></tr>
<tr><td>—</td><td><code>50%</code></td><td>Circular row actions, toggle knob</td></tr>
<tr><td>—</td><td><code>3px</code></td><td>Scrollbar thumb, progress track</td></tr>
</table>

<h2>Spacing</h2>
<p class="note">Newer code (Dropgate, File Converter) uses Bootstrap utilities — <code>p-4</code>, <code>mb-3</code>, <code>gap-2</code>, <code>d-grid</code>. Media Player uses ad-hoc pixels: 2, 4, 6, 10, 12, 15, 18, 20, 28, 40. <b>Bootstrap utilities are the direction of travel.</b></p>
<table>
<tr><th>Context</th><th>Value</th></tr>
<tr><td>Page padding</td><td><code>p-4</code> (1.5rem), dropping to <code>.75rem</code> below 500px</td></tr>
<tr><td>Block rhythm</td><td><code>mb-3</code> between stacked sections</td></tr>
<tr><td>Drop zone padding</td><td><code>2.25rem 1.5rem</code></td></tr>
<tr><td>List row padding</td><td><code>.35rem 0</code>, <code>gap: .5rem</code></td></tr>
<tr><td>Content max-width</td><td><code>580px</code> (File Converter) / <code>650px</code> (Dropgate)</td></tr>
</table>

<h2>Shadows</h2>
<p class="note"><b>The house barely uses shadows.</b> The Dropgate client has none at all; depth comes from borders plus a wash. Media Player has exactly two: <code>0 -2px 10px rgba(0,0,0,.3)</code> on the floating control bar and <code>0 1px 4px rgba(0,0,0,.15)</code> on the toggle knob.</p>
`);

card("foundations/motion.html", "Motion",
    "Five durations and three easings. The duration says what kind of change it is, so pick by meaning rather than by feel.",
    "Foundations", `
<style>
.demo{width:100%;height:56px;border-radius:var(--radius-card);background:var(--surface);
      border:1px solid var(--border);display:flex;align-items:center;padding:0 16px;cursor:pointer}
.demo:hover{background:rgba(var(--accent-rgb),.06);border-color:var(--accent)}
.d1{transition:background-color var(--dur-micro) ease,border-color var(--dur-micro) ease}
.d2{transition:background-color var(--dur-state) ease-in-out,border-color var(--dur-state) ease-in-out}
.d3{transition:background-color var(--dur-default),border-color var(--dur-default)}
@keyframes pulse{0%,100%{opacity:.75}50%{opacity:.5}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.knob{width:48px;height:28px;border-radius:34px;background:var(--surface-2);position:relative;cursor:pointer}
.knob::after{content:"";position:absolute;width:20px;height:20px;left:4px;top:4px;border-radius:50%;
  background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.15);transition:transform var(--dur-default) var(--ease-standard)}
.knob:hover{background:var(--accent)}
.knob:hover::after{transform:translateX(20px)}
</style>
<h2>Durations — hover each row</h2>
<div class="stack">
  <div class="demo d1"><b style="width:90px">120ms</b> <span style="color:var(--text-dim)">Micro — hover and press on small controls (row delete, icon buttons)</span></div>
  <div class="demo d2"><b style="width:90px">0.2s</b> <span style="color:var(--text-dim)">State — a surface changing meaning (drop zone arming)</span></div>
  <div class="demo d3"><b style="width:90px">0.3s</b> <span style="color:var(--text-dim)">Default — everything else</span></div>
</div>
<table style="margin-top:20px">
<tr><th>Duration</th><th>Name</th><th>Used for</th></tr>
<tr><td><code>120ms ease</code></td><td>micro</td><td>Small-control hover</td></tr>
<tr><td><code>0.2s ease-in-out</code></td><td>state</td><td>Surface state change</td></tr>
<tr><td><code>0.3s</code></td><td>default</td><td>General transitions</td></tr>
<tr><td><code>0.4s ease</code></td><td>enter</td><td>Page-load fade-in</td></tr>
<tr><td><code>2s ease-in-out ∞</code></td><td>ambient</td><td>Loading pulse / breathe</td></tr>
</table>

<h2>Easing</h2>
<div class="row" style="align-items:flex-start;gap:32px">
  <div><div class="knob"></div><div class="caption">cubic-bezier(.4, 0, .2, 1)<br>knob travel — the only custom curve</div></div>
  <div><div style="width:56px;height:56px;border-radius:8px;background:rgba(var(--accent-rgb),.25);border:1px solid var(--accent);animation:pulse 2s infinite ease-in-out"></div><div class="caption">ambient pulse — "still loading"</div></div>
  <div><div style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--accent);animation:spin 1.4s linear infinite">◠</div><div class="caption">spin 1.4s linear — work in progress</div></div>
</div>

<h2>Timings shared with the JS side</h2>
<table>
<tr><th>Value</th><th>Meaning</th></tr>
<tr><td><code>500ms</code></td><td>Debounce — window-bounds saves, Explorer multi-file batching</td></tr>
<tr><td><code>3000ms</code></td><td>Progress bar reset after completion</td></tr>
<tr><td><code>4500ms</code></td><td>Toast auto-dismiss</td></tr>
<tr><td><code>2000ms</code></td><td>Idle before the video control bar hides</td></tr>
<tr><td><code>5000ms</code></td><td>Delay before the startup update check</td></tr>
</table>
<p class="note"><b>Disabled and busy is <code>opacity: 0.5</code> plus <code>pointer-events: none</code></b> — applied as inline style, not a class.</p>
`);

// ── Components ───────────────────────────────────────────────────────────────

card("components/buttons.html", "Buttons",
    "All stock Bootstrap variants. The house contributes a vocabulary — which variant means what — rather than custom button CSS.",
    "Components", `
<style>
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;
  font-size:14px;border-radius:var(--radius-control);border:1px solid transparent;cursor:pointer;
  font-family:inherit;transition:background-color var(--dur-default),border-color var(--dur-default)}
.btn-sm{padding:5px 11px;font-size:13px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:#6c757d;color:#fff}
.btn-secondary:hover{background:#5c636a}
.btn-outline{background:transparent;border-color:#6c757d;color:var(--text-dim)}
.btn-outline:hover{background:#6c757d;color:#fff}
.btn-danger{background:var(--danger);color:#fff}
.btn-warning{background:var(--warning);color:#000}
.btn:disabled{opacity:.5;pointer-events:none}
</style>
<h2>Variant vocabulary</h2>
<table>
<tr><th>Variant</th><th>Example</th><th>Means</th></tr>
<tr><td><code>btn-primary</code></td><td><button class="btn btn-primary">Convert</button></td><td>Commit the action — one per screen</td></tr>
<tr><td><code>btn-secondary</code></td><td><button class="btn btn-secondary btn-sm">Select Files</button></td><td>Neutral action</td></tr>
<tr><td><code>btn-outline-secondary</code></td><td><button class="btn btn-outline btn-sm">Clear All</button></td><td>Tertiary, or adjacent to an input</td></tr>
<tr><td><code>btn-danger</code></td><td><button class="btn btn-danger btn-sm">Cancel Upload</button></td><td>Destructive or abort</td></tr>
<tr><td><code>btn-warning</code></td><td><button class="btn btn-warning btn-sm">Upload Anyway</button></td><td>Confirm something risky</td></tr>
<tr><td>disabled</td><td><button class="btn btn-primary" disabled>Convert</button></td><td><code>opacity .5</code> + <code>pointer-events:none</code></td></tr>
</table>

<h2>Fill is reserved for the action being committed</h2>
<div class="panel">
  <div class="row"><button class="btn btn-outline">Cancel</button><button class="btn btn-primary">Apply</button>
    <span class="tag" style="color:#75b798;border-color:#75b798">correct</span></div>
  <div class="row" style="margin-top:12px"><button class="btn btn-secondary">Cancel</button><button class="btn btn-primary">Apply</button>
    <span class="tag" style="color:#ea868f;border-color:#ea868f">wrong</span></div>
  <p class="note"><b>A neutral action sitting beside a filled primary is outlined, not filled.</b>
  Two filled buttons side by side read as two equal choices, which is exactly what a
  cancel is not. This applies anywhere the pair appears — dialog footers, the action bar,
  card actions. Bootstrap's own modal example uses a filled <code>btn-secondary</code> for
  Cancel; the house does not.</p>
  <p class="note">A filled neutral button is still fine when it stands alone with no primary
  beside it, as with Add Files in the toolbar.</p>
</div>

<h2>Swap, do not crowd</h2>
<div class="panel">
  <div class="row"><button class="btn btn-primary">Convert</button><span style="color:var(--text-faint)">→ becomes →</span><button class="btn btn-danger">Cancel</button></div>
  <p class="note"><b>The primary and its abort occupy the same slot</b>, toggled with <code>style.display</code>, rather than sitting side by side. Dropgate's upload/cancel pair is the reference.</p>
</div>

<h2>Popup-window button</h2>
<div class="panel" style="max-width:340px">
  <button class="btn" style="display:block;width:100%;background:var(--surface-2);color:var(--text);margin-bottom:10px">Donate on Buy Me a Coffee</button>
  <button class="btn" style="display:block;width:100%;background:var(--surface-2);color:var(--text)">View Source Code on GitHub</button>
  <p class="note">Inside <code>.popup-window</code> pages, <code>.btn</code> is overridden to full-width, <code>10px</code> padding, <code>16px</code> text, <code>--bs-secondary-bg</code> fill, going to <code>--bs-tertiary-bg</code> on hover. Identical in Media Player and Dropgate.</p>
</div>
`);

card("components/drop-zone.html", "Drop Zone",
    "The hero component of both File Converter and Dropgate, and the clearest example of the interaction wash ladder.",
    "Components", `
<style>
.dz{border:2px dashed var(--border);border-radius:var(--radius-zone);padding:2.25rem 1.5rem;
  text-align:center;cursor:pointer;transition:background-color var(--dur-state) ease-in-out,border-color var(--dur-state) ease-in-out}
.dz:hover:not(:has(button:hover)){border-color:rgba(var(--accent-rgb),.5);background:rgba(var(--accent-rgb),.04)}
.dz.over{border-color:rgba(var(--accent-rgb),1);background:rgba(var(--accent-rgb),.06)}
.dz-icon{font-size:48px;color:var(--text-faint);line-height:1}
.dz-label{font-size:1rem;font-weight:500;margin:.75rem 0 .25rem}
.dz-or{font-size:.875rem;color:var(--text-dim);margin:0 0 .5rem}
.mini{padding:5px 11px;font-size:13px;border-radius:5px;border:1px solid transparent;
  background:#6c757d;color:#fff;cursor:pointer;font-family:inherit}
.mini.outline{background:transparent;border-color:#6c757d;color:var(--text-dim)}
</style>
<h2>Empty → populated</h2>
<div class="grid" style="grid-template-columns:1fr 1fr">
  <div>
    <div class="dz">
      <div class="dz-icon">⬆</div>
      <p class="dz-label">Drag &amp; Drop Files Here</p>
      <p class="dz-or">or</p>
      <button class="mini">Select Files</button>
    </div>
    <div class="caption"><code>#dz-empty</code></div>
  </div>
  <div>
    <div class="dz">
      <div class="dz-icon" style="font-size:28px;color:var(--accent)">⊕</div>
      <p class="dz-label">3 Files Queued</p>
      <p class="dz-or">drag and drop more files or</p>
      <div class="row" style="justify-content:center">
        <button class="mini">Select More Files</button>
        <button class="mini outline">Clear All</button>
      </div>
    </div>
    <div class="caption"><code>#dz-has-files</code></div>
  </div>
</div>
<p class="note">Two sibling divs toggled with Bootstrap's <code>.d-none</code>. The zone itself never unmounts, so the border and background transitions stay continuous across the state change.</p>

<h2>Drag-over</h2>
<div class="dz over">
  <div class="dz-icon" style="color:var(--accent)">⬆</div>
  <p class="dz-label">Drag &amp; Drop Files Here</p>
</div>
<p class="note">Border goes to full accent, fill to <code>.06</code>.</p>

<h2>The nested-button guard</h2>
<div class="panel"><code>.drop-zone:hover:not(:has(button:hover))</code></div>
<p class="note"><b>The whole zone is a click target</b>, so it must stop signalling "drop here" once the pointer is over a button inside it. This exact idiom appears in the File Converter, the Dropgate client and the Dropgate server. Note the matching JS guard: the zone's click handler returns early when the event originated on a button, or the browse dialog opens twice.</p>
`);

card("components/file-row.html", "File Row & List",
    "The list primitive shared by File Converter and Dropgate, including the only custom scrollbar in the house style.",
    "Components", `
<style>
.list{max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius-card);padding:.25rem .6rem}
.list::-webkit-scrollbar{width:6px}
.list::-webkit-scrollbar-track{background:transparent}
.list::-webkit-scrollbar-thumb{background:rgba(128,128,128,.3);border-radius:3px}
.list::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.5)}
.frow{display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--border)}
.frow:last-child{border-bottom:none}
.fico{font-size:18px;flex-shrink:0;color:var(--text-dim)}
.fname{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.875rem}
.fmeta{flex-shrink:0;color:var(--text-dim);font-size:.875rem}
.fdel{width:20px;height:20px;border-radius:50%;border:1px solid var(--border);background:var(--bg);
  color:var(--text-dim);display:inline-flex;align-items:center;justify-content:center;padding:0;
  cursor:pointer;flex-shrink:0;font-size:13px;line-height:1;
  transition:background-color var(--dur-micro) ease,color var(--dur-micro) ease,border-color var(--dur-micro) ease}
.fdel:hover{background:var(--danger);border-color:var(--danger);color:#fff}
.divider{height:4px;background:var(--border);margin:2px 0;border-radius:1px}
</style>
<h2>Anatomy</h2>
<div class="list">
  <div class="frow"><span class="fico">▦</span><span class="fname">holiday-montage-final-render-v3.mp4</span><span class="fmeta">248 MB</span><button class="fdel">×</button></div>
  <div class="frow"><span class="fico">▦</span><span class="fname">beach.mov</span><span class="fmeta">1.2 GB</span><button class="fdel">×</button></div>
  <div class="divider"></div>
  <div class="frow"><span class="fico">♪</span><span class="fname">soundtrack.flac</span><span class="fmeta">42 MB</span><button class="fdel">×</button></div>
</div>
<p class="note">Left to right: <b>18px leading icon · flexible truncating name · fixed trailing meta · 20px circular destructive action.</b> The name takes <code>flex: 1 1 0</code> with <code>min-width: 0</code> — without the <code>min-width</code>, a long filename refuses to shrink and pushes the meta out of the row. Hover the × to see the <code>120ms</code> transition to danger.</p>

<h2>Group divider</h2>
<p class="note">File Converter separates media kinds with a <code>4px</code> filled bar rather than a heading, and clears the preceding row's <code>border-bottom</code> so the two rules do not stack.</p>

<h2>Scrollbar</h2>
<table>
<tr><th>Part</th><th>Value</th></tr>
<tr><td>width</td><td><code>6px</code></td></tr>
<tr><td>track</td><td><code>transparent</code></td></tr>
<tr><td>thumb</td><td><code>rgba(128,128,128,0.3)</code>, radius <code>3px</code></td></tr>
<tr><td>thumb:hover</td><td><code>rgba(128,128,128,0.5)</code></td></tr>
</table>
<p class="note">Deliberately theme-neutral grey so one rule works in both themes.</p>
`);

card("components/toggle.html", "Toggle Switch",
    "The one genuinely custom control in the house style. Currently Media Player only — worth promoting to the shared layer.",
    "Components", `
<style>
.ts{position:relative;display:inline-block;width:48px;height:28px;vertical-align:middle}
.ts input{opacity:0;width:0;height:0;position:absolute}
.slider{position:absolute;inset:0;background:var(--surface-2);border-radius:34px;
  cursor:pointer;transition:background-color var(--dur-default)}
.slider::before{content:"";position:absolute;height:20px;width:20px;left:4px;top:4px;background:#fff;
  border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.15);transition:transform var(--dur-default) var(--ease-standard)}
.ts input:checked + .slider{background:var(--accent)}
.ts input:checked + .slider::before{transform:translateX(20px)}
.tlabel{font-size:14px;margin-left:10px}
.trow{display:flex;align-items:center;gap:12px;margin-bottom:18px;cursor:pointer}
</style>
<h2>States</h2>
<div class="panel">
  <label class="trow"><span class="tlabel" style="margin-left:0">Freeze monitoring on pause</span>
    <span class="ts"><input type="checkbox"><span class="slider"></span></span></label>
  <label class="trow"><span class="tlabel" style="margin-left:0">Preserve folder structure</span>
    <span class="ts"><input type="checkbox" checked><span class="slider"></span></span></label>
  <p class="note" style="margin:0">Both are live — click them.</p>
</div>

<h2>Geometry</h2>
<table>
<tr><th>Part</th><th>Value</th></tr>
<tr><td>Track</td><td><code>48 × 28</code>, radius <code>34px</code></td></tr>
<tr><td>Knob</td><td><code>20 × 20</code>, radius <code>50%</code>, inset <code>4px</code></td></tr>
<tr><td>Travel</td><td><code>translateX(20px)</code></td></tr>
<tr><td>Easing</td><td><code>cubic-bezier(.4, 0, .2, 1)</code> over <code>0.3s</code></td></tr>
<tr><td>Knob shadow</td><td><code>0 1px 4px rgba(0,0,0,.15)</code></td></tr>
<tr><td>Checked track</td><td><code>var(--accent)</code></td></tr>
</table>
<p class="note"><b>Row layout is label-left, control-right</b>, wrapped in a single <code>&lt;label&gt;</code> with <code>display:flex; gap:12px</code> so the text is part of the hit target. The real input is visually hidden rather than removed, which keeps it keyboard-focusable.</p>
`);

card("components/status-card.html", "Status Card",
    "Dropgate's signature component: an ambient pulse while a state is unknown, resolving into a semantic wash once it is known.",
    "Components", `
<style>
@keyframes pulse{0%{opacity:.75}50%{opacity:.5}100%{opacity:.75}}
.sc{padding:.75rem 1rem;border-radius:var(--radius-card);display:flex;align-items:center;gap:.5rem;
  border:1px solid var(--border);margin-bottom:12px;font-size:14px}
.sc.loading{animation:pulse 2s infinite ease-in-out}
.sc.green{background:rgba(var(--success-rgb),.1);border-color:rgba(var(--success-rgb),.3);animation:none}
.sc.yellow{background:rgba(var(--warning-rgb),.1);border-color:rgba(var(--warning-rgb),.3);animation:none}
.sc.red{background:rgba(var(--danger-rgb),.1);border-color:rgba(var(--danger-rgb),.3);animation:none}
.ico{font-size:24px;line-height:1}
</style>
<h2>Loading, then resolved</h2>
<div class="sc loading"><span class="ico">◌</span><span>Checking security…</span></div>
<div class="sc green"><span class="ico" style="color:var(--success)">✓</span><span>Your upload will be end-to-end encrypted.</span></div>
<div class="sc yellow"><span class="ico" style="color:var(--warning)">⚠</span><span>This server does not advertise encryption.</span></div>
<div class="sc red"><span class="ico" style="color:var(--danger)">✕</span><span>This connection is not secure.</span></div>

<p class="note"><b>The pattern: pulse while unknown, then kill the animation and apply the wash.</b> The resolved state sets three things at once — the icon glyph, a Bootstrap text colour on the icon, and the wash class on the card. Because the layout is identical in every state, resolving causes no reflow.</p>

<h2>Why it generalises</h2>
<p class="note">This is the natural shape for a File Converter job card's status strip: unknown while the probe is in flight, then green for ready, yellow for "will re-encode", red for an unsupported combination. The ambient pulse is doing real work — it distinguishes "still checking" from "checked and fine", which a static grey card cannot.</p>
`);

card("components/progress.html", "Progress",
    "Three surfaces report progress, and the house uses all three at once for long operations.",
    "Components", `
<style>
@keyframes stripes{from{background-position:1rem 0}to{background-position:0 0}}
.prog{height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden;margin-bottom:6px}
.bar{height:100%;background:var(--accent);border-radius:4px}
.bar.striped{background-image:linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent);background-size:1rem 1rem;animation:stripes 1s linear infinite}
.meta{display:flex;justify-content:space-between;font-size:.875rem;color:var(--text-dim)}
</style>
<h2>Determinate</h2>
<div class="prog"><div class="bar" style="width:62%"></div></div>
<div class="meta"><span>File 3 of 8</span><span>62%</span></div>

<h2>Indeterminate</h2>
<div style="margin-top:14px"><div class="prog"><div class="bar striped" style="width:100%"></div></div>
<div class="meta"><span>Converting…</span><span></span></div></div>
<p class="note"><b>Use this whenever the duration is unknown</b> — still images, streams with no reported length. File Converter v1 had no indeterminate state, so its bar sat frozen at 0% for the whole job whenever ffmpeg could not report a percentage, which read as a hang.</p>

<h2>Window chrome as a progress surface</h2>
<div class="panel">
  <div style="background:var(--surface-2);border-radius:6px 6px 0 0;padding:8px 12px;font-size:13px;border-bottom:1px solid var(--border)">Dropgate Client — Uploading 62%</div>
  <div style="height:34px;background:var(--bg);border-radius:0 0 6px 6px"></div>
</div>
<p class="note">Dropgate sets both the window title and <code>win.setProgressBar()</code>, which lights the Windows taskbar button. On completion it passes <code>{ mode: 'error' }</code> to turn the taskbar bar red, then clears it with <code>-1</code> after <code>3000ms</code>. <b>This is the right pattern for a long convert queue</b> — progress stays visible when the window is behind something else.</p>
`);

card("components/toast.html", "Toast",
    "Currently only in the Dropgate server. The clearest gap in the desktop apps, which have no transient feedback at all.",
    "Components", `
<style>
.toast{border-left:4px solid;padding:12px 16px;border-radius:6px;margin-bottom:10px;font-size:14px}
.t-info{background:var(--info);border-left-color:var(--info);color:#000}
.t-success{background:var(--success);border-left-color:var(--success);color:#fff}
.t-warning{background:var(--warning);border-left-color:var(--warning);color:#000}
.t-danger{background:var(--danger);border-left-color:var(--danger);color:#fff}
</style>
<h2>Variants</h2>
<div class="toast t-info">Queued 24 files from 3 folders.</div>
<div class="toast t-success">Conversion complete — 24 files written.</div>
<div class="toast t-warning">4 files skipped: unsupported format.</div>
<div class="toast t-danger">Could not write to the output folder.</div>

<h2>Placement</h2>
<table>
<tr><th>Property</th><th>Value</th></tr>
<tr><td>position</td><td><code>fixed</code>, <code>top: 16px</code>, <code>left: 50%</code>, <code>translateX(-50%)</code></td></tr>
<tr><td>width</td><td><code>min(720px, calc(100% - 2rem))</code></td></tr>
<tr><td>z-index</td><td><code>1080</code> (above Bootstrap's modal backdrop)</td></tr>
<tr><td>accent bar</td><td><code>4px</code> left border in the semantic colour</td></tr>
<tr><td>dismiss</td><td><code>4500ms</code></td></tr>
</table>
<p class="note"><b>Guard the dismissal against clobbering.</b> The server's implementation snapshots the toast's text before the timeout and only hides the element if the text is still the same — otherwise a second toast raised inside the window gets cut short by the first one's timer.</p>
<p class="note">Note this is a full-fill toast, not Bootstrap's default outlined <code>.alert</code>: the semantic colour is the background, with the left border reinforcing it. Warning and info take black text; success and danger take white.</p>
`);

card("components/modal.html", "Modal Dialog",
    "The house has exactly one in-page HTML dialog, in the Dropgate client. Its conventions are worth following, because the alternative is a native blocking message box.",
    "Components", `
<style>
.backdrop{background:rgba(0,0,0,.5);border-radius:var(--radius-card);padding:40px 20px;display:flex;justify-content:center}
.modal{background:var(--bg);border-radius:8px;max-width:460px;width:100%;box-shadow:0 1rem 3rem rgba(0,0,0,.4)}
.mhead{display:flex;align-items:center;gap:8px;padding:16px 16px 8px;font-size:17px;font-weight:500}
.mbody{padding:8px 16px 16px;font-size:14px}
.mbody .lead{margin:0 0 8px}
.mbody .caveat{color:var(--text-dim);font-size:13px;margin:0}
.mfoot{display:flex;justify-content:flex-end;gap:8px;padding:8px 16px 16px}
.btn{padding:7px 14px;font-size:14px;border-radius:5px;border:1px solid transparent;cursor:pointer;font-family:inherit}
.b-sec{background:#6c757d;color:#fff}
.b-out{background:transparent;border-color:#6c757d;color:var(--text-dim)}
.b-warn{background:var(--warning);color:#000}
</style>
<div class="backdrop">
  <div class="modal">
    <div class="mhead"><span style="color:var(--warning)">⚠</span> Upload Security Warning</div>
    <div class="mbody">
      <p class="lead">This server does not support end-to-end encryption. Your file will be uploaded without encryption.</p>
      <p class="caveat">The server administrator may be able to access your file contents.</p>
    </div>
    <div class="mfoot">
      <button class="btn b-out">Cancel</button>
      <button class="btn b-warn">Upload Anyway</button>
    </div>
  </div>
</div>

<h2>Conventions</h2>
<table>
<tr><th>Element</th><th>Rule</th></tr>
<tr><td>Header &amp; footer</td><td><code>border-0</code> — no dividing rules</td></tr>
<tr><td>Dialog</td><td><code>modal-dialog-centered</code></td></tr>
<tr><td>Title</td><td>Semantic icon + text in <code>d-flex align-items-center gap-2</code></td></tr>
<tr><td>Body</td><td>One plain statement, then one <code>text-body-secondary small mb-0</code> caveat</td></tr>
<tr><td>Footer</td><td><b>Outlined</b> neutral cancel on the left, filled semantic confirm on the right — never two filled buttons</td></tr>
<tr><td>Backdrop</td><td>Bootstrap default — <code>#000</code> at <code>.5</code></td></tr>
<tr><td>Motion</td><td>Bootstrap default — backdrop <code>.15s linear</code>, dialog <code>translate(0,-50px) → 0</code> over <code>.3s ease-out</code></td></tr>
</table>
<p class="note"><b>Wrap it in a promise.</b> Dropgate's helper resolves <code>true</code> on confirm and <code>false</code> on <code>hidden.bs.modal</code>, removing both listeners in a shared cleanup, so the dialog reads as a plain <code>await</code> at the call site. This is the pattern the 2.0 "New Job" modal should use.</p>
`);

card("components/inputs.html", "Inputs & Form Rows",
    "Stock Bootstrap form controls, arranged in a fixed three-part row that all the apps repeat.",
    "Components", `
<style>
.frow{margin-bottom:1rem}
.flabel{display:block;font-size:14px;margin-bottom:.4rem}
.igroup{display:flex}
.ctl{flex:1;padding:8px 12px;font-size:14px;background:var(--surface);border:1px solid var(--border);
  color:var(--text);border-radius:var(--radius-control) 0 0 var(--radius-control);font-family:inherit;min-width:0}
.igroup .ctl:only-child{border-radius:var(--radius-control)}
.iaddon{padding:8px 12px;font-size:14px;background:var(--surface-2);border:1px solid var(--border);
  border-left:none;border-radius:0 var(--radius-control) var(--radius-control) 0;color:var(--text-dim)}
.help{font-size:13px;color:var(--text-dim);margin-top:.25rem;min-height:1.2em}
.help.ok{color:#75b798}.help.warn{color:#ffda6a}.help.bad{color:#ea868f}
</style>
<h2>The row</h2>
<div class="frow">
  <label class="flabel">Output folder</label>
  <div class="igroup"><input class="ctl" value="D:\\Converted"><button class="iaddon" style="cursor:pointer">Browse</button></div>
  <div class="help">Leave empty to write next to each source file.</div>
</div>
<div class="frow">
  <label class="flabel">Concurrency</label>
  <div class="igroup"><input class="ctl" type="number" value="4"><span class="iaddon">jobs at once</span></div>
  <div class="help ok">Detected 8 cores.</div>
</div>
<p class="note">Always three parts, in this order: <b><code>label.form-label</code> above, full width · the control (optionally in an <code>.input-group</code> with a trailing button or addon) · a <code>.form-text</code> help line.</b></p>

<h2>Help-line state vocabulary</h2>
<div class="stack">
  <div class="help">neutral — <code>form-text text-muted</code></div>
  <div class="help ok">success — <code>text-success</code></div>
  <div class="help warn">warning — <code>text-warning</code></div>
  <div class="help bad">error — <code>text-danger</code></div>
</div>
<p class="note"><b>Reserve the space with <code>min-height: 1.2em</code>.</b> Without it the whole form jumps when a validation message appears. This trick is used on every status row in Dropgate.</p>
<p class="note"><b>Disable, do not hide.</b> When the server restricts an option, Dropgate disables the <code>&lt;option&gt;</code> and rewrites its label to <code>"Unlimited (Disabled by Server)"</code> rather than removing it, so the capability stays discoverable.</p>
`);

// ── Shell ────────────────────────────────────────────────────────────────────

card("shell/window-chrome.html", "Window Chrome",
    "Every app uses a standard OS-framed window and the native menu bar. That is a deliberate house choice, not an omission.",
    "Shell", `
<style>
.win{border:1px solid var(--border);border-radius:8px;overflow:hidden;max-width:560px}
.titlebar{background:var(--surface-2);padding:8px 12px;font-size:13px;display:flex;justify-content:space-between;align-items:center}
.menubar{background:var(--surface);padding:5px 12px;font-size:13px;display:flex;gap:18px;border-bottom:1px solid var(--border)}
.menubar span{color:var(--text-dim)}
.canvas{padding:24px;background:var(--bg);min-height:110px;color:var(--text-faint);font-size:13px}
</style>
<div class="win">
  <div class="titlebar"><span>Diamond File Converter</span><span style="color:var(--text-faint)">─ □ ✕</span></div>
  <div class="menubar"><span>Menu</span><span>Credits</span></div>
  <div class="canvas">Single-column content, centred, <code>max-width</code> 580–650px.</div>
</div>

<h2>Rules</h2>
<table>
<tr><th>Decision</th><th>House position</th></tr>
<tr><td>Frameless / custom titlebar</td><td><b>No.</b> No app sets <code>frame:false</code> or <code>titleBarStyle</code>.</td></tr>
<tr><td>Navigation</td><td>Native <code>Menu.buildFromTemplate</code>. No sidebar, no tabs, no router.</td></tr>
<tr><td>Layout</td><td>One centred column of <code>.mb-3</code> blocks.</td></tr>
<tr><td>Bounds</td><td>Persisted to <code>electron-store</code>, debounced <code>500ms</code> on resize/move, written immediately on close.</td></tr>
<tr><td>Single instance</td><td><code>requestSingleInstanceLock()</code>; <code>second-instance</code> restores and focuses.</td></tr>
</table>

<h2>Menu template</h2>
<div class="panel"><pre class="mono" style="margin:0;white-space:pre-wrap;color:var(--text-dim)">Menu
  Open File          Ctrl+O
  ─────────
  Check for Updates
  ─────────
  Exit               Alt+F4   (role: quit)
Credits                        (flat top-level item)</pre></div>
<p class="note">Identical across all three apps, down to the separator positions. <b>Credits is a flat top-level item, not a submenu</b> — clicking the label opens the window directly.</p>

<h2>Window sizes</h2>
<table>
<tr><th>App</th><th>Default</th><th>Minimum</th></tr>
<tr><td>Diamond Media Player</td><td><code>1280 × 775</code></td><td><code>1080 × 775</code></td></tr>
<tr><td>Diamond File Converter</td><td><code>700 × 1000</code></td><td><code>600 × 600</code></td></tr>
<tr><td>Dropgate client</td><td><code>600 × 900</code></td><td><code>400 × 700</code></td></tr>
</table>
<p class="note">Media Player is wide because it shows video; the two utility apps are tall single columns.</p>
`);

card("shell/popup-window.html", "Popup Window",
    "Credits and preferences are real child BrowserWindows, not in-page modals. The recipe and its CSS are copied near-verbatim between apps.",
    "Shell", `
<style>
.pw{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:420px}
.pw h1{font-size:24px;margin:0 0 20px;text-align:center}
.pw label{display:block;font-size:16px;margin-bottom:10px}
.pw select{width:100%;padding:10px;font-size:16px;background:var(--surface-2);color:var(--text);
  border:none;border-radius:5px;margin-bottom:20px;font-family:inherit;transition:background-color var(--dur-default)}
.pw select:hover{background:var(--border)}
.pw hr{margin:20px 0;border:none;border-top:1px solid var(--border)}
.pw .btn{display:block;width:100%;padding:10px;margin-top:20px;font-size:16px;background:var(--surface-2);
  color:var(--text);border:none;border-radius:5px;cursor:pointer;text-align:center;font-family:inherit;
  transition:background-color var(--dur-default)}
.pw .btn:hover{background:var(--border)}
.pw .link{color:var(--accent-muted);cursor:pointer;transition:all var(--dur-default)}
.pw .link:hover{color:var(--accent);text-decoration:underline}
</style>
<div class="row" style="align-items:flex-start;gap:24px">
  <div class="pw">
    <h1>Preferences</h1>
    <label>Visualiser Quality:</label>
    <select><option>Highest</option><option>High</option></select>
    <div class="caption">Media Player — <code>400 × 300</code></div>
  </div>
  <div class="pw">
    <div style="display:flex;align-items:center"><div style="width:24px;height:24px;border-radius:5px;background:var(--accent);margin-right:10px"></div><h2 style="margin:0;font-size:20px;text-transform:none;letter-spacing:0;color:var(--text)">Diamond File Converter</h2></div>
    <p style="font-size:14px">• Created and maintained by <span class="link">Diamond Digital Development</span>.</p>
    <hr>
    <button class="btn">Donate on Buy Me a Coffee</button>
    <div class="caption">Credits — <code>750 × 450</code></div>
  </div>
</div>

<h2>The BrowserWindow recipe</h2>
<div class="panel"><pre class="mono" style="margin:0;white-space:pre-wrap;color:var(--text-dim)">parent: mainWindow, modal: true,
resizable: false, minimizable: false,
maximizable: false, fullscreenable: false
→ win.setMenu(null)
→ win.on("minimize", e => { e.preventDefault(); win.show(); win.focus(); })
→ page listens for Escape and calls window.close()</pre></div>
<p class="note"><b>The anti-minimize guard matters.</b> Because the window is modal to its parent, letting it minimise would strand the app with an invisible blocker. Modality, backdrop and focus trapping all come from the OS, so there is no overlay CSS and no enter/exit animation.</p>

<h2>Shared CSS</h2>
<p class="note">The <code>.popup-window</code> block is duplicated in all three apps with only six points of drift. <b>The "link" is a bare <code>&lt;span&gt;</code> with a click handler, not an <code>&lt;a&gt;</code></b> — it takes the accent-muted colour and underlines on hover. Under context isolation these must be <code>data-href</code> plus a listener rather than inline <code>onclick</code>, since the page has no <code>shell</code>.</p>
`);

card("shell/context-menu.html", "Context Menu",
    "The only context menu in the house style is a Windows Explorer shell extension written at install time. No app has an in-app one.",
    "Shell", `
<style>
.explorer{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 0;max-width:300px;font-size:13px}
.mi{padding:7px 14px;display:flex;align-items:center;gap:10px}
.mi:hover{background:rgba(var(--accent-rgb),.15)}
.mi .ic{width:16px;height:16px;border-radius:3px;background:var(--accent);flex-shrink:0}
.sep{height:1px;background:var(--border);margin:5px 0}
</style>
<div class="explorer">
  <div class="mi" style="color:var(--text-dim)">Open</div>
  <div class="mi" style="color:var(--text-dim)">Edit</div>
  <div class="sep"></div>
  <div class="mi"><span class="ic"></span> Convert with Diamond File Converter</div>
  <div class="mi"><span class="ic" style="background:#9740fb"></span> Open with Diamond Media Player</div>
  <div class="mi"><span class="ic" style="background:#0d6efd"></span> Share with Dropgate</div>
</div>

<h2>How it is registered</h2>
<div class="panel"><pre class="mono" style="margin:0;white-space:pre-wrap;color:var(--text-dim)">!macro customInstall
  WriteRegStr HKCR "*\\shell\\&lt;App&gt;" "" "&lt;Verb&gt; &lt;Product&gt;"
  WriteRegStr HKCR "*\\shell\\&lt;App&gt;" "Icon" "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCR "*\\shell\\&lt;App&gt;\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUninstall
  DeleteRegKey HKCR "*\\shell\\&lt;App&gt;"
!macroend</pre></div>
<p class="note">Lives in <code>installer.nsh</code>, referenced from <code>build.nsis.include</code>. <b>Always pair customInstall with customUninstall</b> — an uninstall that leaves the key behind puts a dead entry in every user's context menu.</p>

<h2>The batching problem</h2>
<p class="note"><b>Windows launches one process per selected file.</b> Selecting 30 files spawns 30 processes, 29 of which hit the single-instance lock and forward their path through <code>second-instance</code>. Collect those arrivals and debounce for <code>500ms</code> before handing them to the renderer, or the queue is rebuilt 30 times. Dropgate's <code>BATCH_DEBOUNCE_MS</code> is the reference.</p>

<h2>Gap</h2>
<p class="note">There is <b>no in-app context menu anywhere</b> — no <code>contextmenu</code> listener, no <code>Menu.popup()</code>. A right-click menu on File Converter's 2.0 job grid would be the first, and needs a house decision on native <code>Menu.popup</code> versus a custom HTML menu.</p>
`);

// ── Patterns ─────────────────────────────────────────────────────────────────

card("patterns/settings-placement.html", "Settings Placement",
    "The house has two competing answers. Both are legitimate; the choice follows how often the setting changes.",
    "Patterns", `
<h2>Two patterns in use</h2>
<div class="grid" style="grid-template-columns:1fr 1fr">
  <div class="panel">
    <div class="tag">Media Player</div>
    <h3 style="font-size:15px;margin:12px 0 8px">Separate popup window</h3>
    <p class="note" style="margin:0">A modal child BrowserWindow at <code>400 × 300</code>, opened from the native menu. Flat layout: heading, then label + control stacked. No save button — changes persist on <code>change</code>.</p>
  </div>
  <div class="panel">
    <div class="tag">Dropgate</div>
    <h3 style="font-size:15px;margin:12px 0 8px">Settings as page</h3>
    <p class="note" style="margin:0">Server URL, lifetime and max downloads are first-class rows on the main screen, above the action button. Persisted on <code>input</code>, <code>blur</code> and <code>change</code>.</p>
  </div>
</div>

<h2>The rule</h2>
<table>
<tr><th>If the setting is…</th><th>Put it…</th></tr>
<tr><td>Changed most times the app is used, and affects the pending action</td><td>On the page, as a form row</td></tr>
<tr><td>Configured once and forgotten</td><td>In the preferences popup window</td></tr>
</table>
<p class="note">Dropgate's lifetime and download-cap settings change per upload, so burying them in a popup would be wrong. Media Player's visualiser quality is set once, so putting it on the player surface would be clutter.</p>
<p class="note"><b>Neither pattern has a save button.</b> Persist on change and reflect the result immediately; a modal save step is not the house style.</p>

<h2>Applied to File Converter 2.0</h2>
<p class="note">Per-job encoding options belong in the <b>New Job modal</b> — changed constantly, scoped to one job. App-wide defaults (output routing, concurrency, conflict policy, name template) belong in a <b>preferences popup window</b>, since they are set once. Output folder is the borderline case, and it argues for the page: it changes often enough to deserve a visible row.</p>
`);

card("patterns/feedback.html", "Feedback & Error Surfacing",
    "The weakest area of the house style. Everything is a native blocking dialog, which does not scale to batch operations.",
    "Patterns", `
<h2>What exists today</h2>
<table>
<tr><th>Situation</th><th>Current treatment</th><th>Verdict</th></tr>
<tr><td>Update available / ready</td><td>Native <code>dialog.showMessageBox</code></td><td>Fine — rare, needs a decision</td></tr>
<tr><td>Output file exists</td><td>Native dialog: Cancel / Overwrite / Save as New</td><td>Fine for one file, <b>painful for fifty</b></td></tr>
<tr><td>Conversion failed</td><td>Native dialog, <b>one per failed file, mid-queue</b></td><td><b>Wrong</b> — blocks the batch</td></tr>
<tr><td>Unsupported file dropped</td><td><b>Nothing at all</b></td><td><b>Wrong</b> — silent rejection</td></tr>
<tr><td>Background operation done</td><td>OS <code>Notification</code> when unfocused (Dropgate only)</td><td>Good — worth copying</td></tr>
</table>

<h2>The rule to adopt</h2>
<p class="note"><b>A blocking dialog is for a decision only the user can make, right now.</b> Anything reporting what already happened belongs in a toast or an inline status row. A failure inside a batch is a report, not a decision — it should mark the job and let the queue continue, with the detail available afterwards.</p>

<h2>Two specific traps</h2>
<p class="note"><b><code>body { user-select: none }</code> makes error text uncopyable.</b> File Converter sets it globally to stop text selection dragging the UI, which also means a user cannot copy the ffmpeg error to report it. Scope the rule to the chrome and let messages and paths stay selectable.</p>
<p class="note"><b>A per-file conflict prompt does not scale.</b> Offer "apply to all remaining" on the first prompt, or resolve the whole batch up front, before any work starts.</p>

<h2>Silent failure is the worst outcome</h2>
<p class="note">Two real examples worth remembering. File Converter drops unsupported files from a drop with no feedback whatsoever — the user sees nothing happen and cannot tell the app from a broken one. And its <code>debug.log</code> is the only record of a failure, with no way to open it from inside the app. <b>If the app knows something went wrong, the user must be able to find out what.</b></p>
`);

card("patterns/theme.html", "Theming",
    "System-following only, set before first paint. No app has a manual toggle — a known gap rather than a decision.",
    "Patterns", `
<h2>The bootstrap script</h2>
<div class="panel"><pre class="mono" style="margin:0;white-space:pre-wrap;color:var(--text-dim)">&lt;script&gt;
  (() =&gt; {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const root = document.documentElement;
    const apply = () =&gt; root.setAttribute("data-bs-theme", mql.matches ? "dark" : "light");
    apply();
    mql.addEventListener?.("change", apply);
  })();
&lt;/script&gt;</pre></div>
<p class="note"><b>Inline in <code>&lt;head&gt;</code>, before the stylesheet link.</b> Deferring it to a bundle or to <code>DOMContentLoaded</code> produces a flash of the wrong theme. The subscription matters as much as the initial call: these are long-running desktop apps, and the OS theme can flip under them at sunset.</p>
<p class="note">Dropgate's newer spelling is the one to standardise on — an IIFE with optional chaining on <code>addEventListener</code>. It also pre-sets <code>data-bs-theme="auto"</code> on <code>&lt;html&gt;</code> as a placeholder.</p>

<h2>Scoped theme islands</h2>
<p class="note">A subtree can opt out with its own <code>data-bs-theme</code>. Media Player forces its transport bar dark regardless of app theme, because it overlays video: <code>&lt;div id="controls" data-bs-theme="dark"&gt;</code>. <b>Use this rather than hardcoding hexes</b> when a region must stay dark.</p>

<h2>Known gaps</h2>
<table>
<tr><th>Gap</th><th>Consequence</th></tr>
<tr><td>No manual toggle in any app</td><td>A user on a light OS cannot get a dark app</td></tr>
<tr><td>No persisted preference</td><td>Nothing to restore even if a toggle were added</td></tr>
<tr><td>Hardcoded hexes bypass theming</td><td>Media Player's meters and Dropgate's two legacy greys (<code>#5a5a5a</code>, <code>#535353</code>) do not respond to theme</td></tr>
</table>
<p class="note">The fix for the third is the token layer: every colour resolves through a variable, so a theme change reaches all of them.</p>
`);

// ── Index + manifest ─────────────────────────────────────────────────────────

const byGroup = cards.reduce((acc, c) => {
    (acc[c.group] ||= []).push(c);
    return acc;
}, {});

const indexBody = Object.entries(byGroup).map(([group, list]) => `
<h2>${group}</h2>
<div class="stack">
${list.map(c => `  <div class="panel"><a href="${c.file}" style="color:var(--accent-muted);text-decoration:none;font-size:15px">${c.title}</a> <span class="mono" style="color:var(--text-faint);font-size:12px">${c.file}</span></div>`).join("\n")}
</div>`).join("\n");

fs.writeFileSync(path.join(OUT, "index.html"), page(
    "Diamond Digital — Electron House Style",
    `The shared visual language of Diamond Media Player, the Dropgate client and Diamond File Converter. Extracted from the three codebases on 2026-08-27. ${cards.length} cards.`,
    "Overview",
    indexBody
), "utf8");

fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify(cards, null, 2), "utf8");

console.log(`Wrote ${cards.length} artboards + index.html into ${OUT}`);
for (const c of cards) console.log(`  [${c.group}] ${c.file}`);
