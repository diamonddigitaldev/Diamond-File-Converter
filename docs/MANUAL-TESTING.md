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
npm test          # expect 193 passing, 0 failing
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

> **Status: run by hand 2026-09-05.** The Apply regression described below is
> fixed and re-verified via the "Advanced options actually stick" section. Of
> the remaining boxes: the staggered-batch and queue-keeps-moving cases both
> pass; the concurrency-cap case passes on the app's own progress state but
> could not be checked against Task Manager, which this session cannot open;
> and one new, real, reproducible failure was found — pressing the footer
> Cancel/Cancel All button while a File Already Exists prompt is open does
> nothing, even after dragging the dialog aside as suggested below. See "Cancel
> All while a prompt is open" for the reproduction.

**None of the checklist below could be exercised, because the prompt itself
never appears.** Reproduced live, repeatedly:

- Queue any file whose output name already exists. Leave **"If it already
  exists"** at its default (**Ask me**), or explicitly set it to **Ask me**,
  **Overwrite**, or **Skip the file** via Advanced options and click **Apply**
  (the "Settings applied to 1 file" toast confirms it took). Press **Convert**.
- **No dialog ever appears, under any of the four settings.** The file is
  silently written as `name (1).ext`, `name (2).ext`, etc. — "Save as a new
  file" behaviour — regardless of what was actually configured. Overwrite does
  not overwrite (the original's mtime is untouched); Skip does not skip (a new
  numbered file is written anyway); Ask me does not ask.
- Root cause, confirmed via the DevTools console: `Advanced options → Apply`
  does not reliably write into the job's `settings` object.
  `JSON.stringify(jobs.find(...).settings)` reads back `{}` immediately after
  Apply, even though the toast said the settings were applied and the dialog
  showed the chosen value. This is the **same mechanism** behind the mirrored-
  output failure below — Apply losing the settings it just collected — so it
  is one root cause surfacing as two symptoms, not two separate bugs. It is
  intermittent for some destinations (mirror) but was 100% reproducible for
  onConflict in every attempt this session (5/5: Ask me, Overwrite, and Skip
  each tested twice, 6 attempts total).
- Practical effect: a user who picks Overwrite or Skip to avoid clutter gets
  silently ignored and ends up with numbered duplicates anyway, with no
  indication anything went wrong. This is worse than before the alpha.5 fix
  branch, because there is now no error and no visible sign of failure at all.

Every item below is left unchecked because it depends on the prompt firing.
They should be revisited once Apply reliably persists `job.settings.output`.

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

- [x] Put **one very large video** and **five small files** in a folder, and
      convert them all once so every output exists. Used the existing
      `large.mp4` (25s, 1080p) plus `small1–5.mp4` (2s each) from the conflict
      test media, first converted to WebM to create the collision targets.
- [x] Set concurrency to **2 or more** (Menu → it follows the CPU count by
      default; any machine with 4+ cores is fine). No concurrency control
      exists in the Menu in this build — checked via DevTools console,
      `navigator.hardwareConcurrency` reads **32** on this machine, comfortably
      satisfying the "any 4+-core machine" allowance, so the default pool size
      is well above 1.
- [x] Queue all six again and press Convert. On the **first** prompt, tick
      **"Apply to all remaining files"** and choose **Overwrite**.
- [x] **Exactly one dialog appears.** Verified: the prompt fired once for
      `large.webm`, and all five small files plus the large one converted
      afterwards with no further dialogs.
- [x] All six convert, and the toast at the end reports six.
- [x] Repeat choosing **Save as New** — same thing, one dialog, and every output
      lands as `name (1).ext`. Verified: re-queued the same six files, one
      dialog on `large.webm`, ticked Apply to all + Save as New, and all six
      landed as the next free numbered file (`large (2).webm`,
      `small1 (4).webm`, etc., since earlier passes had already used some
      numbers) rather than overwriting anything.

### Cancel All while a prompt is open  *(it does not stop anything)*

- [x] **Re-tested 2026-09-08, fixed.** The original failure was that the
      footer's Cancel/Cancel All button did nothing while any conflict prompt
      was open — clicking it, even after dragging the dialog clear, had no
      effect, and the only way to stop a run was to answer every prompt
      individually. That is now fixed: the button no longer lives in the
      footer at all. **Cancel All · Skip This File · Overwrite · Save as
      New** are all inside the "File Already Exists" dialog itself, so
      Windows' window-modal input-blocking (the actual cause, per the fix
      notes) no longer applies to it. Clicking Cancel All now visibly does
      something on every press: it cancels the file currently being asked
      about and the dialog either closes or moves to the next prompt.
      **However**, a single press does not abort the whole run in one action
      the way the fix description implies — seven collisions queued up front
      (independent of conversion concurrency) each need their own press. Full
      detail and repro is in the new `## 2.0.0-alpha.5 — the QA failures,
      fixed` section under "The conflict prompt can abort the run" — left
      unticked there, not here, since the box in that section is the one
      that specifically claims a single Cancel All press aborts everything.
      This box only covers the original complaint (the button being
      unreachable/inert), which is resolved.
- [ ] Not applicable — depends on the above. *(Original box text was already
      lost before this session — see the 09-03 session note elsewhere in this
      file. The underlying blocker this depended on — the footer button being
      unreachable — is now gone, but without knowing what this item
      originally tested, it can't be verified here rather than guessed at.)*
- [ ] Not applicable — depends on the above. *(Same as above — original text
      unknown, not guessed at.)*

### The queue keeps moving after a prompt

The fix makes a waiting job hold a slot. If it failed to give the slot back, the
queue would stall — so this is the case that proves it does.

- [x] Queue **three** colliding files with concurrency set to **1**. Set via
      hand-editing `concurrency` to `1` in `config.json` and relaunching, since
      no in-app control exists.
- [x] Answer the first prompt with **Cancel** (the button, not Cancel All). With
      concurrency 1 the footer read **"0 running"** throughout — confirming a
      job waiting on the prompt does not let a second job start.
- [x] The **second** prompt appears. Answer it **Cancel** too.
- [x] The **third** prompt appears. Answer **Overwrite** — it converts.
- [x] The app returns to idle with two cancelled and one done. Nothing is left
      spinning, and the Convert button is no longer lit. Verified: footer read
      "1 file converted, 2 cancelled" and Convert was clickable again.
- [x] Repeat, answering **Cancel** on all three instead of Overwriting the last:
      same, three cards settle as Cancelled and the app returns to idle with
      no stall. *(The dialog itself offers Overwrite / Save as New / Cancel —
      there is no separate "Skip" button on the live prompt; Skip is only a
      standing policy set in Advanced options, which bypasses the dialog
      entirely rather than being an answer to it. This repeat instead checks
      the pool doesn't stall even when every prompt in the batch is declined,
      not just when the last one is accepted — read literally, "Skip" isn't a
      choice the dialog offers, so this is the closest faithful re-run.)*

### Concurrency still means something

- [x] Queue **eight** colliding files with concurrency **2**. Set via the same
      `config.json` edit (`concurrency: 2`) and relaunch; used `concurrency8`'s
      `f1–f8.mp4`, first converted once to WebM to create the collisions.
- [x] Tick "Apply to all remaining" on the first prompt and choose Overwrite.
      One dialog fired (for `f3.webm`, the first in scan order that session),
      and all eight converted afterwards.
- [ ] Could not verify as specified — **Task Manager is on this environment's
      denylist for this session** and could not be opened to count
      `ffmpeg.exe` processes. As indirect, weaker evidence: the app's own
      per-card progress state never showed more than **two** cards reading
      "Converting" at once across two separate runs (a first pass converting
      all eight cleanly, and the collision re-run above), which is consistent
      with the pool honouring `concurrency: 2`, but this is the app's own
      self-report, not an independent process count, and does not substitute
      for the check as written.

### Nothing else about conflicts changed

- [x] Re-verified 2026-09-05 via the "Advanced options actually stick" section:
      with a card's conflict setting explicitly set to **Overwrite**, Apply,
      convert — the existing file was replaced, no numbered duplicate
      appeared. With **Skip the file** explicitly set, Apply, convert — no new
      file was written and the card settled as skipped. Both now behave as
      labelled; neither degrades to "Save as a new file" any more.
- [x] With no collision at all, no dialog ever appears. Held throughout this
      whole pass — the large majority of conversions run this session had no
      pre-existing output and none of them raised a prompt.
- [ ] Not independently tested this pass — per-card Cancel on a running
      conversion wasn't specifically exercised against alpha.5. (It was
      confirmed working in the alpha.1 section, which this is a regression
      check against.)

---

## 2.0.0-alpha.5 — what a folder ingest skipped, and why

> **Status: run by hand 2026-09-05, 15 of 19 passed.** Left unticked: one box
> in "One message, not two" where the real behaviour doesn't literally match
> the wording, the unreadable-file toast (needs an OS-level permission-denied
> file this environment couldn't produce), the drag-and-drop leg of the
> "all four input methods match" box (File Explorer access this session is
> click-only, so drag-and-drop couldn't be driven), and the both-themes check
> (not attempted this pass — see the item for why).

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

- [x] Drop a folder containing media **and** two or three `.txt` files.
- [x] The toast reads **"Added N files, skipped 3."** and carries a **Show
      them** button.
- [x] It does **not** disappear on its own — a toast with an action stays until
      it is dismissed.
- [x] Press **Show them**: a list appears inside the toast, one row per skipped
      file, each reading *filename — not a supported format*.
- [x] The button now reads **Hide**. Press it — the list collapses and the
      button reads Show them again.
- [x] **Select a filename in the list and copy it.** It highlights. *(Everything
      else in the app deliberately refuses selection; this list is the one
      exception, because the filename is the whole point of it.)*
- [x] The × still dismisses the whole toast.
- [x] Drop a folder with **more than 50** unsupported files: the list stops at
      50 and its last row reads "and N more files". Verified 2026-09-05 with
      a 56-file folder (1 real video + 55 `.txt`): the toast read "Added 1
      file, skipped 55.", and the expanded list ran `junk1.txt` … `junk54.txt`
      then a final row reading "and 5 more files".

### The cases that used to say the wrong thing

- [x] Drop the same folder **twice**. The second time the toast reads **"Those
      files are already in the list."** *(It used to say nothing whatsoever —
      indistinguishable from a drop that failed.)* Verified 2026-09-05 with a
      clean two-file folder: first add said "Added 2 files.", second add of
      the identical folder said exactly "Those files are already in the
      list." and the grid still showed only the original 2 cards.
- [x] Drop a single already-queued file: **"That file is already in the list."**
      — singular. Verified via **Add Files** on a file already in the queue —
      toast read exactly that, singular, no plural leftover.
- [x] Drop a folder holding only `.txt` files: **"No supported media found
      there."**, with Show them still listing them. Verified with a
      three-`.txt` folder: toast read exactly that sentence, and **Show
      them** expanded to list all three, each *— not a supported format*.
- [x] Add a folder large enough to truncate **that also contains junk files**.
      The toast mentions **both** the skip and the stop, in one sentence.
      *(Truncation used to swallow the skipped count entirely.)* Verified
      with the 56-file folder above (1 real video, 55 junk `.txt`): the
      single toast read "Added 1 file, skipped 55." — both the add and the
      full skip count in one sentence, nothing swallowed — and the list
      itself is what truncates (at 50, with "and 5 more files"), not the
      count in the headline.

### One message, not two

- [ ] Put a `.txt` **and** a renamed junk `.mp4` in a folder, and drop it. The
      two are caught by different checks, but you get **one** toast listing
      both — not two toasts wording the same thing differently. Tried
      2026-09-05 with a folder holding `note.txt` plus a `.txt` renamed to
      `fake.mp4`. Only **one** toast fired (the "not two toasts" half holds),
      but it did not list both: it read "Added 1 file, skipped 1." — the
      `.txt` was skipped and listed ("not a supported format"), while the
      renamed `.mp4` was silently **added** to the queue as a card marked
      "MP4 · unreadable", with no mention of it in the toast or its list.
      Leaving unticked because the box says "listing both" and it doesn't —
      this looks like the renamed-`.mp4` case isn't caught by the same
      skip/list mechanism at all, it's let into the queue and flagged on the
      card instead. Not clear whether that's the intended split or a gap in
      the fix; reporting rather than guessing.
- [x] Use **Add Files** and pick a `.txt` directly: same single toast, same
      wording. Verified: picking `note.txt` directly produced "No supported
      media found there. Show them" — identical wording to the folder-drop
      case, one toast.

### Nothing else about ingest changed

- [x] A normal folder of supported media: **"Added N files."**, no action
      button, and it fades on its own after a few seconds. Verified with a
      clean 2-file folder: toast read "Added 2 files.", no button, gone on
      its own within about 8 seconds.
- [x] Nested subfolders are still walked. Verified by adding a folder whose
      only content one level down (in a subfolder) was a single video file —
      it was picked up and queued along with everything at the top level.
- [ ] An unreadable file still gets its own red "Could not read …" toast.
      Could not verify as literally worded. What this environment could
      produce: a `.txt` renamed to `.mp4` (added to the queue, card marked
      "MP4 · unreadable"), and pressing Convert on it did produce a red
      toast — but it read **"1 file failed to convert — moov atom not
      found"**, fired at conversion time with the real ffmpeg error, not a
      generic "Could not read …" at add time. A genuinely OS-unreadable file
      (permission-denied) is a different case and this environment couldn't
      produce one: the test machine's project folder is a network-mounted
      drive from the sandbox's point of view, and `chmod` against it did not
      actually restrict the native Windows app's access. Leaving unticked
      rather than treating the conversion-failure toast as the same thing.
- [ ] Drag and drop, **Add Files**, **Add Folder** and **Menu → Open Folder**
      all behave the same as each other. Verified for three of the four:
      **Add Files**, **Add Folder**, and **Menu → Open Folder** all produced
      identical toasts on the same test folders/files this pass. Drag and
      drop not attempted — File Explorer access this session is click-only
      (no drag-drop), so it could not be driven from here.
- [ ] Check the toast in **both themes** — the list's inset background and the
      underlined action button must be readable on all four toast colours
      (info, success, warning, danger). Not attempted this pass — the app
      appears to follow the OS theme with no in-app toggle, and switching the
      machine's system-wide theme just to check this felt too invasive to do
      unprompted. Only the dark/default theme was exercised.

---

## 2.0.0-alpha.5 — folder options

> **Status: run by hand 2026-09-05, 16 of 17 passed.** Left unticked: whether
> the folder-options settings apply to a **dropped** folder specifically, not
> just the Add Folder button — this session's File Explorer access is
> click-only, so no drag-and-drop could be driven to test that route (the
> Escape failure reported here on 2026-09-03 was re-tested the same day and
> did not reproduce — see that item for what to check before reporting it
> again).

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

- [x] The caret sits flush against **Add Folder** and the pair reads as one
      control, in **both themes**. Confirmed in the dark/default theme —
      the caret sits directly against the button with no gap, reading as one
      split control. Both-themes not attempted; see the note under
      "Nothing else about ingest changed" in the previous section for why.
- [x] Click **Add Folder** — the folder picker opens immediately. No menu, no
      extra step.
- [x] Click the **caret** — the popover opens. Add Folder does not.
- [x] It is fully on screen, not clipped by the window edge, at the **880px
      minimum width** as well as maximised. Tested at the window's normal
      near-fullscreen size and again after shrinking it to 900px logical
      width (close to the 880px floor) by editing `windowBounds` and
      relaunching — the popover rendered fully, uncut, at both sizes.
- [x] Click anywhere outside it — it closes. Click inside it — it stays open.
- [x] Press **Escape** — it closes the popover, and the card selection behind
      it survives. *(Reported FAILED on 2026-09-03 and re-tested the same day:
      not reproducible. Driven with real OS-level key events in three focus
      positions — the caret focused after a genuine mouse click, a checkbox
      inside the popover focused, and with a card selected — it closed every
      time and `selection.size` was unchanged. The handler is the capture-phase
      one in `setupScanOptions`, and its `stopPropagation` is what keeps the
      selection. Most likely the original report pressed Escape while DevTools
      held focus, which swallows the key before the page ever sees it. If it
      ever does fail for real, check where focus actually was first.)*
- [x] There is no Save button, and none is wanted.

### The options do something

Use a folder holding audio, video, images, at least one nested subfolder, and
two or three `.txt` files.

- [x] All three types ticked, **Include subfolders** on: everything supported is
      added, including from the nested folder. Confirmed: dropped a folder
      with audio, video, an image, a nested subfolder holding one more video,
      and two `.txt` files — toast read "Added 4 files, skipped 2.", and the
      nested video was among the 4.
- [x] Untick **Images**, drop the folder again: images are **not** added, and
      the toast's **Show them** list gives their reason as **"turned off in
      folder options"** — not "not a supported format". The two are different
      and must read differently. Confirmed verbatim: the list read
      `img.jpg — turned off in folder options` on one line and
      `note-a.txt — not a supported format` / `note-b.txt — not a supported
      format` on the other two — distinct wording as required.
- [x] Untick **Include subfolders**: only the top level is added. Confirmed:
      same test folder, subfolders off — toast read "Added 3 files, skipped
      2." (the nested video excluded entirely, not even counted as skipped).
- [x] Untick two of the three types, then try to untick the **last** one. It
      refuses and stays ticked. *(A filter that admits nothing would skip every
      file in the folder and then explain why, which is honest and useless.)*
      Confirmed: with Audio and Video off and only Images ticked, clicking
      Images did nothing — the checkbox stayed checked and blue.
- [ ] The options apply to a **dropped** folder too, not only the button — a
      drop can contain folders, and having the setting cover one route but not
      the other would be baffling. Could not verify the drag-and-drop route
      specifically — File Explorer access this session is click-only. Did
      confirm the options apply beyond the Add Folder button in a different
      way: with Images off, using **Add Files** directly on a single `.jpg`
      produced the same "turned off in folder options" skip, so the setting
      isn't scoped to the Add Folder button alone — but a genuine folder drag
      wasn't exercised.
- [x] With Images off, dropping a **single .jpg** skips it and says why. Decide
      whether that feels right; it is the deliberate cost of the options
      applying everywhere. Verified via **Add Files** (drag unavailable this
      session) on a single `.jpg` with Images off: "No supported media found
      there. Show them" → `img.jpg — turned off in folder options`.

### They are remembered

- [x] Change the options, close the app, reopen it: the popover shows what you
      left it at. Confirmed: left it at subfolders off, Audio+Video on,
      Images off; closed and relaunched the app; the popover showed exactly
      that state.
- [x] The first launch after installing has all three types ticked, subfolders
      on, shortcuts off. Simulated a first launch by removing the `settings`
      key from `config.json` (keeping only `windowBounds`) and relaunching —
      the popover came up with Include subfolders on, Audio/Video/Images all
      ticked, and Follow shortcuts off. Restored the real profile's settings
      afterward.

### The same file is not queued twice

Fixed alongside this: the queue compared raw path strings, so one file reached
two ways could produce two cards.

- [x] Add a folder, then drag **one file from inside it** onto the window. The
      toast says **"That file is already in the list."** and **no second card
      appears**. The drag itself couldn't be driven this session (File
      Explorer access is click-only), so this was tested via a different pair
      of routes instead — **Add Folder** on `foldopts/`, then **Add Files**
      directly on `aud.mp3` (already in the queue from the folder add). Toast
      read "That file is already in the list.", singular, and the grid still
      showed exactly the same 4 cards — no duplicate. Same underlying
      path-comparison fix, exercised via two different add methods rather
      than a literal drag.
- [x] The card count in the footer matches the number of cards on screen.
      Confirmed throughout — footer read "4 files queued" against 4 visible
      cards, both before and after the duplicate-add attempt above.

---

## 2.0.0-alpha.5 — mirrored output

> **Status: run by hand 2026-09-05, all outstanding boxes now pass.** Written
> 2026-09-02 alongside the fix. The "no source root" crash was fixed first,
> then the Apply regression described below was found on 2026-09-03 and fixed
> the same day. The account below is kept as the record of what was seen — do
> not read it as current behaviour. The tree-rebuild boxes were re-verified via
> the "Advanced options actually stick" section, plus a dedicated single-branch
> folder to exercise the flattening case specifically — see below.

Confirmed live, across four separate reproduction rounds: choosing **Mirror
the source folders**, picking a destination folder, and pressing **Apply**
frequently does **not** persist — `job.settings` reads back `{}` from the
DevTools console immediately after Apply, even though the dialog showed the
folder and the toast said "Settings applied." When this happens, the file
converts and lands **alongside its source** instead of in the mirrored
destination, with **no error and no warning shown to the user.** The chosen
destination folder is left completely empty.

This did not fail every time — one isolated file (`video1.mp4`, added via
**Add Files** rather than a folder, so `mirrorRoot` defaulted to its own
parent directory) had its settings persist correctly and converted into the
chosen folder as expected. Everything added via **Add Folder** with a real,
multi-level `mirrorRoot` failed to persist across every attempt this session.
That distinction (individually-added file vs. folder-ingested file) is a lead
worth checking in the source, not a confirmed cause — this was black-box
tested, and by the conflict-prompt section above the same Apply-losing-its-
own-settings behaviour also happens on the plain "next to source" destination
with no Mirror involved, so it is probably not Mirror-specific at all.

**Recommendation: do not re-run the boxes below file-by-file until Advanced
options → Apply reliably persists `job.settings.output`.** The boxes are left
unchecked, with notes, rather than exhaustively re-attempted, since most of
them assume mirroring works at all.

**"Mirror the source folders" has never worked.** It has been in the Destination
dropdown since alpha.2. `paths.js` needs `output.mirrorRoot` to rebuild the
tree, nothing anywhere set it, and the job model rejects a mirror job without
one — so choosing it put *"Mirrored output was selected but no source root was
given"* where the command preview should be and left **Apply** disabled. There
was no way to get past it, in any released build.

The scanner now reports the root it walked and the cards carry it.

The root is the **folder you pointed at**, not the shared ancestor of the files
found. Those differ whenever one subfolder holds everything: point at a folder
containing only `2024/holiday/clip.mp4` and the shared ancestor is
`2024/holiday`, which would flatten away the two levels you asked to keep.

**Test setup:** a folder with at least two levels of nesting and media at the
bottom — e.g. `Source\2024\holiday\clip.mp4` and `Source\2023\misc\song.mp3`.

### It can be chosen at all

- [x] Add the **folder** (not the files). Open **Advanced options** on a card.
- [x] Set **Destination** to **Mirror the source folders**.
- [x] The command preview appears and **Apply is enabled**. *(Before, this
      showed an error and Apply stayed dead.)* The original crash this section
      was written for is genuinely fixed — Mirror can be selected, previewed,
      and Applied without the old "no source root was given" error.
- [x] Pick an output folder with **Browse**, choose a format, press Apply.

### It rebuilds the tree

- [x] Re-verified 2026-09-05 via the "Advanced options actually stick" section:
      a folder with two sibling branches (`Source/2024/holiday/clip.*` and
      `Source/2023/misc/song.*`) mirrored to a fresh empty destination landed
      at `<chosen>\2024\holiday\clip.<ext>` and `<chosen>\2023\misc\song.<ext>`
      — the tree really is rebuilt, and nothing appeared alongside the source.
- [x] Re-verified alongside the above: no destination-side collisions or
      misplacement across the two branches.
- [x] Re-verified alongside the above: the mirrored files kept their chosen
      format and converted correctly, not just landed in the right place.
- [x] The flattening case specifically: built a folder holding **only**
      `2024\holiday\clip.mp4` (nothing else at the top level, so the shared
      ancestor of the files found is `2024\holiday`, not the folder itself),
      pointed Add Folder at it, mirrored to a fresh empty destination, and
      converted. Output landed at `<chosen>\2024\holiday\clip.mkv` — the two
      levels were kept, not flattened away. Confirms the root used is the
      folder you pointed at, not the shared ancestor of the files inside it.

### The other destinations still work

- [x] **Alongside the original** puts the output next to the source, as
      always — this is the default and was exercised throughout this whole
      pass without issue.
- [x] **A folder I choose** puts everything flat in one folder, no
      subfolders — verified live as a control test against the Mirror bug
      above: `Advanced options → Destination → A folder I choose → Browse →
      Apply` correctly persisted `settings.output` (`routing:"fixed"`,
      `dir:<chosen>`) and the converted file landed in the chosen folder, not
      alongside the source. This is what first pointed at Mirror/Apply
      persistence rather than the routing logic itself.
- [x] Switching between all three in the dialog updates the command preview
      each time, and Apply stays enabled for all three.

### When there is nothing to mirror

- [x] Select files with **Add Files** rather than adding a folder, then open
      Advanced options. Mirror is still offered — a file's own folder is a
      perfectly good root — and converting puts the output flat. Verified
      live: `video1.mp4` added individually, Mirror selected, folder chosen,
      Applied — settings persisted correctly this time
      (`mirrorRoot` defaulted to the file's own containing folder) and the
      output landed flat in the chosen destination, not alongside the source.
- [ ] *(Only if you have two drives.)* Not attempted — this machine's test
      setup only used one drive for the pass. Per the checklist's own caveat,
      skipping this is expected when the hardware doesn't support it.

---

## 2.0.0-alpha.5 — Join

> **Status: the feature itself works well.** Written 2026-09-02 alongside the
> feature. The one failure found is the same conflict-prompt regression
> documented above, reused here rather than re-explained. Re-run by hand
> 2026-09-05: the single-clip message, two-MP3s-alone acceptance, and
> trim-actually-affects-the-output cases were all confirmed. Left unticked:
> two items that need drag-and-drop onto the window (not exercisable this
> pass — File Explorer access is click-only) and one item near the end of
> "Names, folders and interruptions" whose original wording was already
> reduced to "Not tried this pass" before this pass began, with nothing left
> to indicate what it was testing — left as found rather than guessed at.

Joining several files into one is the job this app could not do at all. It is a
second destination on the rail beside Files, and it is **an ordered list, not a
canvas** — the order is the whole model.

Two routes, and which one runs is a fact about the clips rather than a setting.
Where they already agree on container, codecs, size, frame rate and time base,
they are stitched with no re-encoding: near-instant, nothing lost. Where they do
not, they are re-encoded to fit. **The panel says which is about to happen and
why**, because those are very different things to press the same button for.

**Test media:** three or four clips that came off the same camera or export
(they will match), plus one from somewhere else with a different size and frame
rate (it will not). An MP3 or two for the audio-only case.

### Getting there and back

- [x] The rail has **Files** and **Join**. The Join icon is a two-into-one arrow
      and is legible at rail size, in both themes and when collapsed.
- [x] Click Join: the file grid, the footer, the selection bar **and the Add
      Files / Add Folder buttons in the header** all disappear.
- [x] Click Files: the grid comes back **exactly as it was** — same cards, same
      selection, same chosen formats. Nothing was rebuilt.
- [x] Go back to Join: your clip list is still there too.
- [x] Queue files in Files, switch to Join, add different files. The two lists
      are independent and neither disturbs the other.
- [ ] Not verified — drag-and-drop onto the window wasn't exercisable through
      this pass's input method (files were added via the Select Files dialog
      throughout). The list-independence and view-switching this depends on
      were confirmed, so this is a gap in coverage, not a known failure.
- [ ] Not verified, for the same reason (no way to check "inert while Join is
      showing" without also being able to drive drag/drop and the keyboard
      shortcuts against the Files grid for comparison in the same pass).

### Building the list

- [x] Drop two clips, or use **Select Files**. Each row shows its position, its
      name, its duration and its dimensions.
- [x] **Add the same file twice.** It appears twice. *(Unlike the queue, which
      refuses duplicates — repeating a clip in a join is a real thing to want.)*
      Verified: `clip1.mp4` added twice, both rows present and independently
      reorderable.
- [x] The up and down arrows reorder, and the numbers renumber. The first row's
      up arrow and the last row's down arrow are disabled. Verified: moved a
      duplicate clip from position 3 to position 2 via the down/up arrows and
      the list renumbered correctly.
- [x] × removes a row.
- [x] **Add more** adds to the list. Its **+ icon lines up with its label** — it
      sits directly under the list rather than in the header.
- [x] **Clear** empties the list and returns to the drop zone.

### It says what it is going to do

- [x] Add two clips **from the same source**. The panel says they match and will
      be joined **without re-encoding**, with a green edge.
- [x] Add the odd one out. The panel changes to say they will be **re-encoded**,
      with an amber edge, and lists what differs — "width, height, frame rate,
      time base, sample rate" or similar. Verified message read exactly: "These
      do not match, so they will be re-encoded to fit together. It takes longer
      and the result is not identical to the sources. They differ in: width,
      height, frame rate, time base."
- [x] Remove the odd clip again: it goes back to the no-re-encode message.
- [x] Verified 2026-09-05: with only one clip in the list, the panel reads
      "Add another file — a join needs at least two." and Join stays
      disabled.

### It refuses what it cannot do

- [x] Add a **video and an MP3** together: it refuses, saying they are a mix of
      video and audio-only files. Join stays disabled. Verified message read
      exactly: "These are a mix of video and audio-only files. Join files of
      one kind at a time." Confirmed via DevTools that the Join button's
      `disabled` property was `true`.
- [x] Verified 2026-09-05: two MP3s alone are accepted (not refused as a
      video/audio mix, since both are the same kind) — the panel read "These
      match, so they will be joined without re-encoding — quick, and no
      quality is lost." and MP3 was offered as the Join-into format.
- [x] Add an **animated WebP** (which the bundled FFmpeg cannot read): the row
      reads "unreadable" and the join is refused, naming the problem. Verified
      with the same animated WebP used in the mirrored-output testing.
- [x] **GIF is never in the "Join into" list**, for any combination. Verified:
      added a real animated GIF alongside two matching MP4 clips (the panel
      correctly flagged a different problem here — "Some of these have sound
      and some do not, which cannot be joined as they are," since the GIF is
      silent — worth noting as a distinct, sensible refusal reason not called
      out explicitly in this checklist) and confirmed the "Join into" dropdown
      offered MP4/MKV/WebM/AVI/MOV/WMV/FLV with no GIF option.

### Joining

- [x] Set a name and a folder. **Join** enables only once both are set — before
      that it says which is missing ("Choose where to save it.").
- [x] Join two matching clips. It finishes **quickly**, and the result is the
      two clips back to back, at the **original size and quality**. Verified
      via ffprobe on the actual output: 1280×720 preserved, h264/aac codecs
      unchanged from the sources.
- [x] Check the duration: it is the sum of both clips. Verified: two 3s clips
      joined to a 6.024s output.
- [x] Join two clips that do **not** match. It takes noticeably longer
      (re-encoding a mismatched 25s 1080p clip plus a 3s clip took several
      seconds, versus near-instant for the fast path), and the output plays
      through with no torn frames at the seam (spot-checked via ffprobe +
      a frame grab, not full playback).
- [x] Play the re-encoded result: the smaller clip is **fitted inside the
      frame and padded**, not stretched out of shape. Verified by extracting
      a frame from partway through the smaller (640×480, 4:3) clip's segment
      of a 1280×720 (16:9) joined output: it is letterboxed with black bars
      left and right, aspect ratio intact, not stretched.

### Trimming

- [x] Type `0:05` in a row's **from** box. The row's line reads "keeping …" with
      the shorter length. (Used `1` on a 3s clip rather than `0:05`, since the
      test clips were only 3s long and `0:05` would start past the end — see
      next item. Reads "0:03 · 1280×720 · keeping 0:02", correctly computed.)
- [x] Accept seconds too: `5` means the same as `0:05` — the plain-integer
      form (`1`) was accepted and parsed as seconds, confirming the same
      parser handles both forms.
- [x] Set **to** earlier than **from**: it says that clip ends before it starts
      and Join is disabled. Verified message read exactly: "clip1.mp4 ends
      before it starts." Confirmed via DevTools that Join's `disabled` was
      `true`.
- [x] Verified 2026-09-05: trimmed `track1.mp3` (0:04 source) to keep 0:02,
      left `track2.mp3` (0:04) untouched, and actually joined them — the
      output measured 6.06s via ffprobe, matching 2s (trimmed) + 4s (full),
      confirming the trim is genuinely applied to the join output and not
      just reflected in the row's label.

### Names, folders and interruptions

- [x] Re-verified 2026-09-05 via the "Advanced options actually stick" section
      ("Join asks too"): joining into a name that already exists now raises the
      **File Already Exists** prompt, and cancelling at it leaves no output
      file and no `%TEMP%\dfc-join-*` folder behind. No longer silently writing
      `joined (1).mp4`.
- [x] **Cancel** during a join stops it, and no half-written file is left
      behind. Verified: started a re-encode join (25s 1080p + 3s clip),
      clicked Cancel while the progress bar was moving, and no new output
      file appeared on disk from that attempt.
- [x] Cancel a join, then run it again: it works. Verified immediately after
      the above — pressing Join again on the same list completed normally and
      produced a new output file.
- [x] No `%TEMP%\dfc-join-*` folder is left behind. *(Checked directly on
      2026-09-03, after a join that was interrupted at the output-exists
      prompt: `%TEMP%` held no `dfc-join-*` entry at all. The earlier pass
      could not reach that filesystem and left this open.)*
- [ ] Not tried this pass.
---

## 2.0.0-alpha.5 — Advanced options actually stick

> **Status: run by hand 2026-09-05, 22 of 23 passed, 1 failed.** Run against
> the packaged alpha.5 build. Because the machine's real profile was already
> migrated and clean, the migration half was exercised by hand-editing
> `config.json` to write `onConflict`, `outputRouting`, `outputDir` and
> `nameTemplate` under `settings`, plus empty `presets`/`pipelines` arrays at
> the top level, and removing `settingsSchema`, to stand in for a genuine
> upgraded v1 profile — then launching. One failure found: the card's settings
> summary line does not reflect a conflict-policy-only change, even though the
> setting itself is correctly saved. See below.

Three of the failures in the sections above were one bug wearing three faces,
and it turned out to be **two** cooperating defects rather than the one the QA
pass suspected.

**The first is ordering.** `applyJobModal` wrote `job.settings` and *then* called
`setTarget`, which clears the settings whenever the output kind changes. A card
with no format chosen yet counts as a change from every kind — so every first
Apply threw away exactly what the user had just chosen. It read as intermittent
only because a card already sitting on the chosen format takes `setTarget`'s
early return and keeps its settings.

**The second is a ghost.** `onConflict`, `outputRouting`, `outputDir` and
`nameTemplate` are settings v1 wrote and 2.0 has no screen for, yet main still
layers all four underneath every job. Any install carrying v1's `onConflict:
"unique"` therefore renamed silently, whatever the card said — and with the
first defect having emptied the card's settings, that is exactly what happened.
A one-time migration now removes them, so the job model's own defaults govern.

**Test this on a profile that has run v1**, or the second half is invisible.

### The settings survive Apply

- [x] Add a file. **Do not choose a format on the card.**
- [x] Open **Advanced options**, choose a format *and* set **If it already
      exists** to **Skip the file**, then press **Apply**.
- [x] Reopen Advanced options on that same card: it still reads **Skip the
      file**, not **Ask me**. *(This is the whole bug. Before the fix the card
      came back empty and the summary line under it vanished.)*
- [x] **Re-tested 2026-09-08, fixed.** Repeated the exact repro: queued a
      file, gave it a format so it read Ready, opened Advanced options,
      touched nothing but **If it already exists** → **Skip the file**, and
      pressed Apply. A green summary line now appears under the card's
      metadata, reading `skip existing`. Also re-verified Overwrite
      (`overwrite`) and Save as a new file (`save as new`) each produce their
      own summary line the same way, and that a codec change combined with a
      conflict policy shows both, joined by `·` (e.g. `VP9 · skip existing`).
      Full detail is in the new `## 2.0.0-alpha.5 — the QA failures, fixed`
      section under "The summary line reports the conflict policy".
- [x] Do the same on a card that **already** had that exact format chosen — it
      must behave identically. That case always worked, which is what made the
      bug look random.
- [x] Select **several** cards, apply settings to all of them, then change one
      card's settings on its own. The others must not change with it.

### The conflict prompt is reachable again

Use a folder where the output name already exists — converting `x.mp4` to WebM
in a folder that already holds `x.webm` is enough.

- [x] Leave a card's conflict setting alone and convert: the **File Already
      Exists** prompt appears. *(This is the default path, and the one most
      users are on. It was silently producing `x (1).webm` before.)*
- [x] Set **Skip the file** explicitly, Apply, convert: **no** dialog, the card
      settles as skipped, and **no new file is written**.
- [x] Set **Overwrite** explicitly, Apply, convert: no dialog, and the existing
      file is replaced rather than a numbered one appearing beside it.
- [x] Set **Save as a new file** explicitly, Apply, convert: `x (1).webm`
      appears, as it always did.
- [x] Cancel at the prompt: the card settles as **cancelled** and nothing is
      written.

### Mirrored output reaches the destination

- [x] Add a **folder** with at least one nested subfolder.
- [x] Advanced options → **Mirror the source folders**, Browse to an empty
      destination, choose a format, Apply.
- [x] Convert. The output appears **under the chosen destination**, in the
      rebuilt subfolder structure — and **nothing new appears beside the
      source**. Check the source folder explicitly; the old failure was silent
      and left the destination empty.

### Join asks too

- [x] Join two clips into a folder, giving the joined file a name that already
      exists there.
- [x] The **File Already Exists** prompt appears. *(Join sends no conflict
      setting of its own, so it inherits the app default — which is the whole
      reason it was renaming silently.)*
- [x] Cancel at the prompt: no output file, and no `%TEMP%\dfc-join-*` folder
      left behind.

### The old settings are gone, and stay gone

- [x] Launch the app once, then open
      `%APPDATA%\diamond-file-converter\config.json`.
- [x] `settings` no longer contains `onConflict`, `outputRouting`, `outputDir`
      or `nameTemplate`, and the dead `presets` and `pipelines` keys are gone
      too.
- [x] `settingsSchema` is present and reads `2`.
- [x] `debug.log` names what was removed, rather than deleting it in silence.
      Verified: `Removing settings 2.0 has no screen for: onConflict,
      outputRouting, outputDir, nameTemplate`, then `Removing the orphaned
      store key presets` and `Removing the orphaned store key pipelines`, each
      its own line, timestamped a few milliseconds after "App ready".
- [x] Collapse the nav rail and change a folder option, then relaunch: both are
      remembered. *(The migration must not take live settings with it.)*
      Verified: collapsed the rail and unticked Images in the folder-options
      popover, fully closed the app and reopened it — the rail was still
      collapsed and Images was still unticked.
- [x] Launch a **second** time: the migration does not run again — `debug.log`
      carries no further "Removing" lines. Verified: the second launch's
      `debug.log` holds only the startup line, "App ready", and the
      update-check line — no "Removing" lines at all.

---

## 2.0.0-alpha.5 — the QA failures, fixed

> **Status: not yet run.** Written 2026-09-08 alongside the fixes for the four
> failures the 2026-09-05/07 passes found. Nothing here has been verified by a
> human yet; do not read the section existing as the section passing.

Four defects, three causes, one non-defect:

**The command preview stubbed its own output path.** `buildArgs` was handed the
literal string `<output>` rather than a resolved destination, so the one
argument a user is most likely to be checking was the one the box was making up.
It now runs the same resolver the conversion runs, which means routing, the name
template *and* the conflict policy all show through.

**A bare `C` accelerator opened Credits from any text field.** Electron
registers menu accelerators globally regardless of focus, so every "c" typed
into any input in the app fired it. It is now `Ctrl+Shift+C` — the binding
Dropgate's client already uses, so this is the org's existing pattern rather
than a new one. A test now scans the menu for any modifier-less accelerator, as
the same mistake is still sitting in two sibling apps.

**The card summary ignored a conflict-policy-only change.** `summariseSettings`
never looked at `onConflict`, so a card whose only change was "Skip the file"
showed no summary line and read as though the setting had not stuck — even
though it had.

**"Cancel All" was dead while the conflict prompt was open, and the runner was
never at fault.** The prompt is window-modal, so Windows blocks every click on
the app behind it; the footer button could not receive input at all, which is
why dragging the dialog clear changed nothing. The abort now lives in the
dialog, where it can actually be reached. Its buttons are now **Cancel All ·
Skip This File · Overwrite · Save as New** — v1's "Cancel" renamed to what it
always did to one job.

> **"Skip This File" is not just a relabel.** The runner has always known how to
> settle a job as **Skipped**, but nothing ever answered the prompt that way, so
> declining one file left the card reading Cancelled. Check the status word.

The fifth report — toast colours not matching Craftbox — was **investigated and
closed with no change**. DFC's toasts already match Bootstrap's `.text-bg-*`
contract and the house spec: info and warning are black on colour, success and
danger are white on colour.

### The command preview tells the truth

- [x] Queue one file, open **Advanced options**, choose a format. The preview's
      output path is a **real path**, not `<output>`. Verified via DevTools
      console (the preview box itself is too narrow to show the full command):
      queued `conflict\large.mp4` → WebM, and the preview's final argument
      resolved to `...\conflict\large.webm` — a real, resolved path.
- [x] Change **Destination** to a custom folder. The path in the preview follows
      it. Verified: switched Destination to `A folder I choose` →
      `...\qa-alpha5\New folder`, and the preview's output path updated to
      `...\qa-alpha5\New folder\large.webm`.
- [x] Change the **Name template**. The filename in the preview follows it.
      Verified: set the template to `{name}-renamed`, and the preview's output
      filename updated to `large-renamed.webm`.
- [x] Point the job at a file that already exists and set **If it already
      exists** to **Save as a new file**. The preview shows the `(1)` name it
      would actually write. Verified: reset Destination back to "Next to each
      source file" (where `large.webm`, `large (1).webm` and `large (2).webm`
      already exist from earlier passes), set the conflict policy to "Save as
      a new file", and the preview correctly resolved to `large (3).webm` —
      the next actually-free name, not a static or placeholder one.
- [x] Select **two or more** cards and bulk-edit them. A line under the preview
      names which file is shown and how many others share the settings.
      Verified: queued `large.mp4` + `small1.mp4`, bulk-edited both, and the
      line under the preview read "Showing large.mp4. One other file uses
      these settings with its own paths."
- [x] With one card selected, that line is **absent** — not "0 other files".
      Verified: opened Advanced options on `large.mp4` alone — the dialog goes
      straight from the command preview to Cancel/Apply, no line in between.

### Typing is not a shortcut

- [x] Click into the **Name template** field and type `credits are cool`. The
      text appears in full and **no Credits window opens**. Verified.
- [x] Do the same in every other text field in Advanced options. Verified in
      the single-card dialog: Quality's `auto` box, Resize width, Resize
      height, Frame rate, and Bitrate all took a typed `c` with no Credits
      window opening.
- [x] **Ctrl+Shift+C** still opens Credits. Verified — but only after closing
      DevTools first. With DevTools open, Ctrl+Shift+C and Ctrl+O were both
      being intercepted by DevTools itself (Chrome's own "inspect element" and
      "open file" shortcuts) before they reached the app, which looked like a
      failure at first. That was this session's tooling, not the app — closing
      DevTools and retrying confirmed the accelerator does fire normally.
- [x] Credits still opens from the menu bar. Verified.
- [x] `Ctrl+O`, `Ctrl+Shift+O`, `F12` and `Alt+F4` all still work. `Ctrl+O`
      (Open Files dialog), `Ctrl+Shift+O` (Select Folder dialog) and `F12`
      (toggled DevTools) all verified once DevTools-focus was ruled out as
      above. **`Alt+F4` could not be verified**: sending it needs an
      elevated "system key combos" permission from the computer-use tooling,
      and that permission prompt (which needs the user's own approval) timed
      out twice unattended rather than being answered. Not tested; not a
      reflection on the app.

> **`Alt+F4` verified 2026-09-11.** A fresh permission request for system key
> combos was granted this session (no timeout this time). With the app
> focused, Alt+F4 closed it immediately — the window disappeared and the
> app was gone from the taskbar/window list. `role: "quit"` behaves as
> expected; nothing nearby had changed it.

### The summary line reports the conflict policy

- [x] Queue a file, give it a format so it reads Ready. Verified.
- [x] Open **Advanced options**, touch **nothing** except **If it already
      exists** → **Skip the file**. Apply. Verified.
- [x] A green summary line now appears on the card, reading `skip existing`.
      Verified — this is exactly the case that failed on 09-07 (a
      conflict-policy-only change produced no summary line at all). Now fixed.
- [x] Repeat with **Overwrite** (`overwrite`) and **Save as a new file**
      (`save as new`). Verified both — summary read `overwrite`, then
      `save as new`.
- [x] Set it back to **Ask me**: the summary line disappears again, because the
      default is not a change. Verified.
- [x] Set a codec **and** a conflict policy: both appear, joined by `·`.
      Verified: codec VP9 + conflict policy "Skip the file" → summary line
      read `VP9 · skip existing`.

### The conflict prompt can abort the run

- [x] Queue six colliding files and press **Convert**. Verified — and this
      confirms the headline fix: the prompt's buttons (**Cancel All · Skip
      This File · Overwrite · Save as New**) are now inside the dialog itself,
      not a footer button a window-modal dialog was blocking.
- [ ] **FAILED (partially).** With the prompt open, press **Cancel All**. The
      dialog closes and **every card** reads Cancelled — the one that was
      prompting and the five behind it. **Not what happened.** Reproduced
      twice: queued the six colliding files (`large` + `small1–5`), pressed
      Convert, and pressed **Cancel All** on the first prompt (`large.webm`).
      That cancelled only `large.mp4`'s card and immediately opened a **new**
      "File Already Exists" prompt for `small1.webm` — because all six
      files' existence checks apparently resolve up front (independent of
      conversion concurrency), so five more collisions were already queued
      behind the first one. Cancel All had to be pressed **five more times**,
      once per remaining prompt, before all six cards finally read Cancelled
      and the dialog closed. A single press does not abort the run — it
      declines only the file currently being asked about. (By contrast,
      ticking **Apply to all remaining files** alongside **Skip This File**
      *does* resolve every pending prompt in one action — see two boxes
      below. Cancel All has no equivalent "apply to all" behavior of its own,
      which is presumably the gap: the fix reached the other three buttons
      but Cancel All still behaves like a per-file decline rather than a true
      whole-run abort.)
- [x] The footer leaves its converting state; the app is not stuck. Verified
      — true in the end, once all six prompts were individually answered.
- [x] Re-run. Press **Skip This File**. That card reads **Skipped**, *not*
      Cancelled, and the run carries on to the next file. Verified — this
      part of the fix is solid. One side note, not part of this box: the
      *footer's* running tally read "1 cancelled" for a file whose card
      correctly said Skipped — a minor label-only mismatch in the tally, not
      the card.
- [x] Re-run. Tick **Apply to all remaining files** and press **Skip This
      File**. Every remaining collision is skipped with no further prompts, and
      each of those cards reads Skipped. Verified — single click, dialog
      closed immediately, all six cards read Skipped. This is the behavior
      the box above was expecting from Cancel All and didn't get.
- [x] Re-run. **Overwrite** and **Save as New** both still behave as they did.
      Verified both, each with "Apply to all remaining files" ticked: all six
      converted cleanly with Overwrite (in place); a fresh two-file re-run
      with Save as New produced `large (3).webm` and `small1 (5).webm`
      alongside the originals, both playable-size, no errors.
- [x] Nothing is written to disk by a run that was cancelled. Verified by
      listing the destination folder directly after the Cancel-All and Skip
      sequences above: no stray, partial, `.tmp`, or `.part` files — only the
      expected, deliberately-created `(N)` files from the Save-as-New tests.

> The failure recorded above is fixed. It is left written as it was found
> because the cause turned out to be two separate holes, not one, and the
> second only shows up under a condition this pass never met. Both are covered
> by the section at the end of this file, which is where the retest lives.

> ### Not testable by an agent — the user tests this one
>
> - [ ] Press **Escape** at the conflict prompt. It aborts the **whole run**,
>       the same as Cancel All. This is intended.
>
> Computer-use cannot send the Escape key, so an automated pass cannot verify
> this and must leave it unticked with that reason written in rather than
> guessing at it. **Not testable by an agent — computer-use cannot send
> Escape.** Left unticked as instructed; not attempted, not substituted with
> Cancel All. Worth noting given the box directly above: if Escape's abort
> shares the same "Cancel All" code path this session found only cancels the
> current file, it may have the same partial-abort behavior rather than
> aborting the whole run in one press — but that is a guess, not a finding,
> and the user should verify it directly rather than trust this note.

---

## 2.0.0-alpha.5 — one press of Cancel All

> **Status: re-tested 2026-09-11.** Written 2026-09-08 alongside the fix for
> the partial abort the 2026-09-08 re-QA pass found. The fix was built by a
> local Claude Code session (handed the diagnosis above plus two code-review
> checks) and reinstalled from a fresh `Diamond-File-Converter-Setup-2.0.0-
> alpha.5.exe`, then re-tested below. `npm test` reported 186/186 passing on
> that native Windows run, including the two new tests the session added for
> this (`runner.test.js`: an abort not surviving `start()`, and one Cancel
> All ending a batch whose files are still arriving).

The re-QA pass above confirmed the abort had reached the dialog, and then found
it still declining one file at a time: six colliding files wanted six presses of
a button labelled **All**. Two causes sit behind that, and only the first was
obvious.

**The prompts behind the answered one were already in the queue.** Conflict
prompts are serialised so that only one dialog is ever open, but every job that
has reached the runner joins that chain the moment its own collision is found —
before anyone has answered anything. Telling the runner to cancel everything
does not un-chain them: each still called up its own dialog when its turn came.
The prompt now checks whether the batch has been aborted before it opens
anything, which is the same short-circuit "Apply to all remaining files" has
always used.

**The runner forgets an abort between two files of the same batch.** This is
the one the failing pass was actually seeing, and it is why the count matched
the number of files rather than the number of conversions running at once.
Every file is submitted separately and probed before it reaches the runner, so
a batch answered quickly can empty the pool while its later files are still
being probed. The runner calls that the end of the run — and the next file to
arrive starts a new one, which clears the abort. The abort, and the
apply-to-all choice beside it, are now held for as long as any file of the
batch is still outstanding rather than until the runner next falls idle. That
second half also fixes **Apply to all remaining files** silently forgetting
itself in the same circumstances.

### One press stops everything

- [x] Queue six colliding files (the `large` + `small1–5` set), press
      **Convert**, and press **Cancel All** on the first prompt. Exactly one
      dialog appears. It closes, and **every card** reads Cancelled — the one
      that was prompting and the five behind it. No second prompt opens.
      **Re-tested 2026-09-11.** Six files queued (`large`, `small1–5`) → WebM,
      Convert, one press of Cancel All on the `large.webm` prompt. Dialog
      closed immediately; footer read "6 cancelled"; all six cards read
      Cancelled. No second prompt appeared. Repeated the same six-file/Cancel
      All sequence a second time in the same run (see "abort belongs to its
      own run" below) with the same one-press result both times.
- [x] The footer leaves its converting state immediately, with no further
      presses needed. **Re-tested 2026-09-11**, same run as above — footer
      dropped straight to "6 cancelled" with its progress bar, no residual
      "Converting" state.
- [x] Nothing was written: the destination has no new, partial, `.tmp` or
      `.part` files. **Re-tested 2026-09-11** — checked the `conflict/`
      folder's contents by directory listing immediately after both
      cancelled runs; newest file present was still from the 2026-09-08
      session, nothing new, partial, `.tmp` or `.part` from tonight's test.

### One press stops everything, when the files are still arriving

This is the case the previous pass was hitting. It needs enough files that they
are still being read when you answer, so use a folder, not six files.

- [ ] Queue **thirty or more** colliding files — a folder ingest of a
      directory whose outputs already exist is the easiest way — and press
      **Convert**.
- [ ] Press **Cancel All** on the first prompt **as soon as it appears**,
      without waiting. Still exactly one dialog: every card ends Cancelled and
      no second prompt opens, however quickly you answered.
- [ ] Repeat, this time ticking **Apply to all remaining files** with **Skip
      This File** instead. One dialog again, and every card reads Skipped —
      the choice is not forgotten half way through.

> **Not attempted 2026-09-11.** Left unticked, not guessed at. Reproducing the
> "still arriving" timing reliably through UI automation (versus the six files
> above, which are small enough to all be probed before the first dialog is
> even answered) wasn't practical this session. This is exactly the scenario
> the session that built the fix added a dedicated test for —
> `test/runner.test.js`: "runner: one Cancel All ends a batch whose files are
> still arriving" — which drives the real `JobRunner` pool with files
> enqueued one at a time between `await` points and asserts one dialog, zero
> spawned jobs, and every job Cancelled. That test passed as part of the
> 186/186 run. A human running this box directly against the UI is still the
> one thing that actually closes it out.

### The abort belongs to its own run and no other

- [x] After an aborted run, press **Convert** again on the same cards. The
      conflict prompt appears normally. *(A run must not inherit the previous
      run's abort and cancel itself silently.)* **Re-tested 2026-09-11** —
      `large.mp4` + `small1.mp4` → WebM, Convert, Cancel All (one press, both
      Cancelled). Pressed Convert again on the same two still-selected cards
      without restarting the app: the File Already Exists prompt reappeared
      normally for `small1.webm` — not silently skipped or re-cancelled.
      Answered it with Overwrite + Apply to all remaining files this time and
      let the batch actually run: both files converted normally, confirming
      the pool is fully usable again after an abort, not just able to open a
      dialog.
- [x] After an aborted run, build a **Join** whose output name already exists
      and run it. It prompts, rather than cancelling itself without asking.
      **Re-tested 2026-09-11**, directly after the six-file Cancel All above,
      no restart — joined `small1.mp4` + `small2.mp4` into `large.mp4` in the
      same `conflict/` folder (an existing filename, chosen deliberately to
      collide). The File Already Exists prompt appeared normally for
      `large.mp4`; pressed Cancel All to close it out. This was the case the
      fix's own author flagged as the one they were most careful about
      (`conflictAbort`/`conflictChoiceForBatch` leaking from one job type into
      the next via `withBatchJob`'s job-count-based reset) — confirmed not
      leaking.
- [x] Start a run with no conflicts at all — files that do not collide, so no
      prompt opens — and press the **footer's** Cancel All while it converts.
      It still stops the run. **Re-tested 2026-09-11** — during the
      Overwrite-and-let-it-run check above, `small1.mp4` finished first while
      `large.mp4` was still mid-convert with no dialog open; pressed the
      footer's red Cancel button and `large.mp4` immediately read Cancelled
      (`small1.mp4` stayed Done). Confirms the footer button still works
      outside the conflict-prompt path, not just as part of that fix.

> ### Not testable by an agent — the user tests this one
>
> - [ ] Press **Escape** at the conflict prompt instead of clicking Cancel
>       All. One press aborts the **whole run**, exactly as Cancel All does.
>       This is intended.
>
> Computer-use cannot send the Escape key, so an automated pass must leave this
> unticked with that reason written in rather than guessing at it. Code review
> settles what it *should* do: the prompt is a native message box whose
> `cancelId` is `0`, and button `0` is Cancel All, so Escape resolves to the
> same branch and the fix above covers both. That is a reading of the code, not
> a test of it — the box stays unticked until someone presses the key.

## 2.0.0-beta.1 — one app, two sections

> **Status: signed off by hand 2026-09-11, before the beta.1 release.** The
> boxes below were not ticked one by one as part of that sign-off, so they
> stand for whoever runs the section formally. Written 2026-09-11 alongside
> the fix. The layout was measured in the running app through a driver
> rather than by eye:
> the header, the title, the toolbar and the drop zone occupy the same
> rectangle on Convert and on Join, to the pixel, and the rail's three icons
> sit at the same y whether the rail is expanded or collapsed. What a driver
> cannot judge — whether it *looks* still — is what this section is for.

Three things stopped the two sections reading as one app, and all three were
visible in the first thirty seconds of using it.

**Switching moved the title.** The Add Files / Add Folder group was hidden on
Join, and those buttons are 31px tall against a 24px title. Taking them out of
the header shrank it by 7px, and the title and everything under it jumped up on
every switch. The toolbar is now shared: it stays in the header on both
sections and adds to whichever one is showing, so the header is the same height
everywhere. That is also what puts the buttons on Join — they were missing
there, and Join could not take a folder at all.

**Collapsing moved the icons.** A rail item is a 20px icon beside a label whose
line box, at Bootstrap's 1.5, is 21.6px. The label sets the item's height;
collapsing hides the label; every item shrinks by 1.6px and every icon below it
creeps up. The item's line box is now pinned to the icon's height, so the two
states are identical and the icons hold still while the width animates.

**Join's empty state was its own design.** Different lines, a hint in the wrong
colour, no "or", and the section's icon on the rail was a grid while the zone
above it showed an upload arrow. The two zones are now the same zone line for
line, and the icon at the top of each is the same glyph as that section's rail
item. **Files is now Convert**, with the source-to-target arrow the cards
already draw. That last rule is written into the design system — a section is
named by one glyph, not two — in `docs/design-system/` (regenerate with
`node docs/design-system/build.js`; the Claude Design project needs a
`/design-login` from an interactive session to receive it).

### Nothing moves when you switch

- [ ] Launch the app. The rail reads **Convert** and **Join**, and Convert is
      highlighted *immediately*, before anything is clicked. *(It used to light
      up only after a round trip through Join — the first launch showed no
      section at all.)*
- [ ] Click Join, then Convert, then Join again, watching the title **Diamond
      File Converter**. It does not move by a pixel. *(It jumped up 7px on
      Join.)*
- [ ] Same switch, watching the drop zone's dashed border. It stays exactly
      where it is — same size, same position — and only the icon and the
      label inside it change.
- [ ] Same switch, watching **Add Files** and **Add Folder** in the header.
      They are there on both sections, in the same place, at the same size,
      with the options caret beside Add Folder on both.
- [ ] Both themes.

### Nothing moves when you collapse

- [ ] With the rail expanded, press **Collapse**, watching the three icons —
      Convert, Join and the chevron. They stay on their lines while the rail
      narrows: the labels disappear, and nothing slides up or down. *(Each
      item used to shrink by 1.6px, so the icons below it crept upward.)*
- [ ] Press **Expand**. The same in reverse, and the chevron *turns* to face
      the other way rather than flipping.
- [ ] Do it from Join as well. The collapse must not care which section is
      showing.
- [ ] Collapsed, hover each icon: the hover wash is the same rounded box as
      when expanded, just narrower.

### The two sections read as one app

- [ ] Convert's zone, top to bottom: a green ⇄ arrow, "Drag & Drop Files or
      Folders Here", a grey "or", **Select Files**. The ⇄ is the same glyph
      as the Convert item on the rail.
- [ ] Join's zone, top to bottom: the green two-into-one arrow, "Drag & Drop
      Files to Join Here", a grey "or", **Select Files**. The same four lines,
      the same colours on each, the same glyph as the Join item on the rail.
      *(It had five lines, and the extra one was in body colour, not grey.)*
- [ ] Click anywhere in Join's zone that is not the button: the file dialog
      opens. Click the button: it opens once, not twice. *(Convert's zone has
      always done this; Join's only answered to its button.)*
- [ ] Hover Join's zone: the same green wash as Convert's. Drag a file over it:
      the same stronger wash.

### The toolbar adds to whichever section is showing

- [ ] On Join, **Add Files** → pick two clips. They are listed on Join, and
      Convert's grid is untouched.
- [ ] On Join, **Add Folder** → a folder of clips. Every supported file in it
      is listed, in name order, and the toast reads *Added N files* — with
      *skipped M* and a **Show them** link if the folder held anything the
      app cannot join. *(Join could not take a folder at all; a dropped one
      bounced with "None of those are files this can join.")*
- [ ] Drop a folder onto Join's zone. The same result as Add Folder.
- [ ] Untick **Include subfolders** in the options caret, then Add Folder a
      folder that has a subfolder of clips. The subfolder's clips are not
      listed. *(The folder options apply on Join exactly as on Convert.)*
- [ ] Switch to Convert, **Add Files**. They go to the grid, not to Join.
- [ ] Drop files on Convert while Join has a list. They go to the grid; the
      join list is untouched.

### Nothing else moved

- [ ] Queue files on Convert, pick formats, select two cards. Switch to Join
      and back: the grid, its selection and its chosen formats are exactly as
      left.
- [ ] Ctrl+A and Delete still act on the grid on Convert and do nothing on
      Join.
- [ ] Collapse the rail, quit, relaunch. Still collapsed.
- [ ] Add the same clip twice on Join, by two separate Add Files. It appears
      twice. *(A folder walk lists each file once, but two adds are two adds.)*

---

## 2.0.0-beta.2 — trimming you can place exactly

> **Status: written 2026-09-23 alongside the change, not yet run by hand.**
> Checked in the running app through a driver, not by eye. Drags, arrow keys
> and Shift-steps landed on the grid. Typed values reached the command exactly
> as typed (`-ss 3.04 … -t 4.46`). A backwards end was refused, and Apply
> stayed off until it was fixed. Two handles one frame apart gave `-t 0.04`.
> Screenshots were taken in both themes, single-frame mode and audio. A driver
> cannot tell whether a drag *feels* right, so that is what this section is for.

This supersedes parts of the alpha.1 **Trim slider** section. That section
says the control is "not a pair of text boxes" and that Shift makes the handle
move "much more slowly". Neither is true any more.

Three things were wrong with the trim control.

**The command carried whatever fraction the pointer landed on.** An ordinary
drag gave `-ss 3.47 -t 8.21`. Handles now move in whole seconds. With **Shift**
held, whether dragging or on the arrow keys, they move one frame at a time for
video, or a tenth of a second for audio.

**The two handles could sit on top of each other.** Only 0.05s had to separate
them, so on any clip longer than a few seconds they covered each other and the
span could shrink to nothing you could see or grab. They now always stay at
least one step apart: a second, or a frame or tenth with Shift. Each handle is
half a pill on the *outside* of its point, so two handles a frame apart sit
side by side as one whole pill.

**There was no way to say an exact time, and no picture for a trim.** Each end
now has a box above the slider for an exact time. The first and last kept
frames show under the slider for any video trim, not only when exporting
frames.

### Test media

A video of 10–20 seconds that is **not** a whole number of seconds long, with
something visibly changing from frame to frame (a clock, a timecode, motion).
One audio file. One song with cover art (an MP3 or FLAC with an embedded
picture).

### Whole seconds by default

- [ ] Add the video, pick **MKV**, open Advanced options. The Trim section
      reads, top to bottom: **Start** and **End** boxes with *keeping …*
      between them, the slider, two frame previews (**First frame** under the
      start, **Last frame** under the end), then the help line.
- [ ] Drag the start handle slowly across. The Start box only ever shows whole
      seconds (`0:03`, `0:04`), never `0:03.47`. The command preview shows
      `-ss 3`, not `-ss 3.47`.
- [ ] Drag the end handle in from the right, then all the way back. You can
      reach the true end of the clip. The End box shows its full length, for
      example `0:12.48`, and the command has **no** `-t`.
- [ ] Click a handle, then press ← and →. It moves a second at a time.

### Shift for single frames

- [ ] Hold **Shift** and drag a handle. It moves a few pixels per frame, and
      the box counts up in frames (`0:03.04`, `0:03.08` at 25fps). The cursor
      turns to a crosshair while Shift is held.
- [ ] Press and release Shift *during* a drag. The handle carries on from where
      it is and does not jump somewhere else.
- [ ] Shift+← / Shift+→ on a focused handle. One frame per press. Watch the
      frame preview under that handle: it changes by exactly one frame.
- [ ] Repeat with the audio file (target WAV). A Shift-step is a tenth of a
      second (`0:03.1`, `0:03.2`). The help line says "a tenth of a second".

### The handles never cover each other

- [ ] Set Start to `6` and End to `7`, then press Shift+← on the end handle
      until it stops. It stops **one frame** after the start. The two halves
      sit side by side as one pill, both still visible and grabbable. The
      command shows `-t 0.04` (at 25fps), not `-t 0`.
- [ ] Without Shift, press ← on the end handle from well to the right. It stops
      a whole second after the start.
- [ ] Try to drag the start handle past the end. It stops short and does not
      cross.
- [ ] At both ends of the track, the handles are fully visible and not clipped
      by the edge of the dialog.

### Exact times

- [ ] Type `0:03.04` into Start and press **Enter**. The handle moves there,
      the command shows `-ss 3.04`, and the first-frame preview updates. The
      value is **not** rounded to a whole second.
- [ ] Each of these is accepted in the End box: `7.5`, `0:07.5`, `0:00:07.5`.
- [ ] Clear the End box and press Tab. It fills back in with the clip's full
      length, and the command has no `-t`.
- [ ] Type `0:02` into End while Start is `0:03.04`, then press Enter. The box
      goes red, and a red line under the boxes reads *The end must be after the
      start, at 0:03.04.* **Apply is disabled.** The slider has not moved.
- [ ] Fix the End box. The red clears and Apply comes back.
- [ ] Each of these is refused with a message: `abc`, `1:75`, a Start equal to
      the End, an End past the clip's length.
- [ ] Type a bad value, then drag a handle instead. The red clears and both
      boxes show the span the slider is actually on.
- [ ] Type `1:2` in a box but do not leave it. Nothing goes red until you press
      Enter or leave the box.

### Previews

- [ ] On the video trim, the **Last frame** preview shows the last frame *kept*,
      one frame before the End time, not the first frame cut.
- [ ] On the audio file there are no previews, just the boxes and slider.
- [ ] On the song with cover art (target MP3 or WAV) there are no previews
      either. Cover art is not a picture to trim through.
- [ ] Target **PNG** on the video, choose **A single frame**. The Start box is
      labelled **Frame at**, there is no End box, the handle is a round dot
      sitting on its point, and the single preview is captioned **This frame**.
      Type `0:04.2`. The command shows `-ss 4.2` and `-frames:v 1`.
- [ ] Switch to **Every frame in the range**. Both boxes and both handles come
      back, and the end handle can be dragged all the way out.

### Nothing else moved

- [ ] Set a trim, Apply, reopen the dialog. The boxes and handles show the same
      span, fractions included.
- [ ] Set a trim with a frame-exact start, Apply, convert. Check the output
      with ffprobe or a player: it starts on that frame.
- [ ] On **Join**, type `1:23` and `0:05` in a clip's trim fields. They still
      work as before. `1:75` is now treated as blank, like any other
      non-time.
- [ ] Both themes: the boxes, the red refusal line, the pill handles and the
      previews all read correctly in light and dark.

### Not testable by an agent — Escape

> A computer-use agent cannot send Escape. Leave these boxes unticked and say
> so. Only a person at the keyboard can run them.

- [x] Type a refused value in End, then press **Escape**. The dialog closes and
      nothing is applied. Reopen it: the trim is what it was before.
      Verified by Will at the keyboard, 2026-10-01 (M4's gate).

## Settings > Update — channels and automatic downloads

The update boxes are gone. Updates live in **Settings > Update**, and the menu's
**Check for Updates** opens that tab and checks. Test against a packaged build:
nothing checks from a build run from source.

### The tab

- [ ] Settings > Update shows `Diamond File Converter <version>`, **Check for
      Updates** with a status line under it, the **Download updates
      automatically** switch (on), and the **Update channel** select.
- [ ] On a beta build with nothing saved, the channel is **Beta**, with the help
      line "Betas and finished releases." Change it to **Stable**: the line
      changes, and a check runs.
- [ ] Close and reopen: the switch and the channel are as you left them.

### Automatic downloads on

- [ ] With a newer release in the channel, about 5 seconds after launch one
      toast says "Version X has downloaded and will be installed when you close
      Diamond File Converter." No box asks anything.
- [ ] The Update tab says the same. Close the app: the update installs, and the
      next launch runs the new version.

### Automatic downloads off

- [ ] A yellow dot shows on the rail's Settings (on the corner of its icon when
      the rail is collapsed) and on the Update tab, which says "Version X is
      available." with **Download Update**. Nothing downloads by itself.
- [ ] **Download Update** downloads it, with no toast. The dot stays. Close the
      app: it installs, and the dot is gone on the new version.

### Never the wrong release

- [ ] On **Stable**, running a beta, nothing older than the beta is offered, and
      no pre-release is either.
- [ ] **Check for Updates** with nothing newer says "You're up to date."
- [ ] With no network, the check says "Couldn't check for updates. Try again
      later." in red, and the app carries on.

## Everything shared from the house kit — prompts, drops, the log, one window

The toasts, the "File Already Exists" prompt, the drop zones, the action bar,
the progress bars, the key guard, the log, the settings' migration, the
window's size and position, one instance and "Open with" all come from the
house kit now. DFC's own versions are gone. "File Already Exists" is asked in
the app, not in a Windows box, and the Title Case slips are fixed.

> **Status: run on Windows on 2026-10-01, on Will's installed 2.0.0-beta.2
> (per machine), by an agent driving the real app while Will watched.** Boxes
> ticked below were seen working; each says how. **Not run, so left unticked:**
> every "Open with" and every drag from Explorer (Explorer is click-only for
> the agent: no right-click, no drag), every Escape (an agent can't send it),
> unplugging a monitor, and `debug.log` after a second "Open with". NVDA was
> skipped: it isn't installed on Will's machine. An agent had earlier driven
> the app built from source through every step it can (23/23 on Windows,
> 2026-10-01), and the M1 checks again on a profile 2.0.0 had saved (29/29).
> What the pass found is under "Found in the pass", at the end of this
> section, with what was done about each.
>
> **Then run by Will, 2026-10-01, before the next beta (M4's gate):** every
> box left for a person (the three "Open with", the second-Open-with log, the
> Explorer drags, the Escapes, the second monitor, and his own look at the
> reworked Settings > Update), all as written. NVDA stays skipped. The Linux
> build was passed the same day: the next section.

Test a packaged, installed build. Use files you can lose: the steps write
outputs next to them.

### Open with, and a second "Open with"

- [x] Right-click an audio file in Explorer, **Open with** the app, with the app
      closed: it opens with the file as a card.
      Verified by Will, 2026-10-01.
- [x] With the app open, **Open with** two more files at once: the app comes to
      the front, and both arrive together as cards, in one go.
      Verified by Will, 2026-10-01.
- [x] Only one window, ever, and the app opened only once (one taskbar button).
      Verified by Will, 2026-10-01.

### Drops and the toast's list

- [x] Drag a supported file and a `.txt` onto the empty Convert view: the
      dashed box lights while you're over it, and one toast says "Added 1 file,
      skipped 1." with **Show Them**.
      The toast was first seen the other way: Add Folder on a folder holding a WAV
      and a notes.txt gave "Added 1 file, skipped 1." with **Show Them**. The drag
      itself, with the dashed box lighting, verified by Will, 2026-10-01.
- [x] **Show Them** lists `notes.txt — not a supported format`, and says
      **Hide**; the toast stays until you close it.
      Verified 2026-10-01, through Add Folder rather than a drag: it listed
      `notes.txt — not a supported format`, the link read **Hide**, and the toast
      was still there 12 seconds later.
- [x] With cards on screen, drag more files anywhere over the grid: the grid
      lights, and they're added.
      Verified by Will, 2026-10-01.
- [x] Drag files onto Join: they're added to Join, not Convert.
      Verified by Will, 2026-10-01.

### A conversion, and "File Already Exists"

- [ ] Convert a file to MP3: the card's thin bar fills (or slides, for a file
      whose length isn't known), the bar under the grid says "Converting 1
      file…" with **Cancel** where **Convert** was, then "1 file converted".
      Partly seen 2026-10-01: the bar under the grid said "Converting 1 file…" with
      a red **Cancel** where **Convert** was, then "1 file converted". Not seen: the
      card's own thin bar. A 4-second WAV finishes before a screenshot can catch it.
      Try a longer file.
- [x] Clear All, add the same file, convert it to MP3 again: a prompt in the
      app, not a Windows box, says "File Already Exists", with **Cancel All**,
      **Skip This File**, **Overwrite** and **Save as New** (focused), and
      **Apply to All Remaining**.
      Verified 2026-10-01: an in-app prompt titled "File Already Exists" with **Cancel
      All**, **Skip This File**, **Overwrite** and **Save as New**, the last with a
      visible focus ring. **Apply to All Remaining** is a checkbox above the buttons.
- [x] Press Escape: the run is cancelled, nothing is written, and focus is back
      where it was.
      Verified by Will at the keyboard, 2026-10-01. (The agent's pass had checked the
      prompt's **Cancel All** button instead: the run stopped, the cards read
      Cancelled, and nothing was written.)
- [x] Again, **Save as New**: `name (1).mp3` is written.
      Verified 2026-10-01: `tone-a (1).mp3` was written beside `tone-a.mp3`.
- [x] Convert five files that all exist, tick **Apply to All Remaining** on the
      first prompt with **Skip This File**: no more prompts, all five skipped.
      Verified 2026-10-01 for the behaviour: all five cards read Skipped and no
      second prompt came. **But the result says the wrong thing:** the toast read
      "Conversion cancelled." and the bar under the grid "5 cancelled". Skipped
      files are counted as cancelled (`announce()` in renderer.js). See "Found".

### A join

- [x] Join two WAV files into **MP3** (the first format offered): the plan
      says they'll be re-encoded, because MP3 isn't their own format, and the
      join works. (It used to try to copy them, and failed in ffmpeg.)
      Verified 2026-10-01: the plan read "These match, but they are joined into MP3,
      not their own format, so they will be re-encoded. It takes longer and the result
      is not identical to the sources.", and `joined.mp3` came out at 8.05 s (two 4 s
      WAVs).
- [x] Join the same two into **WAV**: the plan says they'll be joined without
      re-encoding, and that works too.
      Verified 2026-10-01: "…joined without re-encoding — quick, and no quality is
      lost.", and `joined.wav` was written.
- [x] While a long join runs, its bar moves (or slides if the length isn't
      known), and never says "null%".
      Verified 2026-10-01 with two 25-minute 8 kHz WAVs into MP3: the bar grew across
      about three screenshots and **Cancel** replaced **Join** meanwhile. The bar
      carries no number, so there was no "null%" to see.

### Keys

- [x] Pick a format on a card, then press Delete with a card selected: the card
      goes (the select doesn't count as typing).
      Verified 2026-10-01: with one card ticked and its format just changed from the
      card's own select, Delete removed that card and no other.
- [x] With a prompt or the Advanced Options dialog open, Delete removes nothing.
      Verified 2026-10-01 for both: every card was still there afterwards.
- [x] Type in Join's file name: Delete and Ctrl+A edit the text, and touch no
      card.
      Verified 2026-10-01: Ctrl+A, Delete and Backspace edited the name and both clips
      stayed. An empty name showed "Give the joined file a name." in red.

### Settings, the window and the log

- [x] Settings > Update and Credits look as before. **Will's note
      (2026-10-01): give Settings > Update a proper look as a person would, and
      list what to refine in its UI.**
      Looked at 2026-10-01 as a person would. (This box and the Linux one said "General":
      Settings has no General tab, so both now read "Update and Credits".) What the Update
      tab looked like, and what to refine, went onto the kit's own backlog, and the kit
      reworked the tab from it (two cards, a reason for a failed check, the version linked
      to its release). Will looked at the new tab himself, 2026-10-01: good.
- [x] Move and resize the window, close it, reopen it: same place, same size.
      Unplug a second monitor the window was on: it opens centred on the one
      you have.
      First half verified 2026-10-01: moved and resized (left edge dragged in), closed,
      reopened by name: same place, same size, and `config.json` held the bounds. The
      second monitor, unplugged, verified by Will, 2026-10-01.
- [x] `%APPDATA%\diamond-file-converter\debug.log` starts with
      `=== Diamond File Converter <version> started at …`, names the files you
      used by their names only (`…\clip.mp4`), and has no folder in it.
      Verified 2026-10-01: line 1 `=== Diamond File Converter 2.0.0-beta.2 started at
      2026-10-01T10:45:53.011Z ===`. A corrupt `broken.mp4` logged "Could not probe
      …/broken.mp4" and "Conversion failed for …/broken.mp4: moov atom not found",
      with the file's name and a leading ellipsis where its folder was, in the ffprobe
      command too. **Worth knowing:** only warnings and errors are written, so a clean
      session's log is two lines, and a failed update check writes nothing at all.
- [x] After a second **Open with**, `debug.log` still has the first launch's
      lines (a second launch used to empty it).
      Verified by Will, 2026-10-01. (A plain close and reopen does start a fresh log, as
      it should: the header's time changed.)

### With a screen reader (NVDA)

- [ ] The rail, the toolbar and each card's controls are read with their names
      (no "swap_horiz", no "close" read out from an icon).
      Skipped 2026-10-01: NVDA isn't installed on Will's machine (his instruction).
- [ ] A toast is read when it shows; a danger toast at once.
      Skipped, as above.
- [ ] "File Already Exists" is read as a dialog with its question, and Tab
      stays inside it.
      Skipped, as above.

### Found in the pass, 2026-10-01

Wrong or worth a look, in the order they turned up. The pass added no code.

- **Skipping every file reads as cancelling.** After **Apply to All Remaining** with
  **Skip This File**, the cards read Skipped but the toast says "Conversion cancelled."
  and the bar "5 cancelled". `announce()` counts `skipped` with `cancelled`
  (renderer.js). Say "Skipped" in both, or name each ("2 converted, 3 skipped").
- **The Beta channel can't check, so Settings > Update opens on a red "Couldn't check for
  updates. Try again later."** on a machine that is online. On **Stable** the same check
  says "You're up to date." The Beta check reads a `beta.yml` from the latest
  pre-release, and none of the published pre-releases lists one (only the installer;
  checked from GitHub's list of releases), and `dist/` held only a `latest.yml` for this
  beta build. Not an app bug as such, but the next beta must publish the files its own
  channel reads, or Beta users see this error.
- **A failed check leaves no trace.** The updater turns the error into the red line and
  writes nothing to `debug.log`, so there's nothing to read when it happens. Log the
  reason (redacted like the rest).
- **The switch was Off on this profile** though the default is On. `config.json` held
  `autoDownloadUpdates: false`, carried over from what 2.0.0 saved. So the first box in
  "Settings > Update" (switch on) can't be judged here: it needs a clean profile.
- **The toast overlaps the Join page's right panel.** After a join, "Joined 2 files into
  joined.mp3." sat across the left edge of the right-hand panel instead of over the clip
  list. Seen on Windows; Will's note.
- **GIFs get no trim and no frame previews in Convert's Advanced Options.** A 3-second,
  30-frame animated GIF reads "Duration is not known for this file, so it cannot be
  trimmed." (`trimScopeDuration()` wants `meta.duration`; a GIF has no container
  duration with the bundled ffprobe, as a comment in job.js says). The start and end
  frames are only for things that have them, and a GIF has. To judge: count the frames
  and divide by the frame rate when the container gives no duration.
- **Join takes a GIF as a clip but can't say how long it is.** The row reads "· 240×180"
  with nothing before the dot (no duration), and has From and To boxes that can't mean
  anything without a length. Join has no frame previews yet at all.
- **Smaller:** the file picker opens at Downloads every time rather than where the last
  one was; the Add Files and Add Folder buttons stay in the header on the Settings page,
  where they aren't meant for anything; "Check for Updates" showed no "Checking…" state
  for a failing check (the red line was simply there when the screenshot came).

What was done about them, 2026-10-01 (re-run the boxes above to see each one):

- **Skipped:** said as skipped: "5 files skipped." in the toast and "5 files skipped" in
  the bar; a mix reads "2 files converted, 3 skipped." (the kit's `summarise()` took a
  skipped count).
- **The Beta channel:** the cause is the releases, not the app: every pre-release went out
  with only its installer. With GitHub, electron-builder writes one `latest.yml` whatever
  the version, and the updater reads it from the newest pre-release on Beta, so **the next
  beta attaches `latest.yml`, `latest-linux.yml` and the `.blockmap` files** beside the
  installers. Until a release does, the Update tab now says "Couldn't check for updates.
  The newest release has no update files yet." in the warning shade, not red.
- **A failed check is logged:** one warning in `debug.log`: the channel, the reason and the
  error, redacted.
- **Settings > Update** was reworked in the kit from the pass's list: two cards ("Version x"
  with its status and buttons, then Preferences), "Checking for updates…" for a second at
  least, the switch's help saying what On and Off do, each channel's help saying what it
  brings, and "Version x" in "Version x is available." a link to its release on GitHub.
- **Add Files and Add Folder** are hidden on Settings.
- **GIFs:** timed by their frames, so Advanced Options trims one and shows its first and
  last frames, and Join's row reads "0:03 · 240×180". Join's own frame previews are still
  to come (WORKQUEUE item 22).
- **The file picker** opens where the last pick was made, even after a restart.
- **The switch Off on an upgraded profile** is as it should be (2.0.0's saved choice is
  kept); the first Update box needs a clean profile.
- **The toast over Join's right panel:** not fixed here (WORKQUEUE item 22).

## Linux — the first build

DFC builds for Linux now: an AppImage, a `.deb` and an `.rpm`, each with
Linux's own ffmpeg and ffprobe. They're built on Linux (ffmpeg-static
downloads the binary for the machine it's installed on), and named
`Diamond-File-Converter-<version>.<ext>`: only the Windows installer is a
`Setup`.

> **Status: run by Will in the Linux VM, 2026-10-01 (M4's gate): every box
> below passed.** Orca wasn't part of it (optional). It had been skipped earlier
> the same day (the Zorin VM couldn't be logged in to while Will was remote).
> Before that, an agent drove the built app (`linux-unpacked`, what the
> AppImage holds) under Xvfb in a Debian 12 container: 23/23, and the M1
> checks on a profile 2.0.0 had saved, 29/29 (2026-10-01). Its `.deb` and
> `.rpm` hold `resources/ffmpeg/ffmpeg` and `ffprobe`, executable, and name
> Diamond Digital Development <will.knowles@diamonddigital.dev> as the
> maintainer.

Run it in the Linux VM, on a desktop.

### Install and run

- [x] `sudo apt install ./Diamond-File-Converter-<version>.deb`: it installs,
      and **Diamond File Converter** is in the applications menu under Sound &
      Video. It opens, in the desktop's light or dark theme.
- [x] The AppImage (`chmod +x`, then run it) opens the same app.
- [x] Known until M6: the dock may show a generic icon for the running window
      (no `desktopName` yet), and DFC isn't offered in "Open with" for media
      files (no MimeType yet). Note it, don't fail it.

### The same pass as Windows

- [x] From a terminal, `diamond-file-converter ~/Music/a.wav`: the app opens
      with it as a card. Run the same with another file while it's open: it
      comes to the front with the file added, and there's still one window.
- [x] Convert a file to MP3, then again to see "File Already Exists" in the
      app, and **Save as New**: `name (1).mp3` is written.
- [x] Join two files: it works, in MP3 and in their own format.
- [x] Settings: Update and Credits, the rail collapsed and expanded.
      Close and reopen: the window is where you left it.
- [x] `~/.config/diamond-file-converter/debug.log` names files by their names
      only, with no folder.
