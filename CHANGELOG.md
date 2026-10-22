# Changelog

## 1.0.0 - 2026-10-22

- Start a new release series from the original V23.12 userscript.
- Rename the installable script to `APS.user.js` and synchronize its metadata and runtime version.
- Fix array validation for recovery strategy chains and site filters.
- Copy configuration patches before storing them, preventing caller-owned values from being frozen or changing saved overrides unexpectedly.
- Add English installation instructions, usage examples, a license file, and configuration regression tests.
- Preserve the existing console API, userscript namespace, and browser storage keys.
