"use strict";

// The desktop app's electron-builder config, made by the kit's config() on its
// base (NSIS in the Diamond Digital Development menu folder; AppImage, .deb and
// .rpm). It's .cjs, never .js: on Windows, electron-builder typed in this
// folder would run electron-builder.js with Windows Script Host instead.
//
// - The installer asks who it's for (an install for everyone, as every one
//   before 2.0.0-beta.6 was, is upgraded in place), then which of the 22 types
//   to open and whether to add "Convert with Diamond File Converter" to the
//   menu files and folders have when they're right-clicked. It replaced
//   installer.nsh, and keeps its registry key, so an upgrade never shows the
//   entry twice. On Linux, the app is in Open With for each type.
// - ffmpeg and ffprobe are packed per platform, where main.js looks for them;
//   the packages' own binaries stay out of app.asar.unpacked (415 MB in 2.0.0).
const { config } = require("@diamonddigitaldev/electron-kit/builder");

module.exports = config(require("./package.json"), {
    build: {
        appId: "com.diamonddigitaldev.diamondfileconverter",
        productName: "Diamond File Converter",
        artifactName: "Diamond-File-Converter-${version}.${ext}",
        files: [
            "**/*",
            "!test-media",
            "!test-media/**/*",
            "!node_modules/ffmpeg-static/ffmpeg{,.exe}",
            "!node_modules/ffprobe-static/bin/**",
        ],
        publish: {
            provider: "github",
            owner: "diamonddigitaldev",
            repo: "Diamond-File-Converter",
        },
        win: {
            icon: "src/assets/diamondfileconverter.ico",
            extraResources: [
                { from: "node_modules/ffmpeg-static/ffmpeg.exe", to: "ffmpeg/ffmpeg.exe" },
                { from: "node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe", to: "ffmpeg/ffprobe.exe" },
            ],
        },
        linux: {
            icon: "src/assets/diamondfileconverter.png",
            category: "AudioVideo",
            extraResources: [
                { from: "node_modules/ffmpeg-static/ffmpeg", to: "ffmpeg/ffmpeg" },
                { from: "node_modules/ffprobe-static/bin/linux/x64/ffprobe", to: "ffmpeg/ffprobe" },
            ],
        },
        // The installer's name is what its update files point at: unchanged from 2.0.0.
        nsis: {
            artifactName: "Diamond-File-Converter-Setup-${version}.${ext}",
        },
    },
    fileTypes: [
        { name: "Audio File", ext: ["mp3", "wav", "flac", "ogg", "aac", "m4a", "opus", "wma"] },
        { name: "Video File", ext: ["mp4", "mkv", "webm", "avi", "mov", "wmv", "flv"] },
        { name: "Image File", ext: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"] },
    ],
    contextMenu: { label: "Convert with Diamond File Converter", folders: true },
});
