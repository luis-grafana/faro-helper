# Grafana Faro Helper

A Chrome extension that injects the [Grafana Faro](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/) web SDK into any site you choose, so you can capture front-end telemetry — Web Vitals, errors, traces, and optionally session replay — from sites you don't control the source of.

Most production sites send a `Content-Security-Policy` header that blocks scripts from a `chrome-extension:` origin and blocks network calls to a telemetry collector. This extension patches that policy at the network layer so the SDK can run, then injects and initialises it early enough to capture real metrics.

Everything is configured at runtime from the toolbar popup. There is no build step, no bundler, and no remotely-hosted code.

---

## Contents

- [Install](#install)
  - [Option 1 · Chrome Web Store (request access)](#option-1--chrome-web-store-request-access)
  - [Option 2 · Manual install (local, unpacked)](#option-2--manual-install-local-unpacked)
- [Usage](#usage)
- [What Apply actually does](#what-apply-actually-does)
- [Session replay](#session-replay)
- [Architecture](#architecture)
- [The timing requirement](#the-timing-requirement)
- [Troubleshooting](#troubleshooting)
- [Design decisions](#design-decisions)
- [Maintenance](#maintenance)

---

## Install

Two options: request access to the published Chrome Web Store listing, or install the folder manually.

### Option 1 · Chrome Web Store (request access)

The extension **is** published on the Chrome Web Store, but the listing is private — it is not publicly searchable and cannot be installed directly. Access is granted per person.

1. **Request access** using this form: **[Faro Helper — access request form](https://forms.gle/REPLACE-ME)**
2. Once your request is approved, you'll receive a **one-click installation link** from the Chrome Web Store
3. Open the link and choose **Add to Chrome**

This is the recommended route: installation is one click, and updates arrive automatically through the Web Store.

### Option 2 · Manual install (local, unpacked)

Use this if you'd rather not wait for access, or you want to run modified code.

Download this repository first — either `git clone`, or **Code → Download ZIP** and unzip it. The folder you select below must be the one containing `manifest.json`.

> **Works on any Chromium-based browser** — Google Chrome, Microsoft Edge, Brave, Vivaldi, Opera, Arc, and others. The two most common are covered below; the steps on any other Chromium browser are the same, just at that browser's own extensions page.

#### Google Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the folder containing `manifest.json`
5. Pin **Grafana Faro Helper** from the toolbar's extensions (🧩) menu so the popup is one click away

#### Microsoft Edge

1. Open `edge://extensions`
2. Turn on **Developer mode** (toggle, bottom left)
3. Click **Load unpacked**
4. Select the folder containing `manifest.json`
5. Pin it from the toolbar's extensions menu

> Edge may warn that the extension isn't from the Microsoft Store — expected for a manually loaded extension, and safe to accept here.

#### Other Chromium browsers

Same three steps at the browser's own extensions page — e.g. `brave://extensions`, `vivaldi://extensions`, `opera://extensions` — then **Developer mode** → **Load unpacked**.

> **Note on manual installs:** the extension will not auto-update, so re-download and reload it to get changes. Some browsers also show a "disable developer mode extensions" prompt on each restart; that's normal for unpacked extensions.

### After installing (either option)

The popup opens empty. The extension holds **no** site access until you add a profile and click Apply — the manifest declares host permissions as *optional*, requested per-site at runtime.

---

## Usage

A **profile** is one site plus the Faro config to use there. The popup walks through it:

### 1 · Where it runs

Match patterns, one per line:

```
https://www.example.com/*
*://*.example.com/*
```

Standard [Chrome match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns). Validated as you type.

> **Apex vs `www` is a real trap.** `https://example.com/*` does **not** match `https://www.example.com/`. Most sites redirect the apex to `www`, so if nothing appears in the console, check `location.hostname` against your pattern. `*://*.example.com/*` covers both plus any subdomain.

### 2 · Where to send the data

| Field | Notes |
|---|---|
| **Faro endpoint URL** | Any collector — Grafana Cloud (`…grafana.net/collect/<key>`) or a self-hosted/custom domain. Its **origin** is what gets added to `connect-src`. |
| **App name / Version / Environment** | Passed straight to `initializeFaro` as `app.*`. Nothing is pre-filled — a default here would silently ship as real telemetry metadata. |
| **Enable session replay** | Off by default. See [Session replay](#session-replay). |

### 3 · Turn it on, then Apply

Tick **On**, click **Apply**, accept Chrome's permission prompt, then reload the page.

Apply is the only action that changes browser state. Editing fields just autosaves — the **Apply** button and **Reload tabs** checkbox only appear when there is something pending, and that pending state survives the popup closing.

**Access is handled for you.** There is no Grant/Revoke button:

- Profile **On** + no access → Apply requests it
- Profile **Off** + access held → Apply gives it back
- **Deleting** a profile revokes its access too — but only origins no remaining profile still needs

**Reload tabs** reloads matching open tabs so you don't refresh by hand. It applies when switching a profile *off* as well, which is what unloads the SDK and restores the site's own policy.

---

## What Apply actually does

For each enabled profile, Apply:

1. **Fetches the live page** and reads its real `content-security-policy` response header.
2. **Patches that policy additively** — only ever adding tokens, never removing:

   | Directive | Token | Why |
   |---|---|---|
   | `script-src` | `chrome-extension:` | Page CSP governs MAIN-world content scripts, including the SDK files themselves. Without this, nothing executes. |
   | `connect-src` | the collector's **origin** | So beacons can be sent. Only the origin — never the `/collect/<key>` path, which would be an invalid CSP source and would leak the app key into a response header. |
   | `worker-src` | `blob:` | **Replay only.** The recorder starts a Web Worker from a Blob URL. |

3. **Installs it** as a `declarativeNetRequest` dynamic rule — one rule per match pattern, scoped to that pattern, on `main_frame` + `sub_frame`.
4. **Registers the content scripts** for that profile.
5. **Reports what it changed**, so you see the actual edit rather than a claim of success.

### Why fetch-and-patch rather than store a CSP

`declarativeNetRequest` cannot read-modify-write a header. `set` needs a literal value, and `append` on a CSP creates a *second* policy that gets **intersected** — more restrictive, not less. So the only way to loosen a policy is to read it, patch it, and install the result.

That is done fresh on **every** Apply and stored nowhere, which matters: a hand-maintained replacement policy drifts from production and starts silently dropping origins the site needs. Apply also records what the site was serving last time, so the next run reports *"the site's CSP changed since the last Apply"* rather than quietly installing something stale.

Two CSP subtleties handled rather than ignored:

- **Fallback inheritance.** An absent directive inherits from its chain (`worker-src` → `child-src` → `default-src`). Creating `script-src` from nothing would *drop* every origin `default-src` was allowing scripts from, so a created directive is seeded from its nearest present fallback first.
- **`'none'`** must appear alone, so it is removed when anything is being allowed.

`'unsafe-eval'` is **never** added. The SDK is injected as content scripts, not eval'd, so the installed policy never weakens the page's script-execution rules.

---

## Session replay

Optional, per profile, **off by default** — it records the page DOM (text, form inputs, images) via rrweb, which is far more than the metric/error/trace telemetry the base SDK sends.

When enabled, `faro-instrumentation-replay.iife.js` is injected and registered:

```js
faro.instrumentations.add(new GrafanaFaroInstrumentationReplay.ReplayInstrumentation());
```

### It also has to be enabled on the Grafana side

Session Replay is a **public-preview add-on**, enabled per Grafana Cloud *stack* — there is no self-serve toggle in the Grafana UI. You submit Grafana's [enablement form](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/session-replay/) listing your stacks.

Until that is done, the extension still records and POSTs replay data, but it won't render as playable sessions.

---

## Architecture

```
popup.html/.js ─── chrome.storage.local ─── background.js (service worker)
  thin UI; Apply         the only               owns Apply
  is a message           config source               │
                                                     │ ① GET the page, read its CSP
lib/match.js     match pattern → regexFilter         ▼
lib/csp.js       parse / patch / diff a policy    the live site
lib/fetch-csp.js read a policy as served             │
lib/config.js    schema + validation                 │ ② patchCsp() → install as a
lib/apply.js     fetch → patch → install             │    modifyHeaders rule
                                                     │
                                                     │ ③ runtime table → storage
                                                     ▼
                                                 bridge.js  (ISOLATED world)
                                                     │ data-csp-inject-config
                                                     ▼
                    MAIN world, in this order:  faro-web-sdk.iife.js
                                                faro-web-tracing.iife.js
                                                faro-instrumentation-replay.iife.js  (if on)
                                                init.js → initializeFaro()
```

### Two worlds, because each has something the other lacks

The SDK and `init.js` must run in the page's **MAIN** world to share globals with the page — which means no `chrome.*` access. And content script *files* cannot be parameterised, so per-profile config has to arrive some other way.

`bridge.js` runs in the **ISOLATED** world: it has `chrome.*` but cannot touch page globals. It reads the profile config and hands it over through a DOM attribute on `<html>` — the one channel both worlds can see — then dispatches a `CustomEvent` so `init.js` starts in the same task the config lands.

### File map

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest. Optional host permissions, no static rules, no WAR. |
| `background.js` | Service worker. Owns Apply and reading a site's pristine CSP. **Deliberately off the page-load path.** |
| `bridge.js` | ISOLATED content script. Reads config from storage, publishes it to the page world. |
| `init.js` | MAIN content script. Calls `initializeFaro`, adds tracing + replay, logs the timing proof. |
| `popup.*` | The UI. Thin — Apply is a message to the worker. |
| `lib/match.js` | Match pattern → DNR `regexFilter`, origin, and test URL. |
| `lib/csp.js` | CSP parse / serialize / patch / diff, and collector-origin extraction. |
| `lib/fetch-csp.js` | Reads a site's policy as served. |
| `lib/config.js` | Profile schema, normalisation, validation. |
| `lib/apply.js` | The apply pipeline: triage → resolve → build rules → register scripts. |
| `faro-*.iife.js` | Faro SDK bundles, packaged locally. **No remote code.** |

---

## The timing requirement

**Faro must be initialised before `DOMContentLoaded`** or it misses early Web Vitals and the numbers are quietly wrong. `init.js` logs the sequence on every page load so this is verifiable rather than assumed:

```
[CSP Inject] +0.0ms   loading      init.js running, SDK present: true
[CSP Inject] +21.1ms  loading      bridge signalled config ready
[CSP Inject] +29.8ms  loading      Faro initialised for "example"
[CSP Inject] +30.3ms  loading      ✓ Faro is up before DOMContentLoaded — early Web Vitals will be captured
[CSP Inject] +33.3ms  loading      tracing instrumentation added
[CSP Inject] +861.7ms interactive  DOMContentLoaded fired — Faro ready by now: true
```

Each line carries elapsed ms and `document.readyState`. The `✓` line is the one that matters. If the ordering ever inverts you get a warning instead:

```
[CSP Inject] ✗ Faro initialised at readyState="interactive", after DOMContentLoaded.
             Early Web Vitals were missed for this load.
```

`SDK present: false` on the first line means the bundles were blocked — see the `chrome-extension:` row in [Troubleshooting](#troubleshooting).

Two design choices exist purely to protect this budget:

- **The service worker is off the page-load path.** `bridge.js` reads `chrome.storage.local` directly (~21 ms measured) rather than messaging the worker, because a cold service-worker start costs tens to hundreds of milliseconds and would race `DOMContentLoaded`.
- **The config handoff is event-driven, not polled.** An earlier version used `requestAnimationFrame`; on a `document_start` script the first frame can land *after* `DOMContentLoaded`, and never fires at all in a background tab.

---

## Troubleshooting

Debug from the **page's** console, filtered to `[CSP Inject]` — not the extension's Errors page (see the last row).

| Symptom | Cause |
|---|---|
| No `[CSP Inject]` logs at all | Content scripts aren't registered. Check the **service worker** console (`chrome://extensions` → *service worker*) — a single bad file fails the whole batch. Also verify the match pattern really matches (`location.hostname`). |
| `Apply` reports `0 scripts registered` | Registration threw. The service-worker console has the reason. |
| Response header unchanged | Profile off, access not granted, or Apply not clicked. Check `await chrome.declarativeNetRequest.getDynamicRules()`. A fetch failure means Apply deliberately installed *nothing* rather than guess. |
| `the Faro SDK did not load` | Installed policy lacks `chrome-extension:` in `script-src`. Since patching adds it automatically, suspect another extension overriding the header, or a `<meta http-equiv>` CSP (DNR cannot touch those). |
| **CORS** error on the collector | Not a CSP problem — the request *left* the browser, so `connect-src` is right. The endpoint isn't returning `Access-Control-Allow-Origin`. For Grafana Cloud, add the site's origin to the app's allowed origins. |
| Faro says "fully active" but no data in Grafana | Almost always the CORS/allowed-origins case above. |
| Assets break after Apply | The installed policy is a snapshot. If the site deployed a new CSP, click **Apply** again — it reports the drift and re-syncs. |
| Two policies alternating between reloads | Another extension is setting the same header. Don't run two copies of this extension on one site. |
| Extension's Errors page full of the *site's* errors | Expected. Faro wraps `console`, so its wrapper is topmost on the stack for every console call the page makes, and Chrome attributes those to whichever extension is on top. Cosmetic — but it will bury real extension errors, so debug from the page console. |

Useful service-worker console commands:

```js
await chrome.scripting.getRegisteredContentScripts()
await chrome.declarativeNetRequest.getDynamicRules()
await chrome.permissions.getAll()
;(await chrome.storage.local.get('cspInjectConfig')).cspInjectConfig.profiles
```

---

## Design decisions

Things that look odd until you know why.

- **`storage.local`, not `sync`.** A real production CSP runs to ~4 KB and `storage.sync` caps a single item at 8 KB, so a couple of profiles would silently fail to save.
- **No `eval`.** The SDK bundles are registered as MAIN-world content scripts. Two earlier designs were worse: `eval`ing the bundles forced `'unsafe-eval'` into the installed policy (a gift to any XSS on the page), and injecting a `<script src="chrome-extension://…">` tag needs a `web_accessible_resources` entry whose `matches` must name every target host — the exact coupling this extension exists to remove.
  Additionally, since Faro **2.10.0** the bundles begin with `"use strict"`, and a strict *indirect* eval does not leak the bundle's `var GrafanaFaroWebSdk` into global scope — so eval-based injection is now broken by construction.
- **`regexFilter`, not `requestDomains`.** `requestDomains` also matches subdomains, so it cannot express "`www.example.com` and nothing else."
- **Apply is a full atomic replace**, never an incremental diff. Cheap at this scale, and it makes stale rules surviving an edit impossible.
- **Apply is serialised.** It is triggered from several places that can overlap (the popup, plus `permissions.onAdded`/`onRemoved`), and two concurrent runs would interleave `unregisterContentScripts` and `registerContentScripts` — re-registering a live id throws.
- **Apply runs in the service worker**, not the popup: it does one network fetch per profile, and a popup is destroyed the moment it loses focus.
- **Reading a policy needs no rule suspension.** The override rules are scoped to `main_frame`/`sub_frame`; a `fetch()` from an extension context is an `xmlhttprequest`, so our own override cannot match it and the pristine header comes back.
- **The CSP fetch is anonymous** (`credentials: 'omit'`), so it reads the logged-out policy. A site that tightens its CSP for signed-in users would serve something different to a signed-in tester.
- **Tabs are reloaded by id, not by URL.** Switching a profile off revokes its host access, and `tabs.query({url})` needs that permission — so the popup captures tab ids *before* revoking and passes them to the worker. Reloading by id needs no permission.
- **Revoking is scoped.** Two profiles can legitimately cover the same host; access is only handed back for origins no remaining enabled profile needs.
- **Nothing is pre-filled.** Faro's version/environment start empty rather than defaulting to `1.0.0`/`production`, because a default becomes real telemetry metadata if nobody looks at it.
- **`<meta http-equiv>` policies are out of reach.** DNR only modifies response headers.

---

## Maintenance

### Updating the Faro bundles

```bash
b="https://cdn.jsdelivr.net/npm/@grafana"
v="2.10.0"   # check https://www.npmjs.com/package/@grafana/faro-web-sdk
curl -sL "$b/faro-web-sdk@$v/dist/bundle/faro-web-sdk.iife.js"                               -o faro-web-sdk.iife.js
curl -sL "$b/faro-web-tracing@$v/dist/bundle/faro-web-tracing.iife.js"                       -o faro-web-tracing.iife.js
curl -sL "$b/faro-instrumentation-replay@$v/dist/bundle/faro-instrumentation-replay.iife.js" -o faro-instrumentation-replay.iife.js
```

> ### ⚠ After updating the replay bundle, you MUST re-run the ASCII transform
>
> The published replay bundle contains non-ASCII characters — a `﻿`/`￾` BOM check inside its bundled postcss, and a Chinese deprecation string. Chrome's content-script loader **rejects the file** with *"Could not load file … It isn't UTF-8 encoded"*, even though it is valid UTF-8 (`U+FFFE` is a Unicode noncharacter).
>
> Because all content scripts register in **one atomic call**, that single bad file fails the entire batch — you get **`0 scripts registered`** and nothing runs on any page, while the CSP rule still installs. The symptom is a silent extension with the real error only in the *service-worker* console.
>
> Fix — rewrites those characters as `\uXXXX` escapes (semantically identical, all inside string literals):
>
> ```bash
> python3 - <<'PY'
> f = 'faro-instrumentation-replay.iife.js'
> s = open(f, encoding='utf-8').read()
> def esc(c):
>     if ord(c) < 128: return c
>     b = c.encode('utf-16-be')
>     return ''.join('\\u%02x%02x' % (b[i], b[i+1]) for i in range(0, len(b), 2))
> open(f, 'w', encoding='ascii').write(''.join(esc(c) for c in s))
> print('non-ASCII remaining:', sum(1 for c in open(f, encoding='ascii').read() if ord(c) > 127))
> PY
> ```
>
> It must print `0`. The transform is idempotent.

Verify a bundle is really the version you think it is by **byte comparison** against the CDN, not by grepping for a version string — the minified bundles embed their *dependencies'* versions (OpenTelemetry, rrweb), which is misleading.

### Packaging a release

Bump `version` in `manifest.json` first, then:

```bash
V=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
rm -f "faro-helper-${V}.zip"
zip -rq "faro-helper-${V}.zip" . -x '.git/*' '.gitignore' 'README.md' '*.zip' '.DS_Store' '*/.DS_Store'
```

`manifest.json` must sit at the **archive root**, not inside a nested folder.

---

## License / status

Internal tool, BETA. Not affiliated with or endorsed by any site it is used on.
