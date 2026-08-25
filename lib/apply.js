// Applying configuration to the live browser.
//
// This is what replaces "edit rules.json, save, reload the extension". Both
// declarativeNetRequest dynamic rules and scripting-registered content scripts
// can be rewritten at runtime, and both take effect on the next page load — so
// Apply plus a page refresh is the whole loop.
//
// Every sync is a full atomic replace rather than an incremental diff. That
// costs nothing at this scale and removes the entire class of bugs where stale
// rules or scripts survive an edit — which is how the legacy extensions ended
// up with three copies of rule id 1 fighting over the same domain.

import { loadConfig, profileIssues, profileOrigins, saveConfig } from './config.js';
import { diffCsp, patchCsp } from './csp.js';
import { fetchLiveCsp, profileFetchUrl } from './fetch-csp.js';
import { matchPatternToRegexFilter, patternToTestUrl } from './match.js';

/** modifyHeaders rules are "unsafe" rules, capped well below this in practice. */
const MAX_UNSAFE_DYNAMIC_RULES = 5000;

const CSP_HEADER = 'content-security-policy';

/** Content script ids must not begin with '_' — that prefix is reserved. */
const scriptIds = (profileId) => ({
  bridge: `p-${profileId}-bridge`,
  main: `p-${profileId}-main`,
});

export const SDK_FILES = ['faro-web-sdk.iife.js', 'faro-web-tracing.iife.js'];

/** Session-replay instrumentation bundle, injected only for replay-enabled profiles. */
export const REPLAY_FILE = 'faro-instrumentation-replay.iife.js';

/**
 * What gets injected into the page's own world, in this exact order.
 *
 * `script` mode registers the SDK bundles as real content scripts. `js` entries are
 * documented to run in array order, so the IIFEs have defined
 * `window.GrafanaFaroWebSdk` / `GrafanaFaroWebTracing` (and, when replay is on,
 * `GrafanaFaroInstrumentationReplay`) by the time init.js runs, and the patched
 * policy needs no `'unsafe-eval'`.
 *
 * `eval` mode registers only init.js, which evals bundle text handed over by
 * bridge.js. The eval'd code has no owning file, so Chrome attributes it to the page
 * rather than to this extension — which is what keeps the site's console output off
 * the extension's Errors page.
 *
 * Either way the installed policy must allow `chrome-extension:` in `script-src`:
 * page CSP applies in the MAIN world and governs these files themselves, not just
 * what they do. init.js is an extension file in both modes.
 */
const mainWorldJs = (injection, replay) => {
  if (injection === 'eval') return ['init.js'];
  const files = [...SDK_FILES];
  if (replay) files.push(REPLAY_FILE);
  files.push('init.js');
  return files;
};

/** Where bridge.js finds cached bundle text, for eval-mode profiles only. */
export const BUNDLES_KEY = 'cspInjectBundles';

/** Has the user granted every origin this profile needs? */
export async function hasPermission(profile) {
  const origins = profileOrigins(profile);
  if (origins.length === 0) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/** Origins needed by the profiles that are switched on. */
export function origins(profiles) {
  return [...new Set(profiles.filter((p) => p.enabled).flatMap(profileOrigins))];
}

/**
 * Drop host access that no switched-on profile needs any more.
 *
 * `keepFor` is the set of profiles whose access must survive — passed separately so
 * this also covers deletion, where the profile is already gone from the list.
 *
 * Only origins actually held are removed, and only ones no remaining profile wants:
 * two profiles can legitimately share a host, and revoking on behalf of one would
 * silently break the other.
 */
export async function revokeUnusedOrigins(candidateOrigins, keepFor) {
  const keep = new Set(origins(keepFor));
  const stale = candidateOrigins.filter((origin) => !keep.has(origin));
  if (stale.length === 0) return [];

  const held = [];
  for (const origin of stale) {
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) held.push(origin);
    } catch {
      // A malformed origin cannot have been granted; nothing to remove.
    }
  }
  if (held.length > 0) await chrome.permissions.remove({ origins: held });
  return held;
}

/**
 * Partition profiles into what we can act on and why the rest were dropped.
 * A profile needs to be on, free of validation errors, and hold host permissions —
 * modifyHeaders silently does nothing without the last one.
 *
 * "Off" and "on but incomplete" are kept apart on purpose: the first is a deliberate
 * choice and the second is a problem the user needs told about.
 */
export async function triageProfiles(config) {
  const active = [];
  const disabled = [];
  const invalid = [];
  const noPermission = [];

  for (const profile of config.profiles) {
    if (!profile.enabled) {
      disabled.push(profile);
      continue;
    }
    const { errors } = profileIssues(profile);
    if (errors.length > 0) {
      invalid.push({ profile, errors });
      continue;
    }
    if (await hasPermission(profile)) {
      active.push(profile);
    } else {
      noPermission.push(profile);
    }
  }
  return { active, disabled, invalid, noPermission };
}

/**
 * Read each profile's live policy, patch it, and decide its injection mode.
 *
 * One fetch per profile. Failures are reported rather than worked around: a
 * profile whose policy could not be read gets no rule at all, because guessing
 * or reusing a stale policy is how you end up installing something that blocks
 * assets the site needs.
 *
 * @returns {Promise<{resolved: Array, modes: Map<string, string>, failures: string[],
 *   notes: string[]}>} `modes` covers every profile attempted, including ones that
 *   need no rule, because content scripts are still registered for those.
 */
export async function resolvePolicies(profiles) {
  const resolved = [];
  const modes = new Map();
  const failures = [];
  const notes = [];

  for (const profile of profiles) {
    const label = profile.name || profile.id;
    const url = profileFetchUrl(profile, patternToTestUrl);
    if (!url) {
      failures.push(`${label}: no URL to read the policy from — set one on the profile.`);
      continue;
    }

    const result = await fetchLiveCsp(url);
    if (!result.ok) {
      failures.push(`${label}: ${result.error}`);
      // Content scripts are still registered, so a mode is still needed. Use the
      // one that does not depend on eval being permitted.
      modes.set(profile.id, 'script');
      continue;
    }

    if (!result.csp) {
      // Nothing is being blocked, so installing a policy would only make things
      // worse than the site's own behaviour — no rule needed.
      notes.push(`${label}: ${url} sends no CSP — no rule needed.`);
      modes.set(profile.id, 'script');
      continue;
    }

    // Always script mode: the SDK bundles are injected as content scripts. eval mode
    // was retired because the 2.10.0 bundles begin with `"use strict"`, and a strict
    // indirect eval does not leak the bundle's `var GrafanaFaroWebSdk` to global
    // scope, so the second bundle could never find the first. Script mode has no such
    // dependency and needs no `'unsafe-eval'`.
    const injection = 'script';
    modes.set(profile.id, injection);

    const { csp, changes } = patchCsp(result.csp, {
      collectorUrl: profile.faro.collectorUrl,
      replay: profile.replay,
    });

    // Drift check against what we installed last time.
    const drift = profile.installedLiveCsp ? diffCsp(profile.installedLiveCsp, result.csp) : null;
    if (drift?.changed) {
      notes.push(
        `${label}: the site's CSP changed since the last Apply ` +
          `(+${drift.added.length}/-${drift.removed.length}) — now re-synced.`,
      );
    }
    resolved.push({
      profile,
      csp,
      liveCsp: result.csp,
      changes,
      injection,
      fetchedFrom: result.finalUrl,
    });
  }

  return { resolved, modes, failures, notes };
}

/**
 * One rule per match pattern, scoped to that profile's own patterns.
 *
 * Deliberately not a broad domain filter like `urlFilter: "||example.com"`, which
 * would fire on every subdomain and let one profile rewrite headers on sites another
 * profile owns.
 */
export function buildDnrRules(resolved) {
  const rules = [];
  let nextId = 1;

  for (const { profile, csp } of resolved) {
    for (const pattern of profile.matches) {
      rules.push({
        id: nextId++,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: CSP_HEADER, operation: 'set', value: csp }],
        },
        condition: {
          regexFilter: matchPatternToRegexFilter(pattern),
          // Documents only. Subframes included so an iframed page is covered too.
          resourceTypes: ['main_frame', 'sub_frame'],
        },
      });
    }
  }
  return rules;
}

/** Replace all dynamic rules in a single atomic update. */
export async function syncDnrRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: rules,
  });
}

/**
 * Replace all registered content scripts.
 *
 * persistAcrossSessions defaults to true, so registrations survive browser
 * restarts. That makes unregister-before-register mandatory rather than
 * defensive: re-registering an existing id throws.
 */
export async function syncContentScripts(profiles, modes = new Map()) {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  }

  const scripts = profiles.flatMap((profile) => {
    const ids = scriptIds(profile.id);
    const injection = modes.get(profile.id) ?? 'script';
    return [
      {
        id: ids.bridge,
        js: ['bridge.js'],
        matches: profile.matches,
        runAt: 'document_start',
        world: 'ISOLATED',
        allFrames: true,
      },
      {
        id: ids.main,
        js: mainWorldJs(injection, profile.replay),
        matches: profile.matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
      },
    ];
  });

  if (scripts.length > 0) {
    await chrome.scripting.registerContentScripts(scripts);
  }
  return scripts.length;
}

/** Where bridge.js looks up its per-page config. See syncRuntimeTable. */
export const RUNTIME_KEY = 'cspInjectRuntime';

/**
 * Publish a lookup table that bridge.js can read on its own.
 *
 * Faro has to be initialised before DOMContentLoaded or it misses early Web
 * Vitals, which leaves very little budget at document_start. An earlier version
 * had bridge.js ask the service worker for its config over sendMessage — that can
 * mean a cold service-worker start of tens to hundreds of milliseconds, racing
 * DOMContentLoaded on a fast page.
 *
 * Reading chrome.storage.local from the content script instead costs about a
 * millisecond and never wakes the worker. Patterns are pre-compiled to regex
 * strings here so bridge.js needs no module imports to do the matching — content
 * scripts cannot be ES modules.
 */
export async function syncRuntimeTable(profiles, modes = new Map()) {
  const table = profiles.map((profile) => ({
    name: profile.name || profile.id,
    patterns: profile.matches.map((pattern) => matchPatternToRegexFilter(pattern)),
    injection: modes.get(profile.id) ?? 'script',
    replay: profile.replay === true,
    faro: profile.faro,
  }));
  await chrome.storage.local.set({ [RUNTIME_KEY]: table });

  // eval-mode profiles need the bundle *text* in the page world, and a content
  // script cannot read an extension file without a web_accessible_resources entry
  // whose `matches` would have to name every target host — the very coupling this
  // extension exists to remove. Caching the text here means bridge.js reads it from
  // storage instead, with no WAR and no service-worker round trip on the page-load
  // path. Written under its own key so `script`-mode profiles never pay to read it.
  //
  // The replay bundle is only cached when an eval-mode profile actually uses replay,
  // so non-replay pages never carry its ~200KB.
  const evalEntries = table.filter((entry) => entry.injection === 'eval');
  if (evalEntries.length > 0) {
    const wantReplay = evalEntries.some((entry) => entry.replay);
    const files = [...SDK_FILES, ...(wantReplay ? [REPLAY_FILE] : [])];
    const [sdkText, tracingText, replayText] = await Promise.all(
      files.map((file) => fetch(chrome.runtime.getURL(file)).then((r) => r.text())),
    );
    await chrome.storage.local.set({
      [BUNDLES_KEY]: { sdkText, tracingText, ...(wantReplay ? { replayText } : {}) },
    });
  } else {
    await chrome.storage.local.remove(BUNDLES_KEY);
  }

  return table.length;
}

/**
 * Serialises every caller of applyConfig.
 *
 * Necessary because Apply is triggered from several places that can now overlap: the
 * popup's message, and the permissions.onAdded / onRemoved listeners that granting or
 * revoking access fires. Two concurrent runs would interleave
 * unregisterContentScripts and registerContentScripts, and re-registering a live id
 * throws.
 */
let applyChain = Promise.resolve();

export function applyConfig() {
  const run = applyChain.then(runApply, runApply);
  // Never let a rejection poison the chain for the next caller.
  applyChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Rebuild the browser's live state from stored config.
 *
 * @returns a summary the popup renders, so Apply can report what it actually did
 *   instead of just claiming success.
 */
async function runApply() {
  const config = await loadConfig();
  const { active, disabled, invalid, noPermission } = await triageProfiles(config);

  const summary = {
    ok: true,
    ruleCount: 0,
    scriptCount: 0,
    activeIds: [],
    activeNames: [],
    needsPermission: noPermission.map((p) => p.name || p.id),
    disabledCount: disabled.length,
    patches: [],
    notes: [],
    errors: [],
  };

  // An on-but-incomplete profile is a problem, not a quiet skip. The specifics are
  // listed on the profile card, so this only needs to say which one and how much.
  for (const { profile, errors } of invalid) {
    summary.ok = false;
    const count = errors.length === 1 ? '1 field' : `${errors.length} fields`;
    summary.errors.push(`${profile.name || profile.id} is incomplete — ${count} missing.`);
  }
  // Access should already have been requested by the caller, so reaching here means
  // it was denied.
  if (noPermission.length > 0) {
    summary.ok = false;
    summary.errors.push(`No site access granted for: ${summary.needsPermission.join(', ')}`);
  }

  // Read and patch each live policy before touching the browser. This is also where
  // the injection mode is decided, from the site's own policy.
  const { resolved, modes, failures, notes } = await resolvePolicies(active);
  summary.notes = notes;
  if (failures.length > 0) {
    summary.ok = false;
    summary.errors.push(...failures);
  }

  summary.patches = resolved.map(({ profile, changes, injection, fetchedFrom }) => ({
    name: profile.name || profile.id,
    changes,
    injection,
    replay: profile.replay === true,
    fetchedFrom,
  }));

  // Content scripts are registered for every active profile, but rules only exist
  // for profiles whose policy we could resolve. A profile on a site that sends no
  // CSP still needs its scripts injected — there is just nothing to override.
  summary.activeIds = active.map((p) => p.id);
  summary.activeNames = active.map((p) => p.name || p.id);

  let rules;
  try {
    rules = buildDnrRules(resolved);
  } catch (error) {
    // Should be unreachable: triage already rejects invalid patterns.
    summary.ok = false;
    summary.errors.push(`Could not build rules: ${error.message}`);
    return summary;
  }

  if (rules.length > MAX_UNSAFE_DYNAMIC_RULES) {
    summary.ok = false;
    summary.errors.push(
      `${rules.length} rules exceeds Chrome's limit of ${MAX_UNSAFE_DYNAMIC_RULES} for header-modifying rules.`,
    );
    return summary;
  }

  try {
    await syncDnrRules(rules);
    summary.ruleCount = rules.length;
  } catch (error) {
    summary.ok = false;
    summary.errors.push(`declarativeNetRequest update failed: ${error.message}`);
  }

  // Record what the site was serving, so the next Apply can report that it changed.
  if (summary.ok) {
    const byId = new Map(resolved.map((r) => [r.profile.id, r]));
    await saveConfig({
      ...config,
      profiles: config.profiles.map((profile) => {
        const match = byId.get(profile.id);
        return match ? { ...profile, installedLiveCsp: match.liveCsp } : profile;
      }),
    });
  }

  // Publish the lookup table before registering, so no page can be injected
  // while the table is missing or stale.
  try {
    await syncRuntimeTable(active, modes);
  } catch (error) {
    summary.ok = false;
    summary.errors.push(`Could not publish the runtime table: ${error.message}`);
  }

  try {
    summary.scriptCount = await syncContentScripts(active, modes);
  } catch (error) {
    summary.ok = false;
    summary.errors.push(`Content script registration failed: ${error.message}`);
  }

  return summary;
}

/**
 * Reload open tabs a profile applies to. Optional convenience so Apply closes
 * the loop without a manual refresh; needs no permission beyond the host
 * access already granted for these origins.
 */
export async function reloadMatchingTabs(profiles) {
  return reloadTabsMatching([...new Set(profiles.flatMap((p) => p.matches))]);
}

/**
 * Set by the popup before it requests host access, when "Reload tabs" is checked.
 *
 * Granting access shows Chrome's permission prompt, which closes the popup — so the
 * popup's own reload never runs. The service worker's permissions.onAdded handler
 * reads this flag and finishes the reload instead. See doApply / onAdded.
 */
export const RELOAD_ON_GRANT_KEY = 'cspInjectReloadOnGrant';

/**
 * Ids of open tabs matching any of these URL patterns.
 *
 * Querying BY URL needs host permission for the pattern, so this has to run while the
 * permission is still held — which matters when switching a profile off, because the
 * revoke happens before the rebuild. Callers capture ids first, then reload by id.
 */
export async function tabIdsMatching(patterns) {
  const ids = new Set();
  for (const pattern of [...new Set(patterns)]) {
    try {
      for (const tab of await chrome.tabs.query({ url: pattern })) ids.add(tab.id);
    } catch {
      // A pattern we lack permission to query is not worth failing over.
    }
  }
  return [...ids];
}

/** Reload specific tabs. Unlike querying by URL, this needs no host permission. */
export async function reloadTabIds(ids) {
  let reloaded = 0;
  for (const id of new Set(ids)) {
    try {
      await chrome.tabs.reload(id);
      reloaded += 1;
    } catch {
      // The tab may have been closed in the meantime.
    }
  }
  return reloaded;
}

/** Reload every open tab matching any of these URL patterns. */
export async function reloadTabsMatching(patterns) {
  return reloadTabIds(await tabIdsMatching(patterns));
}
