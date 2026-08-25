// Service worker.
//
// Owns applying config to the browser and reading a site's pristine CSP.
//
// Deliberately NOT on the page-load path. Content scripts get their config by
// reading the runtime table from chrome.storage.local themselves — see
// syncRuntimeTable in lib/apply.js. Routing that through here would put a
// potential cold service-worker start between document_start and
// DOMContentLoaded, which is the window Faro has to be initialised in.

import {
  RELOAD_ON_GRANT_KEY,
  applyConfig,
  reloadTabIds,
  reloadTabsMatching,
  tabIdsMatching,
} from './lib/apply.js';
import { loadConfig } from './lib/config.js';
import { fetchLiveCsp } from './lib/fetch-csp.js';

/**
 * Apply, driven from the popup.
 *
 * This runs here rather than in the popup because Apply now performs one network
 * fetch per profile to read the live policy, and a popup is destroyed the moment
 * it loses focus — which would abort the run half way. The service worker
 * outlives it, so closing the popup mid-Apply is harmless.
 */
async function applyFromPopup({ reloadTabs, staleTabIds = [] }) {
  const summary = await applyConfig();

  if (reloadTabs) {
    // `staleTabIds` are tabs of profiles the popup just switched OFF. Their access was
    // already revoked before this message was sent, so they are stale whatever else
    // happened — deliberately NOT gated on summary.ok, or an unrelated profile with a
    // validation error would leave the disabled profile's page still instrumented.
    const ids = [...staleTabIds];

    // Tabs a still-active profile matches, so they pick up the rebuilt rules. Only
    // meaningful when the rebuild actually succeeded.
    if (summary.ok) {
      const { profiles } = await loadConfig();
      const active = profiles.filter((p) => summary.activeIds.includes(p.id));
      ids.push(...(await tabIdsMatching(active.flatMap((p) => p.matches))));
    }

    // reloadTabIds de-duplicates, so a tab in both sets reloads once.
    summary.reloadedTabs = await reloadTabIds(ids);
  }
  return summary;
}

// chrome.runtime.onMessage cannot await a returned promise in Chrome, so each
// handler resolves into sendResponse and the listener returns true.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'apply') {
    applyFromPopup(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, errors: [error.message], notes: [], patches: [] }));
    return true;
  }

  if (message?.type === 'fetchLiveCsp') {
    fetchLiveCsp(message.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

// Nothing to seed: a fresh install starts with no profiles, so this just clears
// any rules left behind by a previous version of the extension.
chrome.runtime.onInstalled.addListener(async () => {
  // Written by a removed feature (the popup's applied-state snapshot); nothing reads
  // it anymore, so drop it from installs that predate the removal.
  await chrome.storage.local.remove('cspInjectAppliedSnapshot');

  const summary = await applyConfig();
  console.log('CSP Inject: installed.', summary);
});

// Dynamic rules and registered content scripts both persist across restarts, so
// this is not required for correctness. It is self-healing: if host permissions
// were revoked while the browser was closed, this drops the now-orphaned rules.
chrome.runtime.onStartup.addListener(async () => {
  const summary = await applyConfig();
  console.log('CSP Inject: startup sync.', summary);
});

// Granting or revoking host access changes which profiles can act, so re-sync
// immediately rather than waiting for the next Apply.
//
// The grant case also covers the popup being closed by Chrome's permission prompt:
// the grant lands, the rules get rebuilt here, and — if the popup set the reload
// flag before it died — the tabs the popup couldn't reach get reloaded from here.
chrome.permissions.onAdded.addListener(async (permissions) => {
  await applyConfig();

  const stored = await chrome.storage.local.get(RELOAD_ON_GRANT_KEY);
  if (!stored[RELOAD_ON_GRANT_KEY]) return;
  // Consume the flag first, so a second onAdded (or the popup, if it survived)
  // cannot reload the same tabs twice.
  await chrome.storage.local.remove(RELOAD_ON_GRANT_KEY);
  await reloadTabsMatching(permissions.origins ?? []);
});
chrome.permissions.onRemoved.addListener(() => applyConfig());

// No action.onClicked listener: the manifest sets default_popup, and the two are
// mutually exclusive — onClicked never fires when a popup is configured.
