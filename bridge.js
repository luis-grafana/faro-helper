// Content script — ISOLATED world, document_start.
//
// Carries per-profile config into the page's world. init.js runs in the MAIN
// world, where chrome.* is unavailable, and content script files cannot be
// parameterised — so the collector URL and app name have to arrive some other way.
// A DOM attribute is the one channel both worlds see.
//
// Speed is the whole design constraint here. Faro must be initialised before
// DOMContentLoaded or it misses early Web Vitals, and everything below runs at
// document_start with only the HTML parse to work with. So this reads
// chrome.storage.local directly (tens of ms) rather than messaging the service
// worker, which would risk a cold start of hundreds of milliseconds.

const RUNTIME_KEY = 'cspInjectRuntime';
const BUNDLES_KEY = 'cspInjectBundles';
const CONFIG_ATTRIBUTE = 'data-csp-inject-config';
const READY_EVENT = 'csp-inject-config-ready';

(async () => {
  let payload = null;

  try {
    const stored = await chrome.storage.local.get(RUNTIME_KEY);
    const table = stored[RUNTIME_KEY] ?? [];

    // Patterns arrive pre-compiled as regex strings, so no module import is
    // needed — content scripts cannot be ES modules.
    const entry = table.find((candidate) =>
      candidate.patterns.some((pattern) => {
        try {
          return new RegExp(pattern, 'i').test(location.href);
        } catch {
          return false;
        }
      }),
    );

    if (entry) {
      payload = { profileName: entry.name, faro: entry.faro, replay: entry.replay === true };

      // Only eval-mode profiles need the bundle text, and it is ~170KB — so this
      // second read is deliberately lazy. `script`-mode profiles get the SDK as
      // registered content scripts and never pay for it.
      if (entry.injection === 'eval') {
        const bundles = (await chrome.storage.local.get(BUNDLES_KEY))[BUNDLES_KEY];
        if (bundles?.sdkText) {
          payload.sdkText = bundles.sdkText;
          payload.tracingText = bundles.tracingText;
          // Present only when an eval-mode profile actually uses replay.
          if (payload.replay && bundles.replayText) payload.replayText = bundles.replayText;
        } else {
          console.error('[CSP Inject] eval mode is selected but no cached SDK was found — re-run Apply.');
          payload = null;
        }
      }
    }
  } catch (error) {
    console.error('[CSP Inject] bridge could not read its config:', error);
  }

  // Always publish, even with no payload: `null` is how init.js learns to stop
  // waiting rather than sitting on a listener for the life of the page.
  document.documentElement.setAttribute(CONFIG_ATTRIBUTE, JSON.stringify(payload));

  // The event is what lets init.js start in the same task the config lands,
  // instead of waiting for the first animation frame — which on a document_start
  // script can be later than DOMContentLoaded. No detail is attached; the
  // attribute carries the data, so there is nothing to clone across worlds.
  document.dispatchEvent(new CustomEvent(READY_EVENT));
})();
