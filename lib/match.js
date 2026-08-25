// Match-pattern engine.
//
// Converts Chrome extension match patterns into declarativeNetRequest
// `regexFilter` strings. The same generated string is reused with JS RegExp to
// resolve which profile a page belongs to, so the service worker and the DNR
// engine always agree. That is only safe because we emit a syntax subset that
// RE2 and JS interpret identically: literals, escapes, `.`, `*`, `?`, `[^…]`
// classes and non-capturing alternation. No backreferences, no lookaround.
//
// Grammar we accept (a subset of Chrome's):
//   <scheme>://<host><path>   where scheme is * | http | https
//   <all_urls>
//
// Pure functions only — no chrome.* access — so this file is unit-testable
// under plain Node.

/** DNR requires regexFilter to be ASCII-only. */
const ASCII_ONLY = /^[\x00-\x7F]*$/;

/** DNR rejects any rule whose compiled regex exceeds 2KB. */
export const MAX_REGEX_BYTES = 2048;

const SCHEMES = ['*', 'http', 'https'];

/**
 * Escape RE2/JS regex metacharacters. `*` is NOT escaped here — callers split
 * on it first and pass wildcard-free fragments. `/` is deliberately left alone:
 * it needs no escaping in RE2 or in `new RegExp(string)`, and escaping it just
 * makes the generated filters harder to read in DevTools.
 */
function escapeLiteral(text) {
  return text.replace(/[\\.+?()[\]{}^$|]/g, '\\$&');
}

/** Expand a wildcard-bearing fragment: literal parts escaped, `*` → `.*`. */
function expandWildcards(text) {
  return text.split('*').map(escapeLiteral).join('.*');
}

/**
 * Split a match pattern into its parts without validating them.
 * @returns {{scheme: string, host: string, path: string}|null}
 */
function splitPattern(pattern) {
  const sep = pattern.indexOf('://');
  if (sep === -1) return null;

  const scheme = pattern.slice(0, sep);
  const rest = pattern.slice(sep + 3);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;

  return { scheme, host: rest.slice(0, slash), path: rest.slice(slash) };
}

/**
 * Validate a match pattern.
 * @returns {string|null} a human-readable error, or null when the pattern is valid.
 */
export function validateMatchPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return 'Pattern is empty.';
  }
  if (pattern !== pattern.trim()) {
    return 'Pattern has leading or trailing whitespace.';
  }
  if (!ASCII_ONLY.test(pattern)) {
    return 'Pattern must be ASCII only. Convert an internationalised domain to punycode (e.g. xn--…).';
  }
  if (pattern === '<all_urls>') return null;

  const parts = splitPattern(pattern);
  if (!parts) {
    return "Expected the form scheme://host/path, e.g. https://www.example.com/* (the path is required — use /* to match every page).";
  }
  const { scheme, host, path } = parts;

  if (!SCHEMES.includes(scheme)) {
    return `Unsupported scheme "${scheme}". Use https, http, or * for either.`;
  }
  if (host === '') {
    return 'Host is empty.';
  }
  if (host.includes(':')) {
    return 'Host must not include a port. Patterns match every port already.';
  }
  if (host !== '*') {
    const bare = host.startsWith('*.') ? host.slice(2) : host;
    if (bare.includes('*')) {
      return `Invalid host "${host}". A wildcard is only allowed as a leading "*." label, e.g. *.example.com.`;
    }
    if (bare === '') {
      return 'Host is just a wildcard label. Use *.example.com or *.';
    }
  }
  if (!path.startsWith('/')) {
    return 'Path must start with "/".';
  }
  return null;
}

/**
 * Convert a match pattern to a declarativeNetRequest `regexFilter`.
 *
 * Two details that are easy to get wrong and are the reason this is a named,
 * tested function:
 *
 *  1. Match patterns carry no port, and they match a URL on ANY port. The
 *     generated regex therefore needs an optional `(:\d+)?` group after the
 *     host, and the host classes must exclude `:` so they cannot swallow it.
 *  2. The end is anchored with `$` unless the path ends in `*`. Match-pattern
 *     paths must match in full, so `/news` matches `/news` but not `/newsroom`.
 *     The overwhelmingly common `/*` becomes `/.*`, which also covers query
 *     strings.
 *
 * @throws {Error} if the pattern is invalid.
 */
export function matchPatternToRegexFilter(pattern) {
  const error = validateMatchPattern(pattern);
  if (error) throw new Error(`${pattern}: ${error}`);

  if (pattern === '<all_urls>') return '^https?://';

  const { scheme, host, path } = splitPattern(pattern);

  const schemeRe = scheme === '*' ? 'https?' : scheme;

  let hostRe;
  if (host === '*') {
    hostRe = '[^/:]+';
  } else if (host.startsWith('*.')) {
    // Matches the apex too: *.example.com covers example.com and a.b.example.com.
    hostRe = `(?:[^/:]*\\.)?${escapeLiteral(host.slice(2))}`;
  } else {
    hostRe = escapeLiteral(host);
  }

  const pathRe = expandWildcards(path);
  const end = path.endsWith('*') ? '' : '$';

  return `^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}${end}`;
}

/**
 * Origins to hand to chrome.permissions.request(). Paths are collapsed to `/*`
 * because host permissions are per-origin, and a `*` scheme is expanded into
 * the two concrete schemes declared in optional_host_permissions.
 * @returns {string[]}
 */
export function patternToOrigins(pattern) {
  const error = validateMatchPattern(pattern);
  if (error) throw new Error(`${pattern}: ${error}`);

  if (pattern === '<all_urls>') return ['https://*/*', 'http://*/*'];

  const { scheme, host } = splitPattern(pattern);
  const schemes = scheme === '*' ? ['https', 'http'] : [scheme];
  return schemes.map((s) => `${s}://${host}/*`);
}

/**
 * Best-effort concrete URL to read a site's policy from. Returns null when
 * the pattern is too wild to pin down (a `*` host), in which case the UI asks
 * for a URL instead.
 * @returns {string|null}
 */
export function patternToTestUrl(pattern) {
  if (validateMatchPattern(pattern) !== null) return null;
  if (pattern === '<all_urls>') return null;

  const { scheme, host, path } = splitPattern(pattern);
  if (host === '*') return null;

  const concreteScheme = scheme === '*' ? 'https' : scheme;
  const concreteHost = host.startsWith('*.') ? host.slice(2) : host;

  // Keep everything before the first wildcard; fall back to the site root.
  const star = path.indexOf('*');
  const concretePath = star === -1 ? path : path.slice(0, star);

  return `${concreteScheme}://${concreteHost}${concretePath || '/'}`;
}

/**
 * Does `href` fall under any of `patterns`? Uses the same regex the DNR rules
 * are built from, so profile resolution in the service worker cannot drift
 * from what the network layer actually did.
 */
export function hrefMatchesPatterns(href, patterns) {
  return patterns.some((pattern) => {
    let regexFilter;
    try {
      regexFilter = matchPatternToRegexFilter(pattern);
    } catch {
      return false; // Invalid patterns simply never match.
    }
    // 'i' mirrors isUrlFilterCaseSensitive defaulting to false.
    return new RegExp(regexFilter, 'i').test(href);
  });
}
