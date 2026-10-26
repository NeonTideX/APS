'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.resolve(__dirname, '..', process.env.APS_TEST_SOURCE || 'APS.user.js'), 'utf8');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `Missing source section: ${start}`);
    return source.slice(a, b);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function mediaInstance() {
    return {
        media: { isConnected: true, paused: true, error: null, muted: false, currentSrc: 'test.mp4' },
        state: 'paused-auto', userPaused: false, metrics: { recoverCount: 0 },
        ac: new AbortController()
    };
}

function loadRuntime() {
    let now = 1000, id = 0, visible = true;
    const timers = new Map(), frames = new Map(), transitions = [];
    const logger = { debug() {}, warn() {}, error() {}, trace() {}, log() {}, info() {} };
    logger.scope = () => logger;
    let runtime;
    const context = {
        AbortController, structuredClone, queueMicrotask,
        Clock: { wall: () => now, mono: () => now },
        setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
        clearTimeout(key) { timers.delete(key); },
        requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key; },
        cancelAnimationFrame(key) { frames.delete(key); },
        Logger: logger, GlobalResources: { add() {} },
        APS: { destroyed: false, lifecycle: 'ready' },
        APS_LIFECYCLE: { RECOVERING: 'recovering', READY: 'ready' },
        RuntimeState: { errors: 0, circuitOpen: false }, PerfState: { fps: 60, cpuLoad: 0 },
        ServiceContainer: { get: name => name === 'scheduler' ? runtime?.Scheduler : runtime?.RecoveryDispatcher },
        MediaStore: { getActive: () => null },
        MEDIA_STATE: { DESTROYED: 'destroyed', PAUSED_AUTO: 'paused-auto', RECOVERING: 'recovering', PLAYING: 'playing', VERIFIED: 'verified' },
        StateMachine: { transition: (ins, state, reason) => { transitions.push({ state, reason }); ins.state = state; } },
        REASONS: { RECOVERY_TIMEOUT: 'recovery-timeout', RECOVERY_SUCCESS: 'recovery-success' },
        APS_EVENTS: {}, EventBus: { emit() {} },
        Telemetry: { recordRecoveryTime() {}, push() {}, perfMetrics: {} },
        LearningEngine: { record() {}, recordStrategy() {}, shouldRecover: () => true },
        PluginLifecycle: { notifyResume() {} }, IntentEngine: { adjust() {} },
        location: { hostname: 'example.test' }, navigator: { onLine: true },
        FailureClassifier: { classify: () => null },
        RecoveryPlanner: { plan: () => ({ delay: 0 }) },
        RecoveryStrategyRegistry: { chain: () => [] }
    };
    const code = [
        section('class APSError extends', 'const REASONS ='),
        section('const CONST =', 'function clamp('),
        section('class CancellationToken {', 'const SafeRegex ='),
        section('const TIMING =', 'const Assert ='),
        section('class RingHistory {', 'const ServiceContainer ='),
        section('const LIMITS =', 'function getConfig()'),
        'function getConfig() { return ConfigStore.get(); }',
        section('const CircuitBreaker =', 'const Native ='),
        section('const Native =', 'const EVENT_PRIORITY ='),
        section('const Scheduler =', 'const MEDIA_STATE ='),
        section('const RecoveryThrottle =', 'function createMediaInstance('),
        section('const RecoveryReason =', 'const FailureClassifier ='),
        section('async function tryPlay(', 'const RecoveryPlanner ='),
        section('const RetryStrategy =', 'function recoverActive()'),
        section('const RecoveryEngine =', 'const Watchdog ='),
        '({ CancellationToken, Scheduler, CircuitBreaker, RecoveryDispatcher, RecoveryEngine, RecoveryBudget, ConfigStore, Utils, Native, STRATEGY_DEFINITIONS, enqueueRecovery })'
    ].join('\n');
    runtime = vm.runInNewContext(code, context, { timeout: 1000 });
    runtime.Utils.visible = () => visible;
    return { ...runtime, context, timers, frames, transitions,
        setVisible(value) { visible = value; },
        frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); },
        advance(ms) {
            now += ms;
            const due = [...timers].filter(([, timer]) => timer.at <= now);
            for (const [key, timer] of due) { if (timers.delete(key)) timer.fn(); }
        }
    };
}

test('scheduler restarts after pause and after a background-to-foreground transition', () => {
    const h = loadRuntime();
    let calls = 0;
    h.Scheduler.register('work', () => calls++, 100);
    h.Scheduler.pause();
    assert.equal(h.frames.size, 0);
    h.Scheduler.resume();
    assert.equal(h.frames.size, 1);
    h.advance(100); h.frame();
    assert.equal(calls, 1);
    h.setVisible(false); h.frame();
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 1);
    h.setVisible(true); h.advance(1000);
    assert.equal(h.frames.size, 1);
    h.frame();
    assert.ok(calls > 1);
});

test('rescheduling a non-root task makes it eligible immediately', () => {
    const h = loadRuntime(), calls = [];
    h.Scheduler.register('early', () => calls.push('early'), 1000);
    h.Scheduler.register('late', () => calls.push('late'), 5000);
    h.Scheduler.reschedule('late'); h.frame();
    assert.deepEqual(calls, ['late']);
});

test('a task replacing itself does not leave its stale entry in the heap', () => {
    const h = loadRuntime();
    let replacements = 0;
    h.Scheduler.register('replace', () => {
        h.Scheduler.register('replace', () => replacements++, 100);
    }, 100);
    h.advance(100); h.frame();
    assert.equal(h.Scheduler._heap.length, 1);
    h.advance(100); h.frame();
    assert.equal(replacements, 1);
});

test('pausing from inside a task prevents further frames and due tasks', () => {
    const h = loadRuntime(), calls = [];
    h.Scheduler.register('pause', () => { calls.push('pause'); h.Scheduler.pause(); }, 100);
    h.Scheduler.register('other', () => calls.push('other'), 100);
    h.advance(100); h.frame();
    assert.deepEqual(calls, ['pause']);
    assert.equal(h.frames.size, 0);
});

test('cancellation settles a never-ending external promise', async () => {
    const h = loadRuntime(), token = new h.CancellationToken();
    const pending = token.run(() => new Promise(() => {}));
    token.cancel();
    await assert.rejects(pending, { code: 'E_CANCELLED' });
});

test('linked tokens detach earlier listeners when a later input is already cancelled', () => {
    const h = loadRuntime(), first = new h.CancellationToken(), second = new h.CancellationToken();
    let attached = 0;
    const add = first.onCancel.bind(first), remove = first.removeCancelListener.bind(first);
    first.onCancel = fn => { attached++; add(fn); };
    first.removeCancelListener = fn => { attached--; remove(fn); };
    second.cancel();
    const linked = h.CancellationToken.linked(first, second);
    assert.equal(linked.cancelled, true);
    assert.equal(attached, 0);
});

test('duplicate queued requests consume only one execution budget', async () => {
    const h = loadRuntime(), ins = mediaInstance();
    let calls = 0;
    h.RecoveryDispatcher._executor = () => { calls++; return true; };
    for (let i = 0; i < 100; i++) h.enqueueRecovery(ins, 'unknown');
    assert.equal(h.RecoveryBudget._totalAttempts, 0);
    await settle();
    assert.equal(calls, 1);
    assert.equal(h.RecoveryBudget._totalAttempts, 1);
});

test('bounded dispatch releases capacity without dropping pending requests', async () => {
    const h = loadRuntime(), waits = [];
    h.RecoveryDispatcher._executor = () => { const next = deferred(); waits.push(next); return next.promise; };
    for (let i = 0; i < 5; i++) h.RecoveryDispatcher.enqueue(mediaInstance(), 'unknown');
    await settle();
    assert.equal(waits.length, 3);
    assert.equal(h.RecoveryDispatcher.size, 2);
    waits[0].resolve(true); await settle();
    assert.equal(waits.length, 4);
    assert.equal(h.RecoveryDispatcher.pending, 3);
    waits.forEach(wait => wait.resolve(true)); await settle();
    waits.forEach(wait => wait.resolve(true)); await settle();
    assert.equal(h.RecoveryDispatcher.pending, 0);
    assert.equal(h.RecoveryDispatcher.size, 0);
});

test('paused or disabled work is discarded without charging admission', async () => {
    const h = loadRuntime(), ins = mediaInstance();
    let calls = 0;
    h.RecoveryDispatcher._executor = () => { calls++; return true; };
    h.RecoveryDispatcher.enqueue(ins, 'unknown');
    ins.userPaused = true;
    await settle();
    h.RecoveryDispatcher.enqueue(mediaInstance(), 'unknown');
    h.ConfigStore.patch({ recovery: { enabled: false } });
    await settle();
    assert.equal(calls, 0);
    assert.equal(h.RecoveryBudget._totalAttempts, 0);
});

test('stopping dispatch prevents queued microtasks from starting work', async () => {
    const h = loadRuntime();
    let calls = 0;
    h.RecoveryDispatcher._executor = () => { calls++; return true; };
    h.RecoveryDispatcher.enqueue(mediaInstance(), 'unknown');
    h.RecoveryDispatcher.stop();
    await settle();
    assert.equal(calls, 0);
});

test('recovery timeout releases its dispatcher slot even if the executor never settles', async () => {
    const h = loadRuntime(), ins = mediaInstance();
    h.ConfigStore.patch({ recovery: { timeout: 20, recoveringTimeout: 30 } });
    h.RecoveryEngine._prepareRecovery = () => true;
    h.context.SitePluginRegistry = { config: { retry: 3 } };
    h.context.RecoveryStrategyRegistry.chain = () => [
        { name: 'hung-player', fn: () => new Promise(() => {}) }
    ];
    h.RecoveryDispatcher._executor = (instance, reason) => h.RecoveryEngine.recover(instance, reason);
    h.RecoveryDispatcher.enqueue(ins, 'unknown');
    await settle();
    assert.equal(h.RecoveryDispatcher.pending, 1);
    h.advance(20); await settle();
    assert.equal(h.RecoveryDispatcher.pending, 0);
    assert.equal(ins.recovering, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.transitions.at(-1).reason, 'recovery-timeout');
});

test('media removal cancels recovery without recording a failure transition', async () => {
    const h = loadRuntime(), ins = mediaInstance();
    h.RecoveryEngine._doRecover = () => new Promise(() => {});
    const pending = h.RecoveryEngine.recover(ins);
    ins.ac.abort();
    assert.equal(await pending, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.transitions.length, 0);
});

test('failed half-open recovery reopens the breaker instead of exhausting probes forever', async () => {
    const h = loadRuntime();
    h.ConfigStore.patch({ circuitBreaker: { maxErrors: 2, cooldownMs: 10 } });
    h.CircuitBreaker.record(); h.CircuitBreaker.record(); h.advance(10);
    h.RecoveryDispatcher._executor = () => false;
    h.RecoveryDispatcher.enqueue(mediaInstance(), 'unknown');
    await settle();
    assert.equal(h.CircuitBreaker.isOpen(), true);
    h.advance(10);
    assert.equal(h.CircuitBreaker.allowRequest(), true);
});

test('cancelling an unfinished strategy prevents later strategies and ignores its late resolution', async () => {
    const h = loadRuntime(), ins = mediaInstance(), first = deferred();
    const token = new h.CancellationToken();
    let laterCalls = 0;
    const pending = h.RecoveryEngine._serialPhase([
        { name: 'pending', fn: () => first.promise },
        { name: 'later', fn: () => { laterCalls++; return true; } }
    ], ins, 'unknown', token);
    await settle();
    token.cancel();
    assert.equal(await pending, null);
    first.resolve(true); await settle();
    assert.equal(laterCalls, 0);
    assert.equal(h.context.RuntimeState.errors, 0);
});

test('strategies stop after verified playback and after a deliberate pause', async () => {
    const h = loadRuntime(), ins = mediaInstance(), calls = [];
    h.Utils.sleep = async () => {};
    const entries = [
        { name: 'first', fn: () => { calls.push('first'); ins.media.paused = false; return true; } },
        { name: 'second', fn: () => { calls.push('second'); return true; } }
    ];
    const result = await h.RecoveryEngine._serialPhase(entries, ins, 'unknown', new h.CancellationToken());
    assert.equal(result.strategy, 'first');
    assert.deepEqual(calls, ['first']);
    const paused = mediaInstance();
    await h.RecoveryEngine._serialPhase([
        { name: 'pause', fn: () => { paused.userPaused = true; return false; } }, entries[1]
    ], paused, 'unknown', new h.CancellationToken());
    assert.deepEqual(calls, ['first']);
});

test('muted fallback respects disabled configuration and cancellation', async () => {
    const h = loadRuntime(), ins = mediaInstance();
    let plays = 0;
    h.Native.media.play = () => { plays++; return Promise.reject(new Error('blocked')); };
    h.ConfigStore.patch({ recovery: { mutedFallback: false } });
    await assert.rejects(h.Native.safePlayWithFallback(ins.media, 10, ins));
    assert.equal(plays, 1);
    assert.equal(ins.media.muted, false);
    h.ConfigStore.patch({ recovery: { mutedFallback: true } });
    const token = new h.CancellationToken();
    h.Native.media.play = () => { token.cancel(); return Promise.reject(new Error('blocked')); };
    await assert.rejects(h.Native.safePlayWithFallback(ins.media, 10, ins, token));
    assert.equal(ins.media.muted, false);
});

test('DRM retry stops before a second play call when cancelled during its delay', async () => {
    const h = loadRuntime(), ins = mediaInstance(), token = new h.CancellationToken();
    let plays = 0;
    h.Native.media.play = () => { plays++; return Promise.resolve(); };
    const pending = h.STRATEGY_DEFINITIONS.drm.fn(ins, 'drm', token);
    await settle();
    assert.equal(plays, 1);
    token.cancel();
    assert.equal(await pending, false);
    assert.equal(plays, 1);
    assert.equal(h.timers.size, 0);
});

test('cancelled hard reload restores its cleared source without playing', async () => {
    const h = loadRuntime(), ins = mediaInstance(), token = new h.CancellationToken();
    let plays = 0;
    ins.media.src = 'test.mp4';
    ins.media.removeAttribute = () => { ins.media.src = ''; };
    ins.media.getAttribute = () => ins.media.src;
    h.Native.media.play = () => { plays++; };
    const pending = h.STRATEGY_DEFINITIONS['hard-reload'].fn(ins, 'unknown', token);
    assert.equal(ins.media.src, '');
    token.cancel();
    await assert.rejects(pending, { code: 'E_CANCELLED' });
    assert.equal(ins.media.src, 'test.mp4');
    assert.equal(plays, 0);
});

test('a late result from a cancelled attempt cannot clear a newer recovery', async () => {
    const h = loadRuntime(), ins = mediaInstance(), old = deferred();
    h.RecoveryEngine._doRecover = () => old.promise;
    const first = h.RecoveryEngine.recover(ins);
    await settle();
    h.RecoveryEngine.cancelRecovery(ins.media);
    assert.equal(await first, false);
    h.advance(10000);
    h.RecoveryEngine._doRecover = () => new Promise(() => {});
    const next = h.RecoveryEngine.recover(ins);
    await settle();
    old.resolve(true); await settle();
    assert.equal(ins.recovering, true);
    h.RecoveryEngine.cancelRecovery(ins.media);
    assert.equal(await next, false);
    assert.equal(ins.recovering, false);
    assert.equal(h.timers.size, 0);
});
