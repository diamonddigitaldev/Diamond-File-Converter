"use strict";

// The app's own items in the house menu. The kit builds the rest of it
// (Settings on CmdOrCtrl+,, Check for Updates, Toggle Developer Tools on a
// pre-release, Exit) and puts these first. Credits is the last tab of
// Settings, so it has no item.
//
// Kept apart from main.js so test/kit.test.js can check the accelerators
// without launching Electron.

/**
 * @param {{ openFiles: () => void, openFolder: () => void }} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function menuItems({ openFiles, openFolder }) {
    return [
        { label: "Open Files", accelerator: "CmdOrCtrl+O", click: openFiles },
        { label: "Open Folder", accelerator: "CmdOrCtrl+Shift+O", click: openFolder },
    ];
}

module.exports = { menuItems };
