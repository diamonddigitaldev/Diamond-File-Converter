<div align="center">
   <img alt="Diamond File Converter Logo" src="./docs/img/diamondfileconverter.png" style="width:100px;height:auto;margin-bottom:1rem;" />

   # Diamond File Converter

   <p style="margin-bottom:1rem;">An Electron-based desktop app for converting audio, video, and image files.</p>

</div>

<div align="center">

  ![license](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)
  ![version](https://img.shields.io/badge/version-1.0.0-brightgreen?style=flat-square)
  ![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey?style=flat-square)

  [![discord](https://img.shields.io/discord/667479986214666272?logo=discord&logoColor=white&style=flat-square)](https://diamonddigital.dev/discord)
  [![buy me a coffee](https://img.shields.io/badge/-Buy%20Me%20a%20Coffee-ffdd00?logo=Buy%20Me%20A%20Coffee&logoColor=000000&style=flat-square)](https://www.buymeacoffee.com/willtda)

</div>


## Features

- <b>Audio Conversion</b> | Convert between MP3, WAV, FLAC, OGG, AAC, M4A, OPUS, and WMA.
- <b>Video Conversion</b> | Convert between MP4, MKV, WebM, AVI, MOV, WMV, and FLV.
- <b>Image Conversion</b> | Convert between JPG, PNG, WebP, GIF, BMP, and TIFF.
- <b>Drag & Drop</b> | Drop a file onto the app or use the file browser to get started.
- <b>Bundled FFmpeg</b> | No system installs required — FFmpeg is included with the app.
- <b>Modern UI</b> | Clean, minimal interface with dark mode support.

## Installation

Download the files for your system from the [releases page](https://github.com/diamonddigitaldev/Diamond-File-Converter/releases). In the names below, `<version>` is the release's version, such as `2.0.0`.

### Windows

Download **Diamond-File-Converter-Setup-`<version>`.exe** and run it. It installs for all users, so it will ask for administrator rights.

> [!NOTE]
> You may get a Windows SmartScreen popup when trying to run the installer. This is normal as the installer is not signed.

### Linux

- **Debian, Ubuntu and derivatives:** download **Diamond-File-Converter-`<version>`.deb**, then run `sudo apt install ./Diamond-File-Converter-<version>.deb`. Diamond File Converter is then in your applications menu under Sound & Video.
- **Fedora, openSUSE and others using RPM:** download **Diamond-File-Converter-`<version>`.rpm** and install it with your package manager, such as `sudo dnf install ./Diamond-File-Converter-<version>.rpm`.
- **Anywhere else:** download **Diamond-File-Converter-`<version>`.AppImage**, make it executable with `chmod +x`, and run it.

Linux builds start with 2.0. For now, the app isn't offered in "Open with" for media files on Linux, and the dock may show a generic icon for its window; opening files from a terminal (`diamond-file-converter file.mp4`) works.

### On every system

FFmpeg and FFprobe are bundled, so there is nothing else to install and nothing to add to your PATH. The `latest.yml`, `latest-linux.yml` and `.blockmap` files on each release are for the app's updater: you don't need to download them.

To go back to an earlier version, uninstall the app and install that version from the releases page.

## Usage

1. Open Diamond File Converter.
2. Drag and drop a file onto the drop zone, or click **Browse** to pick one.
3. Select the format you want to convert to.
4. Click **Convert**.
5. The converted file is saved to the same folder as the original.

## Development

1. Clone the repository:
   ```
   git clone https://github.com/diamonddigitaldev/Diamond-File-Converter.git
   ```

2. Install dependencies:
   ```
   cd Diamond-File-Converter
   npm install
   ```

3. Run the application in development mode:
   ```
   npm start
   ```

## Building

To build the application, run the following command:

```
npm run build
```

This will create distributable packages in the `dist` folder.

## License

Diamond File Converter is licensed under the Apache 2.0 License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

- Logo designed by [TheFuturisticIdiot](https://github.com/TheFuturisticIdiot)
- Built with [Electron](https://www.electronjs.org/)
- Conversion powered by [FFmpeg](https://ffmpeg.org/) via [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)


### AI Disclosure

This project uses AI tools to aid development. Read our [AI Transparency & Quality Commitment](https://diamonddigital.dev/ai-transparency) statement for more information.

## Contact Us

- Need help or want to chat? [Join our Discord Server](https://diamonddigital.dev/discord)!
- Found a bug? [Open an issue](https://github.com/diamonddigitaldev/Diamond-File-Converter/issues) on our GitHub repository.
- Have a feature request? [Submit it here](https://github.com/diamonddigitaldev/Diamond-File-Converter/issues/new?labels=enhancement)!

---

<div align="center">
  <a href="https://diamonddigital.dev/">
  <strong>Created and maintained by</strong>
  <img align="center" alt="Diamond Digital Development Logo" src="https://diamonddigital.dev/img/png/ddd_logo_text_transparent.png" style="width:25%;height:auto" /></a>
</div>
