'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(path.resolve(__dirname, '..', process.env.APS_TEST_SOURCE || 'APS.user.js'), 'utf8');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
}
const ringSource = section('class RingHistory {', 'const ServiceContainer =');

test('history reads preserve insertion order before and after wrapping', () => {
    const RingHistory = vm.runInNewContext(ringSource + '\nRingHistory');
    const ring = new RingHistory(3);
    for (const [value, expected] of [[1, [1]], [2, [1, 2]], [3, [1, 2, 3]], [4, [2, 3, 4]]]) {
        ring.push(value);
        const sum = expected.reduce((a, b) => a + b, 0);
        assert.deepEqual([...ring], expected);
        assert.deepEqual(Array.from(ring.slice()), expected);
        const target = [];
        ring.writeTo(target);
        assert.deepEqual(target, expected);
        const visited = [];
        ring.forEach(v => visited.push(v));
        assert.deepEqual(visited, expected);
        assert.equal(ring.aggregate((a, b) => a + b, 0), sum);
        assert.equal(ring.reduce((a, b) => a + b), sum);
        assert.equal(ring.reduce((a, b) => a + b, 10), sum + 10);
        assert.equal(ring.every(Number.isFinite), true);
        assert.equal(ring.some(v => v === value), true);
        assert.equal(ring.find(v => v === value), value);
        assert.deepEqual(Array.from(ring.filter(v => v > 0)), expected);
    }
    ring.clear();
    assert.deepEqual([...ring], []);
    ring.push(8);
    assert.deepEqual([...ring], [8]);
});

function loadBreaker() {
    const timers = new Map();
    let id = 0, paused = false;
    const scheduler = { pause() { paused = true; }, resume() { paused = false; } };
    const context = {
        CONST: { CB_ERROR_RING_SIZE: 100, HALF_OPEN_MAX_PROBES: 3 },
        RuntimeState: { circuitOpen: false },
        Clock: { wall: () => 1000 },
        getConfig: () => ({ circuitBreaker: { maxErrors: 2, windowMs: 1000, cooldownMs: 100 } }),
        APS: { lifecycle: 'ready', destroyed: false },
        APS_LIFECYCLE: { RECOVERING: 'recovering', READY: 'ready' },
        Logger: { error() {}, log() {}, warn() {} },
        ServiceContainer: { get: () => scheduler },
        setTimeout(fn) { timers.set(++id, fn); return id; },
        clearTimeout(key) { timers.delete(key); }
    };
    const breaker = vm.runInNewContext(ringSource + section('const CircuitBreaker =', 'const Native =') + '\nCircuitBreaker', context);
    return { breaker, context, get paused() { return paused; },
        tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
        get pending() { return timers.size; } };
}

test('breaker opens at the error threshold and rejects requests until cooldown', () => {
    const h = loadBreaker();
    h.breaker.record();
    assert.equal(h.breaker.isOpen(), false);
    h.breaker.record();
    assert.equal(h.breaker.isOpen(), true);
    assert.equal(h.breaker.allowRequest(), false);
    assert.equal(h.paused, true);
    h.tick();
    assert.equal(h.paused, false);
    assert.equal(h.breaker.allowRequest(), true);
    h.breaker.record();
    assert.equal(h.breaker.isOpen(), true);
    assert.equal(h.pending, 1);
    h.tick();
    h.breaker.recordSuccess();
    assert.equal(h.breaker._state, 'closed');
});

test('manual breaker reset resumes the scheduler and cancels cooldown', () => {
    const h = loadBreaker();
    h.breaker.record(); h.breaker.record();
    assert.equal(h.paused, true);
    assert.equal(h.pending, 1);
    h.breaker.reset();
    assert.equal(h.paused, false);
    assert.equal(h.pending, 0);
    assert.equal(h.context.APS.lifecycle, 'ready');
    assert.equal(h.breaker.allowRequest(), true);
});

test('breaker cleanup never resumes a destroyed runtime', () => {
    const h = loadBreaker();
    h.breaker.record(); h.breaker.record();
    h.context.APS.destroyed = true;
    h.context.APS.lifecycle = 'stopped';
    h.breaker.reset();
    h.tick();
    assert.equal(h.pending, 0);
    assert.equal(h.paused, true);
    assert.equal(h.context.APS.lifecycle, 'stopped');
});

test('cached navigation preserves runtime and later permanent navigation destroys it', () => {
    const listeners = new Map();
    let destroyed = 0;
    const code = section('GlobalResources.add(() => Lifecycle.destroy());', '\nboot();');
    vm.runInNewContext(code, {
        GlobalResources: { add() {} }, Lifecycle: { destroy() { destroyed++; } },
        window: { addEventListener(type, fn, options) { listeners.set(type, { fn, options }); } }
    });
    const emit = persisted => {
        const listener = listeners.get('pagehide');
        if (listener) {
            listener.fn({ persisted });
            if (listener.options?.once) listeners.delete('pagehide');
        }
    };
    emit(true); emit(true);
    assert.equal(destroyed, 0);
    emit(false);
    assert.equal(destroyed, 1);
});

test('recovery safely ignores missing instances', async () => {
    const engine = vm.runInNewContext(section('const RecoveryEngine =', 'const Watchdog =') + '\nRecoveryEngine', {
        RecoveryReason: { UNKNOWN: 'unknown' }
    });
    assert.equal(await engine.recover(null), false);
    assert.equal(await engine.recover(undefined), false);
});
