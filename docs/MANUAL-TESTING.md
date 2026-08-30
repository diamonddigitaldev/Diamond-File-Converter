# Manual Testing Checklist

Steps a human needs to perform, covering what automated tests cannot judge:
whether something *looks* right, *feels* right, and behaves correctly against
the real filesystem, real dialogs and real Windows integration.

A new section is appended for each version or fix. Do not rewrite earlier
sections — the history is useful.

> ### Read the status line on each section
>
> **2.0.0-alpha.3 has been run in full and passed.** Earlier sections were
> deliberately held until the UX direction settled, and one section is marked
> **WITHDRAWN** because the feature it covers was removed.
>
> A written checklist is not a passed one. Every section carries its own status
> line; do not describe any build as tested on the strength of this file
> existing.

**Before starting:**

```
npm install
npm test          # expect 126 passing, 0 failing
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

> **Status: not started.** Written 2026-08-28, awaiting UX sign-off before the
> pass begins. Nothing below has been executed.


First release of the rebuilt interface. The whole UI changed, so this pass is
broad rather than targeted.

### Window and first run

- [ ] App opens at roughly 1100×780 on a clean profile.
- [ ] Window cannot be resized below 880×600. *(Raised from 720×560 in
      alpha.4 — below roughly 800px wide the selection bar clipped its own
      buttons.)*
- [ ] Resize and move the window, close and reopen — position and size are
      remembered.
- [ ] Menu bar shows **Menu** and **Credits**.
- [ ] `Menu → Open Files` opens a file dialog filtered to supported types.
- [ ] `Menu → Open Folder` opens a folder picker.
- [ ] `Ctrl+O` opens the file dialog; `Ctrl+Shift+O` opens the folder picker.
- [ ] `Credits` opens a modal window; it cannot be minimised; `Escape` closes
      it; the version number shown matches `package.json`.
- [ ] Credits links (Diamond Digital, TheFuturisticIdiot, Donate, GitHub) all
      open in the external browser, not inside the app.

### Empty state and ingest

- [ ] Empty state shows the dashed drop zone, centred.
- [ ] Hovering the drop zone tints it; the tint does **not** persist after the
      pointer leaves.
- [ ] Clicking the drop zone opens the file dialog. Clicking the **Select
      Files** button inside it opens the dialog exactly once, not twice.
- [ ] Drag a file over the window — the target area highlights. Drag out again
      without dropping — the highlight clears. It must not flicker while moving
      across cards.
- [ ] Drop a single file: a card appears immediately.
- [ ] Drop a folder containing nested subfolders: files from subfolders are
      included, not just the top level.
- [ ] Drop a folder containing an unsupported file: a toast reports how many
      were skipped. **Nothing may be discarded silently.**
- [ ] Drop the same file twice: it is not duplicated.
- [ ] Drop a file onto the very edge of the window, outside the grid: the app
      must **not** navigate away or replace itself with the file.

### Cards and metadata

- [ ] Each card shows a kind icon (video / audio / image), the filename, and a
      metadata line.
- [ ] Metadata fills in shortly after the card appears — resolution, duration,
      codec and size. A card must never wait on this to render.
- [ ] Hover a card: the background lightens slightly and the border tints.
- [ ] A long filename truncates with an ellipsis and does not push the remove
      button out of the card.
- [ ] Hovering a truncated filename shows the full path as a tooltip.
- [ ] The × button removes just that card.
- [ ] Drop an MP3 that has embedded cover art: it is treated as audio, with no
      resolution shown.

### Text selection *(regression: filenames used to highlight on click-drag)*

- [ ] Click and drag across a card's filename — **no text highlights.**
- [ ] Same for the metadata line, the status text, the app title, the bulk bar
      and the action bar.
- [ ] Text inside a real input field can still be selected and edited.

### Selecting cards

- [ ] Click a card: it is selected and the bulk bar switches to "N selected".
- [ ] Ctrl+click a second card: both selected.
- [ ] Shift+click a third: the range between them is selected.
- [ ] `Ctrl+A` selects every card; `Escape` clears the selection.
- [ ] `Delete` removes the selected cards.
- [ ] Click the checkbox in a card's top-left corner: it toggles only that card
      and leaves the rest of the selection alone.
- [ ] With some but not all cards selected, the select-all checkbox in the bulk
      bar shows a dash (indeterminate), not a tick.
- [ ] Ticking select-all selects everything; unticking clears it.
- [ ] Click the empty grid background: the selection clears.

### Choosing formats

- [ ] With nothing selected, the bulk bar reads **"All N files"** and
      **"Convert all to"**.
- [ ] **The two-click flow:** drop a folder of images, choose one format from
      the bulk bar, press Convert. Nothing else should be required. *(This is
      how the previous version worked and must stay this quick.)*
- [ ] With cards selected, the bar reads "N selected" / "Convert selected to",
      and **Remove** and **Deselect** appear.
- [ ] A per-card dropdown changes only that card.
- [ ] Select a video and an audio file together: the bulk dropdown offers only
      formats both can produce, and never a video-only container like MKV.
- [ ] Select a video and an image together: no shared format exists, so the
      dropdown is empty and the bar explains why.
- [ ] Choose a format, then pick **"Choose format…"** again: the card returns to
      the amber "Choose a format" state and Convert disables again.
      *(Regression: this previously did nothing.)*
- [ ] Convert stays disabled until at least one card has a format.
- [ ] The footer detail line reads **"1 file still needs a format"** for one and
      **"2 files still need a format"** for two. *(Regression: used to read
      "1 still need a format".)*

### Converting

- [ ] Queue several files, choose formats, press Convert.
- [ ] More than one file converts at once — cards show progress simultaneously.
- [ ] Each card shows its own progress bar advancing.
- [ ] A file with no readable duration (a still image) shows a moving
      indeterminate bar, **never a bar frozen at 0%**.
- [ ] The overall bar at the bottom is **accent green, not blue**, and matches
      the card bars.
- [ ] While converting, the Convert button is replaced by **Cancel** — the two
      never appear side by side.
- [ ] Per-card **Cancel** stops just that file; the others carry on.
- [ ] Footer **Cancel** stops everything.
- [ ] Cancel a job mid-run, then check the output folder: **no partial file is
      left behind.**
- [ ] On completion a success toast appears and the footer summary reads the
      outcome (e.g. "3 files converted"), **not** "3 files queued".
      *(Regression: it used to revert to "queued".)*
- [ ] Completed cards offer **Show in folder**; clicking it reveals the file in
      Explorer.
- [ ] Output lands next to the source file, with the correct extension.

### Conversions worth checking individually

- [ ] Video → video (MP4 → MKV): plays correctly.
- [ ] Video → audio (MP4 → MP3): audio only, correct duration.
- [ ] Video → GIF: **colours look correct**, not a muddy 256-colour mess.
- [ ] Video → PNG: output is a **folder** of numbered frames, and the card says
      how many frames — "1 frame" for one, "12 frames" for twelve.
- [ ] Animated GIF → PNG: also produces a folder of frames.
- [ ] Image → image (PNG → JPG): correct, and transparency is flattened.
- [ ] Audio → audio (FLAC → MP3): correct duration and audible quality.

### Failure handling

- [ ] Convert the deliberately corrupt file. It must fail **without a blocking
      dialog**.
- [ ] The failing card turns red and shows the real ffmpeg reason, not a
      generic message.
- [ ] Other files in the same batch keep going.
- [ ] A **Retry** button appears on the failed card and works after changing the
      format.
- [ ] Convert to a format whose output already exists: a prompt offers Cancel /
      Overwrite / Save as New, and each behaves as labelled.
- [ ] Convert to a read-only folder: fails with a clear message rather than
      hanging.

### Toasts

- [ ] Toasts appear centred below the header and **do not cover the app title
      or the Add Files / Add Folder buttons.**
- [ ] The icon lines up with the first line of text — check specifically on a
      long wrapped message, where the icon must stay on the first line.
- [ ] The × dismisses a toast; toasts auto-dismiss after a few seconds.
- [ ] Several toasts stack rather than overlapping.
- [ ] A failure toast stays until dismissed.

### Appearance

- [ ] Switch Windows to light mode: the app follows without restarting.
- [ ] Switch back to dark: it follows again.
- [ ] **In light mode**, the Convert button is accent green, **not Bootstrap
      blue**. *(Regression: it was blue in light mode.)*
- [ ] Clear All, Cancel and Convert are all the same height where they sit
      together. *(Regression: Clear All was shorter.)*
- [ ] Resize the window narrow and wide: cards reflow, and the page never
      scrolls sideways.
- [ ] With many files queued, the grid scrolls and the header, bulk bar and
      action bar stay put.

### Windows integration *(packaged build only)*

```
npm run build
```

- [ ] Installer runs and the app launches from the Start menu.
- [ ] `resources/ffmpeg/` in the install directory contains **both**
      `ffmpeg.exe` and `ffprobe.exe`.
- [ ] Right-click a media file in Explorer: **"Convert with Diamond File
      Converter"** appears and opens the app with that file queued.
- [ ] Right-click a *folder*: the same entry appears and queues its contents.
- [ ] Select several files in Explorer and use the entry: they arrive as **one
      batch**, not one window per file.
- [ ] With the app already running, use the Explorer entry again: files are
      added to the existing window rather than opening a second one.
- [ ] Double-click an associated media file: it opens in the app.
- [ ] Uninstall, then right-click a media file: the context-menu entry is
      **gone**. A leftover entry is a bug.

### Security posture

- [ ] Open DevTools (in a dev run) and check the console on both the main and
      credits windows:
  - [ ] `window.electronAPI` is defined
  - [ ] `window.require` is `undefined`
  - [ ] `window.process` is `undefined`
- [ ] No errors in the console during a normal session.

---

## 2.0.0-alpha.1 — QA fixes

> **Status: not started.** Written 2026-08-28, awaiting UX sign-off before the
> pass begins. Nothing below has been executed.


Two defects found running the checklist above against the packaged build, plus
the updater behaviour for pre-releases. **Test these against a packaged build,
not `npm start`** — the Escape defect only appeared once packaged.

### Credits window closes on Escape

- [ ] Open Credits from the menu (or press `C`).
- [ ] Press **Escape** — the window closes.
- [ ] Open it again, click a link or a button first so focus has moved inside
      the page, then press Escape — it still closes.
- [ ] The × button still closes it too.
- [ ] The window still cannot be minimised.

### Existing output prompts instead of silently renaming

- [ ] Convert a file to a format whose output already exists in the
      destination. A **File Already Exists** prompt appears offering
      **Cancel / Overwrite / Save as New**.
      *(It previously wrote "name (1).ext" with no prompt at all.)*
- [ ] **Cancel** — the job is abandoned and the existing file is untouched.
- [ ] **Overwrite** — the existing file is replaced.
- [ ] **Save as New** — a numbered file appears alongside the original, and
      the original is untouched.
- [ ] Queue several files that all collide. Tick **"Apply to all remaining
      files"** and choose one option — the prompt appears **once**, and the
      rest follow that choice without asking again.
- [ ] Start a second batch afterwards: the prompt appears again. The
      apply-to-all choice must not carry over between runs.

### Updates never offer a pre-release

The app currently ships as `2.0.0-alpha.1` while the latest stable is `1.0.0`.

- [ ] `Menu → Check for Updates` while running the alpha reports **"You're up
      to date!"**, not an offer to install `1.0.0`. Going backwards to an older
      stable is a downgrade and must be refused.
- [ ] It does **not** offer any other alpha or beta, even a newer one.
- [ ] No update prompt appears on its own a few seconds after launch.
- [ ] On a stable build, a newer stable release *is* still offered normally —
      this must not have broken ordinary updates.
- [ ] "View Changelog" from an update dialog opens the correct release page.

---

## 2.0.0-alpha.2 — Advanced options / Bulk edit

> **Status: not started.** Written 2026-08-28, awaiting UX sign-off before the
> pass begins. Nothing below has been executed.


Per-file encoding settings. The engine already supported all of this; this pass
exposes it. **The plain path must stay two clicks** — check that first.

### The simple path is not disturbed

- [ ] Drop a folder of images, pick one format in the bulk bar, press Convert.
      Still two clicks. The dialog must not be required for this.
- [ ] The per-card format dropdown still works on its own.

### Opening the dialog

- [ ] There is **no button in the top-right corner** for this — it lives in the
      green selection bar.
- [ ] With nothing selected the bar reads **"Select all"** and the button reads
      **"Edit all"**; it opens for every file.
- [ ] With cards selected the button reads **"Bulk edit"** and opens for just
      those, titled **"Bulk edit"**.
- [ ] The tune icon on a card opens it for that one file only, titled
      **"Advanced options"**, and does not change the selection.
- [ ] Bulk editing files that already have *different* settings starts blank and
      says they are configured differently, rather than showing one file's
      values as if they applied to all.
- [ ] The word "job" appears nowhere in the interface.
- [ ] Escape and the × both close it without applying anything.

### Controls follow the target format

- [ ] Choose an **audio** target (MP3): the Video section disappears entirely.
- [ ] Choose an **image** target (PNG): the Audio section disappears and an
      Image quality slider appears. Trim disappears for a still image.
- [ ] Choose **GIF**: Trim stays available, because a GIF can be animated.
- [ ] Choose **WebM**: the codec list offers VP9/VP8/AV1 and **not** H.264.
- [ ] Choose **MP4**: it offers H.264/H.265/AV1 and **not** VP9.
- [ ] Choose **MP3**: the audio codec list offers only MP3.
- [ ] Set Stream to **Copy without re-encoding**: codec, quality, resize and
      frame rate all disappear, since none of them apply to a remux.
- [ ] Set Stream to **Remove video**: same, and the preview gains `-vn`.
- [ ] Pick a codec with no constant-quality mode (MPEG-4 in AVI): Quality
      switches to bitrate and locks. Switch back to H.264 — it must return to
      **Constant quality**, not stay stuck on bitrate.
- [ ] Select a video and an image together: no shared format exists, the target
      list is empty and the dialog says so.

### Command preview

- [ ] The preview updates as you change controls, and starts with `ffmpeg`.
- [ ] It reflects what you set — a CRF of 20 appears as `-crf 20`, a resize as
      `scale=...`, a trim as `-ss`.
- [ ] The preview text can be selected and copied. *(It is the one deliberate
      exception to nothing-is-selectable.)*
- [ ] An invalid combination shows a red message and disables **Apply**.

### Trim slider

- [ ] Trim is a **two-point slider**, not a pair of text boxes.
- [ ] Drag the left handle right and the right handle left; the green range
      between them shrinks and the readout shows the kept duration.
- [ ] The handles **cannot cross**.
- [ ] **Hold Shift while dragging** — the handle moves much more slowly for the
      same pointer movement, so a precise point is reachable.
- [ ] Click a handle and use the arrow keys; Shift+arrow gives a smaller step.
      Home and End jump to the extremes.
- [ ] Leave the handles alone and Apply: **no trim is recorded**, and the card
      shows no trim in its summary.
- [ ] Open advanced options on a file with no readable duration: the slider is
      replaced by a note saying it cannot be trimmed.
- [ ] Bulk edit a selection of clips of different lengths: the slider spans the
      **longest**, and a trim past a shorter clip's end simply runs to its end.

### Button styling

- [ ] The dialog's **Cancel is outlined, not filled** — only Apply is filled.
      Two filled buttons side by side is a design violation.

### Applying

- [ ] Apply, then check the card: a green summary line appears under the
      metadata describing what was set, e.g. "H.264 · CRF 20 · 1280×720".
- [ ] Open the dialog again on that card — your settings are still there.
- [ ] Apply with nothing changed: the card gains **no** summary line. Untouched
      settings must not be baked in.
- [ ] Apply to a multi-file selection: every selected card gets the summary.
- [ ] Convert, and confirm the output honours the settings — check the
      resolution, duration and audio channels of the result, not just that a
      file appeared.

### Nothing is clipped

Fixed widths on a `<select>` cut the selected option off with no ellipsis and
no scrollbar — the text just disappears. Check at a few window sizes.

- [ ] In Video, the Quality dropdown reads **"Constant quality"** in full, not
      "Constant qual…".
- [ ] The Resize fit dropdown reads **"Contain"** in full, not "Contai".
- [ ] Type `1920` and `1080` into Resize — both are fully readable.
- [ ] Widen and narrow the window: no label, dropdown or field ever cuts text
      off mid-word. Filenames on cards are the one exception — those ellipsis
      deliberately.
- [ ] Repeat with an audio target and an image target, where different controls
      are on screen.

### Output routing

- [ ] Destination **A folder I choose** reveals a Browse button; picking a
      folder puts the path in the field.
- [ ] Convert and confirm the output lands in that folder, not next to the
      source.
- [ ] A name template of `{name}-web` produces `something-web.mp4`.
- [ ] **If it already exists** set to Overwrite converts without prompting.

---

## 2.0.0-alpha.2 — Processing mode (Manual settings / Pipeline) — WITHDRAWN

> **Status: WITHDRAWN 2026-08-30. Do not run this section.** Pipelines were
> removed from the application: too complex for what the app is for, and the
> editor built on top of them in alpha.4 was unintuitive in use. There is no
> processing-mode chooser any more — a file is configured by hand, full stop.
> Kept here as a record of what was tried, not as work to do.

A card is configured **either** by hand **or** by a saved pipeline, never both.
The chooser is two tiles at the top of the advanced options dialog.

### The tiles

- [ ] Open advanced options on a card. **Manual settings** is selected by
      default and its icon is accent-coloured.
- [ ] The tiles sit side by side, equal width, and do not wrap.
- [ ] Hover an unselected tile: the border tints and the background washes,
      matching the card grid.
- [ ] The selected tile has an accent border that looks slightly thicker than
      the unselected one, and **selecting a tile must not shift the layout** —
      nothing beside it should move by a pixel.

### Keyboard

- [ ] Tab into the dialog: an unlocked tile can take focus and shows a focus
      ring.
- [ ] With a tile focused, press **Enter** — it becomes the active mode.
- [ ] Press **Space** on the other tile — same.
- [ ] A locked tile is **skipped** when tabbing.

### One or the other

- [ ] Choosing **Pipeline** hides Video, Audio, Image and Trim entirely and
      shows the pipeline picker.
- [ ] Choosing **Manual settings** reverses it.
- [ ] Click the **already active** tile — nothing happens. There is no state
      where neither is selected.

### Locked until there is something to pick

With no pipelines saved (a clean profile):

- [ ] The **Pipeline** tile is greyed out and cannot be clicked.
- [ ] Hovering it explains why: *"No pipelines saved yet"*.
- [ ] The pipeline section says you have not built any pipelines yet.

### Lossless switching

- [ ] Set a CRF and a resize in Manual settings, Apply.
- [ ] Reopen, switch to **Pipeline**, pick one, Apply. The card now names the
      pipeline **instead of** the manual settings.
- [ ] Reopen and switch back to **Manual settings** — your CRF and resize are
      **still there**. Switching modes must never lose work.

### A pipeline that goes missing

- [ ] Assign a pipeline to a card, then delete that pipeline.
- [ ] The card reads **"Pipeline missing"** in amber, the same treatment as a
      card with no format chosen.
- [ ] **Convert is disabled** while any card is in that state.
- [ ] The card does **not** quietly fall back to the manual settings it still
      holds — converting with settings the user did not ask for would be worse
      than refusing.

### Converting through a pipeline

- [ ] A card in pipeline mode converts, and the output reflects what the
      pipeline does rather than the dialog's manual fields.
- [ ] The command preview in the dialog shows the compiled pipeline, including
      a `-filter_complex`.
- [ ] Check the preview's `-map` arguments: a **filtered** stream appears as
      `[v0]` with brackets, an **untouched** stream as `0:a` **without** them.
      Brackets on an unfiltered stream make ffmpeg fail to open the output.

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

- [ ] Pick a format from **any card's dropdown**. Without clicking anything
      else, press **Ctrl+A** — every card is selected.
- [ ] Repeat, and press **Escape** — the selection clears.
- [ ] Repeat with one card selected, and press **Delete** — the card is
      removed.
- [ ] Click a card's **checkbox** (a checkbox is an `<input>` too), then press
      Escape, Delete and Ctrl+A — all three still work.
- [ ] Click into a **text field** (the resize width, or the name template) and
      press Delete — it edits the text and does **not** remove any cards.
- [ ] Open **Advanced options**, select some text in a field, press Escape —
      the dialog closes and the cards behind it are untouched.
- [ ] With the dialog open and cards selected behind it, press **Delete** —
      nothing is removed.

### Convert no longer re-runs a finished batch

- [ ] Queue several files including one that will fail. Convert.
- [ ] Fix the failed card's format and press **Convert** again. Only that card
      runs. Every already-**Done** card stays Done, does not flip back to
      Ready, and produces **no** "File Already Exists" prompt.
- [ ] The **Retry** button on a single card still re-runs just that card.
- [ ] Once every card is Done, the **Convert button is disabled** rather than
      enabled and doing nothing.
- [ ] Add a new file to a finished queue: Convert enables again and runs only
      the new file.

### "Apply to all remaining files" actually applies

Jobs run through a concurrency pool, and several used to reach the prompt at
once — each opening its own dialog before the first answer was recorded, so
the tick had no effect on the dialogs already queued behind it.

- [ ] Queue **at least six** files that all collide with existing output.
      Convert.
- [ ] Only **one** prompt is on screen at a time.
- [ ] Tick **"Apply to all remaining files"** and choose **Overwrite** — no
      further prompts appear, and every file is overwritten.
- [ ] Repeat with **Save as New**, and again with **Cancel**. Each choice
      carries to the rest of the batch.
- [ ] Start a second batch afterwards — the prompt appears again. The choice
      must not carry between runs.

### Advanced options: the codec you pick is the codec you get

One defect caused both of the dialog bugs reported. The codec selects were
rebuilt from the value the dialog opened with, so a pick was overwritten
immediately — dropping it on Apply, and leaving Quality apparently stuck
because the effective codec fell back to the container default.

- [ ] Target **AVI**, set Codec to **MPEG-4**. Quality switches to **Target
      bitrate** with its explanatory note. Reopen the Codec dropdown — it
      reads **MPEG-4**, not "Format default".
- [ ] Now set Codec to **H.264**. Quality returns to **Constant quality** and
      the CRF field comes back.
- [ ] Switch between MPEG-4 and H.264 several times — it tracks every time.
- [ ] Set a CRF, Apply, and reopen — the codec and the CRF are both still
      there, and the card's summary names the codec you chose.
- [ ] Convert, then ffprobe the output: it really is the codec you picked.
- [ ] Same check on the **audio** codec select, and on the **encoder preset**
      (it is rebuilt the same way).

### An unreadable file says so

- [ ] Queue a deliberately corrupt file (rename a `.txt` to `.mp4`).
- [ ] Its metadata line settles on **"MP4 · unreadable"** within a second or
      two. It must not sit on "Reading…" indefinitely.
- [ ] A healthy file still shows its real resolution, duration, codec and size.

### DevTools are reachable again

Replacing Electron's default menu removed its F12 accelerator along with it.

- [ ] **Menu → Toggle Developer Tools** opens DevTools.
- [ ] **F12** does the same.
- [ ] With DevTools open, use the app normally — drop files, choose formats,
      open the dialog, convert. **The console shows no errors.** *(This was
      unverifiable in the first pass and is still unverified.)*

### Credits window

The Escape handler was verified working in isolation; what was missing was a
guard against opening the window more than once.

- [ ] Open Credits, press **Escape** — it closes.
- [ ] Open Credits **five times in a row** from the menu. Only one window ever
      exists; the others just focus it.
- [ ] After those five opens, press **Escape once** — the window closes and
      there is **no second window behind it**.
- [ ] Open Credits, click **View Source Code on GitHub** (the browser takes
      focus), click back on the Credits window, then press Escape — it closes.
- [ ] The × button still closes it, and it still cannot be minimised.

### Still unconfirmed — needs the reporter's exact sequence

Two reported defects could not be reproduced. Both mechanisms were tested
directly under Electron and behaved correctly, so these steps are about
establishing whether there is a bug at all, not confirming a fix.

- [ ] **Live theme change.** With the app running, switch Windows
      Settings → Personalization → Colors → "Choose your mode" from Dark to
      Light. The app follows **without a restart**. Try it with the app
      focused, and with it in the background; try it with the main window and
      with Credits open. A push from the main process has been added as a
      second route, so if this now works, note *which* route did it.
- [ ] **Escape on Credits.** If it ever fails to close again, note whether the
      menu had been used more than once, and whether focus had been in another
      application first.

---

## 2.0.0-alpha.4 — pipelines removed, window minimum raised

> **Status: not started.** Written 2026-08-30.

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

- [ ] The window will not resize below **880×600** in either direction.
- [ ] At exactly the minimum, with several files queued and all selected:
      the selection bar fits, **no button is cut off at the right edge**, and
      the Deselect button is fully visible.
- [ ] At the minimum the footer still shows the summary, the progress bar and
      all three buttons without overlap.
- [ ] At the minimum at least one full row of cards is visible in the grid.
- [ ] Collapse the rail at the minimum size — nothing reflows badly.
- [ ] An existing install that had a smaller window remembered will open at or
      above the new minimum rather than at the old saved size.

### Nothing offers a pipeline any more

- [ ] The rail shows **Files** only. There is no Pipelines item.
- [ ] Open **Advanced options** on a card. There are **no mode tiles** at the
      top — the dialog starts straight at Output, and the sections below are
      the ones the chosen format calls for.
- [ ] There is no "Use pipeline" dropdown and no link to any editor anywhere.
- [ ] No card ever reads "Choose a pipeline" or "Pipeline missing".
- [ ] Every card with a format reads **Ready**.
- [ ] The settings summary under a card shows the manual settings applied to
      it, and is blank when none have been.

### An existing install that had pipelines saved

Worth doing on a profile that ran alpha.4's first build, if you still have one:

- [ ] The app opens normally with no error.
- [ ] Cards that were previously set to use a pipeline now behave as ordinary
      cards: they take their manual settings and convert.
- [ ] Nothing in the interface refers to the pipelines that were saved.

### The rail still works with one destination

- [ ] Clicking **Files** when already on Files does nothing awkward.
- [ ] Collapse and expand still work, and the choice survives a restart.
- [ ] Keyboard: Tab reaches the rail items, each takes a focus ring, Enter
      activates.

### Everything else still behaves

This is the regression sweep — all of it worked in alpha.3 and must still:

- [ ] Drop files and folders; unsupported files are reported, not discarded.
- [ ] Selection: click, ctrl+click, shift+click, Ctrl+A, Escape, Delete.
- [ ] The two-click flow: drop a folder, pick one format in the bulk bar,
      Convert.
- [ ] Per-card format dropdowns, and clearing one back to "Choose format…".
- [ ] Advanced options: output routing, name template, conflict policy, video
      and audio settings, image quality, the trim slider.
- [ ] The codec you choose is the codec you get, and it survives Apply and
      reopening. *(The alpha.3 fix — it lived next to the removed code.)*
- [ ] The live command preview updates as you change settings.
- [ ] Convert several files at once; per-card progress and per-card cancel.
- [ ] A failing file marks its own card and the queue carries on.
- [ ] "Apply to all remaining files" on an output conflict.
- [ ] Convert does not re-run already-finished cards.
- [ ] Toasts, Credits, F12 Developer Tools, and both themes.
