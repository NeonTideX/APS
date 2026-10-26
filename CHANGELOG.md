# Changelog

## [Unreleased]

### V1 runtime refactor - 2026-10-26

- Keep the product name at V1 and the machine-readable version at 1.0.0.
- Restore scheduler execution after pause/resume and background-to-foreground transitions.
- Rebuild deadline ordering after rescheduling and discard stale entries when a task replaces itself.
- Charge recovery budgets only when a deduplicated request starts execution; preserve queued work when admission is temporarily blocked.
- Execute strategies sequentially per media element with playback verification, preventing overlapping recovery side effects.
- Bound the entire recovery attempt with a cancellation-aware deadline, including hung player promises and escalation.
- Cancel recovery on deliberate pause, media removal, and teardown; release dispatcher slots and cancellation listeners.
- Reopen failed half-open circuit probes and honor disabled recovery and muted-fallback settings.
- Extend automated coverage to scheduler transitions, queue admission, cancellation, and late promise settlement.

## V1 ([1.0.0]) - 2026-10-25

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

### Repository maintenance

- Complete community guidance, support links, release metadata, and tagged distribution.

### Distribution and validation

- Include technical documentation covering architecture, configuration, storage, and compatibility limits.
- Provide JavaScript syntax checks and 15 automated regression tests; real-site playback compatibility requires browser testing.
- License the project under GPL-3.0-or-later.

[Unreleased]: https://github.com/NeonTideX/APS/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NeonTideX/APS/releases/tag/v1.0.0
