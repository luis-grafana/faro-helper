// Configuration store.
//
// Everything that would otherwise be hardcoded across several files lives here, in
// chrome.storage.local. `local` and not `sync` on purpose: a real production CSP runs
// to 4KB on its own and storage.sync caps a single item at 8KB, so a couple of
// realistic profiles would silently fail to save.

import { collectorOrigin } from './csp.js';
import { patternToOrigins, patternToTestUrl, validateMatchPattern } from './match.js';

const STORAGE_KEY = 'cspInjectConfig';
export const SCHEMA_VERSION = 3;

// How the SDK reaches the page's world is decided per Apply from the site's own
// policy, and is deliberately absent from this schema — it is neither a setting nor
// something the user is shown. See allowsUnsafeEval in csp.js.

/**
 * A profile with no site attached yet.
 *
 * There is deliberately no `csp` field. The installed policy is derived on every
 * Apply by fetching the site's live CSP and patching it, so there is nothing for
 * the user to author and nothing stored that can go stale unnoticed.
 * `installedLiveCsp` is only a record of what the site was serving last time, so
 * the next Apply can report that it changed.
 */
export function blankProfile() {
  return {
    id: crypto.randomUUID().slice(0, 8),
    name: '',
    enabled: false,
    matches: [],
    testUrl: '',
    // Opt-in session replay. Off by default: replay records the page DOM (text,
    // inputs, images), which is far more than the metric/error/trace telemetry the
    // base SDK sends, so it should only run when the user deliberately asks for it.
    replay: false,
    // Recorded by Apply, never edited: what the site was serving last time, so the
    // next Apply can report that its policy changed.
    installedLiveCsp: '',
    // Nothing is pre-filled. A default version or environment would be a guess that
    // silently ships as real telemetry metadata if it is never looked at.
    faro: {
      collectorUrl: '',
      appName: '',
      appVersion: '',
      environment: '',
    },
  };
}

/**
 * Coerce anything stored (or imported from a JSON file) into a well-formed
 * profile. Imported configs are untrusted input, so every field gets a type
 * check rather than being spread in blindly.
 */
export function normalizeProfile(raw) {
  const base = blankProfile();
  if (!raw || typeof raw !== 'object') return base;

  const faro = raw.faro && typeof raw.faro === 'object' ? raw.faro : {};
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    enabled: raw.enabled === true,
    matches: Array.isArray(raw.matches) ? raw.matches.filter((m) => typeof m === 'string' && m.trim()) : [],
    testUrl: typeof raw.testUrl === 'string' ? raw.testUrl : '',
    replay: raw.replay === true,
    // Migration from schema 1, which stored a hand-authored `csp`: that value is
    // dropped rather than carried forward, because it was an edited policy and
    // treating it as "what the site served" would report bogus drift.
    installedLiveCsp: typeof raw.installedLiveCsp === 'string' ? raw.installedLiveCsp : '',
    faro: {
      collectorUrl: typeof faro.collectorUrl === 'string' ? faro.collectorUrl : '',
      appName: typeof faro.appName === 'string' ? faro.appName : '',
      appVersion: typeof faro.appVersion === 'string' ? faro.appVersion : '',
      environment: typeof faro.environment === 'string' ? faro.environment : '',
    },
  };
}

/** Ensure ids are unique; a duplicate would collide in the DNR/script id space. */
function dedupeIds(profiles) {
  const seen = new Set();
  return profiles.map((profile) => {
    let id = profile.id;
    while (seen.has(id)) id = crypto.randomUUID().slice(0, 8);
    seen.add(id);
    return id === profile.id ? profile : { ...profile, id };
  });
}

export function normalizeConfig(raw) {
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles.map(normalizeProfile) : [];
  return { version: SCHEMA_VERSION, profiles: dedupeIds(profiles) };
}

export async function loadConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeConfig(stored[STORAGE_KEY]);
}

export async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

/** Every host-permission origin a profile needs, deduplicated. */
export function profileOrigins(profile) {
  const origins = new Set();
  for (const pattern of profile.matches) {
    if (validateMatchPattern(pattern) !== null) continue;
    for (const origin of patternToOrigins(pattern)) origins.add(origin);
  }
  return [...origins];
}

/**
 * Per-profile problems worth surfacing in the UI. Split into `errors`, which
 * stop a profile from producing rules, and `warnings`, which do not.
 *
 * Validation only applies while the profile is **on**. An off profile installs no
 * rules and registers no scripts, so half-filled fields are not a problem yet —
 * nagging about them would just be noise while a site is being set up. Ticking On is
 * the statement "this should be live", and that is when everything must be present.
 */
export function profileIssues(profile) {
  const errors = [];
  const warnings = [];

  if (!profile.enabled) return { errors, warnings };

  if (profile.matches.length === 0) {
    errors.push('No match patterns — add the sites this should run on.');
  }
  for (const pattern of profile.matches) {
    const error = validateMatchPattern(pattern);
    if (error) errors.push(`${pattern} — ${error}`);
  }

  // Apply reads the site's policy from a concrete URL. Usually derived from the
  // first match pattern; only patterns too broad to pin down need one typed in.
  const hasFetchUrl = profile.testUrl.trim() || patternToTestUrl(profile.matches[0] ?? '');
  if (profile.matches.length > 0 && !hasFetchUrl) {
    errors.push('Set a URL to read the policy from under Advanced — the match pattern is too broad to derive one.');
  }

  const { collectorUrl, appName, appVersion, environment } = profile.faro;
  if (!collectorUrl.trim()) {
    errors.push('No Faro collector URL — nothing would be reported.');
  } else if (!collectorOrigin(collectorUrl)) {
    // Any host is valid — Grafana Cloud or a self-hosted/custom endpoint — because
    // connect-src is patched with this URL's own origin. It only has to be a URL we
    // can extract an http(s) origin from.
    errors.push(`Faro collector URL must be a valid http(s) URL: ${collectorUrl}`);
  }
  if (!appName.trim()) errors.push('No Faro app name.');
  if (!appVersion.trim()) errors.push('No Faro app version.');
  if (!environment.trim()) errors.push('No Faro environment.');

  return { errors, warnings };
}

