# AntiPause Suite

AntiPause Suite (APS) is a browser userscript for monitoring HTML audio and video playback and attempting recovery from unexpected pauses and stalls. It combines media discovery, user-intent scoring, a playback state machine, and bounded recovery strategies in one dependency-free script.

## Installation

Install a userscript manager such as Tampermonkey or Violentmonkey, then download **[APS.user.js from the V1 release](https://github.com/NeonTideX/APS/releases/download/v1.0.0/APS.user.js)**. Open or import the downloaded file with your userscript manager. If needed, paste its contents into a new script.

See the [V1 release notes](https://github.com/NeonTideX/APS/releases/tag/v1.0.0) for the release summary and downloadable assets.

The script runs at `document-start` on HTTP and HTTPS pages with `@grant none`. Disable other installations of APS before enabling it, then reload the page and start playback normally.

## Runtime architecture

| Component | Responsibility |
| --- | --- |
| Discovery and registry | Scan audio/video elements, observe DOM changes, and inspect supported shadow roots and accessible iframe documents. |
| Intent and scoring | Combine recent input, media state, visibility, and playback history to select active media and estimate whether a pause was deliberate. |
| State machine and watchdog | Track playback transitions and detect stalled progress or overdue states. |
| Recovery dispatcher | Prioritize recovery requests with per-media throttling, concurrency limits, and a global attempt budget. |
| Strategy engine | Try player adapters, native playback, seeking, muted playback, and escalation steps according to configuration and media state. |
| Circuit breaker | Suspend scheduling after repeated internal errors, allow limited probes after cooldown, and reopen on probe errors. |
| Background services | Use workers, silent audio, wake locks, and visibility/focus hooks where the browser permits them. |

The normal flow is **discovery → intent assessment → state tracking → recovery queue → strategy execution → playback verification**. Successful recovery updates local learning data; deliberate pauses are intended to remain paused. Intent classification is heuristic and can misclassify player interactions.

The implementation is organized into numbered sections in [`APS.user.js`](./APS.user.js). It is both the source and the installable artifact; there is no bundle or build step.

## Configuration

The page-context API is available as `window.__APS23`. The identifier and the `APS23_*` storage keys are compatibility identifiers; the current release version is **1.0.0**.

```js
// Inspect the current immutable configuration snapshot.
window.__APS23.config;

// Validate and apply a partial configuration update.
window.__APS23.configure({
    recovery: { retry: 3, interval: 5000 },
    watchdog: { interval: 5000, timeout: 12000 }
});

// Save overrides in this website's localStorage for subsequent loads.
window.__APS23.configure({
    recovery: { strategyChain: ['adapter', 'native'] }
}, { persist: true });
```

`configure()` returns `{ ok: true }` or `{ ok: false, errors: [...] }`. Unknown keys, malformed sections, invalid types, and values outside explicitly defined ranges are rejected. Array settings replace the corresponding array. Some services read their options only during initialization; reload the page after persisting changes to shields, background services, or the strategy chain.

`recovery.strategyChain` seeds strategy registration. Other built-in strategies are appended as lower-priority fallbacks, and execution order is determined by effective priority. The configured array is not an exclusive allowlist.

Selected defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `recovery.retry` | `3` | Retry count used by recovery logic. |
| `recovery.strategyChain` | `['adapter', 'drm', 'seek', 'muted', 'native']` | Configured strategy chain. |
| `recovery.recoverEnded` | `false` | Whether ended media may be recovered. |
| `filters.maxManaged` | `15` | Maximum number of managed media elements. |
| `shield.stopPropagation` | `'passive'` | Event interception mode; aggressive mode can interfere with page handlers. |
| `background.silentAudio` | `true` | Enable the background audio mechanism when available. |
| `telemetry.enabled` | `false` | Collect local diagnostic samples. |

`filters.blacklist` and `filters.whitelist` entries are tested as regular expressions against the media source URL and as CSS selectors against the media element. They do not directly match the page hostname. Use your userscript manager's exclusions to disable APS on a website.

## Diagnostics

```js
window.__APS23.debug.lifecycle(); // Runtime lifecycle state
window.__APS23.debug.media();     // Managed media, playback state, and history
window.__APS23.debug.stats();     // Runtime report
window.__APS23.debug.bridge();    // Page bridge status
window.__APS23.control.scan();    // Request media discovery
window.__APS23.control.destroy(); // Stop APS on this page until reload
```

The default stealth mode makes the API non-enumerable. The optional `paranoid` mode may remove the global API after initialization.

## Storage and network behavior

Configuration overrides, learned outcomes, and custom rules use the current origin's `localStorage` (`APS23_CONFIG`, `APS23_LEARNING`, and `APS23_RULES` by default). They are scoped to the website and are not isolated from that website's scripts.

Telemetry is disabled by default. When enabled, diagnostic samples remain in memory unless explicitly exported; session export writes to `sessionStorage`. The script does not include a telemetry upload endpoint. The rule-loading API can fetch a supplied remote rule URL when invoked.

## Compatibility and limits

- Requires a modern browser and a userscript manager capable of executing the script in the page context.
- Autoplay restrictions, suspended tabs, operating-system power policies, DRM requirements, and site-specific player logic can prevent recovery.
- The userscript itself runs only in the top-level document. It can inspect accessible iframe documents; cross-origin media access remains subject to browser restrictions.
- Content Security Policy may restrict page bridge injection or worker creation. Diagnostics expose bridge degradation.
- Visibility/focus overrides, media API interception, and background audio can change website behavior. Disable APS on sites where those interactions cause problems.

## Development and validation

Use Node.js 22 or newer. No package installation is required:

```sh
npm run validate
```

This checks userscript syntax and runs regression tests for configuration validation and isolation, history ordering, circuit-breaker transitions, navigation cleanup, missing recovery inputs, and version metadata. Tests execute source sections with controlled dependencies; they do not replace end-to-end playback testing in real browsers.

The package is marked private to prevent accidental npm publication; distribution uses the userscript file in this public repository.

## License

Licensed under the **GNU General Public License, version 3 or (at your option) any later version** (`GPL-3.0-or-later`). See [LICENSE](./LICENSE) for the full GPL v3 text. The program is provided without warranty.
