/**
 * background.js — Service Worker for Tab Out
 *
 * Two responsibilities:
 * 1. Keep the toolbar badge showing the current open tab count.
 * 2. Dynamically redirect new tabs to Tab Out when newTabMode is enabled.
 *
 * Instead of using chrome_url_overrides in manifest.json (which is static),
 * we listen for new tab creation and redirect programmatically.
 * This allows the user to toggle the new-tab override on/off at runtime.
 *
 * Badge color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

'use strict';

// ─── New tab mode — cached setting ──────────────────────────────────────────

// Cache the setting in memory for fast access.
// Default to false (don't redirect) until we confirm from storage.
// This avoids a race condition where the service worker restarts and
// redirects before the async storage read completes.
let newTabModeEnabled = false;
let settingLoaded = false;

// Load setting from storage
function loadNewTabSetting() {
  chrome.storage.local.get('settings', (data) => {
    if (data.settings) {
      newTabModeEnabled = data.settings.newTabMode !== false;
    } else {
      // No settings yet = first run, default to enabled
      newTabModeEnabled = true;
    }
    settingLoaded = true;
  });
}

// Keep cache in sync when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    newTabModeEnabled = (changes.settings.newValue || {}).newTabMode !== false;
    settingLoaded = true;
  }
});

// Load on startup
loadNewTabSetting();


// ─── New tab interception ───────────────────────────────────────────────────

/**
 * When a new tab is created, check if it's heading to chrome://newtab.
 * If newTabMode is enabled, redirect it to our dashboard page.
 * If disabled, do nothing — Chrome shows its default new tab page.
 *
 * To avoid race conditions when the service worker restarts, we read
 * storage directly if the cached setting hasn't been loaded yet.
 */
chrome.tabs.onCreated.addListener(async (tab) => {
  const target = tab.pendingUrl || tab.url || '';
  if (target !== 'chrome://newtab/' && target !== 'chrome://newtab') return;

  let enabled = newTabModeEnabled;

  // If cache not yet warmed, read from storage directly
  if (!settingLoaded) {
    try {
      const data = await chrome.storage.local.get('settings');
      if (data.settings) {
        enabled = data.settings.newTabMode !== false;
      } else {
        enabled = true; // No settings = first run, default enabled
      }
      newTabModeEnabled = enabled;
      settingLoaded = true;
    } catch {
      return; // On error, don't redirect (safe fallback)
    }
  }

  if (enabled) {
    chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('index.html') });
  }
});


// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter(t => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  // Initialize default settings if not present
  chrome.storage.local.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.local.set({ settings: { newTabMode: true } });
    }
  });
});

// Open Tab Out dashboard when the extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  loadNewTabSetting();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
