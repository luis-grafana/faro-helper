// Reading a site's Content-Security-Policy as served.
//
// No rule suspension is needed, which is worth spelling out because it looks like
// it should be: the override rules are scoped to
// `resourceTypes: ['main_frame', 'sub_frame']`, and a fetch() from an extension
// context is neither — it is an `xmlhttprequest`. So our own override cannot match
// this request and the headers come back untouched.
//
// Callers should run this from the service worker, not the popup: Apply performs
// one fetch per profile, and a popup is destroyed the moment it loses focus.

/**
 * @returns {Promise<{ok: true, csp: string, reportOnlyCsp: string, status: number,
 *   finalUrl: string} | {ok: false, error: string}>}
 */
export async function fetchLiveCsp(url) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: `Not a valid URL: ${url}` };
  }
  if (!/^https?:$/.test(target.protocol)) {
    return { ok: false, error: 'Only http and https URLs can be fetched.' };
  }
  if (!(await chrome.permissions.contains({ origins: [`${target.origin}/*`] }))) {
    return { ok: false, error: `No host access to ${target.origin}. Grant access first.` };
  }

  try {
    const response = await fetch(target.href, {
      method: 'GET',
      cache: 'no-store',
      // Anonymous, so this reads the logged-out policy. A site that varies its CSP
      // by auth state may serve something different to a signed-in tester.
      credentials: 'omit',
      redirect: 'follow',
    });
    return {
      ok: true,
      csp: response.headers.get('content-security-policy') || '',
      reportOnlyCsp: response.headers.get('content-security-policy-report-only') || '',
      status: response.status,
      finalUrl: response.url,
    };
  } catch (error) {
    return { ok: false, error: `Fetch failed: ${error.message}` };
  }
}

/**
 * The URL to read a profile's policy from: its explicit testUrl, else a concrete
 * URL derived from its first match pattern.
 */
export function profileFetchUrl(profile, patternToTestUrl) {
  const explicit = profile.testUrl?.trim();
  if (explicit) return explicit;
  return patternToTestUrl(profile.matches[0] ?? '');
}
