# Changelog

## V1 (1.0.0) - 2026-10-26

AntiPause Suite V1 is distributed as the standalone APS.user.js userscript under GPL-3.0-or-later.

### Playback and recovery

- Discover audio and video elements through DOM observation, shadow-root scanning, and accessible iframe inspection.
- Combine user-intent scoring, playback state tracking, and watchdog monitoring to detect unexpected pauses and stalls.
- Execute recovery strategies sequentially for each media element and verify playback before accepting success.
- Provide player adapters, background playback support, local learning, and a console diagnostics API.

### Scheduling and admission

- Resume scheduling after pause/resume and background-to-foreground transitions.
- Restore deadline-heap ordering after task rescheduling and discard replaced task entries.
- Deduplicate recovery requests and charge budgets only when execution starts.
- Enforce per-media throttling, bounded concurrency, request priorities, and a global attempt budget while preserving temporarily blocked queued work.

### Cancellation and reliability

- Bound the entire recovery attempt, including hung player promises and escalation, with a cancellation-aware deadline.
- Cancel waiting recovery work on deliberate pause, media removal, and teardown; release dispatcher slots, timers, and cancellation listeners.
- Prevent late results from cancelled attempts from clearing newer recovery state.
- Restore a source cleared by a cancelled hard reload without restarting playback.
- Reopen failed half-open circuit probes and honor disabled recovery and muted-fallback settings.
- Validate configuration types, arrays, unknown keys, and numeric values; isolate stored values from caller-owned objects.
- Preserve ring-buffer history ordering and runtime state during back-forward cache navigation.

### Distribution and validation

- Include English technical documentation, contribution and support guidance, private security reporting, issue forms, and release instructions.
- Run syntax checks and 34 regression tests, with CI on Node.js 22 and 24.
- Publish the script, GPL license, technical documentation, changelog, and SHA-256 checksums from the same tagged commit.
- Keep the product version at V1 and the machine-readable version at 1.0.0. Refreshed installations with the same version require manual import.

Automated tests cover controlled runtime cases. Real-site playback compatibility requires browser testing.
