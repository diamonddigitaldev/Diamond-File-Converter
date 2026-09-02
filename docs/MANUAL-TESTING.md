# Manual Testing Checklist

Steps a human needs to perform, covering what automated tests cannot judge:
whether something *looks* right, *feels* right, and behaves correctly against
the real filesystem, real dialogs and real Windows integration.

A new section is appended for each version or fix. Do not rewrite earlier
sections — the history is useful.

> ### Read the status line on each section
>
> **Every section in this file has been run in full and passed, as of
> 2026-09-02 against 2.0.0-alpha.4.** The alpha.1 and alpha.2 sections were
> held back while the UX direction settled; they were worked through for this
> release, alongside the three alpha.4 sections. The withdrawn pipelines
> section has been deleted rather than carried as dead weight — the feature it
> covered was removed in `09eaca3` and no longer exists to test.
>
> A written checklist is not a passed one. Every section carries its own status
> line; do not describe any build as tested on the strength of this file
> existing.

**Before starting:**

```
npm install
npm test          # expect 152 passing, 0 failing
npm start
```

> If Electron exits immediately with `Cannot read properties of undefined
> (reading 'getPath')`, the shell has `ELECTRON_RUN_AS_NODE=1` set, which makes
> Electron run as plain Node. `unset ELECTRON_RUN_AS_NODE` and retry. This is
> an environment quirk, not a bug in the app.

**Test media you will need:** a folder containing a mix of video, audio and
image files, at least one nested subfolder, at least one unsupported file
(a `.txt` will do), one very large video, and one deliberately corrupt media
file (rename a text file to `.mp4`).

---

## 2.0.0-alpha.1 — card grid, secure bridge, core architecture

> **Status: PASSED 2026-09-02.** Held while the UX direction settled, then run
> in full by hand against 2.0.0-alpha.4 and passed. This is the broad sweep —
> the card grid, ingest, selection, the format dropdown, conversion, failure
> handling, toasts, appearance in both themes, Windows integration and the
> security posture.


First release of the rebuilt interface. The whole UI changed, so this pass is
broad rather than targeted.

### Window and first run

- [x] App opens at roughly 1100×780 on a clean profile.
- [x] Window cannot be resized below 880×600. *(Raised from 720×560 in
      alpha.4 — below roughly 800px wide the selection bar clipped its own
      buttons.)*
- [x] Resize and move the window, close and reopen — position and size are
      remembered.
- [x] Menu bar shows **Menu** and **Credits**.
- [x] `Menu → Open Files` opens a file dialog filtered to supported types.
- [x] `Menu → Open Folder` opens a folder picker.
- [x] `Ctrl+O` opens the file dialog; `Ctrl+Shift+O` opens the folder picker.
- [x] `Credits` opens a modal window; it cannot be minimised; `Escape` closes
      it; the version number shown matches `package.json`.
- [x] Credits links (Diamond Digital, TheFuturisticIdiot, Donate, GitHub) all
      open in the external browser, not inside the app.

### Empty state and ingest

- [x] Empty state shows the dashed drop zone, centred.
- [x] Hovering the drop zone tints it; the tint does **not** persist after the
      pointer leaves.
- [x] Clicking the drop zone opens the file dialog. Clicking the **Select
      Files** button inside it opens the dialog exactly once, not twice.
- [x] Drag a file over the window — the target area highlights. Drag out again
      without dropping — the highlight clears. It must not flicker while moving
      across cards.
- [x] Drop a single file: a card appears immediately.
- [x] Drop a folder containing nested subfolders: files from subfolders are
      included, not just the top level.
- [x] Drop a folder containing an unsupported file: a toast reports how many
      were skipped. **Nothing may be discarded silently.**
- [x] Drop the same file twice: it is not duplicated.
- [x] Drop a file onto the very edge of the window, outside the grid: the app
      must **not** navigate away or replace itself with the file.

### Cards and metadata

- [x] Each card shows a kind icon (video / audio / image), the filename, and a
      metadata line.
- [x] Metadata fills in shortly after the card appears — resolution, duration,
      codec and size. A card must never wait on this to render.
- [x] Hover a card: the background lightens slightly and the border tints.
- [x] A long filename truncates with an ellipsis and does not push the remove
      button out of the card.
- [x] Hovering a truncated filename shows the full path as a tooltip.
- [x] The × button removes just that card.
- [x] Drop an MP3 that has embedded cover art: it is treated as audio, with no
      resolution shown.

### Text selection *(regression: filenames used to highlight on click-drag)*

- [x] Click and drag across a card's filename — **no text highlights.**
- [x] Same for the metadata line, the status text, the app title, the bulk bar
      and the action bar.
- [x] Text inside a real input field can still be selected and edited.

### Selecting cards

- [x] Click a card: it is selected and the bulk bar switches to "N selected".
- [x] Ctrl+click a second card: both selected.
- [x] Shift+click a third: the range between them is selected.
- [x] `Ctrl+A` selects every card; `Escape` clears the selection.
- [x] `Delete` removes the selected cards.
- [x] Click the checkbox in a card's top-left corner: it toggles only that card
      and leaves the rest of the selection alone.
- [x] With some but not all cards selected, the select-all checkbox in the bulk
      bar shows a dash (indeterminate), not a tick.
- [x] Ticking select-all selects everything; unticking clears it.
- [x] Click the empty grid background: the selection clears.

### Choosing formats

- [x] With nothing selected, the bulk bar reads **"All N files"** and
      **"Convert all to"**.
- [x] **The two-click flow:** drop a folder of images, choose one format from
      the bulk bar, press Convert. Nothing else should be required. *(This is
      how the previous version worked and must stay this quick.)*
- [x] With cards selected, the bar reads "N selected" / "Convert selected to",
      and **Remove** and **Deselect** appear.
- [x] A per-card dropdown changes only that card.
- [x] Select a video and an audio file together: the bulk dropdown offers only
      formats both can produce, and never a video-only container like MKV.
- [x] Select a video and an image together: no shared format exists, so the
      dropdown is empty and the bar explains why.
- [x] Choose a format, then pick **"Choose format…"** again: the card returns to
      the amber "Choose a format" state and Convert disables again.
      *(Regression: this previously did nothing.)*
- [x] Convert stays disabled until at least one card has a format.
- [x] The footer detail line reads **"1 file still needs a format"** for one and
      **"2 files still need a format"** for two. *(Regression: used to read
      "1 still need a format".)*

### Converting

- [x] Queue several files, choose formats, press Convert.
- [x] More than one file converts at once — cards show progress simultaneously.
- [x] Each card shows its own progress bar advancing.
- [x] A file with no readable duration (a still image) shows a moving
      indeterminate bar, **never a bar frozen at 0%**.
- [x] The overall bar at the bottom is **accent green, not blue**, and matches
      the card bars.
- [x] While converting, the Convert button is replaced by **Cancel** — the two
      never appear side by side.
- [x] Per-card **Cancel** stops just that file; the others carry on.
- [x] Footer **Cancel** stops everything.
- [x] Cancel a job mid-run, then check the output folder: **no partial file is
      left behind.**
- [x] On completion a success toast appears and the footer summary reads the
      outcome (e.g. "3 files converted"), **not** "3 files queued".
      *(Regression: it used to revert to "queued".)*
- [x] Completed cards offer **Show in folder**; clicking it reveals the file in
      Explorer.
- [x] Output lands next to the source file, with the correct extension.

### Conversions worth checking individually

- [x] Video → video (MP4 → MKV): plays correctly.
- [x] Video → audio (MP4 → MP3): audio only, correct duration.
- [x] Video → GIF: **colours look correct**, not a muddy 256-colour mess.
- [x] Video → PNG: output is a **folder** of numbered frames, and the card says
      how many frames — "1 frame" for one, "12 frames" for twelve.
- [x] Animated GIF → PNG: also produces a folder of frames.
- [x] Image → image (PNG → JPG): correct, and transparency is flattened.
- [x] Audio → audio (FLAC → MP3): correct duration and audible quality.

### Failure handling

- [x] Convert the deliberately corrupt file. It must fail **without a blocking
      dialog**.
- [x] The failing card turns red and shows the real ffmpeg reason, not a
      generic message.
- [x] Other files in the same batch keep going.
- [x] A **Retry** button appears on the failed card and works after changing the
      format.
- [x] Convert to a format whose output already exists: a prompt offers Cancel /
      Overwrite / Save as New, and each behaves as labelled.
- [x] Convert to a read-only folder: fails with a clear message rather than
      hanging.

### Toasts

- [x] Toasts appear centred below the header and **do not cover the app title
      or the Add Files / Add Folder buttons.**
- [x] The icon lines up with the first line of text — check specifically on a
      long wrapped message, where the icon must stay on the first line.
- [x] The × dismisses a toast; toasts auto-dismiss after a few seconds.
- [x] Several toasts stack rather than overlapping.
- [x] A failure toast stays until dismissed.

### Appearance

- [x] Switch Windows to light mode: the app follows without restarting.
- [x] Switch back to dark: it follows again.
- [x] **In light mode**, the Convert button is accent green, **not Bootstrap
      blue**. *(Regression: it was blue in light mode.)*
- [x] Clear All, Cancel and Convert are all the same height where they sit
      together. *(Regression: Clear All was shorter.)*
- [x] Resize the window narrow and wide: cards reflow, and the page never
      scrolls sideways.
- [x] With many files queued, the grid scrolls and the header, bulk bar and
      action bar stay put.

### Windows integration *(packaged build only)*

```
npm run build
```

- [x] Installer runs and the app launches from the Start menu.
- [x] `resources/ffmpeg/` in the install directory contains **both**
      `ffmpeg.exe` and `ffprobe.exe`.
- [x] Right-click a media file in Explorer: **"Convert with Diamond File
      Converter"** appears and opens the app with that file queued.
- [x] Right-click a *folder*: the same entry appears and queues its contents.
- [x] Select several files in Explorer and use the entry: they arrive as **one
      batch**, not one window per file.
- [x] With the app already running, use the Explorer entry again: files are
      added to the existing window rather than opening a second one.
- [x] Double-click an associated media file: it opens in the app.
- [x] Uninstall, then right-click a media file: the context-menu entry is
      **gone**. A leftover entry is a bug.

### Security posture

- [x] Open DevTools (in a dev run) and check the console on both the main and
      credits windows:
  - [x] `window.electronAPI` is defined
  - [x] `window.require` is `undefined`
  - [x] `window.process` is `undefined`
- [x] No errors in the console during a normal session.

---

## 2.0.0-alpha.1 — QA fixes

> **Status: PASSED 2026-09-02.** Run against the packaged 2.0.0-alpha.4 build
> — not `npm start` — and passed. The Escape defect only ever appeared once
> packaged, so the packaged build is the only run that counts here.


Two defects found running the checklist above against the packaged build, plus
the updater behaviour for pre-releases. **Test these against a packaged build,
not `npm start`** — the Escape defect only appeared once packaged.

### Credits window closes on Escape

- [x] Open Credits from the menu (or press `C`).
- [x] Press **Escape** — the window closes.
- [x] Open it again, click a link or a button first so focus has moved inside
      the page, then press Escape — it still closes.
- [x] The × button still closes it too.
- [x] The window still cannot be minimised.

### Existing output prompts instead of silently renaming

- [x] Convert a file to a format whose output already exists in the
      destination. A **File Already Exists** prompt appears offering
      **Cancel / Overwrite / Save as New**.
      *(It previously wrote "name (1).ext" with no prompt at all.)*
- [x] **Cancel** — the job is abandoned and the existing file is untouched.
- [x] **Overwrite** — the existing file is replaced.
- [x] **Save as New** — a numbered file appears alongside the original, and
      the original is untouched.
- [x] Queue several files that all collide. Tick **"Apply to all remaining
      files"** and choose one option — the prompt appears **once**, and the
      rest follow that choice without asking again.
- [x] Start a second batch afterwards: the prompt appears again. The
      apply-to-all choice must not carry over between runs.

### Updates never offer a pre-release

The app currently ships as `2.0.0-alpha.1` while the latest stable is `1.0.0`.

- [x] `Menu → Check for Updates` while running the alpha reports **"You're up
      to date!"**, not an offer to install `1.0.0`. Going backwards to an older
      stable is a downgrade and must be refused.
- [x] It does **not** offer any other alpha or beta, even a newer one.
- [x] No update prompt appears on its own a few seconds after launch.
- [x] On a stable build, a newer stable release *is* still offered normally —
      this must not have broken ordinary updates.
- [x] "View Changelog" from an update dialog opens the correct release page.

---

## 2.0.0-alpha.2 — Advanced options / Bulk edit

> **Status: PASSED 2026-09-02.** Held while the UX direction settled, then run
> in full by hand against 2.0.0-alpha.4 and passed, including the check that
> the plain path is still two clicks.


Per-file encoding settings. The engine already supported all of this; this pass
exposes it. **The plain path must stay two clicks** — check that first.

### The simple path is not disturbed

- [x] Drop a folder of images, pick one format in the bulk bar, press Convert.
      Still two clicks. The dialog must not be required for this.
- [x] The per-card format dropdown still works on its own.

### Opening the dialog

- [x] There is **no button in the top-right corner** for this — it lives in the
      green selection bar.
- [x] With nothing selected the bar reads **"Select all"** and the button reads
      **"Edit all"**; it opens for every file.
- [x] With cards selected the button reads **"Bulk edit"** and opens for just
      those, titled **"Bulk edit"**.
- [x] The tune icon on a card opens it for that one file only, titled
      **"Advanced options"**, and does not change the selection.
- [x] Bulk editing files that already have *different* settings starts blank and
      says they are configured differently, rather than showing one file's
      values as if they applied to all.
- [x] The word "job" appears nowhere in the interface.
- [x] Escape and the × both close it without applying anything.

### Controls follow the target format

- [x] Choose an **audio** target (MP3): the Video section disappears entirely.
- [x] Choose an **image** target (PNG): the Audio section disappears and an
      Image quality slider appears. Trim disappears for a still image.
- [x] Choose **GIF**: Trim stays available, because a GIF can be animated.
- [x] Choose **WebM**: the codec list offers VP9/VP8/AV1 and **not** H.264.
- [x] Choose **MP4**: it offers H.264/H.265/AV1 and **not** VP9.
- [x] Choose **MP3**: the audio codec list offers only MP3.
- [x] Set Stream to **Copy without re-encoding**: codec, quality, resize and
      frame rate all disappear, since none of them apply to a remux.
- [x] Set Stream to **Remove video**: same, and the preview gains `-vn`.
- [x] Pick a codec with no constant-quality mode (MPEG-4 in AVI): Quality
      switches to bitrate and locks. Switch back to H.264 — it must return to
      **Constant quality**, not stay stuck on bitrate.
- [x] Select a video and an image together: no shared format exists, the target
      list is empty and the dialog says so.

### Command preview

- [x] The preview updates as you change controls, and starts with `ffmpeg`.
- [x] It reflects what you set — a CRF of 20 appears as `-crf 20`, a resize as
      `scale=...`, a trim as `-ss`.
- [x] The preview text can be selected and copied. *(It is the one deliberate
      exception to nothing-is-selectable.)*
- [x] An invalid combination shows a red message and disables **Apply**.

### Trim slider

- [x] Trim is a **two-point slider**, not a pair of text boxes.
- [x] Drag the left handle right and the right handle left; the green range
      between them shrinks and the readout shows the kept duration.
- [x] The handles **cannot cross**.
- [x] **Hold Shift while dragging** — the handle moves much more slowly for the
      same pointer movement, so a precise point is reachable.
- [x] Click a handle and use the arrow keys; Shift+arrow gives a smaller step.
      Home and End jump to the extremes.
- [x] Leave the handles alone and Apply: **no trim is recorded**, and the card
      shows no trim in its summary.
- [x] Open advanced options on a file with no readable duration: the slider is
      replaced by a note saying it cannot be trimmed.
- [x] Bulk edit a selection of clips of different lengths: the slider spans the
      **longest**, and a trim past a shorter clip's end simply runs to its end.

### Button styling

- [x] The dialog's **Cancel is outlined, not filled** — only Apply is filled.
      Two filled buttons side by side is a design violation.

### Applying

- [x] Apply, then check the card: a green summary line appears under the
      metadata describing what was set, e.g. "H.264 · CRF 20 · 1280×720".
- [x] Open the dialog again on that card — your settings are still there.
- [x] Apply with nothing changed: the card gains **no** summary line. Untouched
      settings must not be baked in.
- [x] Apply to a multi-file selection: every selected card gets the summary.
- [x] Convert, and confirm the output honours the settings — check the
      resolution, duration and audio channels of the result, not just that a
      file appeared.

### Nothing is clipped

Fixed widths on a `<select>` cut the selected option off with no ellipsis and
no scrollbar — the text just disappears. Check at a few window sizes.

- [x] In Video, the Quality dropdown reads **"Constant quality"** in full, not
      "Constant qual…".
- [x] The Resize fit dropdown reads **"Contain"** in full, not "Contai".
- [x] Type `1920` and `1080` into Resize — both are fully readable.
- [x] Widen and narrow the window: no label, dropdown or field ever cuts text
      off mid-word. Filenames on cards are the one exception — those ellipsis
      deliberately.
- [x] Repeat with an audio target and an image target, where different controls
      are on screen.

### Output routing

- [x] Destination **A folder I choose** reveals a Browse button; picking a
      folder puts the path in the field.
- [x] Convert and confirm the output lands in that folder, not next to the
      source.
- [x] A name template of `{name}-web` produces `something-web.mp4`.
- [x] **If it already exists** set to Overwrite converts without prompting.

---

## 2.0.0-alpha.3 — fixes from the first manual test pass

> **Status: PASSED.** Written 2026-08-28, run and passed 2026-08-30. Every
> check below was executed by hand on real Windows and passed, including the
> two "still unconfirmed" items at the end.

The first pass reported nine issues. Seven were reproduced in the code and are
fixed here. **Two were not reproducible and are still open** — see "Still
unconfirmed" at the end, which is the most valuable part of this section to
work through, because it needs the reporter's exact sequence rather than ours.

### Escape, Delete and Ctrl+A after choosing a format

The global key handler treated any focused `<select>` as "the user is typing"
and bailed out. A `<select>` keeps focus after you pick an option, so choosing
a format on a card silently ate the next key until you clicked something
non-focusable.

- [x] Pick a format from **any card's dropdown**. Without clicking anything
      else, press **Ctrl+A** — every card is selected.
- [x] Repeat, and press **Escape** — the selection clears.
- [x] Repeat with one card selected, and press **Delete** — the card is
      removed.
- [x] Click a card's **checkbox** (a checkbox is an `<input>` too), then press
      Escape, Delete and Ctrl+A — all three still work.
- [x] Click into a **text field** (the resize width, or the name template) and
      press Delete — it edits the text and does **not** remove any cards.
- [x] Open **Advanced options**, select some text in a field, press Escape —
      the dialog closes and the cards behind it are untouched.
- [x] With the dialog open and cards selected behind it, press **Delete** —
      nothing is removed.

### Convert no longer re-runs a finished batch

- [x] Queue several files including one that will fail. Convert.
- [x] Fix the failed card's format and press **Convert** again. Only that card
      runs. Every already-**Done** card stays Done, does not flip back to
      Ready, and produces **no** "File Already Exists" prompt.
- [x] The **Retry** button on a single card still re-runs just that card.
- [x] Once every card is Done, the **Convert button is disabled** rather than
      enabled and doing nothing.
- [x] Add a new file to a finished queue: Convert enables again and runs only
      the new file.

### "Apply to all remaining files" actually applies

Jobs run through a concurrency pool, and several used to reach the prompt at
once — each opening its own dialog before the first answer was recorded, so
the tick had no effect on the dialogs already queued behind it.

- [x] Queue **at least six** files that all collide with existing output.
      Convert.
- [x] Only **one** prompt is on screen at a time.
- [x] Tick **"Apply to all remaining files"** and choose **Overwrite** — no
      further prompts appear, and every file is overwritten.
- [x] Repeat with **Save as New**, and again with **Cancel**. Each choice
      carries to the rest of the batch.
- [x] Start a second batch afterwards — the prompt appears again. The choice
      must not carry between runs.

### Advanced options: the codec you pick is the codec you get

One defect caused both of the dialog bugs reported. The codec selects were
rebuilt from the value the dialog opened with, so a pick was overwritten
immediately — dropping it on Apply, and leaving Quality apparently stuck
because the effective codec fell back to the container default.

- [x] Target **AVI**, set Codec to **MPEG-4**. Quality switches to **Target
      bitrate** with its explanatory note. Reopen the Codec dropdown — it
      reads **MPEG-4**, not "Format default".
- [x] Now set Codec to **H.264**. Quality returns to **Constant quality** and
      the CRF field comes back.
- [x] Switch between MPEG-4 and H.264 several times — it tracks every time.
- [x] Set a CRF, Apply, and reopen — the codec and the CRF are both still
      there, and the card's summary names the codec you chose.
- [x] Convert, then ffprobe the output: it really is the codec you picked.
- [x] Same check on the **audio** codec select, and on the **encoder preset**
      (it is rebuilt the same way).

### An unreadable file says so

- [x] Queue a deliberately corrupt file (rename a `.txt` to `.mp4`).
- [x] Its metadata line settles on **"MP4 · unreadable"** within a second or
      two. It must not sit on "Reading…" indefinitely.
- [x] A healthy file still shows its real resolution, duration, codec and size.

### DevTools are reachable again

Replacing Electron's default menu removed its F12 accelerator along with it.

- [x] **Menu → Toggle Developer Tools** opens DevTools.
- [x] **F12** does the same.
- [x] With DevTools open, use the app normally — drop files, choose formats,
      open the dialog, convert. **The console shows no errors.** *(This was
      unverifiable in the first pass and is still unverified.)*

### Credits window

The Escape handler was verified working in isolation; what was missing was a
guard against opening the window more than once.

- [x] Open Credits, press **Escape** — it closes.
- [x] Open Credits **five times in a row** from the menu. Only one window ever
      exists; the others just focus it.
- [x] After those five opens, press **Escape once** — the window closes and
      there is **no second window behind it**.
- [x] Open Credits, click **View Source Code on GitHub** (the browser takes
      focus), click back on the Credits window, then press Escape — it closes.
- [x] The × button still closes it, and it still cannot be minimised.

### Still unconfirmed — needs the reporter's exact sequence

Two reported defects could not be reproduced. Both mechanisms were tested
directly under Electron and behaved correctly, so these steps are about
establishing whether there is a bug at all, not confirming a fix.

- [x] **Live theme change.** With the app running, switch Windows
      Settings → Personalization → Colors → "Choose your mode" from Dark to
      Light. The app follows **without a restart**. Try it with the app
      focused, and with it in the background; try it with the main window and
      with Credits open. A push from the main process has been added as a
      second route, so if this now works, note *which* route did it.
- [x] **Escape on Credits.** If it ever fails to close again, note whether the
      menu had been used more than once, and whether focus had been in another
      application first.

---

## 2.0.0-alpha.4 — pipelines removed, window minimum raised

> **Status: PASSED 2026-09-02.** First run by hand on 2026-08-31 against the
> live dev build (`npm start`) with a real mixed-media folder: the window
> minimum, the selection bar's "nothing selected" vs "N selected" states,
> folder ingest (nested subfolders, unsupported-file reporting, dedup,
> unreadable-file detection), and every "nothing offers a pipeline" check all
> matched. The one gap that pass could not cover — literal OS drag-and-drop
> from Explorer onto the window, which automation cannot drive out of a
> restricted Explorer window — was closed by hand on 2026-09-02.

Two changes, both subtractive.

**Pipelines are gone.** The feature was out of proportion to what this app is
for: a node editor is a large, fiddly thing to learn in order to do something
the advanced options dialog already does per file, and in use it proved
unintuitive. Everything has been removed — the editor, the Manual settings /
Pipeline chooser in the advanced options dialog, the graph model and compiler,
the IPC channels and the stored pipelines. Joining several files into one is
still wanted and is tracked separately; it was never going to be built on this.

**The window will no longer shrink to a size that breaks it.** The old minimum
of 720×560 let the selection bar run past the right edge and clip its own
buttons.

So most of this section is checking that removing something did not take
anything else with it.

### The window minimum

- [x] The window will not resize below **880×600** in either direction.
- [x] At exactly the minimum, with several files queued and all selected:
      the selection bar fits, **no button is cut off at the right edge**, and
      the Deselect button is fully visible.
- [x] At the minimum the footer still shows the summary, the progress bar and
      all three buttons without overlap.
- [x] At the minimum at least one full row of cards is visible in the grid.
- [x] Collapse the rail at the minimum size — nothing reflows badly.
- [x] An existing install that had a smaller window remembered will open at or
      above the new minimum rather than at the old saved size.

### Nothing offers a pipeline any more

- [x] The rail shows **Files** only. There is no Pipelines item.
- [x] Open **Advanced options** on a card. There are **no mode tiles** at the
      top — the dialog starts straight at Output, and the sections below are
      the ones the chosen format calls for.
- [x] There is no "Use pipeline" dropdown and no link to any editor anywhere.
- [x] No card ever reads "Choose a pipeline" or "Pipeline missing".
- [x] Every card with a format reads **Ready**.
- [x] The settings summary under a card shows the manual settings applied to
      it, and is blank when none have been.

### An existing install that had pipelines saved

Worth doing on a profile that ran alpha.4's first build, if you still have one:

- [x] The app opens normally with no error.
- [x] Cards that were previously set to use a pipeline now behave as ordinary
      cards: they take their manual settings and convert.
- [x] Nothing in the interface refers to the pipelines that were saved.

### The rail still works with one destination

- [x] Clicking **Files** when already on Files does nothing awkward.
- [x] Collapse and expand still work, and the choice survives a restart.
- [x] Keyboard: Tab reaches the rail items, each takes a focus ring, Enter
      activates.

### Drag and drop actually works  *(it did not)*

Dropping files on the window has been broken since the 2.0 rewrite and nobody
caught it, because the drop steps live in the alpha.1 section and that section
has never been run. Every drop threw before it reached the queue. Use the
buttons and this looks fine; only dropping is affected.

- [x] Drag **one file** from Explorer onto the window — a card appears.
- [x] Drag **several files at once** — a card appears for each.
- [x] Drag a **folder** — its contents are scanned in, subfolders included.
- [x] Drag a **mixture** of files and folders together.
- [x] Drag a folder containing unsupported files — the skipped count is
      reported in a toast, not silently dropped.
- [x] Drop the **same file twice** — it is not duplicated.
- [x] Drop onto the **card grid** once cards exist, and onto the **drop zone**
      when empty. Both work.
- [x] Drop onto the **navigation rail** — it still queues the file rather than
      doing nothing.
- [x] Drop something with no file behind it — an image dragged out of a browser,
      or selected text. Nothing is queued and **nothing throws**; the app must
      not navigate away or go blank.
- [x] With DevTools open, drop a file and confirm **no console error**.

### The selection bar only offers what applies

- [x] With cards queued and **nothing selected**: the bar shows the
      **Select all** checkbox, **"Convert all to"** and its format dropdown.
      **Bulk edit, Remove and Deselect are all absent.**
- [x] The two-click flow still works from that state: pick one format, press
      Convert. *(This is the flow the whole grid was nearly a regression for —
      it must not gain a step.)*
- [x] Select one card: **Bulk edit**, **Remove** and **Deselect** appear, and
      the labels change to "1 selected" / "Convert selected to".
- [x] Deselect everything again: those three disappear and the labels revert.
- [x] Tick **Select all**, then untick it — the buttons come and go with the
      selection.
- [x] The bar itself is gone entirely when there are no cards at all.

### Everything else still behaves

This is the regression sweep — all of it worked in alpha.3 and must still:

- [x] Drop files and folders; unsupported files are reported, not discarded.
- [x] Selection: click, ctrl+click, shift+click, Ctrl+A, Escape, Delete.
- [x] The two-click flow: drop a folder, pick one format in the bulk bar,
      Convert.
- [x] Per-card format dropdowns, and clearing one back to "Choose format…".
- [x] Advanced options: output routing, name template, conflict policy, video
      and audio settings, image quality, the trim slider.
- [x] The codec you choose is the codec you get, and it survives Apply and
      reopening. *(The alpha.3 fix — it lived next to the removed code.)*
- [x] The live command preview updates as you change settings.
- [x] Convert several files at once; per-card progress and per-card cancel.
- [x] A failing file marks its own card and the queue carries on.
- [x] "Apply to all remaining files" on an output conflict.
- [x] Convert does not re-run already-finished cards.
- [x] Toasts, Credits, F12 Developer Tools, and both themes.

---

## 2.0.0-alpha.4 — cross-kind conversions

> **Status: PASSED 2026-08-31.** Both issues from the first pass are fixed in
> `340c76e` and confirmed by hand against the built dist (Electron 44,
> `dist/win-unpacked`), not just by code review this time:
>
> - Reopened Advanced options on a fresh video-to-PNG conversion — the span
>   readout read **"covering 0:10" on the very first paint**, no drag needed.
> - Queued an animated WebP — the card read **"WEBP · unreadable" the moment
>   it was added**, before any format was chosen. Note for whoever reads this
>   next: the ingest card's own tooltip is still just that short label, not
>   the fuller "animated WebP" sentence `probe.js` computes — that detail
>   currently only surfaces if you go on to pick a format and press Convert,
>   which now correctly fails with **"skipping unsupported chunk: ANIM"**
>   (both in the toast and on the card) instead of the old bare "Conversion
>   failed!". Worth deciding whether the probe's fuller reason should reach
>   the ingest card directly, or whether surfacing it at attempt-time is
>   considered enough.
>
> `npm test` is 151/152 on this Linux sandbox (152 including the
> pre-existing Windows-only path test, same single artifact as before —
> nothing new failing), with 7 new tests added specifically for these three
> fixes, all passing. A normal conversion (clip.mp4 → 300 PNG frames) still
> ran clean on the rebuilt Electron 44 binary.
>
> <details>
> <summary>First pass (2026-08-31, superseded by the fix above)</summary>
>
> Run by hand against the live dev build with a real video, audio file, and a
> spread of still/animated GIF/WebP/PNG sources. Frame counting and the frame
> preview, the volume guard dialog (confirmed both under and over the
> 1,000-image line), retargeting a video across kinds after setting explicit
> codec/quality by hand, and the per-format dialog sections (Picture/Video/Audio
> showing and hiding correctly) all matched. Two real problems:
>
> 1. **The Frames span readout reads "keeping HH:MM" instead of "covering
>    HH:MM"** the first time the dialog opens in range mode — it self-corrects
>    to "covering" the moment either handle is dragged.
> 2. **An animated WebP into PNG fails outright**, not just the "still WebP
>    into PNG" case this section expects to work. The bundled ffmpeg's WebP
>    decoder skips the `ANIM`/`ANMF` chunks that carry the animation and reports
>    "image data not found" — a real limitation of this particular
>    ffmpeg-static build's WebP support, not a bug in this app's job
>    composition. Separately, the card only ever shows a bare "Conversion
>    failed!" for this failure, with none of the real ffmpeg reason surfaced.
>
> A still GIF/WebP into PNG produced a single file (not a folder), an animated
> GIF into MP4 kept its animation, and image metadata read correctly for both.
> Audio extraction's stream-copy rule (offered only when the source audio
> already matches) wasn't re-driven by hand here — it's covered by the
> automated suite rather than this pass.
> </details>

Converting between *kinds* — a video into audio, a video into stills, a GIF into
a video — has been offered in the format dropdown since the card grid landed.
What it did once you chose it was another matter. The queue described this item
as "surface the cross-kind conversions"; they were already surfaced, and quietly
wrong.

What changed, and so what to poke at:

- **Choosing which frames.** A conversion that produces stills now has a
  **Frames** section instead of Trim: a span with a preview of the frame at each
  end, a choice between every frame in that span and a single one, and a running
  count of the images it will write.
- **An animated GIF into MP4 keeps its animation.** It used to be treated as one
  still and looped for five seconds.
- **A still WebP into PNG makes one file.** It used to make a *folder* holding
  one frame.
- **Retargeting across kinds no longer fails** on settings chosen for the old
  target.
- A picture target no longer asks for a video codec, bitrate or encoder preset.

### Frames: choosing which ones

- [x] Queue a video of a minute or so and set its format to **PNG**.
- [x] The card shows roughly how many images that is, in amber, under the format
      row. Click that line — **Advanced options opens.**
- [x] The section is headed **Frames**, not Trim, and offers **Every frame in
      the range** / **A single frame**.
- [x] A preview of the actual frame appears at each end of the span, with its
      timestamp beneath. **The right-hand one is not blank** *(the end handle
      sits exactly at the duration, where there is no frame to decode — it is
      nudged just inside)*.
- [x] Drag either handle: the previews follow, the timestamps update, and the
      image count changes with them.
- [x] Drag quickly back and forth, then stop. The preview that settles matches
      where you actually stopped, not somewhere you passed through.
- [x] The readout says **covering** a span, not "keeping" one.
- [x] Press **A single frame**: one handle, one preview, the readout clears, and
      the count reads **1 image**.
- [x] Apply, and the card now reads **1 image**.
- [x] Reopen the dialog — it is still on **A single frame**.
- [x] Convert. Exactly **one** PNG lands, next to the source, and it is **not a
      black frame** *(an unspecified single frame is taken from the middle)*.
- [x] Set a narrow range and **Every frame in the range**, convert, and count the
      files. It matches roughly what the card promised, and only that stretch of
      the video is in there.
- [x] The files are named `frame_000001.png` upwards and **sort in capture
      order** in Explorer.

### The volume guard

- [x] With a target of PNG over a long video, press **Convert**. A dialog says
      about how many images this writes.
- [x] **Cancel** — nothing converts, the card stays Ready.
- [x] Confirm — it runs.
- [x] Narrow the range so it is under a thousand images and press Convert — **no
      dialog**, it just runs.
- [x] Convert a single frame, or anything that is not a frame export — no dialog.

### Conversions that used to be wrong

- [x] **An animated GIF to MP4.** The result *plays the animation* and is about
      as long as the GIF. It must not be a single frozen frame held for five
      seconds.
- [x] **A still WebP or GIF to PNG.** One file appears. **Not a folder.**
- [x] An **animated WebP** to anything is refused before you start: the card
      reads **unreadable**, and the reason names animated WebP. *(This is a
      limitation of the bundled FFmpeg 6.1.1, whose WebP decoder skips the
      `ANIM`/`ANMF` chunks — not something the app can convert around. An
      earlier version of this checklist wrongly said it should work.)*
- [x] **A video to MP3.** Plays, right length, no video stream.
- [x] **A video to GIF.** Still animated, still good colours.
- [x] **A still image to MP4.** A short clip holding that picture.

### Retargeting across kinds

- [x] Queue a video, open Advanced options, set a codec and a quality
      deliberately, Apply.
- [x] Now change that card's format to **PNG** and convert. It works. *(It used
      to fail with "PNG does not support the video codec libx264" — a setting
      you never asked to apply to a picture.)*
- [x] Changing between two formats of the **same** kind — MP4 to MKV — **keeps**
      your settings.

### The dialog suits the conversion

- [x] Target **PNG**: the section is headed **Picture** and offers only Resize
      and Frame rate. **No Stream, Codec, Quality or Encoder preset.**
- [x] Target **MP4**: headed **Video**, all of them present.
- [x] Target **MP3** from a video: no video section at all, no Resize.
- [x] An **image source into MP4**: no Audio section — a picture has none.
- [x] **Stream copy** is offered for MP4 to MKV.
- [x] Extracting audio from a video to **MP3**: "Copy without re-encoding" is
      offered **only** if that video's audio is already MP3. From a normal
      AAC-carrying MP4 it must be absent. *(It used to always be offered and
      then fail inside ffmpeg.)*
- [x] Extracting to **M4A** from an AAC video does offer it, and copying works.

### Metadata reads correctly for images

The probe's still-vs-moving test was inverted, so this is worth a look:

- [x] An **animated GIF** card shows its dimensions.
- [x] A **still PNG or WebP** card shows its type without claiming a frame rate.
- [x] A video card is unchanged — resolution, duration, codec, size.
- [x] A corrupt file still settles on "unreadable".

### Nothing else regressed

- [x] Drag and drop, folder ingest, selection, the two-click flow.
- [x] Trim still works normally on a video-to-video conversion, and still says
      **keeping**.
- [x] The command preview updates as you change anything.
- [x] Convert several files of mixed kinds at once.
- [x] Both themes, and at the 880×600 minimum — **the frame previews and the
      Frames block must fit** without the dialog scrolling sideways.

---

## 2.0.0-alpha.4 — Electron 44

> **Status: PASSED 2026-09-02.** Run against the clean 2026-09-02 installer.
> Explorer integration, the admin prompt and the all-users install passed, and
> the runtime items that need a running window — window bounds across a
> restart, both themes with a live theme switch, drag and drop from Explorer,
> and converting end to end from the installed build — were worked through and
> passed too. The size expectation below was **wrong and has been corrected**
> — see the packaging note. `resources/ffmpeg/` in the fresh build carries
> both `ffmpeg.exe` and `ffprobe.exe`.

> ### Packaging: what sits in the project folder ships
>
> The 2026-08-31 alpha.4 build was **polluted**. `electron-builder` has no
> `files` allowlist in `package.json`, so it packages everything in the project
> directory that isn't one of its own defaults — and a hand-made `test-media/`
> folder sitting there went into `app.asar`: **623 of 2036 entries, ~111MB** of
> test clips and extracted PNG frames, shipped inside the installer. `.gitignore`
> does not help; electron-builder does not read it.
>
> Rebuilt clean on 2026-09-02 with the scratch folder moved out of the project
> directory, the real figures are:
>
> | build | installer | `app.asar` |
> |---|---|---|
> | alpha.3 (Electron 41, clean) | 241.2 MiB | — |
> | alpha.4 2026-08-31 (polluted) | 307.5 MiB | 131.6 MB |
> | alpha.4 2026-09-02 (clean) | **252.0 MiB** | **16.5 MB** |
>
> So Electron 41 → 44 costs **+10.8 MiB (+4.5%)**, not the ~66MB the earlier
> figure implied. Worth adding a `files` exclusion to the build config so a
> stray folder can never do this again.

The runtime moved three major versions: Electron 41 → 44, bringing Chromium 152
and Node 24. **No application code changed for it.** It was taken only after
driving the real app against the things a major bump actually threatens, all of
which passed — but automation cannot judge how it feels, and a runtime change
can affect anything.

- [x] The app starts, and **Menu → About / Credits** shows the right version.
- [x] Window position and size are still remembered across a restart.
- [x] Drag and drop from Explorer still queues files. *(This crosses the context
      bridge through `webUtils`, which is exactly the sort of API a major bump
      moves.)* *(Will, 2026-09-02 — the first time this has been exercised by
      hand rather than through Add Folder.)*
- [x] Frame previews still appear in the Frames section.
- [x] Both themes, and a live Windows theme switch while running.
- [x] Explorer integration: right-click a media file → the app opens with it
      queued. Double-click an associated file. *(Will, 2026-09-02.)*
- [x] The installer runs, asks for admin, and installs for all users.
      *(Will, 2026-09-02.)*
- [x] **The installer is about 252 MiB, up from 241 MiB on alpha.3** — a +10.8
      MiB, +4.5% cost for Electron 44. *(Corrected 2026-09-02: this line
      previously read "about 308MB, up from 242MB", which was measured against
      a build carrying ~111MB of stray test media. See the packaging note
      above.)*
- [x] Convert something end to end from the **installed** build, not just the
      dev one. *(Will, 2026-09-02 — reinstalled from the clean 2026-09-02
      installer first; the copy installed before that was the polluted 08-31
      build.)*

---

## 2.0.0-alpha.4 — fixes from the cross-kind test pass

> **Status: PASSED 2026-09-02.** Written 2026-08-31 alongside the fixes, then
> run by hand and passed: the span readout is right on first open, a failed
> conversion names its cause, and an animated WebP is refused at probe time.

Two issues came back from testing the frames work. Both are fixed; a third,
found while fixing them, is fixed too.

### The span readout names what it is doing

- [x] Queue a video, set it to **PNG**, open **Advanced options**. Without
      touching anything, the readout under the slider reads **"covering 0:10"**.
      *(It used to say "keeping" until you dragged a handle — the slider painted
      before the section knew it was choosing frames.)*
- [x] Drag a handle: still "covering".
- [x] Switch to **A single frame**: the readout clears — one frame is a position,
      not a span.
- [x] Now change the format to **MP4** in the same dialog. The section is headed
      **Trim** again and reads **"keeping …"**. *(Found while fixing the above:
      the stale single-frame choice blanked it, and would also have silently
      thrown away the trim's end.)*
- [x] Set a trim, Apply, convert — the output really is trimmed.
- [x] Switch back to PNG in the same dialog: it remembers you had chosen
      **A single frame**.

### A failed conversion says why

- [x] Convert something that will fail — an animated WebP is the easy one, or
      rename a `.txt` to `.mp4`.
- [x] The card shows **a real reason**, not "Conversion failed!". For animated
      WebP it names the unsupported chunk.
- [x] The reason has no `[component @ 0x7f…]` prefix on it.
- [x] Hover or select the message — it is readable and can be copied.
- [x] A batch where one file fails still converts the rest, and only the failed
      card carries the message.

### Animated WebP is refused up front

- [x] Drop an **animated WebP**. The card's metadata line reads
      **"WEBP · unreadable"** as soon as the probe returns — before any format
      is chosen.
- [x] Open Advanced options on it: nothing crashes, and there is no duration to
      trim.
- [x] A **still** WebP is unaffected: it shows its type and converts normally.
- [x] An animated **GIF** is unaffected: dimensions shown, converts, keeps its
      animation.
- [x] An **MP3 with embedded cover art** is unaffected — still audio, no
      resolution badge, converts normally. *(The check looks for a picture
      stream with no dimensions; cover art has them.)*

---

## 2.0.0-alpha.5 — the conflict prompt and the pool

> **Status: not started.** Written 2026-09-02 alongside the fix.

Three defects on the "If it already exists → **Ask me**" path, all with one
cause: a job waiting on the prompt was in neither the running set nor the queue,
so the pool could not see it. It looked idle, it looked empty, and it looked
like nothing had been cancelled.

**The one that matters is the first**, because it is the same symptom a tester
reported against alpha.1 and which `4f1d06b` was supposed to have fixed —
"Apply to all remaining files" being ignored. That fix was real; this is a
second, independent route to the same behaviour, and it survived because the
existing checklist case below happens to use the one ordering that works.

`npm test` is 155 passing. The three defects now have behavioural tests in
`test/runner.test.js` that drive a real `JobRunner`; they were confirmed to fail
against the old code before the fix went in. Two tests that read `main.js` as
text were deleted rather than kept — one of them matched the very line causing
the first defect and read it as proof the code was correct.

### "Apply to all remaining" survives a staggered batch  *(it did not)*

The existing case at **"Apply to all remaining files" actually applies** uses
six similar files, which all finish probing before you can answer the first
dialog. That is the ordering that passes. This one is deliberately the other
ordering.

- [ ] Put **one very large video** and **five small files** in a folder, and
      convert them all once so every output exists.
- [ ] Set concurrency to **2 or more** (Menu → it follows the CPU count by
      default; any machine with 4+ cores is fine).
- [ ] Queue all six again and press Convert. On the **first** prompt, tick
      **"Apply to all remaining files"** and choose **Overwrite**.
- [ ] **Exactly one dialog appears.** Before the fix you would get up to four
      more, because the run was declared finished while you were still reading
      the first one, which threw the answer away.
- [ ] All six convert, and the toast at the end reports six.
- [ ] Repeat choosing **Save as New** — same thing, one dialog, and every output
      lands as `name (1).ext`.

### Cancel All while a prompt is open

- [ ] Queue several colliding files, press Convert, and wait for the first
      prompt.
- [ ] With the dialog still open, press **Cancel All** behind it. *(You may need
      to move the dialog; it is modal to the window.)*
- [ ] Answer the dialog with **Overwrite**.
- [ ] **Nothing converts.** No file on disk is modified — check the timestamp of
      the output that was about to be overwritten. Previously ffmpeg ran to
      completion first and the job was only marked cancelled afterwards, so the
      file *was* overwritten.
- [ ] Every card reads Cancelled, and the app returns to idle.

### The queue keeps moving after a prompt

The fix makes a waiting job hold a slot. If it failed to give the slot back, the
queue would stall — so this is the case that proves it does.

- [ ] Queue **three** colliding files with concurrency set to **1**.
- [ ] Answer the first prompt with **Cancel** (the button, not Cancel All).
- [ ] The **second** prompt appears. Answer it **Cancel** too.
- [ ] The **third** prompt appears. Answer **Overwrite** — it converts.
- [ ] The app returns to idle with two cancelled and one done. Nothing is left
      spinning, and the Convert button is no longer lit.
- [ ] Repeat, answering **Skip** each time instead: same, three cards settle.

### Concurrency still means something

- [ ] Queue **eight** colliding files with concurrency **2**.
- [ ] Tick "Apply to all remaining" on the first prompt and choose Overwrite.
- [ ] Watch Task Manager: **at most two `ffmpeg.exe` at a time.** Before the fix
      all eight started at once, because a job at the prompt held no slot and
      the pool believed it was empty.

### Nothing else about conflicts changed

- [ ] **Overwrite**, **Save as a new file** and **Skip the file** chosen in
      Advanced options still behave exactly as before, with no prompt.
- [ ] With no collision at all, no dialog ever appears.
- [ ] The **Cancel** button on a single running card still cancels just that one.

---

## 2.0.0-alpha.5 — what a folder ingest skipped, and why

> **Status: not started.** Written 2026-09-02 alongside the change.

Unsupported files were dropped with only a count — "skipped 2 unsupported
files" — which tells you something went missing, but not what, and not whether
it was the app's doing or yours. The scanner now records a reason per file and
the toast can list them.

Two reporting bugs went with it. A scan that both truncated *and* skipped
reported only the truncation, because the branches were an else-if chain. And
adding files that were all already in the list said **nothing at all**, which
reads exactly like a drop that never registered.

There were also two different "skipped" toasts — one from the scanner, one from
the queue's own format check — which could both fire for a single folder and
word the same thing differently. There is now one.

**Test media:** a folder holding a few media files, at least one nested
subfolder, two or three `.txt` files, and one file with a media extension that
is actually junk (rename a `.txt` to `.mp4`).

### The skipped list

- [ ] Drop a folder containing media **and** two or three `.txt` files.
- [ ] The toast reads **"Added N files, skipped 3."** and carries a **Show
      them** button.
- [ ] It does **not** disappear on its own — a toast with an action stays until
      it is dismissed.
- [ ] Press **Show them**: a list appears inside the toast, one row per skipped
      file, each reading *filename — not a supported format*.
- [ ] The button now reads **Hide**. Press it — the list collapses and the
      button reads Show them again.
- [ ] **Select a filename in the list and copy it.** It highlights. *(Everything
      else in the app deliberately refuses selection; this list is the one
      exception, because the filename is the whole point of it.)*
- [ ] The × still dismisses the whole toast.
- [ ] Drop a folder with **more than 50** unsupported files: the list stops at
      50 and its last row reads "and N more files".

### The cases that used to say the wrong thing

- [ ] Drop the same folder **twice**. The second time the toast reads **"Those
      files are already in the list."** *(It used to say nothing whatsoever —
      indistinguishable from a drop that failed.)*
- [ ] Drop a single already-queued file: **"That file is already in the list."**
      — singular.
- [ ] Drop a folder holding only `.txt` files: **"No supported media found
      there."**, with Show them still listing them.
- [ ] Add a folder large enough to truncate **that also contains junk files**.
      The toast mentions **both** the skip and the stop, in one sentence.
      *(Truncation used to swallow the skipped count entirely.)*

### One message, not two

- [ ] Put a `.txt` **and** a renamed junk `.mp4` in a folder, and drop it. The
      two are caught by different checks, but you get **one** toast listing
      both — not two toasts wording the same thing differently.
- [ ] Use **Add Files** and pick a `.txt` directly: same single toast, same
      wording.

### Nothing else about ingest changed

- [ ] A normal folder of supported media: **"Added N files."**, no action
      button, and it fades on its own after a few seconds.
- [ ] Nested subfolders are still walked.
- [ ] An unreadable file still gets its own red "Could not read …" toast.
- [ ] Drag and drop, **Add Files**, **Add Folder** and **Menu → Open Folder**
      all behave the same as each other.
- [ ] Check the toast in **both themes** — the list's inset background and the
      underlined action button must be readable on all four toast colours
      (info, success, warning, danger).

---

## 2.0.0-alpha.5 — folder options

> **Status: not started.** Written 2026-09-02 alongside the change.

The scanner has always supported a recursion switch, extension filters and a
symlink switch. None of it was reachable — `ingestPaths` passed an empty options
object. Three of them are now on a popover beside Add Folder.

The depth limit and the file cap are deliberately **not** offered. They are
safety rails rather than preferences, and the toast that fires when one bites
explains itself better at that moment than a number in a popover would.

**Add Folder itself must still open the folder picker on a single click.** The
options have their own caret. If adding a folder ever costs two clicks, this is
wrong however good it looks.

### The popover

- [ ] The caret sits flush against **Add Folder** and the pair reads as one
      control, in **both themes**.
- [ ] Click **Add Folder** — the folder picker opens immediately. No menu, no
      extra step.
- [ ] Click the **caret** — the popover opens. Add Folder does not.
- [ ] It is fully on screen, not clipped by the window edge, at the **880px
      minimum width** as well as maximised.
- [ ] Click anywhere outside it — it closes. Click inside it — it stays open.
- [ ] Press **Escape** — it closes. *(Escape must not also clear the card
      selection behind it.)*
- [ ] There is no Save button, and none is wanted.

### The options do something

Use a folder holding audio, video, images, at least one nested subfolder, and
two or three `.txt` files.

- [ ] All three types ticked, **Include subfolders** on: everything supported is
      added, including from the nested folder.
- [ ] Untick **Images**, drop the folder again: images are **not** added, and
      the toast's **Show them** list gives their reason as **"turned off in
      folder options"** — not "not a supported format". The two are different
      and must read differently.
- [ ] Untick **Include subfolders**: only the top level is added.
- [ ] Untick two of the three types, then try to untick the **last** one. It
      refuses and stays ticked. *(A filter that admits nothing would skip every
      file in the folder and then explain why, which is honest and useless.)*
- [ ] The options apply to a **dropped** folder too, not only the button — a
      drop can contain folders, and having the setting cover one route but not
      the other would be baffling.
- [ ] With Images off, dropping a **single .jpg** skips it and says why. Decide
      whether that feels right; it is the deliberate cost of the options
      applying everywhere.

### They are remembered

- [ ] Change the options, close the app, reopen it: the popover shows what you
      left it at.
- [ ] The first launch after installing has all three types ticked, subfolders
      on, shortcuts off.

### The same file is not queued twice

Fixed alongside this: the queue compared raw path strings, so one file reached
two ways could produce two cards.

- [ ] Add a folder, then drag **one file from inside it** onto the window. The
      toast says **"That file is already in the list."** and **no second card
      appears**.
- [ ] The card count in the footer matches the number of cards on screen.
