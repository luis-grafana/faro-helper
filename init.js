// Content script — MAIN world, document_start.
//
// Handles both injection modes on one code path, so the timing and logging below
// behave identically either way:
//
// - `script` mode — this runs last of three MAIN-world files, after
//   faro-web-sdk.iife.js and faro-web-tracing.iife.js, which have already defined
//   window.GrafanaFaroWebSdk and GrafanaFaroWebTracing. Nothing is eval'd.
// - `eval` mode — this is the only MAIN-world file, and bridge.js hands over the
//   bundle text to window.eval. The eval'd code has no owning file, so Chrome
//   attributes it to the page rather than to this extension, which keeps the site's
//   console output off the extension's Errors page. Costs `'unsafe-eval'` in the
//   patched policy.
//
// Which mode is in play is inferred from the payload: bundle text present means eval.
// Config arrives from bridge.js via a DOM attribute because chrome.* is not
// reachable from the MAIN world.
//
// THE TIMING REQUIREMENT: Faro must be initialised before DOMContentLoaded, or it
// misses early Web Vitals and the numbers are quietly wrong. The logging below
// exists to prove that on every page load rather than assume it, and it says so
// loudly when the invariant is violated.
//
// Page CSP applies to this world, and it applies to these files themselves: the
// installed policy must allow `chrome-extension:` in `script-src` or none of the
// three will execute.

(function () {
  const CONFIG_ATTRIBUTE = 'data-csp-inject-config';
  const READY_EVENT = 'csp-inject-config-ready';

  // Backstop only. The config normally arrives via READY_EVENT; this catches the
  // case where bridge.js never ran at all, so the page is not left with a
  // listener attached for its whole lifetime.
  const DEADLINE_MS = 10000;

  const started = performance.now();
  const since = () => `+${(performance.now() - started).toFixed(1)}ms`;
  const log = (message) => console.log(`[CSP Inject] ${since()} ${document.readyState} — ${message}`);

  if (window.__cspInjectStarted) {
    // allFrames + re-registration can land this script twice in one context.
    return;
  }
  window.__cspInjectStarted = true;

  let faroReady = false;

  log('init.js running, SDK present: ' + Boolean(window.GrafanaFaroWebSdk));

  // Record when DOMContentLoaded fires so the ordering is visible in the log even
  // when it wins the race. readyState is already past 'loading' if we somehow
  // started late, which is itself the failure signal.
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => log(`DOMContentLoaded fired — Faro ready by now: ${faroReady}`),
      { once: true },
    );
  } else {
    console.warn(
      `[CSP Inject] ${since()} init.js started at readyState="${document.readyState}" — ` +
        'DOMContentLoaded already fired, so early Web Vitals were missed.',
    );
  }

  function begin() {
    const raw = document.documentElement.getAttribute(CONFIG_ATTRIBUTE);
    if (raw !== null) {
      consume(raw);
      return;
    }

    // Not there yet. The event fires in the same task bridge.js publishes the
    // attribute, so this costs nothing in the common case. Checking the attribute
    // first means there is no race: both happen synchronously here.
    document.addEventListener(READY_EVENT, onReady, { once: true });
    setTimeout(() => {
      if (faroReady) return;
      document.removeEventListener(READY_EVENT, onReady);
      const stillMissing = document.documentElement.getAttribute(CONFIG_ATTRIBUTE);
      if (stillMissing === null) {
        console.warn(`[CSP Inject] no config from the bridge after 10s — giving up on ${location.href}`);
      } else {
        consume(stillMissing);
      }
    }, DEADLINE_MS);
  }

  function onReady() {
    log('bridge signalled config ready');
    consume(document.documentElement.getAttribute(CONFIG_ATTRIBUTE));
  }

  function consume(raw) {
    document.documentElement.removeAttribute(CONFIG_ATTRIBUTE);

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      console.error('[CSP Inject] could not parse the bridge config:', error);
      return;
    }

    // An explicit null means no profile claims this URL. Nothing to do.
    if (!payload) {
      log('no profile matches this URL — nothing to inject');
      return;
    }

    initialize(payload);
  }

  function initialize({ profileName, faro, sdkText, tracingText, replay, replayText }) {
    if (!faro?.collectorUrl) {
      console.warn(`[CSP Inject] profile "${profileName}" has no Faro collector URL — skipping init.`);
      return;
    }

    // eval mode: the bundles arrive as text and have not run yet.
    if (sdkText) {
      try {
        window.eval(sdkText);
        if (tracingText) window.eval(tracingText);
        if (replay && replayText) window.eval(replayText);
        log('SDK eval\'d into the page');
      } catch (error) {
        console.error(
          "[CSP Inject] eval of the SDK failed. If this mentions 'unsafe-eval', the installed " +
            'policy is missing it — switch this profile to script mode or re-run Apply.',
          error,
        );
        return;
      }
    }

    // In script mode a missing global means the bundles were blocked before they
    // could run — almost always an installed policy without `chrome-extension:` in
    // script-src.
    if (!window.GrafanaFaroWebSdk) {
      console.error(
        '[CSP Inject] the Faro SDK did not load. Check that the installed policy allows ' +
          'chrome-extension: in script-src, then look for a CSP violation above.',
      );
      return;
    }

    try {
      window.GrafanaFaroWebSdk.initializeFaro({
        url: faro.collectorUrl,
        app: {
          name: faro.appName,
          version: faro.appVersion,
          environment: faro.environment,
        },
      });
      faroReady = true;
      log(`Faro initialised for "${profileName}"`);

      // The check this logging exists for.
      if (document.readyState === 'loading') {
        log('✓ Faro is up before DOMContentLoaded — early Web Vitals will be captured');
      } else {
        console.warn(
          `[CSP Inject] ✗ Faro initialised at readyState="${document.readyState}", ` +
            'after DOMContentLoaded. Early Web Vitals were missed for this load.',
        );
      }

      if (window.GrafanaFaroWebTracing) {
        window.GrafanaFaroWebSdk.faro.instrumentations.add(
          new window.GrafanaFaroWebTracing.TracingInstrumentation(),
        );
        log('tracing instrumentation added');
      } else {
        console.warn('[CSP Inject] Faro is running, but the tracing bundle did not load.');
      }

      // Session replay, only when the profile opted in. Added right after init so it
      // records from the start of the session.
      if (replay) {
        if (window.GrafanaFaroInstrumentationReplay) {
          window.GrafanaFaroWebSdk.faro.instrumentations.add(
            new window.GrafanaFaroInstrumentationReplay.ReplayInstrumentation(),
          );
          log('session replay instrumentation added');
        } else {
          console.error(
            '[CSP Inject] session replay is enabled but its bundle did not load. Check that the ' +
              'installed policy allows chrome-extension: in script-src (script mode) or that Apply ' +
              'cached the replay bundle (eval mode).',
          );
        }
      }

      log('fully active');
    } catch (error) {
      console.error('[CSP Inject] Faro init error:', error);
    }
  }

  begin();
})();
