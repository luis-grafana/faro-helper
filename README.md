# Grafana Faro Helper

A Chrome extension that injects the [Grafana Faro](https://grafana.com/docs/grafana-cloud/monitor-applications/frontend-observability/) web SDK into any site you choose, so you can capture front-end telemetry (Web Vitals, errors, traces, and optionally session replay) from sites you don't control the source of.

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

The extension **is** published on the Chrome Web Store, but the listing is private. It is not publicly searchable. Access is granted per person.

1. **Request access** using this form: **[Faro Helper | Access Request Form](https://forms.gle/Vro6Q7eDpeFYbebT8)**
2. Once your request is approved, you'll receive a **one-click installation link** from the Chrome Web Store
3. Open the link and choose **Add to Chrome**

This is the recommended route: installation is one click, and updates arrive automatically through the Web Store.

### Option 2 · Manual install (local, unpacked)

Use this if you'd rather not wait for access, or you want to run modified code.

Download this repository first, either `git clone`, or **Code → Download ZIP** and unzip it. The folder you select below must be the one containing `manifest.json`.

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

> Edge may warn that the extension isn't from the Microsoft Store (expected for a manually loaded extension, and safe to accept here).

#### Other Chromium browsers

Same three steps at the browser's own extensions page, e.g. `brave://extensions`, `vivaldi://extensions`, `opera://extensions` — then **Developer mode** → **Load unpacked**.

> **Note on manual installs:** the extension will not auto-update, so re-download and reload it to get changes. Some browsers also show a "disable developer mode extensions" prompt on each restart; that's normal for unpacked extensions.

### After installing (either option)

The popup opens empty. The extension holds **no** site access until you add a profile and click Apply, the manifest declares host permissions as *optional*, requested per-site at runtime.

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
| **App name / Version / Environment** | Passed straight to `initializeFaro` as `app.*`. Nothing is pre-filled, a default here would silently ship as real telemetry metadata. |
| **Enable session replay** | Off by default. See [Session replay](#session-replay). |

### 3 · Turn it on, then Apply

Tick **On**, click **Apply**, accept Chrome's permission prompt, then reload the page.

Apply is the only action that changes browser state. Editing fields just autosaves, the **Apply** button and **Reload tabs** checkbox only appear when there is something pending, and that pending state survives the popup closing.

**Access is handled for you.** There is no Grant/Revoke button:

- Profile **On** + no access → Apply requests it
- Profile **Off** + access held → Apply gives it back
- **Deleting** a profile revokes its access too — but only origins no remaining profile still needs

**Reload tabs** reloads matching open tabs so you don't refresh by hand. It applies when switching a profile *off* as well, which is what unloads the SDK and restores the site's own policy.

---

## What Apply actually does

For each enabled profile, Apply:

1. **Fetches the live page** and reads its real `content-security-policy` response header.
2. **Patches that policy additively** only ever adding tokens, never removing:

   | Directive | Token | Why |
   |---|---|---|
   | `script-src` | `chrome-extension:` | Page CSP governs MAIN-world content scripts, including the SDK files themselves. Without this, nothing executes. |
   | `connect-src` | the collector's **origin** | So beacons can be sent. Only the origin — never the `/collect/<key>` path, which would be an invalid CSP source and would leak the app key into a response header. |
   | `worker-src` | `blob:` | **Replay only.** The recorder starts a Web Worker from a Blob URL. |

3. **Installs it** as a `declarativeNetRequest` dynamic rule, one rule per match pattern, scoped to that pattern, on `main_frame` + `sub_frame`.
4. **Registers the content scripts** for that profile.
5. **Reports what it changed**, so you see the actual edit rather than a claim of success.

---

## Session replay

Optional, per profile, **off by default** it records the page DOM (text, form inputs, images) via rrweb, which is far more than the metric/error/trace telemetry the base SDK sends.

When enabled, `faro-instrumentation-replay.iife.js` is injected and registered:

```js
faro.instrumentations.add(new GrafanaFaroInstrumentationReplay.ReplayInstrumentation());
```

### It also has to be enabled on the Grafana side

Session Replay is a **public-preview add-on**, enabled per Grafana Cloud *stack*. There is no self-serve toggle in the Grafana UI. You submit Grafana's [enablement form](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-applications/session-replay/) listing your stacks.

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

## Support

For issues, requests or feedback please reach out using this form: **[Faro Helper | Support Form](https://forms.gle/x4vnJ664UeqKxrgo7)**
