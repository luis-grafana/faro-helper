// Popup UI.
//
// Two behaviours are shaped by the fact that this is a popup rather than a page:
//
//  1. Edits autosave to storage as you type. A popup is destroyed whenever it
//     loses focus — including when Chrome raises the host-permission prompt —
//     so "save on Apply" would throw away work at exactly the wrong moment.
//     Saving is therefore separate from applying: storage always holds your
//     latest text; Apply is what pushes it into the browser.
//
//  2. chrome.permissions.request() must be called synchronously inside the
//     click handler. Awaiting anything first spends the user gesture and Chrome
//     rejects the call, so the Grant path reads origins straight out of the
//     in-memory config.

import { RELOAD_ON_GRANT_KEY, hasPermission, origins as originsFor, revokeUnusedOrigins, tabIdsMatching } from './lib/apply.js';
import {
  blankProfile,
  loadConfig,
  profileIssues,
  profileOrigins,
  saveConfig,
} from './lib/config.js';
import { hrefMatchesPatterns, patternToTestUrl, validateMatchPattern } from './lib/match.js';

const AUTOSAVE_MS = 350;

const profilesEl = document.getElementById('profiles');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const templateEl = document.getElementById('profile-template');
const applyBtn = document.querySelector('[data-action="apply"]');
const reloadTabsEl = document.getElementById('reload-tabs');
const reloadTabsLabel = document.getElementById('reload-tabs-label');

let config = { version: 1, profiles: [] };
let saveTimer = null;

/**
 * Profiles whose missing-field errors have been revealed by an Apply attempt.
 *
 * Validation runs continuously, but the results stay hidden until Apply asks for
 * them. Switching a profile on is a statement of intent, not a mistake — lighting the
 * card up red the instant it is ticked reads as an error when the user has simply not
 * finished yet. Errors clear again as soon as the fields are filled in, and the set is
 * in-memory only, so reopening the popup starts quiet.
 */
const revealedIssues = new Set();

/**
 * Whether there are edits Apply has not pushed yet.
 *
 * Persisted to storage, not just held in memory: edits autosave, so a popup closed
 * mid-edit (a click on the page, a tab switch) leaves unapplied changes behind. When
 * it reopens, that pending state has to be recovered so Apply and Reload tabs come
 * back without the user having to touch a field first.
 *
 * It is a flag the popup owns, NOT a comparison against stored config: the service
 * worker rewrites config on its own (recording each site's live CSP after an apply,
 * re-syncing on startup or a permission change), and an earlier snapshot-comparison
 * design read those background writes as "unapplied changes" the instant the popup
 * opened. Only the user's own edits flip this on; only a successful Apply flips it off.
 */
const HAS_EDITS_KEY = 'cspInjectHasEdits';
let hasEdits = false;

function markEdited() {
  // With no profiles there is nothing Apply could do — an empty config produces no
  // rules and no scripts, and any rules a deleted profile held are already torn down
  // by its revoke. Enforcing it here keeps every caller (edit, add, delete) honest.
  if (config.profiles.length === 0) {
    clearEdits();
    return;
  }
  applyBtn.hidden = false;
  // Reload tabs is an Apply-time option, so it only makes sense alongside Apply.
  reloadTabsLabel.hidden = false;
  // Persist only on the false→true transition, so typing doesn't write every keystroke.
  if (!hasEdits) {
    hasEdits = true;
    chrome.storage.local.set({ [HAS_EDITS_KEY]: true });
  }
}

function clearEdits() {
  hasEdits = false;
  applyBtn.hidden = true;
  reloadTabsLabel.hidden = true;
  chrome.storage.local.remove(HAS_EDITS_KEY);
}

// --------------------------------------------------------------------- helpers

/**
 * Every origin any profile refers to, on or off — the candidate set for revocation.
 * `originsFor` deliberately covers only switched-on profiles, which is what must be
 * kept; the difference between the two is what gets handed back.
 */
const allOriginsFor = (profiles) => [...new Set(profiles.flatMap(profileOrigins))];

/** Issue text can contain a site's own CSP, so it is never trusted as markup. */
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
}

/** Persist without touching the browser's live rules. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveConfig(config).catch((error) => setStatus(`Could not save: ${error.message}`, 'error'));
  }, AUTOSAVE_MS);
  markEdited();
}

/** Flush a pending autosave so Apply never races the debounce. */
async function saveNow() {
  clearTimeout(saveTimer);
  config = await saveConfig(config);
}

const findProfile = (id) => config.profiles.find((profile) => profile.id === id);
const cardFor = (id) => profilesEl.querySelector(`[data-profile][data-id="${id}"]`);

/** Read a dotted path like "faro.appName" off a profile. */
function getField(profile, path) {
  return path.split('.').reduce((value, key) => value?.[key], profile);
}

function setField(profile, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((target, key) => target[key], profile)[last] = value;
}

// ---------------------------------------------------------------- per-card sync

/** Refresh only the derived bits of a card, leaving inputs (and the caret) alone. */
function refreshCard(profile) {
  const card = cardFor(profile.id);
  if (!card) return;

  card.classList.toggle('off', !profile.enabled);

  const matchesEl = card.querySelector('[data-field="matches"]');
  const lineErrors = profile.matches
    .map((pattern) => {
      const error = validateMatchPattern(pattern);
      return error ? `${pattern} — ${error}` : null;
    })
    .filter(Boolean);
  card.querySelector('[data-matches-error]').textContent = lineErrors.join('\n');
  matchesEl.classList.toggle('invalid', lineErrors.length > 0);

  // Errors wait for Apply to ask for them. Warnings only fire on data that has been
  // entered and looks wrong, never on data that is simply absent, so they show
  // immediately — there is nothing accusatory about them.
  const { errors, warnings } = profileIssues(profile);
  const shown = revealedIssues.has(profile.id) ? errors : [];
  card.querySelector('[data-issues]').innerHTML = [
    ...shown.map((text) => `<div class="issue-error">✗ ${escapeHtml(text)}</div>`),
    ...warnings.map((text) => `<div class="issue-warn">⚠ ${escapeHtml(text)}</div>`),
  ].join('');

  refreshPermissionBadge(profile);
}

/**
 * Show the current access state. Purely informational — there is no Grant or Revoke
 * button, because Apply handles both: switching a profile on requests access,
 * switching it off gives it back.
 */
async function refreshPermissionBadge(profile) {
  const card = cardFor(profile.id);
  if (!card) return;

  const badge = card.querySelector('[data-perm]');
  const wanted = profileOrigins(profile);

  if (wanted.length === 0) {
    badge.className = 'perm';
    badge.textContent = '';
    badge.title = '';
    return;
  }

  const granted = await hasPermission(profile);
  badge.title = wanted.join('\n');

  if (granted) {
    badge.className = profile.enabled ? 'perm granted' : 'perm pending';
    badge.textContent = profile.enabled ? 'site access granted' : 'access will be removed on Apply';
  } else {
    badge.className = profile.enabled ? 'perm pending' : 'perm';
    badge.textContent = profile.enabled ? 'access will be requested on Apply' : '';
  }
}

// ------------------------------------------------------------------- rendering

function buildCard(profile, expanded) {
  const card = templateEl.content.firstElementChild.cloneNode(true);
  card.dataset.id = profile.id;
  card.classList.toggle('collapsed', !expanded);
  card.querySelector('[data-action="collapse"]').setAttribute('aria-expanded', String(expanded));

  card.querySelector('[data-field="enabled"]').checked = profile.enabled;
  card.querySelector('[data-field="replay"]').checked = profile.replay;
  card.querySelector('[data-field="name"]').value = profile.name;
  card.querySelector('[data-field="matches"]').value = profile.matches.join('\n');
  card.querySelector('[data-field="testUrl"]').value = profile.testUrl;
  card.querySelector('[data-field="faro.collectorUrl"]').value = profile.faro.collectorUrl;
  card.querySelector('[data-field="faro.appName"]').value = profile.faro.appName;
  card.querySelector('[data-field="faro.appVersion"]').value = profile.faro.appVersion;
  card.querySelector('[data-field="faro.environment"]').value = profile.faro.environment;

  return card;
}

/**
 * Full rebuild. Only called for structural changes (boot, add, delete) — typing
 * must never trigger this or the caret jumps. Deliberately does not touch the
 * edited flag: boot renders without edits, and add/delete mark themselves.
 */
function render(expandedIds = new Set()) {
  profilesEl.replaceChildren(
    ...config.profiles.map((profile) => buildCard(profile, expandedIds.has(profile.id))),
  );
  emptyEl.hidden = config.profiles.length > 0;
  for (const profile of config.profiles) refreshCard(profile);
}

/**
 * Which card to open on launch. Best effort: if the active tab's URL is
 * readable and a profile claims it, that is almost certainly the one you came
 * to edit. tab.url needs host permission, so this often returns nothing —
 * hence the fallbacks rather than a hard dependency.
 */
async function chooseExpanded() {
  if (config.profiles.length === 1) return new Set([config.profiles[0].id]);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const match = config.profiles.find((p) => hrefMatchesPatterns(tab.url, p.matches));
      if (match) return new Set([match.id]);
    }
  } catch {
    // No host permission for the active tab; fall through to collapsed.
  }
  return new Set();
}

// -------------------------------------------------------------------- actions

/**
 * Apply, including the access changes the profile switches imply.
 *
 * MUST stay synchronous up to permissions.request(). Awaiting anything first spends
 * the user gesture and Chrome rejects the call — which is why the pending autosave is
 * kicked off without awaiting, and why the origins are computed from the in-memory
 * config rather than looked up.
 *
 * Requesting origins that are already granted is a no-op that resolves immediately
 * without a prompt, so this can request everything the on-profiles need without
 * first checking what is held.
 */
function doApply() {
  // This is the moment errors are asked for, so reveal them now — and hide them again
  // for anything that has since been completed or switched off.
  for (const profile of config.profiles) {
    const incomplete = profile.enabled && profileIssues(profile).errors.length > 0;
    if (incomplete) revealedIssues.add(profile.id);
    else revealedIssues.delete(profile.id);
  }
  for (const profile of config.profiles) refreshCard(profile);

  // Only ask for access on behalf of profiles that could actually be applied.
  // Prompting for a site whose profile is half-filled would be asking for something
  // that cannot be used yet.
  const wanted = originsFor(config.profiles.filter((p) => profileIssues(p).errors.length === 0));

  // Flush without awaiting. The write lands in a millisecond or two, and the service
  // worker only reads config after the round trip below.
  clearTimeout(saveTimer);
  saveConfig(config).catch(() => {});

  if (wanted.length === 0) {
    continueApply();
    return;
  }

  // Requesting access opens Chrome's permission prompt, which closes this popup — so
  // the reload below never runs from here. Hand the intent to the service worker
  // (its onAdded fires after the grant) by persisting it now, before the prompt.
  // Not awaited: an await here would spend the user gesture request() needs.
  if (reloadTabsEl.checked) chrome.storage.local.set({ [RELOAD_ON_GRANT_KEY]: true });

  setStatus('Requesting site access…');
  chrome.permissions.request({ origins: wanted }, (granted) => {
    if (chrome.runtime.lastError) {
      setStatus(`Permission request failed: ${chrome.runtime.lastError.message}`, 'error');
      return;
    }
    // Not fatal — applyConfig reports which profiles ended up without access. The
    // prompt may also have closed this popup, in which case the service worker's
    // permissions.onAdded listener applies the rules without us.
    continueApply(granted);
  });
}

/**
 * The rest of Apply, once the gesture-sensitive part is done.
 *
 * The heavy work runs in the service worker: it performs one network fetch per
 * profile to read the live policy, and this popup is destroyed the moment it loses
 * focus, so closing it mid-Apply cannot leave things half done.
 */
async function continueApply(granted = true) {
  // The popup survived the grant (or none was needed), so it will do the reload itself
  // via the apply message below. Drop the hand-off flag so the service worker's
  // onAdded — which runs slower, since it re-fetches policies — doesn't reload again.
  chrome.storage.local.remove(RELOAD_ON_GRANT_KEY);

  setStatus('Applying — reading each site’s live policy…');
  await saveNow();

  // Capture the tabs of profiles that are now OFF *before* revoking their access.
  // Switching a profile off still needs its page reloaded — that is what drops the
  // injected SDK and restores the site's own CSP — but the tab becomes unfindable the
  // moment access goes, because tabs.query({url}) requires host permission for the
  // pattern. Ids survive that: reloading by id needs no permission.
  let staleTabIds = [];
  if (reloadTabsEl.checked) {
    try {
      staleTabIds = await tabIdsMatching(
        config.profiles.filter((p) => !p.enabled).flatMap((p) => p.matches),
      );
    } catch {
      // Not worth failing Apply over; the rules still get rebuilt.
    }
  }

  // Hand back access for profiles that are now off, before the worker rebuilds — so
  // it sees the final permission state. Only origins no remaining on-profile needs.
  let revoked = [];
  try {
    revoked = await revokeUnusedOrigins(allOriginsFor(config.profiles), config.profiles);
  } catch (error) {
    setStatus(`Could not remove site access: ${error.message}`, 'error');
  }

  const summary = await chrome.runtime.sendMessage({
    type: 'apply',
    reloadTabs: reloadTabsEl.checked,
    staleTabIds,
  });

  if (!summary) {
    setStatus('The service worker did not respond. Check its console.', 'error');
    return;
  }

  // Apply records what each site was serving, so re-read it for accurate drift.
  config = await loadConfig();

  // Only stand Apply down when nothing was left behind. Hiding it while a profile
  // was skipped would claim you are in sync when the profile you care about is not
  // live — a failed run still has something to apply.
  if (summary.ok) clearEdits();

  const lines = [
    `${summary.ruleCount} CSP rule${summary.ruleCount === 1 ? '' : 's'}, ` +
      `${summary.scriptCount} script${summary.scriptCount === 1 ? '' : 's'} registered.`,
  ];

  // Show the edit rather than asserting it was made.
  for (const patch of summary.patches ?? []) {
    const edit = patch.changes.length
      ? patch.changes.join(', ')
      : 'policy already allowed everything needed';
    lines.push(`${patch.name}: ${edit}${patch.replay ? ' — session replay on' : ''}`);
  }
  lines.push(...(summary.notes ?? []));

  if (revoked.length > 0) lines.push(`Removed access to ${revoked.length} origin(s).`);
  if (!granted) lines.push('Site access was denied.');
  if (summary.disabledCount) lines.push(`${summary.disabledCount} profile(s) off.`);
  lines.push(...(summary.errors ?? []));

  if (typeof summary.reloadedTabs === 'number') {
    lines.push(summary.reloadedTabs ? `Reloaded ${summary.reloadedTabs} tab(s).` : 'No open tabs matched.');
  } else if (summary.ok && summary.ruleCount > 0) {
    lines.push('Reload the page to see it take effect.');
  }

  setStatus(lines.join('\n'), summary.ok ? 'ok' : 'error');
  for (const profile of config.profiles) refreshCard(profile);
}

function doAdd() {
  const profile = blankProfile();
  config.profiles.push(profile);
  scheduleSave();
  render(new Set([profile.id]));
  cardFor(profile.id)?.querySelector('[data-field="name"]')?.focus();
}

/**
 * Delete a profile, handing back any site access it was holding.
 *
 * The revoke is scoped to origins no remaining profile needs — two profiles can
 * legitimately cover the same host, and deleting one must not break the other.
 */
async function doDelete(profile) {
  const label = profile.name || 'this profile';
  if (!confirm(`Delete ${label}? Its settings are lost and its site access is removed.`)) return;

  const orphaned = profileOrigins(profile);
  const expanded = new Set(
    [...profilesEl.querySelectorAll('[data-profile]:not(.collapsed)')].map((c) => c.dataset.id),
  );
  config.profiles = config.profiles.filter((p) => p.id !== profile.id);
  await saveNow();
  render(expanded);

  let revoked = [];
  try {
    revoked = await revokeUnusedOrigins(orphaned, config.profiles);
  } catch (error) {
    setStatus(`Deleted ${label}, but its site access could not be removed: ${error.message}`, 'error');
    return;
  }

  // An empty config has nothing to apply — back to the clean initial view. This must
  // run regardless of branch, because Apply may still be showing from an earlier
  // edit or an earlier delete in the same session.
  if (config.profiles.length === 0) clearEdits();

  // Removing access fires permissions.onRemoved, which rebuilds rules in the service
  // worker — so the deleted profile's rules are already gone.
  if (revoked.length > 0) {
    setStatus(`Deleted ${label}. Site access removed for ${revoked.join(', ')}.`);
  } else if (config.profiles.length > 0) {
    // No access was held, so no rules were registered for it — unless a remaining
    // profile shares the host, in which case this profile's own rule lingers until
    // the next Apply re-syncs.
    markEdited();
    setStatus(`Deleted ${label}. Apply to drop its leftover rules.`);
  } else {
    setStatus(`Deleted ${label}.`);
  }
}

// -------------------------------------------------------------------- wiring

// Typing: update state, refresh derived UI, autosave. Never re-renders.
profilesEl.addEventListener('input', (event) => {
  const field = event.target.dataset.field;
  const card = event.target.closest('[data-profile]');
  if (!field || !card) return;

  const profile = findProfile(card.dataset.id);
  if (!profile) return;

  if (field === 'enabled') {
    profile.enabled = event.target.checked;
    // Toggling is intent, not a mistake: never reveal errors here. Any already showing
    // are withdrawn, so the next Apply is what raises them again.
    revealedIssues.delete(profile.id);
    // The last Apply summary described a different set of switches, so it is now
    // misleading. Clearing it also gives back the space it was taking, which is what
    // keeps Apply in view.
    setStatus('');
  } else if (field === 'replay') {
    profile.replay = event.target.checked;
  } else if (field === 'matches') {
    profile.matches = event.target.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    setField(profile, field, event.target.value);
  }

  // Naming a profile after its host is the common case; offer a test URL for free.
  if (field === 'matches' && !profile.testUrl) {
    const guess = patternToTestUrl(profile.matches[0] ?? '');
    if (guess) {
      profile.testUrl = guess;
      card.querySelector('[data-field="testUrl"]').value = guess;
    }
  }

  // Stop showing revealed errors the moment the profile is complete, so filling the
  // gaps in is its own feedback rather than needing another Apply to confirm.
  if (profileIssues(profile).errors.length === 0) revealedIssues.delete(profile.id);

  scheduleSave();
  refreshCard(profile);
});

profilesEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('[data-profile]');
  if (!button || !card) return;

  const profile = findProfile(card.dataset.id);
  if (!profile) return;

  switch (button.dataset.action) {
    case 'collapse': {
      const collapsed = card.classList.toggle('collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
      break;
    }
    case 'delete':
      doDelete(profile);
      break;
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || event.target.closest('[data-profile]')) return;

  switch (button.dataset.action) {
    case 'apply':
      doApply();
      break;
    case 'add':
      doAdd();
      break;
  }
});

// The card listener only covers fields inside a profile; this checkbox lives in the
// footer. It is an option consumed by the Apply run itself rather than saved config,
// but changing it still changes what the next Apply will do — so it surfaces the
// button like any other edit.
reloadTabsEl.addEventListener('change', markEdited);

// ----------------------------------------------------------------------- boot

(async () => {
  config = await loadConfig();

  // Restore the pending-edits state so a popup closed mid-edit reopens with Apply and
  // Reload tabs still showing. markEdited self-guards to nothing when there are no
  // profiles, so a stale flag against an empty config resolves to the clean state.
  const stored = await chrome.storage.local.get(HAS_EDITS_KEY);
  if (stored[HAS_EDITS_KEY]) markEdited();
  else clearEdits();

  // Clear any reload-on-grant flag left over from a grant that was denied (which
  // closes the popup before it can clean up). A live grant is handled within
  // milliseconds, long before a person could reopen the popup, so this cannot race
  // a legitimately pending reload.
  chrome.storage.local.remove(RELOAD_ON_GRANT_KEY);
  render(await chooseExpanded());
})();
