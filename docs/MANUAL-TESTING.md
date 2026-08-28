# Manual Testing Checklist

Steps a human needs to perform, covering what automated tests cannot judge:
whether something *looks* right, *feels* right, and behaves correctly against
the real filesystem, real dialogs and real Windows integration.

A new section is appended for each version or fix. Do not rewrite earlier
sections — the history is useful.

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

First release of the rebuilt interface. The whole UI changed, so this pass is
broad rather than targeted.

### Window and first run

- [ ] App opens at roughly 1100×780 on a clean profile.
- [ ] Window cannot be resized below about 720×560.
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

## 2.0.0-alpha.2 — New Job dialog

Per-file encoding settings. The engine already supported all of this; this pass
exposes it. **The plain path must stay two clicks** — check that first.

### The simple path is not disturbed

- [ ] Drop a folder of images, pick one format in the bulk bar, press Convert.
      Still two clicks. The dialog must not be required for this.
- [ ] The per-card format dropdown still works on its own.

### Opening the dialog

- [ ] **New Job** in the top-right is disabled with an empty grid, enabled once
      files are queued, and disabled again while a conversion runs.
- [ ] With nothing selected it opens for every file and the subtitle reads
      "Configuring N files".
- [ ] With cards selected it opens for just those.
- [ ] The tune icon on a card opens it for that one file only, and does not
      change the selection.
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

### Presets

- [ ] Configure something, **Save as…**, give it a name. It appears in the
      Preset dropdown.
- [ ] Change the fields, then re-select the preset — your saved values come
      back, including the target format.
- [ ] **Delete** removes it, and it is gone after reopening the dialog.
- [ ] Presets survive restarting the app.

### Output routing

- [ ] Destination **A folder I choose** reveals a Browse button; picking a
      folder puts the path in the field.
- [ ] Convert and confirm the output lands in that folder, not next to the
      source.
- [ ] A name template of `{name}-web` produces `something-web.mp4`.
- [ ] **If it already exists** set to Overwrite converts without prompting.
