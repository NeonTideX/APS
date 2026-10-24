# Changelog

## V1 (1.0.0) - 2026-10-23

Initial public release of AntiPause Suite, distributed as the standalone `APS.user.js` userscript.

### Playback and recovery

- Discover audio and video elements through DOM observation, shadow-root scanning, and accessible iframe inspection.
- Combine user-intent scoring, playback state tracking, and watchdog monitoring to detect unexpected pauses and stalls.
- Dispatch recovery strategies with per-media throttling, concurrency limits, and a global attempt budget.
- Provide player adapters, background playback support, local learning, and a console diagnostics API.

### Reliability

- Validate array settings, nested configuration types, unknown keys, and finite numeric values.
- Isolate stored configuration from caller-owned objects and preserve immutable snapshots.
- Read ring-buffer history in insertion order before and after reaching capacity.
- Block recovery requests while the circuit is open, reopen after probe errors, and resume scheduling on manual reset.
- Cancel circuit-breaker cooldown during teardown and preserve runtime state during back-forward cache navigation.
- Safely ignore missing recovery instances.

### Distribution and validation

- Include technical documentation covering architecture, configuration, storage, and compatibility limits.
- Provide JavaScript syntax checks and 15 automated regression tests; real-site playback compatibility requires browser testing.
- License the project under GPL-3.0-or-later.
