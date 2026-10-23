# Changelog

## Maintenance review - 2026-10-23 (version 1.0.0)

- Fix history traversal before the ring buffer reaches capacity.
- Enforce open-circuit request blocking, reopen after probe errors, and resume scheduling on manual reset.
- Cancel circuit-breaker cooldown during runtime teardown.
- Reject malformed configuration objects, unknown empty sections, and non-finite numeric values.
- Preserve runtime state during back-forward cache navigation and guard missing recovery instances.
- Replace the license with GPL-3.0-or-later and document runtime architecture, configuration, and compatibility limits.
- Keep the release version at 1.0.0.

## 1.0.0 - 2026-10-22

- Start a new release series from the original V23.12 userscript.
- Rename the installable script to `APS.user.js` and synchronize its metadata and runtime version.
- Fix array validation for recovery strategy chains and site filters.
- Copy configuration patches before storing them, preventing caller-owned values from being frozen or changing saved overrides unexpectedly.
- Add English installation instructions, usage examples, a license file, and configuration regression tests.
- Preserve the existing console API, userscript namespace, and browser storage keys.
