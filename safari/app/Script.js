// SPDX-License-Identifier: GPL-3.0-or-later
// Called by ViewController.swift: show(platform, enabled?, useSettingsInsteadOfPreferences?)
function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (platform === 'mac' && useSettingsInsteadOfPreferences === false) {
        // macOS 12 calls it Preferences.
        document.querySelector('.settings-name').innerText = 'Preferences';
        document.querySelector('button.open-preferences').innerText = 'Quit and Open Safari Extensions Preferences…';
    }

    if (typeof enabled === 'boolean') {
        document.body.classList.toggle('state-on', enabled);
        document.body.classList.toggle('state-off', !enabled);
    } else {
        document.body.classList.remove('state-on', 'state-off');
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage('open-preferences');
}

document.querySelector('button.open-preferences').addEventListener('click', openPreferences);
