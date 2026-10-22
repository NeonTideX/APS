# AntiPause Suite

AntiPause Suite (APS) is a browser userscript that detects unexpected audio and video pauses and attempts to resume playback while accounting for user pause intent.

Version **1.0.0** starts a new release series based on the original `V23.12.js` script. The original file is preserved in Git history.

## Features

- Monitor playback and attempt recovery after unexpected pauses or stalls.
- Track user interactions to distinguish deliberate pauses from automatic pauses.
- Discover media elements, including media inside supported shadow roots and accessible frames.
- Provide site adapters, configurable recovery strategies, and background playback support.
- Expose configuration and diagnostics through the browser console.

## Installation

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Open [`APS.user.js`](./APS.user.js) in this repository and download the raw file.
3. Import the file into your userscript manager, or create a new script and replace its contents with the entire file.
4. Save the script and reload a page with audio or video.

If you already installed the old V23 script, disable or remove it before enabling this version. The release number restarts at `1.0.0`, so an older `23.x` installation may not accept it as an automatic update.

For a private repository, download the file while signed in to GitHub and import it manually. Automatic update URLs are not configured.

## Usage

The script runs automatically on matching HTTP and HTTPS pages. Start playback normally, then use the site's player controls as usual. A userscript cannot guarantee background playback or override every browser autoplay restriction, site player behavior, or operating-system suspension.

Use the page's developer console to inspect the script:

```js
window.__APS23.version;
window.__APS23.debug.lifecycle();
window.__APS23.debug.media();
window.__APS23.debug.stats();
```

The `__APS23` console API, `aps-v23` namespace, and `APS23_*` storage keys retain their original names for compatibility. The release version is `1.0.0`.

Change configuration for the current page:

```js
window.__APS23.configure({
    debug: true,
    recovery: { interval: 5000 },
    filters: { blacklist: [], whitelist: [] }
});
```

Persist configuration for the current website:

```js
window.__APS23.configure({
    recovery: { retry: 3, strategyChain: ['adapter', 'native'] }
}, { persist: true });
```

Configuration calls return `{ ok: true }` or `{ ok: false, errors: [...] }`. Settings and learning data use the current website's browser storage. Telemetry is disabled by default; enabled diagnostic data is buffered locally. Remote rule loading is available through the console API when explicitly invoked.

## Development

The installable file is the source of truth. No build step or npm dependencies are required. Use Node.js 22 or newer:

```sh
npm run validate
```

Validation checks JavaScript syntax and runs configuration regression tests against code extracted from the userscript. These tests do not simulate complete browser playback; site compatibility requires manual browser testing.

## License

[MIT](./LICENSE), as declared in the original userscript.
