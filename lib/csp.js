// Content-Security-Policy parsing and patching.
//
// declarativeNetRequest cannot read-modify-write a header: `set` needs a literal
// value, and `append` on a CSP creates a second policy that gets intersected
// (more restrictive, not less). So to loosen a site's policy we have to fetch it,
// patch it here, and install the result.
//
// Patching is strictly additive — tokens are only ever added, never removed —
// so the installed policy is the site's own plus exactly what the injection
// needs. Everything else in the site's allowlist is preserved verbatim.

/**
 * What the injection always requires, regardless of where telemetry is sent:
 *
 * - `chrome-extension:` in script-src, because page CSP applies in the MAIN
 *   world and governs the injected SDK files themselves. Without it nothing runs.
 *
 * The `connect-src` entry is NOT here because it depends on the profile: it is the
 * origin of that profile's own collector URL. See collectorOrigin / patchCsp.
 */
export const REQUIRED_TOKENS = {
  'script-src': ['chrome-extension:'],
  'script-src-elem': ['chrome-extension:'],
};

/**
 * The origin to allow in `connect-src`, taken from the profile's collector URL.
 *
 * Derived rather than hardcoded: a Faro collector is often Grafana Cloud
 * (`*.grafana.net`) but can equally be a self-hosted or custom-domain endpoint, and
 * allow-listing a wildcard that does not cover it would silently block every beacon.
 * Using the URL the user actually entered means the two can never disagree.
 *
 * Only the ORIGIN is used — scheme + host + port, never the `/collect/<key>` path —
 * because CSP source expressions match on origin and a path would be both wrong and
 * a needless place to leak the app key.
 *
 * @returns {string|null} e.g. `https://telemetry.example.com`, or null when the URL
 *   is unparseable or not http(s), in which case there is nothing safe to add.
 */
export function collectorOrigin(collectorUrl) {
  try {
    const url = new URL(collectorUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Extra token needed only when session replay is enabled for a profile.
 *
 * The replay instrumentation spins up a Web Worker from a Blob URL (verified in the
 * bundle: `new Worker` + `URL.createObjectURL` + `new Blob`), so the effective
 * worker policy must allow `blob:` or the recorder never starts.
 */
export const REPLAY_TOKENS = {
  'worker-src': ['blob:'],
};

/**
 * Where an absent directive inherits from, in order. CSP's own fallback chain:
 * worker-src → child-src → default-src; the *-src directives → default-src. Seeding
 * a directive we create from its real fallback keeps patching additive — creating
 * `worker-src blob:` from nothing would otherwise drop whatever child-src/default-src
 * was already allowing workers.
 */
const FALLBACK_CHAIN = {
  'script-src': ['default-src'],
  'script-src-elem': ['script-src', 'default-src'],
  'connect-src': ['default-src'],
  'worker-src': ['child-src', 'default-src'],
};

/**
 * Never added by patchCsp — only detected.
 *
 * `'unsafe-eval'` is exploitable by any XSS on the page, whereas
 * `chrome-extension:` gives an attacker nothing. So the injection mode is chosen
 * from whether the site already allows eval, rather than the policy being widened
 * to suit a chosen mode. See allowsUnsafeEval.
 */
export const UNSAFE_EVAL = "'unsafe-eval'";

/** Directives that only matter if the policy already defines them. */
const OPTIONAL_DIRECTIVES = new Set(['script-src-elem']);

/**
 * Parse a policy into ordered directives.
 *
 * Per spec a repeated directive is ignored after its first occurrence, so later
 * duplicates are dropped here to match what the browser actually enforces.
 */
export function parseCsp(value) {
  const directives = [];
  const seen = new Set();

  for (const part of String(value).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const name = tokens[0].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    directives.push({ name, tokens: tokens.slice(1) });
  }
  return directives;
}

export function serializeCsp(directives) {
  return directives
    .map(({ name, tokens }) => (tokens.length ? `${name} ${tokens.join(' ')}` : name))
    .join('; ');
}

const find = (directives, name) => directives.find((d) => d.name === name);

/** CSP host matching is case-insensitive, and 'none' is a keyword. */
const hasToken = (tokens, token) =>
  tokens.some((existing) => existing.toLowerCase() === token.toLowerCase());

/**
 * Add the tokens the injection needs to a live policy.
 *
 * @param {string} liveCsp the policy exactly as the server sent it
 * @param {{collectorUrl?: string, replay?: boolean}} [options] `collectorUrl` is the
 *   profile's Faro endpoint; its origin is what gets added to `connect-src`. When
 *   `replay` is true, also allows the Blob-URL worker the replay recorder needs.
 * @returns {{csp: string, changes: string[], skipped: string[]}} `changes`
 *   describes what was added, so the UI can show the edit rather than assert it.
 *   Patching is idempotent: running it on its own output changes nothing.
 */
export function patchCsp(liveCsp, { collectorUrl = '', replay = false } = {}) {
  const directives = parseCsp(liveCsp);
  const changes = [];
  const skipped = [];

  // connect-src is per-profile: allow exactly the collector the user configured. If
  // the URL is unusable there is nothing meaningful to allow, so it is left alone
  // rather than guessed at — validation surfaces that to the user separately.
  const origin = collectorOrigin(collectorUrl);
  const required = {
    ...REQUIRED_TOKENS,
    ...(origin ? { 'connect-src': [origin] } : {}),
    ...(replay ? REPLAY_TOKENS : {}),
  };

  for (const [name, requiredTokens] of Object.entries(required)) {
    let directive = find(directives, name);

    if (!directive) {
      if (OPTIONAL_DIRECTIVES.has(name)) continue;

      // An absent directive inherits from its fallback chain. Creating it from thin
      // air would silently drop that inheritance — e.g. adding `chrome-extension:`
      // to a missing script-src would *remove* every origin default-src allowed
      // scripts from. Seed it from the nearest present fallback first.
      const fallback = (FALLBACK_CHAIN[name] || [])
        .map((f) => find(directives, f))
        .find(Boolean);
      if (!fallback) {
        // Nothing in the chain restricts this resource type, so it is already
        // unrestricted and there is nothing to loosen.
        skipped.push(`${name} — not restricted by this policy`);
        continue;
      }
      directive = { name, tokens: [...fallback.tokens] };
      directives.push(directive);
      changes.push(`added ${name}, inherited from ${fallback.name}`);
    }

    // "'none'" must appear alone, so it has to go if anything is being allowed.
    if (directive.tokens.length === 1 && directive.tokens[0].toLowerCase() === "'none'") {
      directive.tokens = [];
      changes.push(`${name}: replaced 'none'`);
    }

    for (const token of requiredTokens) {
      if (hasToken(directive.tokens, token)) continue;
      directive.tokens.push(token);
      changes.push(`${name}: added ${token}`);
    }
  }

  return { csp: serializeCsp(directives), changes, skipped };
}

/**
 * Does this policy already permit `eval` for scripts?
 *
 * This is what picks the injection mode, so the extension decides rather than the
 * user: when the site already allows eval we use it (page-attributed, keeps the
 * site's console output off the extension's Errors page, and costs nothing because
 * the token is already there), and when it does not we use content scripts and leave
 * the policy's script rules untouched.
 *
 * Resolution follows the spec: `script-src` governs eval when present, otherwise it
 * falls back to `default-src`. `script-src-elem` is deliberately not consulted — it
 * governs script *elements* and has no say over eval. Neither does
 * `'wasm-unsafe-eval'`, which permits WebAssembly only.
 */
export function allowsUnsafeEval(liveCsp) {
  const directives = parseCsp(liveCsp);
  const governing = find(directives, 'script-src') ?? find(directives, 'default-src');

  // Nothing restricts scripts at all, so eval is already permitted.
  if (!governing) return true;

  return hasToken(governing.tokens, UNSAFE_EVAL);
}

/**
 * Compare two policies directive by directive.
 *
 * Used for drift detection: an installed policy is a snapshot, and if the site
 * later adds an allowlist entry our copy will block it. This is what surfaces
 * that instead of leaving it to be debugged on the page.
 */
export function diffCsp(before, after) {
  const a = new Map(parseCsp(before).map((d) => [d.name, d.tokens]));
  const b = new Map(parseCsp(after).map((d) => [d.name, d.tokens]));
  const added = [];
  const removed = [];

  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const from = a.get(name);
    const to = b.get(name);
    if (!from) {
      added.push(`${name} (new directive)`);
      continue;
    }
    if (!to) {
      removed.push(`${name} (directive gone)`);
      continue;
    }
    for (const token of to) if (!hasToken(from, token)) added.push(`${name}: ${token}`);
    for (const token of from) if (!hasToken(to, token)) removed.push(`${name}: ${token}`);
  }
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}
