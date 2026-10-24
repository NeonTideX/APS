// ==UserScript==
// @name         AntiPause Suite
// @namespace    aps-v23
// @version      1.0.0
// @description  Recover unexpected media pauses with user-intent detection, playback monitoring, and background support.
// @homepageURL  https://github.com/NeonTideX/APS
// @supportURL   https://github.com/NeonTideX/APS/issues
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @noframe
// @license      GPL-3.0-or-later
// ==/UserScript==

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 AntiPause Suite contributors
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// This program is distributed without any warranty. See LICENSE for details.

(function () {
'use strict';

/* ═══════════════════════════════════════════════════════════
 * §0  Lifecycle Enumeration
 * @depends: nothing
 * @provides: APS_LIFECYCLE, APS
 * ═══════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} MediaInstance
 * @property {HTMLMediaElement} media
 * @property {string} state
 * @property {boolean} userPaused
 * @property {number} created
 * @property {number} lastTime
 * @property {number} lastProgress
 * @property {number} lastPlay
 * @property {number} lastPause
 * @property {number} lastInteraction
 * @property {number} score
 * @property {number} id
 * @property {AbortController} ac
 * @property {RingHistory} historyRing
 * @property {boolean} recovering
 * @property {number} recoveryLevel
 * @property {number} escalateCount
 * @property {string|null} _recoveryReason
 * @property {number|null} _hlsTimer
 * @property {boolean} _hlsActive
 * @property {number} _hlsNoProgress
 * @property {number} _hlsLastTime
 * @property {boolean} _transitioning
 * @property {boolean|undefined} restoreMute
 * @property {number|null} _muteRestoreTimer
 * @property {number|null} _emptiedTimer
 * @property {{playCount:number,pauseCount:number,errorCount:number,recoverCount:number,escalateCount:number}} metrics
 */

/**
 * @typedef {Object} SafeResult
 * @property {boolean} ok
 * @property {*} value
 * @property {Error} [error]
 */

const APS_LIFECYCLE = Object.freeze({
    CREATED:    'created',
    BOOTING:    'booting',
    READY:      'ready',
    DEGRADED:   'degraded',
    RECOVERING: 'recovering',
    STOPPED:    'stopped'
});

const APS = {
    name: 'APS',
    version: '1.0.0',
    started: false,
    destroyed: false,
    bootTime: Date.now(),
    lifecycle: APS_LIFECYCLE.CREATED
};

/* ═══════════════════════════════════════════════════════════
 * §0.1  Event Type Constants
 * [NEW] LIFECYCLE_CHANGED for degradation notifications.
 * @provides: APS_EVENTS
 * ═══════════════════════════════════════════════════════════ */
const APS_EVENTS = Object.freeze({
    RECOVERY_ESCALATE:   'recovery:escalate',
    RECOVERY_SUCCESS:    'recovery-success',
    RECOVERY_FAILED:     'recovery-failed',
    BUFFER_WARNING:      'buffer-warning',
    PERFORMANCE:         'performance',
    HEALTH:              'health',
    CONFIG_CHANGED:      'config:changed',
    FRAME_MEDIA:         'frame:media',
    DRM_UPDATE:          'drm-update',
    MSE_BUFFER_CREATED:  'mse-buffer-created',
    PAGE_VISIBLE:        'page:visible',
    PAGE_HIDDEN:         'page:hidden',
    PAGE_FOCUS:          'page:focus',
    PAGE_BLUR:           'page:blur',
    INSTANCE_ADDED:      'instance:added',
    INSTANCE_ADDED_BATCH:'instance:added-batch',
    INSTANCE_REMOVED:    'instance:removed',
    ACTIVE_CHANGED:      'active:changed',
    STATE_CHANGE:        'state:change',
    ONLINE_CHANGED:      'network:online',
    OFFLINE_CHANGED:     'network:offline',
    LIFECYCLE_CHANGED:   'lifecycle:changed'
});

/* ═══════════════════════════════════════════════════════════
 * §0.2  Structured Error Type
 * @provides: APSError
 * ═══════════════════════════════════════════════════════════ */
class APSError extends Error {
    constructor(msg, { code = 'E_UNKNOWN', severity = 'warn', recoverable = true, cause = null } = {}) {
        super(msg, cause ? { cause } : undefined);
        this.name = 'APSError';
        this.code = code;
        this.severity = severity;
        this.recoverable = recoverable;
    }
    toJSON() {
        return {
            name: this.name, message: this.message, code: this.code,
            severity: this.severity, recoverable: this.recoverable,
            stack: this.stack ? this.stack.substring(0, CONST.STACK_TRACE_MAX) : null
        };
    }
}

/* ═══════════════════════════════════════════════════════════
 * §0.3  Transition Reason Constants
 * @provides: REASONS
 * ═══════════════════════════════════════════════════════════ */
const REASONS = Object.freeze({
    REGISTER:              'register',
    NATIVE_PLAY:           'native-play',
    PLAYING:               'playing',
    USER:                  'user',
    MULTI_PAUSE_GUARD:     'multi-pause-guard',
    AUTO:                  'auto',
    BUFFERING:             'buffering',
    STALLED:               'stalled',
    ENDED:                 'ended',
    MEDIA_ERROR:           'media-error',
    WATCHDOG:              'watchdog',
    STATE_TIMEOUT_PREFIX:  'state-timeout:',
    RECOVERY_PREFIX:       'recovery:',
    BRIDGE_PREFIX:         'bridge:',
    RECOVER_GUARD_TIMEOUT: 'recover-guard-timeout',
    RECOVER_ENDED:         'recover-ended',
    BLOCKED_BY_LEARNING:   'blocked-by-learning',
    RECOVERY_SUCCESS:      'recovery-success',
    RECOVERY_FAILED:       'recovery-failed',
    RECOVERY_TIMEOUT:      'recovery-timeout',
    ESCALATED_PREFIX:      'escalated:L',
    MAX_LEVEL_REACHED:     'max-level-reached',
    NO_ESCALATION_STRATEGY:'no-escalation-strategy',
    MISSING_ESCALATION_DEF:'missing-escalation-def',
    ESCALATION_COND_BLOCKED:'escalation-condition-blocked:',
    ALL_LEVELS_EXHAUSTED:  'all-levels-exhausted',
    CLEAR_USER_PAUSE:      'clear-user-pause',
    ENCRYPTED:             'encrypted',
    WAITING_KEY:           'waiting-key'
});

/* ═══════════════════════════════════════════════════════════
 * §0.3.1  Pause Cause Constants  [NEW]
 * Shared between PauseAnalyzer and bridge classification.
 * @provides: PAUSE_CAUSES
 * ═══════════════════════════════════════════════════════════ */
const PAUSE_CAUSES = Object.freeze([
    'visibility', 'focus', 'idle_timer', 'ad', 'site_logic', 'autoplay_policy'
]);

/* ═══════════════════════════════════════════════════════════
 * §0.4  Extracted Magic Numbers & Named Constants
 * [NEW] DESTROY_TIMEOUT, RECOVERY_BUDGET, TARGET_ORIGIN_MAX_LEN
 * @provides: CONST
 * ═══════════════════════════════════════════════════════════ */
const CONST = deepFreeze({
    /* Timing (ms) */
    MS_PER_DAY:                  86_400_000,
    LEARNING_FAIL_EXPIRY_DAYS:   7,
    BOOT_TIMEOUT_MS:             10_000,
    BOOT_MAX_POLL_DELAY:         2_000,
    BOOT_INITIAL_DELAY:          50,
    BOOT_DELAY_MULTIPLIER:       1.5,
    FLUSH_RETRY_BASE_MS:         100,
    FLUSH_DEFER_MS:              500,
    RULE_FETCH_TIMEOUT_MS:       10_000,
    LOCK_CHECK_INTERVAL:         5_000,
    PERF_MONITOR_INTERVAL:       2_000,
    PERF_SAMPLE_SIZE:            20,
    SCORE_FULL_INTERVAL:         30_000,
    SCORE_INCREMENTAL_INTERVAL:  2_000,
    WAKE_MONITOR_INTERVAL:       15_000,
    STREAM_MONITOR_INTERVAL:     3_000,
    BG_BUFFER_SAMPLE_INTERVAL:   5_000,
    STRATEGY_REWEIGHT_INTERVAL:  60_000,
    MEMORY_GUARD_INTERVAL:       30_000,
    UTILITY_CLEAN_INTERVAL:      5_000,
    STEALTH_REAPPLY_DEFAULT:     60_000,
    DESTROY_TIMEOUT_MS:          5_000,

    /* Scoring */
    SCORE_CHANGE_EPSILON:        0.01,
    NEUTRAL_CONFIDENCE:          0.5,
    PROGRESS_GAUSS_SIGMA:        0.35,
    MOMENTUM_DECAY_MS:           10_000,
    DURATION_SCORE_MAX_MS:       300_000,
    CONTAINER_BASE_SCORE:        0.2,
    CONTAINER_PLAYER_CLASS_SCORE:0.6,
    CONTAINER_Z_DIVISOR:         200,
    CONTAINER_Z_WEIGHT:          0.4,
    CONTAINER_DEPTH_DIVISOR:     8,
    CONTAINER_DEPTH_WEIGHT:      0.2,

    /* Scheduler */
    TASK_MAX_CONSECUTIVE_ERRORS: 5,

    /* CircuitBreaker */
    HALF_OPEN_MAX_PROBES:        3,
    CB_ERROR_RING_SIZE:          200,

    /* Dispatcher */
    MAX_FLUSH_DEPTH:             5,
    FLUSH_BACKOFF_MULTIPLIER:    2,
    FLUSH_BACKOFF_MAX_MS:        5_000,

    /* Recovery Budget  [NEW] */
    RECOVERY_BUDGET_MAX:         30,
    RECOVERY_BUDGET_WINDOW_MS:   10_000,

    /* MediaSession */
    MEDIA_SESSION_SEEK_STEP:     10,

    /* SafeRegex */
    REGEX_MAX_PATTERN_LEN:       200,
    REGEX_MAX_TEST_LEN:          10_000,
    REGEX_CACHE_SIZE:            200,

    /* Clock */
    CLOCK_SYNC_INTERVAL:         30_000,

    /* LRU */
    LRU_DEFAULT_SIZE:            300,

    /* MediaStore */
    MEDIA_STORE_HARD_CAP:        50,

    /* deepMerge */
    MAX_MERGE_DEPTH:             10,

    /* FrameBridge */
    FRAME_BRIDGE_ORIGIN_CAPACITY:100,
    TARGET_ORIGIN_MAX_LEN:       256,

    /* ConfigValidator string limits */
    CONFIG_STR_MAX_LEN:          50,
    CONFIG_ARRAY_STR_MAX_LEN:    500,

    /* Misc */
    STACK_TRACE_MAX:             500,
    SCHEDULER_JITTER_FACTOR:     0.1
});

/* ═══════════════════════════════════════════════════════════
 * §1  Core Utilities
 * [FIX] deepMerge: circular-reference guard via WeakSet.
 * [FIX] deepClone: FinalizationRegistry returns ref, not clone.
 * @provides: deepFreeze, deepMerge, deepClone, clamp, clamp01
 * ═══════════════════════════════════════════════════════════ */

function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
        const val = obj[key];
        if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) deepFreeze(val);
    }
    return obj;
}

/* [FIX-A1] Circular-reference guard; [FIX-P2.5] depth guard */
function deepMerge(target, source, opts = {}, _depth = 0, _seen = null) {
    if (_depth > CONST.MAX_MERGE_DEPTH) return target;
    if (!source || typeof source !== 'object') return target;
    if (!_seen) _seen = new WeakSet();
    if (_seen.has(source)) return target;
    _seen.add(source);
    const arrayMode = opts.arrayMode || 'replace';
    const nullMode  = opts.nullMode  || 'assign';
    for (const key of Object.keys(source)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const srcVal = source[key];
        const tgtVal = target[key];
        if (srcVal === null) {
            if (nullMode === 'delete') { delete target[key]; continue; }
            if (nullMode === 'skip')   { continue; }
        }
        if (Array.isArray(srcVal)) {
            if (arrayMode === 'concat' && Array.isArray(tgtVal)) {
                target[key] = [...tgtVal, ...srcVal];
            } else if (arrayMode === 'union' && Array.isArray(tgtVal)) {
                target[key] = [...new Set([...tgtVal, ...srcVal])];
            } else {
                target[key] = srcVal;
            }
        } else if (srcVal && typeof srcVal === 'object' &&
                   tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
            deepMerge(tgtVal, srcVal, opts, _depth + 1, _seen);
        } else {
            target[key] = srcVal;
        }
    }
    return target;
}

/* [FIX-B1] FinalizationRegistry: return original ref (not cloneable) */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    try { return structuredClone(obj); } catch (_) {}
    try { return JSON.parse(JSON.stringify(obj)); } catch (_) {}
    const seen = new WeakMap();
    function clone(val) {
        if (val === null || typeof val !== 'object') return val;
        if (seen.has(val)) return seen.get(val);
        if (Array.isArray(val)) {
            const arr = []; seen.set(val, arr);
            for (let i = 0; i < val.length; i++) arr[i] = clone(val[i]);
            return arr;
        }
        if (val instanceof Date) return new Date(val.getTime());
        if (val instanceof RegExp) return new RegExp(val.source, val.flags);
        if (val instanceof Map) {
            const m = new Map(); seen.set(val, m);
            for (const [k, v] of val) m.set(clone(k), clone(v));
            return m;
        }
        if (val instanceof Set) {
            const s = new Set(); seen.set(val, s);
            for (const v of val) s.add(clone(v));
            return s;
        }
        if (typeof WeakRef !== 'undefined' && val instanceof WeakRef) {
            const target = val.deref();
            if (target === undefined) return undefined;
            return new WeakRef(clone(target));
        }
        if (val instanceof ArrayBuffer) return val.slice(0);
        if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
            const Ctor = val.constructor;
            const buf = val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
            return new Ctor(buf);
        }
        if (val instanceof DataView) {
            const buf = val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
            return new DataView(buf);
        }
        if (val instanceof Error) {
            const E = new val.constructor(val.message);
            E.stack = val.stack;
            if (val.code) E.code = val.code;
            return E;
        }
        /* [FIX-B1] FinalizationRegistry is not meaningful to clone */
        if (typeof FinalizationRegistry !== 'undefined' && val instanceof FinalizationRegistry) {
            return val;
        }
        const proto = Object.getPrototypeOf(val);
        const o = (proto === Object.prototype || proto === null) ? {} : Object.create(proto);
        seen.set(val, o);
        for (const key of Object.keys(val)) o[key] = clone(val[key]);
        return o;
    }
    return clone(obj);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v) { return clamp(v, 0, 1); }

/* ═══════════════════════════════════════════════════════════
 * §1.0.1  Monotonic Clock Abstraction
 * @provides: Clock
 * ═══════════════════════════════════════════════════════════ */
const Clock = {
    _offset: Date.now() - performance.now(),
    _lastSyncMono: 0,
    wall() { return Date.now(); },
    mono() { return performance.now(); },
    now() {
        const mono = performance.now();
        if (mono - this._lastSyncMono > CONST.CLOCK_SYNC_INTERVAL) this.resync();
        return mono + this._offset;
    },
    resync() {
        this._offset = Date.now() - performance.now();
        this._lastSyncMono = performance.now();
    },
    drift() { return Math.abs(Date.now() - (performance.now() + this._offset)); },
    _initVisibilitySync() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.resync();
        }, { passive: true });
    }
};
Clock._initVisibilitySync();

/* ═══════════════════════════════════════════════════════════
 * §1.0.2  CancellationToken
 * @provides: CancellationToken
 * ═══════════════════════════════════════════════════════════ */
class CancellationToken {
    #controller = new AbortController();
    #listeners = new Set();
    cancel() {
        if (this.#controller.signal.aborted) return;
        this.#controller.abort();
        for (const fn of this.#listeners) { try { fn(); } catch (_) {} }
        this.#listeners.clear();
    }
    get cancelled() { return this.#controller.signal.aborted; }
    get signal() { return this.#controller.signal; }
    onCancel(fn) {
        if (this.cancelled) { try { fn(); } catch (_) {} return; }
        this.#listeners.add(fn);
    }
    removeCancelListener(fn) { this.#listeners.delete(fn); }
    throwIfCancel() {
        if (this.cancelled) throw new APSError('Operation cancelled', { code: 'E_CANCELLED', recoverable: false });
    }
    static timeout(ms) {
        const token = new CancellationToken();
        const id = setTimeout(() => token.cancel(), ms);
        token.onCancel(() => clearTimeout(id));
        token.dispose = () => { clearTimeout(id); token.cancel(); };
        return token;
    }
    static linked(...tokens) {
        const combined = new CancellationToken();
        const cleanups = [];
        for (const t of tokens) {
            if (t.cancelled) { combined.cancel(); return combined; }
            const fn = () => combined.cancel();
            t.onCancel(fn);
            cleanups.push(() => t.removeCancelListener(fn));
        }
        combined.onCancel(() => { for (const c of cleanups) c(); cleanups.length = 0; });
        return combined;
    }
}

/* ═══════════════════════════════════════════════════════════
 * §1.0.3  Safe Regex Factory
 * @provides: SafeRegex
 * ═══════════════════════════════════════════════════════════ */
const SafeRegex = {
    _cache: null,
    _DANGEROUS_PATTERNS: [
        /(\+|\*)\s*\)\s*(\+|\*)/, /\([^)]*\|[^)]*\)\s*(\+|\*)/,
        /\([^)]*\)\s*\{[^}]*\}\s*(\+|\*)/, /(\+|\*)\s*\)\s*\{/,
        /\[.*\][+*]\)[+*]/, /\(\?:[^)]*[+*]\)[+*]/,
        /\{[^}]*\}\s*\)\s*(\+|\*)/, /\{[^}]*\}\s*\)\s*\{/
    ],
    _ensureCache() { if (!this._cache) this._cache = new LRUCache(CONST.REGEX_CACHE_SIZE); },
    _isDangerous(pattern) {
        for (const re of this._DANGEROUS_PATTERNS) {
            try { if (re.test(pattern)) return true; } catch (_) {}
        }
        return false;
    },
    create(pattern, flags = '') {
        if (!pattern || typeof pattern !== 'string') return null;
        if (pattern.length > CONST.REGEX_MAX_PATTERN_LEN) return null;
        if (this._isDangerous(pattern)) return null;
        this._ensureCache();
        const cacheKey = pattern + '|' + flags;
        const cached = this._cache.get(cacheKey);
        if (cached) return cached;
        try { const re = new RegExp(pattern, flags); this._cache.set(cacheKey, re); return re; }
        catch (_) { return null; }
    },
    test(pattern, str) {
        const re = this.create(pattern);
        if (!re) return false;
        try {
            const safeStr = str.length > CONST.REGEX_MAX_TEST_LEN ? str.slice(0, CONST.REGEX_MAX_TEST_LEN) : str;
            return re.test(safeStr);
        } catch (_) { return false; }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §1.0.4  Timing & Threshold Constants
 * @provides: TIMING, THRESHOLDS, LOG_LEVEL
 * ═══════════════════════════════════════════════════════════ */
const LOG_LEVEL = Object.freeze({ ERROR:1, WARN:2, INFO:3, LOG:4, DEBUG:5, TRACE:6 });

const TIMING = deepFreeze({
    TIMEUPDATE_EPSILON:0.1, SEEK_NUDGE:0.05, DRM_RETRY_DELAY:200,
    USER_EVENT_WINDOW:150, HARD_RELOAD_CLEAR_WAIT:300, HARD_RELOAD_LOAD_WAIT:500,
    MUTED_RESTORE_DEFAULT:2000, BRIDGE_RETRY_DELAY:2000, IFRAME_SCAN_DELAY:500,
    GLOBAL_RECOVER_DELAY:500, VISIBILITY_RECOVER_DELAY:500, AUDIO_RESUME_TIMEOUT:60000,
    LONG_HIDDEN_THRESHOLD:300_000, EMPTY_GRACE_DEFAULT:200, PLAYER_DELEGATE_WAIT:500,
    RECOVER_ENDED_SEEK:0.2, BUFFER_VELOCITY_WINDOW:1000, PRIORITY_AGE_INTERVAL:5000,
    LOCK_MAX_HOLD:300_000, WAKELOCK_DEBOUNCE:2000, WORKER_FLUSH_THROTTLE:3000,
    FPS_EMA_ALPHA:0.9, FRAME_BUDGET_MS:16.67, MIN_SCHEDULER_DELAY:50,
    RETRY_BASE_MS:300, RETRY_MAX_DELAY:5000, DOM_OBSERVER_QUEUE_MAX:500,
    DOM_OBSERVER_BG_DELAY:100, VISIBILITY_COMPENSATE_MS:200, VISIBILITY_COMPENSATE_MAX:3
});

const THRESHOLDS = deepFreeze({
    FPS_HIGH_LOAD:20, FPS_MEDIUM_LOAD:40,
    SCHEDULER_SCALE_HIGH:2, SCHEDULER_SCALE_MEDIUM:1.5, SCHEDULER_SCALE_NORMAL:1,
    RECOVERY_THROTTLE_BASE:1000, RECOVERY_THROTTLE_MAX:60000,
    LOW_CONFIDENCE_BLOCK:0.3, VERY_LOW_CONFIDENCE:0.4,
    MIN_BUFFER_AHEAD:1, READY_STATE_MIN:2, READY_STATE_HAVE_FUTURE:3,
    WATCHDOG_BUFFER_SAFE:2, STACK_SUBSTRING_MAX:400,
    RULE_MAX_LENGTH:10000, RULE_NAME_MAX:100, RULE_MATCH_MAX:500, RULE_FN_BODY_MAX:5000,
    STRATEGY_FALLBACK_PRIORITY_PENALTY:50, MEMORY_PRESSURE_RATIO:0.85,
    MAX_AGED_PRIORITY:14, BUDGET_CHECK_EVERY:4, DOM_QUEUE_DEGRADE_RATIO:1.5,
    WORKER_PING_MIN:500, WORKER_PING_MAX:60000, LEARNING_PRUNE_TRIGGER:1.2
});

/* ═══════════════════════════════════════════════════════════
 * §1.0.5  Runtime Assertion Layer
 * @provides: Assert
 * ═══════════════════════════════════════════════════════════ */
const Assert = {
    _enabled: false,
    enable() { this._enabled = true; },
    disable() { this._enabled = false; },
    invariant(cond, msg) {
        if (!this._enabled || cond) return;
        try { Logger.error('[ASSERT]', msg); } catch (_) { console.error('[APS23 ASSERT]', msg); }
        try { Telemetry.push({ type: 'assertion-failure', msg }); } catch (_) {}
    }
};

/* ═══════════════════════════════════════════════════════════
 * §1.1  LRU+TTL Cache
 * @provides: LRUCache
 * ═══════════════════════════════════════════════════════════ */
class LRUCache {
    constructor(maxSize = CONST.LRU_DEFAULT_SIZE) {
        this._map = new Map(); this._maxSize = maxSize; this._earliestExpiry = Infinity;
    }
    set(key, value, ttl = Infinity) {
        if (this._map.has(key)) this._map.delete(key);
        else if (this._map.size >= this._maxSize) this._map.delete(this._map.keys().next().value);
        const expireAt = (ttl === Infinity || !isFinite(ttl) || ttl <= 0) ? Infinity : Clock.wall() + ttl;
        this._map.set(key, { value, expireAt });
        if (expireAt < this._earliestExpiry) this._earliestExpiry = expireAt;
    }
    get(key) {
        const entry = this._map.get(key);
        if (!entry) return undefined;
        if (entry.expireAt !== Infinity && Clock.wall() > entry.expireAt) { this._map.delete(key); return undefined; }
        this._map.delete(key); this._map.set(key, entry);
        return entry.value;
    }
    has(key) {
        const entry = this._map.get(key);
        if (!entry) return false;
        if (entry.expireAt !== Infinity && Clock.wall() > entry.expireAt) { this._map.delete(key); return false; }
        return true;
    }
    invalidate(key) { this._map.delete(key); }
    clear() { this._map.clear(); this._earliestExpiry = Infinity; }
    get size() { return this._map.size; }
    pruneExpired() {
        const now = Clock.wall();
        if (now < this._earliestExpiry) return;
        let newEarliest = Infinity;
        for (const [key, entry] of this._map) {
            if (entry.expireAt !== Infinity && now > entry.expireAt) this._map.delete(key);
            else if (entry.expireAt < newEarliest) newEarliest = entry.expireAt;
        }
        this._earliestExpiry = newEarliest;
    }
}

/* ═══════════════════════════════════════════════════════════
 * §1.2  RingHistory
 * [NEW] pushAll batch method.
 * @provides: RingHistory
 * ═══════════════════════════════════════════════════════════ */
class RingHistory {
    constructor(capacity) {
        this._cap = Math.max(1, capacity | 0);
        this._buf = new Array(this._cap); this._idx = 0; this._count = 0;
    }
    push(item) {
        this._buf[this._idx] = item;
        this._idx = (this._idx + 1) % this._cap;
        if (this._count < this._cap) this._count++;
    }
    /* [NEW-F4] Batch push */
    pushAll(items) { for (let i = 0; i < items.length; i++) this.push(items[i]); }
    toArray() {
        if (this._count < this._cap) return this._buf.slice(0, this._count);
        return this._buf.slice(this._idx).concat(this._buf.slice(0, this._idx));
    }
    writeTo(target) {
        target.length = this._count;
        for (let i = 0; i < this._count; i++) target[i] = this._buf[(this._start + i) % this._cap];
        return target;
    }
    last() { return this._count === 0 ? undefined : this._buf[(this._idx - 1 + this._cap) % this._cap]; }
    first() {
        if (this._count === 0) return undefined;
        return this._count < this._cap ? this._buf[0] : this._buf[this._idx];
    }
    get _start() { return (this._idx - this._count + this._cap) % this._cap; }
    get length() { return this._count; }
    get capacity() { return this._cap; }
    clear() { this._buf.fill(undefined); this._idx = 0; this._count = 0; }
    *[Symbol.iterator]() { for (let i = 0; i < this._count; i++) yield this._buf[(this._start + i) % this._cap]; }
    forEach(fn) { for (let i = 0; i < this._count; i++) fn(this._buf[(this._start + i) % this._cap], i); }
    filter(fn) { const o=[]; for(let i=0;i<this._count;i++){const v=this._buf[(this._start+i)%this._cap]; if(fn(v,i))o.push(v);} return o; }
    some(fn) { for(let i=0;i<this._count;i++) if(fn(this._buf[(this._start+i)%this._cap],i)) return true; return false; }
    every(fn) { for(let i=0;i<this._count;i++) if(!fn(this._buf[(this._start+i)%this._cap],i)) return false; return true; }
    reduce(fn, ...args) {
        let acc, si;
        if (args.length >= 1) { acc = args[0]; si = 0; }
        else { if (this._count === 0) throw new TypeError('Reduce of empty RingHistory'); acc = this._buf[this._start]; si = 1; }
        for (let i = si; i < this._count; i++) acc = fn(acc, this._buf[(this._start + i) % this._cap], i);
        return acc;
    }
    find(fn) { for(let i=0;i<this._count;i++){const v=this._buf[(this._start+i)%this._cap]; if(fn(v,i)) return v;} return undefined; }
    aggregate(fn, initial) { let acc=initial; for(let i=0;i<this._count;i++) acc=fn(acc,this._buf[(this._start+i)%this._cap],i); return acc; }
    slice(start=0, end) {
        const s=Math.max(0,start), e=Math.min(this._count, end??this._count), r=[];
        for(let i=s;i<e;i++) r.push(this._buf[(this._start+i)%this._cap]);
        return r;
    }
}

/* ═══════════════════════════════════════════════════════════
 * §1.3  ServiceContainer (DI registry)
 * [FIX-A3] dispose() is now async.
 * @provides: ServiceContainer
 * ═══════════════════════════════════════════════════════════ */
const ServiceContainer = {
    _factories: new Map(), _instances: new Map(), _resolving: new Set(),
    register(name, factory, { singleton = true } = {}) {
        this._factories.set(name, { factory, singleton });
        if (!singleton) this._instances.delete(name);
    },
    get(name) {
        if (this._instances.has(name)) return this._instances.get(name);
        const entry = this._factories.get(name);
        if (!entry) return undefined;
        if (this._resolving.has(name)) {
            try { Logger.warn('ServiceContainer: circular dependency at', name); } catch (_) {}
            return undefined;
        }
        this._resolving.add(name);
        let value;
        try { value = entry.factory(this); } finally { this._resolving.delete(name); }
        if (entry.singleton) this._instances.set(name, value);
        return value;
    },
    has(name) { return this._factories.has(name); },
    unregister(name) { this._factories.delete(name); this._instances.delete(name); },
    /* [FIX-A3] Async dispose with allSettled */
    async dispose() {
        const disposals = [];
        for (const v of this._instances.values()) {
            try { if (v && typeof v.dispose === 'function') disposals.push(v.dispose()); } catch (_) {}
        }
        await Promise.allSettled(disposals);
        this._instances.clear(); this._factories.clear(); this._resolving.clear();
    },
    get names() { return [...this._factories.keys()]; }
};

/* ═══════════════════════════════════════════════════════════
 * §2  Constants & Configuration
 * [FIX-A2] _mergeStructural depth guard.
 * @provides: LIMITS, DEFAULTS, ConfigStore, getConfig
 * ═══════════════════════════════════════════════════════════ */
const LIMITS = deepFreeze({
    INLINE_MEDIA_THRESHOLD:20, SHADOW_SUBTREE_WALK_MAX:200,
    OVERLAY_AREA_MIN:0.3, OVERLAY_AREA_MAX:0.95, SILENT_AUDIO_GAIN:0.0001,
    PAUSE_HISTORY_MAX:30, RECOVERY_HISTORY_MAX:50, TELEMETRY_RECOVERY_SAMPLES:50,
    CONTAINER_DEPTH_MAX:6, PLAYER_CLASS_DEPTH:5,
    TRUSTED_RULE_DOMAINS:['github.com','greasyfork.org','raw.githubusercontent.com'],
    BUFFER_PREDICTOR_SAMPLES:20, BUFFER_PREDICTOR_LOW:3,
    SHADOW_DEPTH_MAX:8, EVENTBUS_QUEUE_MAX:200,
    SCHEDULER_TICK_BUDGET_MS:4, SCHEDULER_MIN_YIELD_MS:4,
    HEAP_COMPACT_INTERVAL:60000, ESCALATION_MAX_DEPTH:10,
    HLS_MAX_SCHEDULE_COUNT:500, BRIDGE_PROTOCOL_VERSION:3,
    RECOVERY_MAX_CONCURRENT:3, CACHE_PRUNE_INTERVAL:60000,
    MSE_EMPTIED_GRACE_MULT:10, PARALLEL_RACE_PRIORITY_THRESHOLD:80,
    FRAME_BRIDGE_ORIGIN_MAX: CONST.FRAME_BRIDGE_ORIGIN_CAPACITY
});

const DEFAULTS = deepFreeze({
    debug: false,
    recovery: {
        enabled:true, retry:3, interval:5000, timeout:15000,
        mutedFallback:true, recoverEnded:false,
        strategyChain:['adapter','drm','seek','muted','native'],
        maxBackoff:60000, recoveringTimeout:35000, maxLevel:5, confidence:0.72, verifyDelay:800, delay:300
    },
    watchdog: { enabled:true, interval:5000, timeout:12000, epsilon:0.01, stall:10000 },
    scheduler: { foreground:1000, background:3000, priorityBoost:true, adaptive:true, fps:true, idleMultiplier:3, highLoadThreshold:0.85 },
    scanner: { interval:30000, idleInterval:180000, shadow:true, iframe:true, chunk:100, delay:20, maxNodes:1000, throttle:15000, gcInterval:30000 },
    intent: { threshold:0.35, history:120, timeout:1500, decay:5000, adaptiveWeight:true, adaptLearningRate:0.05, adaptMinWeight:0.05, adaptMaxWeight:0.5, adaptCooldown:30000, multiPauseWindow:30000, multiPauseCount:2, minThreshold:0.2 },
    shield: { visibility:true, focus:true, rate:true, stopPropagation:'passive', fakeVisibility:true, fakeFocus:true },
    background: { enabled:true, worker:true, workerPing:3000, silentAudio:true, navigatorLock:true, lock:true },
    learning: { enabled:true, storage:'APS23_LEARNING', maxSites:50, ttlDays:30, writeDebounce:500 },
    strategy: { enabled:true, storageKey:'APS23_RULES' },
    mediaSession: true,
    utility: { unlockScroll:true, hideOverlay:false },
    bridge: { enabled:true, veto:true, cspFallback:true },
    hls: { enabled:true, bufferThreshold:2, checkInterval:3000, nudge:0.5 },
    eme: { enabled:true },
    stream: { mse:true, hls:true, eme:true },
    antiDetect: { enabled:true, randomIds:true, stealth:'basic', stealthReapply:60000 },
    perf: { adaptive:true, foregroundMultiplier:1, backgroundMultiplier:2 },
    circuitBreaker: { maxErrors:50, windowMs:60000, cooldownMs:30000 },
    telemetry: { enabled:false, bufferSize:500 },
    filters: { blacklist:[], whitelist:[], maxManaged:15 },
    limits: { historyLength:50, pauseLogLimit:100, containerCacheTtl:30000, visibilityCacheTtl:500, cacheMaxSize:300 },
    timing: { evaluateDelayAdd:300, evaluateDelayRemove:50, recoverDelay:200, recoverDelayBridge:100, muteRestore:1000, paranoidDelete:5000, emptiedGrace:200 },
    shadow: { maxDepth:6 },
    health: { interval:10000 }
});

const ConfigStore = {
    _schemaVersion: 1,
    _base: deepClone(DEFAULTS),
    _overrides: {},
    _frozen: null, _version: 0,
    _dirtyPaths: new Set(),
    _pathSubscribers: new Map(),

    get() {
        if (this._frozen) return this._frozen;
        const merged = this._mergeStructural(this._base, this._overrides);
        this._frozen = deepFreeze(merged);
        return this._frozen;
    },

    /* [FIX-A2] Depth guard added */
    _mergeStructural(base, source, _depth = 0) {
        if (_depth > CONST.MAX_MERGE_DEPTH) return source;
        if (source === null || source === undefined) return base;
        if (typeof source !== 'object') return source;
        if (Array.isArray(source)) return source;
        if (!base || typeof base !== 'object' || Array.isArray(base)) return deepClone(source);
        const result = {};
        const allKeys = new Set([...Object.keys(base), ...Object.keys(source)]);
        for (const key of allKeys) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            if (key in source) {
                const srcVal = source[key];
                if (srcVal === null) result[key] = null;
                else if (typeof srcVal === 'object' && !Array.isArray(srcVal) &&
                         base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
                    result[key] = this._mergeStructural(base[key], srcVal, _depth + 1);
                } else result[key] = srcVal;
            } else result[key] = base[key];
        }
        return result;
    },

    patch(validatedPatch) {
        // Own the stored values so snapshots cannot freeze or alias caller input.
        deepMerge(this._overrides, deepClone(validatedPatch));
        this._trackDirtyPaths(validatedPatch);
        this._frozen = null; this._version++;
        this._notifyPathSubscribers(validatedPatch);
        return this.get();
    },
    subscribe(path, fn) {
        if (!this._pathSubscribers.has(path)) this._pathSubscribers.set(path, new Set());
        this._pathSubscribers.get(path).add(fn);
        return () => { this._pathSubscribers.get(path)?.delete(fn); };
    },
    _notifyPathSubscribers(patch, prefix = '') {
        for (const [k, v] of Object.entries(patch)) {
            const path = prefix ? prefix + '.' + k : k;
            const subs = this._pathSubscribers.get(path);
            if (subs) for (const fn of subs) { try { fn(v, path); } catch (_) {} }
            if (v && typeof v === 'object' && !Array.isArray(v)) this._notifyPathSubscribers(v, path);
        }
    },
    _trackDirtyPaths(patch, prefix = '') {
        for (const [k, v] of Object.entries(patch)) {
            const path = prefix ? prefix + '.' + k : k;
            this._dirtyPaths.add(path);
            if (v && typeof v === 'object' && !Array.isArray(v)) this._trackDirtyPaths(v, path);
        }
    },
    resetPath(path) {
        const segments = path.split('.');
        let target = this._overrides;
        for (let i = 0; i < segments.length - 1; i++) {
            if (!target[segments[i]] || typeof target[segments[i]] !== 'object') return this.get();
            target = target[segments[i]];
        }
        const lastKey = segments[segments.length - 1];
        delete target[lastKey];
        this._frozen = null; this._version++;
        this._dirtyPaths.add(path);
        this._notifyPathSubscribers({ [lastKey]: undefined }, segments.slice(0, -1).join('.'));
        return this.get();
    },
    reset() { this._overrides = {}; this._frozen = null; this._version++; this._dirtyPaths.clear(); return this.get(); },
    get version() { return this._version; },
    get dirtyPaths() { return [...this._dirtyPaths]; },
    clearDirty() { this._dirtyPaths.clear(); }
};

function getConfig() { return ConfigStore.get(); }

/* ═══════════════════════════════════════════════════════════
 * §3  Logger
 * @provides: Logger, ScopedLogger
 * ═══════════════════════════════════════════════════════════ */
class ScopedLogger {
    constructor(tag, getLevel) { this._tag = tag; this._getLevel = getLevel; }
    trace(...a){ if(this._getLevel()>=LOG_LEVEL.TRACE) console.debug(this._tag,...a); }
    debug(...a){ if(this._getLevel()>=LOG_LEVEL.DEBUG) console.debug(this._tag,...a); }
    log(...a)  { if(this._getLevel()>=LOG_LEVEL.LOG)   console.log(this._tag,...a); }
    info(...a) { if(this._getLevel()>=LOG_LEVEL.INFO)  console.info(this._tag,...a); }
    warn(...a) { if(this._getLevel()>=LOG_LEVEL.WARN)  console.warn(this._tag,...a); }
    error(...a){ if(this._getLevel()>=LOG_LEVEL.ERROR) console.error(this._tag,...a); }
}

const Logger = {
    prefix: '[APS23]', _scopeId: 0,
    get _level() {
        const d = getConfig().debug;
        if (d === false || d === 'none') return LOG_LEVEL.WARN;
        if (d === true || d === 'trace') return LOG_LEVEL.TRACE;
        if (d === 'debug') return LOG_LEVEL.DEBUG;
        if (d === 'info') return LOG_LEVEL.INFO;
        if (d === 'log') return LOG_LEVEL.LOG;
        return LOG_LEVEL.WARN;
    },
    scope(label) {
        const id = ++this._scopeId;
        const tag = this.prefix + ' [' + id + ':' + label + ']';
        const self = this;
        return new ScopedLogger(tag, () => self._level);
    },
    trace(...a){ if(this._level>=LOG_LEVEL.TRACE) console.debug(this.prefix,'[TRC]',...a); },
    debug(...a){ if(this._level>=LOG_LEVEL.DEBUG) console.debug(this.prefix,'[DBG]',...a); },
    log(...a)  { if(this._level>=LOG_LEVEL.LOG)   console.log(this.prefix,...a); },
    info(...a) { if(this._level>=LOG_LEVEL.INFO)  console.info(this.prefix,...a); },
    warn(...a) { if(this._level>=LOG_LEVEL.WARN)  console.warn(this.prefix,...a); },
    error(...a){ if(this._level>=LOG_LEVEL.ERROR) console.error(this.prefix,...a); }
};

/* ═══════════════════════════════════════════════════════════
 * §4  Runtime State
 * @provides: RuntimeState, PerfState, CacheManager
 * ═══════════════════════════════════════════════════════════ */
const CacheManager = {
    _caches: new LRUCache(DEFAULTS.limits.cacheMaxSize),
    set(k,v,t){ this._caches.set(k,v,t); }, get(k){ return this._caches.get(k); },
    invalidate(k){ this._caches.invalidate(k); }, invalidateAll(){ this._caches.clear(); },
    pruneExpired(){ this._caches.pruneExpired(); }, get size(){ return this._caches.size; }
};
const PerfState = { fps: 60, cpuLoad: 0, cpu: 'normal' };
const RuntimeState = {
    visible:true, started:false, errors:0, circuitOpen:false,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    get lifecycle(){ return APS.lifecycle; }, set lifecycle(v){ APS.lifecycle = v; },
    setCache(k,v,t){ CacheManager.set(k,v,t); }, getCache(k){ return CacheManager.get(k); },
    invalidate(k){ CacheManager.invalidate(k); }, invalidateAll(){ CacheManager.invalidateAll(); },
    pruneCaches(){ CacheManager.pruneExpired(); }, get cacheSize(){ return CacheManager.size; }
};

/* ═══════════════════════════════════════════════════════════
 * §4.1  Resource Manager
 * @provides: ResourceManager, GlobalResources
 * ═══════════════════════════════════════════════════════════ */
class ResourceManager {
    constructor(){ this.resources = new Set(); }
    add(r){ if(r&&(typeof r==='function'||typeof r.destroy==='function'||typeof r.stop==='function')) this.resources.add(r); }
    remove(r){ this.resources.delete(r); }
    destroyAll(){
        for(const res of this.resources){
            try{ if(typeof res==='function')res(); else if(typeof res.destroy==='function')res.destroy(); else if(typeof res.stop==='function')res.stop(); }catch(e){ Logger.trace('GlobalResources.destroyAll',e); }
        }
        this.resources.clear();
    }
}
const GlobalResources = new ResourceManager();

/* ═══════════════════════════════════════════════════════════
 * §4.5  Module Registry
 * [NEW-A4] verifyAll health-check method.
 * [NEW-F1] _degrade emits LIFECYCLE_CHANGED.
 * @provides: ModuleRegistry
 * ═══════════════════════════════════════════════════════════ */
const ModuleRegistry = {
    _modules: new Map(), _order: [], _dependents: new Map(),
    register(name, module, deps = []) {
        if (this._modules.has(name)) { Logger.warn('ModuleRegistry: duplicate registration', name); return; }
        this._modules.set(name, { module, deps:[...deps], started:false, skipped:false, error:null, ts:0 });
        this._order.push(name);
        for (const dep of deps) {
            if (!this._dependents.has(dep)) this._dependents.set(dep, []);
            this._dependents.get(dep).push(name);
        }
    },
    dependentsOf(name){ return this._dependents.get(name)||[]; },
    _missingDeps(name){ return this._modules.get(name).deps.filter(d=>!this._modules.has(d)); },
    topoOrder() {
        const indeg = new Map();
        for (const [name, entry] of this._modules) {
            let d = 0; for (const dep of entry.deps) if (this._modules.has(dep)) d++;
            indeg.set(name, d);
        }
        const ready = this._order.filter(n => indeg.get(n) === 0);
        const out = []; const outSet = new Set(); let head = 0;
        while (head < ready.length) {
            const n = ready[head++]; out.push(n); outSet.add(n);
            for (const m of this.dependentsOf(n)) {
                indeg.set(m, indeg.get(m) - 1);
                if (indeg.get(m) === 0) ready.push(m);
            }
        }
        if (out.length !== this._modules.size) {
            const cycle = this._order.filter(n => !outSet.has(n));
            Logger.error('ModuleRegistry: dependency cycle detected:', cycle);
            for (const n of cycle) {
                const e = this._modules.get(n);
                e.error = new APSError('dependency cycle',{code:'E_CYCLE',severity:'fatal',recoverable:false});
                e.skipped = true;
            }
            return { order: out, cyclic: cycle };
        }
        return { order: out, cyclic: [] };
    },
    topoLayers() {
        const { order, cyclic } = this.topoOrder();
        const layerOf = new Map(); const layers = [];
        for (const name of order) {
            const entry = this._modules.get(name); let lvl = 0;
            for (const dep of entry.deps) if (layerOf.has(dep)) lvl = Math.max(lvl, layerOf.get(dep) + 1);
            layerOf.set(name, lvl);
            if (!layers[lvl]) layers[lvl] = [];
            layers[lvl].push(name);
        }
        return { layers: layers.filter(Boolean), cyclic };
    },
    async start(name) {
        const entry = this._modules.get(name);
        if (!entry) { Logger.warn('ModuleRegistry: unknown module', name); return false; }
        if (entry.started) return true;
        if (entry.skipped) return false;
        const missing = this._missingDeps(name);
        if (missing.length) {
            entry.skipped = true;
            entry.error = new APSError('missing deps: '+missing.join(','),{code:'E_DEPS'});
            Logger.error('module skipped (missing deps):', name, missing);
            this._degrade(); return false;
        }
        for (const dep of entry.deps) {
            const d = this._modules.get(dep);
            if (!d.started || d.skipped) {
                entry.skipped = true;
                entry.error = new APSError('dependency failed: '+dep,{code:'E_DEP_FAIL'});
                Logger.error('module skipped (dependency failed):', name, '←', dep);
                this._degrade(); return false;
            }
        }
        try {
            if (typeof entry.module.init === 'function') {
                const result = entry.module.init();
                if (result && typeof result.then === 'function') await result;
            }
            entry.started = true; entry.ts = Clock.wall();
            Logger.log('module online:', name);
            return true;
        } catch (e) {
            entry.error = e; Logger.error('module failed:', name, e);
            RuntimeState.errors++; CircuitBreaker.record();
            this._degrade(); return false;
        }
    },
    /* [NEW-F1] Emit LIFECYCLE_CHANGED on degradation */
    _degrade() {
        if (APS.lifecycle === APS_LIFECYCLE.BOOTING || APS.lifecycle === APS_LIFECYCLE.READY) {
            APS.lifecycle = APS_LIFECYCLE.DEGRADED;
            try { EventBus.emit(APS_EVENTS.LIFECYCLE_CHANGED, { to: APS_LIFECYCLE.DEGRADED }); } catch (_) {}
        }
    },
    async startAll(names) {
        let order = names && names.length ? names : this.topoOrder().order;
        let allOk = true;
        for (const name of order) { if (!(await this.start(name))) allOk = false; }
        return allOk;
    },
    async startInLayers() {
        const { layers, cyclic } = this.topoLayers();
        let allOk = cyclic.length === 0;
        for (const layer of layers) {
            const results = await Promise.allSettled(layer.map(name => this.start(name)));
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status === 'rejected' || r.value === false) {
                    allOk = false;
                    const entry = this._modules.get(layer[i]);
                    if (entry && !entry.error) {
                        entry.error = r.status === 'rejected' ? r.reason : new APSError('init returned false',{code:'E_INIT'});
                        entry.skipped = true;
                    }
                }
            }
        }
        return allOk;
    },
    disposeAll() {
        const order = this.topoOrder().order.reverse();
        const outSet = new Set(order);
        const rest = this._order.filter(n => !outSet.has(n)).reverse();
        for (const name of [...order, ...rest]) {
            const entry = this._modules.get(name);
            try { if (entry && typeof entry.module.dispose === 'function') entry.module.dispose(); }
            catch (e) { Logger.trace('ModuleRegistry.disposeAll:'+name, e); }
        }
        this._modules.clear(); this._order.length = 0; this._dependents.clear();
    },
    /* [NEW-A4] Health check all started modules */
    verifyAll() {
        const results = {};
        for (const [name, entry] of this._modules) {
            if (!entry.started) { results[name] = 'not-started'; continue; }
            if (typeof entry.module.healthCheck === 'function') {
                try { results[name] = entry.module.healthCheck() ? 'healthy' : 'unhealthy'; }
                catch (_) { results[name] = 'error'; }
            } else { results[name] = 'ok'; }
        }
        return results;
    },
    get status() {
        const result = {};
        for (const [name, entry] of this._modules) {
            result[name] = {
                started: entry.started, skipped: entry.skipped,
                deps: entry.deps, dependents: this.dependentsOf(name),
                error: entry.error ? (entry.error.message || String(entry.error)) : null,
                startedAt: entry.ts || null
            };
        }
        return result;
    },
    get names(){ return [...this._order]; },
    get size(){ return this._modules.size; }
};

/* ═══════════════════════════════════════════════════════════
 * §5  CircuitBreaker
 * [FIX-A5] Sliding-window error counting via RingHistory.
 * @provides: CircuitBreaker
 * ═══════════════════════════════════════════════════════════ */
const CircuitBreaker = {
    _errors: new RingHistory(CONST.CB_ERROR_RING_SIZE),
    _openUntil: 0, _resetTimer: null,
    _state: 'closed', _halfOpenAttempts: 0,

    record() {
        if (this._state === 'half-open') {
            this._open();
            return;
        }
        if (this._state === 'open') return;
        const now = Clock.wall();
        const cfg = getConfig().circuitBreaker;
        this._errors.push(now);
        /* [FIX-A5] True sliding window */
        const recentCount = this._errors.aggregate(
            (acc, t) => (now - t < cfg.windowMs) ? acc + 1 : acc, 0);
        if (recentCount >= cfg.maxErrors) {
            this._open();
        }
    },
    _open() {
        const cfg = getConfig().circuitBreaker;
        if (this._resetTimer !== null) clearTimeout(this._resetTimer);
        RuntimeState.circuitOpen = true;
        this._state = 'open';
        this._openUntil = Clock.wall() + cfg.cooldownMs;
        APS.lifecycle = APS_LIFECYCLE.RECOVERING;
        Logger.error('Circuit breaker OPEN – lifecycle → RECOVERING');
        const sched = ServiceContainer.get('scheduler');
        if (sched) sched.pause();
        this._resetTimer = setTimeout(() => {
            this._resetTimer = null;
            this._state = 'half-open';
            this._halfOpenAttempts = 0;
            RuntimeState.circuitOpen = false;
            this._errors.clear();
            const s2 = ServiceContainer.get('scheduler');
            if (s2) s2.resume();
            if (APS.lifecycle === APS_LIFECYCLE.RECOVERING) APS.lifecycle = APS_LIFECYCLE.READY;
            Logger.log('Circuit breaker → HALF_OPEN');
        }, cfg.cooldownMs);
    },
    isOpen() { return this._state === 'open'; },
    allowRequest() {
        if (this.isOpen()) return false;
        if (this._state === 'half-open') {
            this._halfOpenAttempts++;
            return this._halfOpenAttempts <= CONST.HALF_OPEN_MAX_PROBES;
        }
        return true;
    },
    recordSuccess() {
        if (this._state === 'half-open') { this._state = 'closed'; Logger.log('CircuitBreaker: half-open → CLOSED'); }
    },
    reset() {
        const wasOpen = this.isOpen();
        this._errors.clear(); this._openUntil = 0; this._state = 'closed';
        this._halfOpenAttempts = 0;
        RuntimeState.circuitOpen = false;
        if (this._resetTimer) { clearTimeout(this._resetTimer); this._resetTimer = null; }
        if (wasOpen && !APS.destroyed) {
            ServiceContainer.get('scheduler')?.resume();
            if (APS.lifecycle === APS_LIFECYCLE.RECOVERING) APS.lifecycle = APS_LIFECYCLE.READY;
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §5.1  Native Layer
 * [FIX-E1] safePlayWithFallback: soft offline check.
 * @provides: Native
 * ═══════════════════════════════════════════════════════════ */
const Native = {
    media: { play:null, pause:null, load:null, _initialized:false },
    doc: { visibilityStateGetter:null, hiddenGetter:null, hasFocus:null },
    obj: { defineProperty: Object.defineProperty, getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor },
    safePlay(m){ try{ return this.media.play.call(m); }catch(e){ return Promise.reject(e); } },
    safePause(m){ try{ this.media.pause.call(m); }catch(e){ Logger.trace('safePause',e); } },
    safeLoad(m){ try{ this.media.load.call(m); }catch(e){ Logger.trace('safeLoad',e); } },
    async safePlayWithFallback(media, restoreAfter = TIMING.MUTED_RESTORE_DEFAULT, instance = null) {
        /* [FIX-E1] Soft check – log but do not block */
        if (!navigator.onLine) Logger.debug('safePlayWithFallback: navigator.onLine false, attempting anyway');
        try { await this.safePlay(media); }
        catch (err) {
            const wasMuted = media.muted;
            if (!wasMuted) {
                try { media.muted = true; }
                catch (e) { Logger.trace('safePlayWithFallback:mute', e); throw err; }
                try {
                    await this.safePlay(media);
                    const timerId = setTimeout(() => {
                        try { if (media.isConnected) media.muted = false; }
                        catch (e) { Logger.trace('mute-restore', e); }
                        if (instance) instance._muteRestoreTimer = null;
                    }, restoreAfter);
                    if (instance) instance._muteRestoreTimer = timerId;
                } catch (e2) {
                    try { media.muted = false; } catch (e3) { Logger.trace('mute-unrestore', e3); }
                    throw e2;
                }
            } else { throw err; }
        }
    },
    init() {
        const r = Utils.safe(() => {
            this.media.play = HTMLMediaElement.prototype.play;
            this.media.pause = HTMLMediaElement.prototype.pause;
            this.media.load = HTMLMediaElement.prototype.load;
            this.doc.visibilityStateGetter = this.obj.getOwnPropertyDescriptor(Document.prototype,'visibilityState')?.get ?? null;
            this.doc.hiddenGetter = this.obj.getOwnPropertyDescriptor(Document.prototype,'hidden')?.get ?? null;
            this.doc.hasFocus = Document.prototype.hasFocus;
            this.media._initialized = true;
        }, 'native-init');
        if (!r.ok) return false;
        if (!this.media.play || !this.media.pause) {
            console.error('[APS23] Critical: native media methods unavailable – aborting');
            return false;
        }
        return true;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §5.2  Utils
 * @provides: Utils
 * ═══════════════════════════════════════════════════════════ */
const Utils = {
    now(){ return Clock.wall(); },
    sleep(ms, token = null) {
        return new Promise((resolve) => {
            if (token?.cancelled) { resolve(); return; }
            let cancelFn = null;
            const id = setTimeout(() => {
                if (cancelFn && token) token.removeCancelListener(cancelFn);
                resolve();
            }, ms);
            if (token) { cancelFn = () => { clearTimeout(id); resolve(); }; token.onCancel(cancelFn); }
        });
    },
    isMedia(el) {
        if (!el || el.nodeType !== 1) return false;
        try { return el instanceof HTMLMediaElement; } catch (_) {}
        return typeof el.play === 'function' && typeof el.pause === 'function' &&
               'currentTime' in el && 'paused' in el && 'readyState' in el;
    },
    /** @returns {SafeResult} */
    safe(fn, label) {
        try { return { ok:true, value: fn() }; }
        catch (e) {
            RuntimeState.errors++; Logger.warn(label||'safe', e);
            const rm = ServiceContainer.get('runtimeMonitor'); if(rm?.stats) rm.stats.errors++;
            CircuitBreaker.record();
            return { ok:false, value:undefined, error:e };
        }
    },
    async safeAsync(fn, label) {
        try { return { ok:true, value: await fn() }; }
        catch (e) {
            RuntimeState.errors++; Logger.warn(label||'safeAsync', e);
            const rm = ServiceContainer.get('runtimeMonitor'); if(rm?.stats) rm.stats.errors++;
            CircuitBreaker.record();
            return { ok:false, value:undefined, error:e };
        }
    },
    safeSilent(fn){ try{ return {ok:true,value:fn()}; }catch(_){ return {ok:false,value:undefined}; } },
    visible() {
        const cfg = getConfig();
        const cached = CacheManager.get('docVisible');
        if (cached !== undefined) return cached;
        let val = true;
        try {
            const vs = Native.doc.visibilityStateGetter ? Native.doc.visibilityStateGetter.call(document) : document.visibilityState;
            val = vs === 'visible';
            if (Native.doc.hiddenGetter && Native.doc.hiddenGetter.call(document)) val = false;
        } catch (e) { Logger.trace('Utils.visible', e); }
        CacheManager.set('docVisible', val, cfg.limits.visibilityCacheTtl);
        return val;
    },
    invalidateVisibility(){ CacheManager.invalidate('docVisible'); },
    throttle(fn, time){ let last=0; return(...args)=>{ const n=Clock.wall(); if(n-last>=time){last=n;return fn(...args);} }; },
    debounce(fn, time){ let t; return(...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),time); }; },
    randomId(){ return getConfig().antiDetect.randomIds ? '_aps23_'+Math.random().toString(36).slice(2,10) : '_aps23'; }
};

/* ═══════════════════════════════════════════════════════════
 * §6  EventBus (with priority queue)
 * @provides: EventBus, EVENT_PRIORITY
 * ═══════════════════════════════════════════════════════════ */
const EVENT_PRIORITY = Object.freeze({
    [APS_EVENTS.RECOVERY_ESCALATE]:10,[APS_EVENTS.RECOVERY_SUCCESS]:9,[APS_EVENTS.RECOVERY_FAILED]:9,
    [APS_EVENTS.BUFFER_WARNING]:8,[APS_EVENTS.CONFIG_CHANGED]:7,
    [APS_EVENTS.STATE_CHANGE]:6,[APS_EVENTS.ACTIVE_CHANGED]:6,
    [APS_EVENTS.INSTANCE_ADDED]:5,[APS_EVENTS.INSTANCE_REMOVED]:5,
    [APS_EVENTS.PERFORMANCE]:2,[APS_EVENTS.HEALTH]:2
});

const EventBus = {
    events: new Map(), _disposables: new Set(), _emitting: false, _queue: [],
    on(type, fn, opts) {
        if (!this.events.has(type)) this.events.set(type, new Set());
        this.events.get(type).add(fn);
        const unsub = () => { this.events.get(type)?.delete(fn); this._disposables.delete(unsub); };
        this._disposables.add(unsub);
        if (opts?.signal) opts.signal.addEventListener('abort', unsub, { once: true });
        return unsub;
    },
    off(type, fn){ this.events.get(type)?.delete(fn); },
    emit(type, data) {
        const list = this.events.get(type);
        if (!list || list.size === 0) return;
        if (this._emitting) {
            if (this._queue.length >= LIMITS.EVENTBUS_QUEUE_MAX) {
                const prio = EVENT_PRIORITY[type] ?? 0;
                const minIdx = this._queue.findIndex(q => (q[2] ?? 0) < prio);
                if (minIdx >= 0) {
                    try { Telemetry.push({type:'eventbus-overflow',dropped:this._queue[minIdx][0]}); } catch(_){}
                    this._queue.splice(minIdx, 1);
                } else {
                    try { Telemetry.push({type:'eventbus-overflow',dropped:type}); } catch(_){}
                    Logger.warn('EventBus queue overflow, dropping:', type);
                    return;
                }
            }
            this._queue.push([type, data, EVENT_PRIORITY[type] ?? 0]);
            return;
        }
        this._emitting = true;
        try {
            this._dispatch(type, data);
            let head = 0;
            while (head < this._queue.length) { const [n,d] = this._queue[head++]; this._dispatch(n,d); }
            this._queue.length = 0;
        } finally { this._emitting = false; }
    },
    _dispatch(type, data) {
        const list = this.events.get(type);
        if (!list || list.size === 0) return;
        const snapshot = [...list];
        for (const fn of snapshot) { try { fn(data); } catch (e) { Logger.warn('event:'+type, e); } }
    },
    clear() {
        for (const u of this._disposables) { try { u(); } catch(e){ Logger.trace('EventBus.clear',e); } }
        this._disposables.clear(); this.events.clear(); this._queue.length = 0;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §7  MediaStore
 * @provides: MediaStore
 * ═══════════════════════════════════════════════════════════ */
const MediaStore = {
    _instances: new Map(), _mediaMap: new WeakMap(), _activeId: null,
    _idCounter: 0, _subs: new Map(), _subsSorted: new Map(), _subsDirty: new Set(),
    _listCache: null, _listDirty: true, _onRemove: null,
    subscribe(event, fn, { scope='external', priority=0 } = {}) {
        if (!this._subs.has(event)) this._subs.set(event, new Map());
        this._subs.get(event).set(fn, { scope, priority });
        this._subsDirty.add(event);
        return () => { this._subs.get(event)?.delete(fn); this._subsDirty.add(event); };
    },
    _emit(event, data) {
        const s = this._subs.get(event);
        if (!s || s.size === 0) return;
        if (this._subsDirty.has(event) || !this._subsSorted.has(event)) {
            this._subsSorted.set(event, [...s.entries()].sort((a,b) => b[1].priority - a[1].priority));
            this._subsDirty.delete(event);
        }
        const sorted = [...this._subsSorted.get(event)];
        for (const [fn] of sorted) { try { fn(data); } catch(e){ Logger.warn('MediaStore:'+event,e); } }
    },
    emitPageEvent(event, data) {
        const allowed = [APS_EVENTS.PAGE_VISIBLE,APS_EVENTS.PAGE_HIDDEN,APS_EVENTS.PAGE_FOCUS,APS_EVENTS.PAGE_BLUR];
        if (!allowed.includes(event)) return;
        this._emit(event, data);
    },
    notifyStateChange(record){ this._emit(APS_EVENTS.STATE_CHANGE, record); },
    add(media, instance) {
        if (this._mediaMap.has(media)) return this._mediaMap.get(media);
        if (this._instances.size >= CONST.MEDIA_STORE_HARD_CAP) {
            Logger.warn('MediaStore: hard cap reached, rejecting add');
            return null;
        }
        Assert.invariant(Utils.isMedia(media), 'MediaStore.add: not a media element');
        const id = ++this._idCounter;
        instance.id = id;
        this._instances.set(id, instance);
        this._mediaMap.set(media, id);
        this._listDirty = true;
        this._emit(APS_EVENTS.INSTANCE_ADDED, { instance, id });
        return id;
    },
    addBatch(entries) {
        const ids = [];
        for (const { media, instance } of entries) {
            if (this._mediaMap.has(media)) { ids.push(this._mediaMap.get(media)); continue; }
            if (this._instances.size >= CONST.MEDIA_STORE_HARD_CAP) break;
            const id = ++this._idCounter;
            instance.id = id;
            this._instances.set(id, instance);
            this._mediaMap.set(media, id);
            ids.push(id);
        }
        if (ids.length > 0) { this._listDirty = true; this._emit(APS_EVENTS.INSTANCE_ADDED_BATCH, {count:ids.length,ids}); }
        return ids;
    },
    remove(media) {
        const id = this._mediaMap.get(media);
        if (id === undefined) return;
        const instance = this._instances.get(id);
        if (this._onRemove && instance) this._onRemove(instance);
        this._instances.delete(id); this._mediaMap.delete(media);
        this._listDirty = true;
        if (this._activeId === id) { this._activeId = null; this._emit(APS_EVENTS.ACTIVE_CHANGED, {old:id,current:null}); }
        this._emit(APS_EVENTS.INSTANCE_REMOVED, { instance, id });
    },
    setActive(id) {
        if (this._activeId === id) return;
        const old = this._activeId; this._activeId = id;
        this._emit(APS_EVENTS.ACTIVE_CHANGED, { old, current: id });
    },
    updateInstance(media, patch){ const ins = this.get(media); if(ins) Object.assign(ins, patch); },
    get(media){ const id = this._mediaMap.get(media); return id !== undefined ? this._instances.get(id) : undefined; },
    getById(id){ return this._instances.get(id); },
    getActive(){ return this._activeId !== null ? this._instances.get(this._activeId) ?? null : null; },
    list() {
        if (this._listDirty) { this._listCache = [...this._instances.values()]; this._listDirty = false; }
        return this._listCache;
    },
    forEach(fn){ for(const ins of this._instances.values()) fn(ins); },
    get size(){ return this._instances.size; },
    clear() {
        this._instances.clear(); this._mediaMap = new WeakMap();
        this._activeId = null; this._subs.clear(); this._subsSorted.clear();
        this._subsDirty.clear(); this._listCache = null; this._listDirty = true;
    },
    fullReset(){ this.clear(); }
};

/* ═══════════════════════════════════════════════════════════
 * §8  Media Domain Events
 * @provides: MEDIA_EVENTS
 * ═══════════════════════════════════════════════════════════ */
const MEDIA_EVENTS = Object.freeze({
    PLAY_STARTED:'media:play-started', PLAYING:'media:playing', PAUSED:'media:paused',
    BUFFERING:'media:buffering', STALLED:'media:stalled', ENDED:'media:ended',
    PROGRESS:'media:progress', VOLUME_CHANGED:'media:volume-changed',
    EMPTIED:'media:emptied', ERROR_OCCURRED:'media:error', INTERACTION:'media:interaction'
});

/* ═══════════════════════════════════════════════════════════
 * §9  AntiDetect / Stealth
 * @provides: AntiDetect
 * ═══════════════════════════════════════════════════════════ */
const AntiDetect = {
    symbols: new Map(),
    symbol(name){ if(!this.symbols.has(name)) this.symbols.set(name, Symbol.for('APS23_'+name)); return this.symbols.get(name); },
    mark(el){ try{ Native.obj.defineProperty(el,this.symbol('internal'),{value:true,writable:false,enumerable:false,configurable:false}); }catch(e){Logger.trace('AntiDetect.mark',e);} },
    isInternal(el){ try{ return !!el[this.symbol('internal')]; }catch(_){ return false; } },
    wrap(fn, name) {
        try {
            return new Proxy(fn, {
                apply(t, thisArg, args){ return t.apply(thisArg, args); },
                get(t, prop, receiver) {
                    if (prop === 'toString') return () => fn.toString();
                    if (prop === 'name') return name || fn.name;
                    if (prop === 'length') return fn.length;
                    if (prop === Symbol.toPrimitive) return () => fn.toString();
                    return Reflect.get(t, prop, receiver);
                }
            });
        } catch (_) {
            const w = function(...a){ return fn.apply(this, a); };
            try {
                Native.obj.defineProperty(w,'name',{value:name||fn.name});
                Native.obj.defineProperty(w,'length',{value:fn.length});
                Native.obj.defineProperty(w,'toString',{value:()=>fn.toString()});
            } catch(e){ Logger.trace('AntiDetect.wrap',e); }
            return w;
        }
    },
    hijackStealth(obj, prop, newFn) {
        const orig = obj[prop];
        if (typeof orig !== 'function') return null;
        const origStr = orig.toString(), origName = orig.name || prop, origLen = orig.length;
        const wrapped = function(...args){ return newFn.call(this, orig, ...args); };
        try {
            Native.obj.defineProperty(wrapped,'name',{value:origName,configurable:true});
            Native.obj.defineProperty(wrapped,'length',{value:origLen,configurable:true});
            Native.obj.defineProperty(wrapped,'toString',{value:()=>origStr,writable:false,configurable:true});
        } catch(e){ Logger.trace('AntiDetect.hijackStealth',e); }
        try { obj[prop] = wrapped; } catch(_){ return null; }
        return orig;
    },
    isNative(fn){ try{ return fn.toString().includes('[native code]'); }catch(_){ return false; } },
    applyStealth() {
        const cfg = getConfig();
        const level = cfg.antiDetect.stealth;
        if (level === 'none') return;
        const cs = document.currentScript;
        if (cs?.parentNode) { try{ cs.parentNode.removeChild(cs); }catch(e){Logger.trace('stealth-rm-script',e);} }
        if (window.__APS23) {
            try{ Native.obj.defineProperty(window,'__APS23',{enumerable:false,configurable:true,writable:true}); }catch(e){Logger.trace('stealth-define',e);}
        }
        if (cfg.shield.fakeFocus) {
            Utils.safe(() => {
                if (this.isNative(document.hasFocus)) this.hijackStealth(document,'hasFocus',function(){return true;});
            }, 'stealth-hasfocus');
        }
        if (level === 'paranoid') {
            setTimeout(() => { try{ delete window.__APS23; }catch(e){Logger.trace('stealth-delete',e);} }, cfg.timing.paranoidDelete);
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §10  Telemetry Buffer
 * [NEW-D6] taskStats in perfMetrics.
 * @provides: Telemetry
 * ═══════════════════════════════════════════════════════════ */
const Telemetry = {
    buffer: new RingHistory(DEFAULTS.telemetry.bufferSize),
    _enabled: false,
    perfMetrics: {
        schedulerTickMs:0, recoveryAvgMs:0,
        _recoveryTimes:null, _recoverySum:0,
        scanCount:0, lastScanDuration:0, scanNodeHits:0,
        taskStats: { totalExecutions:0, slowTasks:0 }
    },
    init() {
        this._enabled = getConfig().telemetry.enabled;
        EventBus.on(APS_EVENTS.CONFIG_CHANGED, () => { this._enabled = getConfig().telemetry.enabled; });
    },
    get enabled(){ return this._enabled; },
    _getRecoveryTimes() {
        if (!this.perfMetrics._recoveryTimes)
            this.perfMetrics._recoveryTimes = new RingHistory(LIMITS.TELEMETRY_RECOVERY_SAMPLES);
        return this.perfMetrics._recoveryTimes;
    },
    push(entry) {
        if (!this._enabled) return;
        if (entry?.error instanceof APSError) entry.error = entry.error.toJSON();
        this.buffer.push({ ts: Clock.wall(), ...entry });
    },
    recordRecoveryTime(ms) {
        if (!isFinite(ms) || ms < 0) return;
        const ring = this._getRecoveryTimes();
        if (ring.length === ring.capacity) this.perfMetrics._recoverySum -= ring.first();
        ring.push(ms);
        this.perfMetrics._recoverySum += ms;
        this.perfMetrics.recoveryAvgMs = ring.length > 0 ? this.perfMetrics._recoverySum / ring.length : 0;
    },
    dump(){ return this.buffer.toArray(); },
    metrics(){ const {_recoveryTimes,_recoverySum,...rest} = this.perfMetrics; return rest; },
    export(format = 'json') {
        const data = {
            version: APS.version, exportedAt: new Date().toISOString(),
            entries: this.buffer.toArray(), metrics: this.metrics(),
            config: { debug: getConfig().debug, telemetryEnabled: this._enabled }
        };
        if (format === 'json') return JSON.stringify(data, null, 2);
        if (format === 'session') { try{ sessionStorage.setItem('APS23_TELEMETRY',JSON.stringify(data)); }catch(_){} return 'saved-to-session'; }
        if (format === 'csv') {
            const entries = data.entries;
            if (!entries.length) return 'ts,type,detail\n';
            const csvEscape = v => {
                const s = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
                return (s.includes(',')||s.includes('"')||s.includes('\n')) ? '"'+s.replace(/"/g,'""')+'"' : s;
            };
            return Object.keys(entries[0]).join(',') + '\n' +
                   entries.map(e => Object.values(e).map(csvEscape).join(',')).join('\n');
        }
        return data;
    },
    clear() {
        this.buffer.clear();
        if (this.perfMetrics._recoveryTimes) this.perfMetrics._recoveryTimes.clear();
        this.perfMetrics._recoverySum = 0; this.perfMetrics.recoveryAvgMs = 0;
        this.perfMetrics.taskStats.totalExecutions = 0;
        this.perfMetrics.taskStats.slowTasks = 0;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §11  Pure Score Functions
 * @provides: ScoreFunctions
 * ═══════════════════════════════════════════════════════════ */
const ScoreFunctions = {
    interaction(lastActionTs,lastInteractionTs,isLastMedia,now,decay) {
        let s = 0;
        if (isLastMedia && lastActionTs) s = Math.max(s, clamp01((decay-(now-lastActionTs))/decay));
        if (lastInteractionTs && now-lastInteractionTs < decay) s = Math.max(s, clamp01((decay-(now-lastInteractionTs))/decay));
        return s;
    },
    audio(muted,volume){ return (muted||volume===0)?0:clamp01(volume); },
    progress(currentTime,duration) {
        if (!duration||!isFinite(duration)) return CONST.NEUTRAL_CONFIDENCE;
        return Math.exp(-Math.pow((currentTime/duration-0.5)/CONST.PROGRESS_GAUSS_SIGMA,2));
    },
    duration(createdTs,now,maxMs=CONST.DURATION_SCORE_MAX_MS){ return clamp01((now-createdTs)/maxMs); },
    momentum(playTs,now){ return playTs?Math.exp(-(now-playTs)/CONST.MOMENTUM_DECAY_MS):0; },
    visibility(ratio){ return clamp01(ratio); },
    container(hasPlayerClass,bestZ,depth) {
        let s = CONST.CONTAINER_BASE_SCORE;
        if (hasPlayerClass) s = Math.max(s, CONST.CONTAINER_PLAYER_CLASS_SCORE);
        s += clamp01(bestZ/CONST.CONTAINER_Z_DIVISOR)*CONST.CONTAINER_Z_WEIGHT;
        s += clamp01(depth/CONST.CONTAINER_DEPTH_DIVISOR)*CONST.CONTAINER_DEPTH_WEIGHT;
        return clamp01(s);
    },
    composite(w,factors) {
        let sum = 0;
        for (const k of Object.keys(w)) if (factors[k] !== undefined) sum += w[k]*factors[k];
        return sum;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §12  Adaptive Scheduler
 * [NEW-F5] pauseTask / resumeTask single-task control.
 * [NEW-D6] Task execution stats in Telemetry.perfMetrics.taskStats.
 * @provides: Scheduler
 * ═══════════════════════════════════════════════════════════ */
const Scheduler = {
    _heap: [], _taskMap: new Map(),
    _rafId: null, _timerId: null,
    _running: false, _paused: false,
    lastTick: 0, scale: 1,
    _frameDelta: TIMING.FRAME_BUDGET_MS, _lastFrameTime: 0,
    _cfgCache: null, _cfgVersion: -1,
    _hiddenSince: 0,

    _cfg() {
        const ver = ConfigStore.version;
        if (this._cfgVersion !== ver || !this._cfgCache) {
            this._cfgCache = getConfig();
            this._cfgVersion = ver;
        }
        return this._cfgCache;
    },
    invalidateCfg() { this._cfgVersion = -1; },

    _siftUp(i) {
        const heap = this._heap;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p].nextRun <= heap[i].nextRun) break;
            const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
            i = p;
        }
    },

    _siftDown(i) {
        const heap = this._heap;
        const n = heap.length;
        while (true) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && heap[l].nextRun < heap[smallest].nextRun) smallest = l;
            if (r < n && heap[r].nextRun < heap[smallest].nextRun) smallest = r;
            if (smallest === i) break;
            const tmp = heap[smallest]; heap[smallest] = heap[i]; heap[i] = tmp;
            i = smallest;
        }
    },

    _heapPush(task) { this._heap.push(task); this._siftUp(this._heap.length - 1); },

    _heapPop() {
        while (this._heap.length > 0) {
            if (this._heap.length === 1) {
                const t = this._heap.pop();
                if (!t.cancelled && this._taskMap.has(t.id)) return t;
                continue;
            }
            const top = this._heap[0];
            this._heap[0] = this._heap.pop();
            this._siftDown(0);
            if (!top.cancelled && this._taskMap.has(top.id)) return top;
        }
        return null;
    },

    _interval(task) {
        return typeof task.interval === 'function' ? task.interval() : task.interval;
    },

    register(id, fn, interval, priority = 0, opts = {}) {
        this.unregister(id);
        const base = typeof interval === 'function' ? interval() : interval;
        const task = {
            id, fn, interval, priority,
            nextRun: Clock.mono() + base,
            backgroundSkip: opts.backgroundSkip === true,
            foregroundSkip: opts.foregroundSkip === true,
            critical: priority >= 10,
            cancelled: false, errorCount: 0,
            paused: false,
            _compensateCount: 0
        };
        this._taskMap.set(id, task);
        this._heapPush(task);
        this._ensureRunning();
    },

    unregister(id) {
        const t = this._taskMap.get(id);
        if (t) { t.cancelled = true; this._taskMap.delete(id); }
    },

    /* [NEW-F5] Single-task pause / resume */
    pauseTask(id) {
        const t = this._taskMap.get(id);
        if (t) t.paused = true;
    },
    resumeTask(id) {
        const t = this._taskMap.get(id);
        if (t) { t.paused = false; t.nextRun = Clock.mono(); }
    },

    reschedule(id) { const t = this._taskMap.get(id); if (t) t.nextRun = 0; },
    rescheduleAll() { for (const [, t] of this._taskMap) t.nextRun = 0; },

    pause() { this._paused = true; this._stopLoop(); },

    resume() {
        if (this._paused) {
            this._paused = false;
            const n = Clock.mono();
            let offset = 0;
            for (const [, t] of this._taskMap) {
                t.nextRun = n + offset + Math.random() * this._interval(t) * CONST.SCHEDULER_JITTER_FACTOR;
                offset += TIMING.MIN_SCHEDULER_DELAY;
            }
            this._ensureRunning();
        }
    },

    onVisibilityReturn() {
        const now = Clock.mono();
        if (this._hiddenSince <= 0) return;
        const hiddenMs = now - this._hiddenSince;
        this._hiddenSince = 0;
        if (hiddenMs <= TIMING.VISIBILITY_COMPENSATE_MS) return;
        for (const [, t] of this._taskMap) {
            if (t.cancelled) continue;
            if (t.nextRun < now) {
                t.nextRun = now;
                if (t.critical && hiddenMs > this._interval(t) * 2) {
                    t._compensateCount = Math.min(
                        Math.floor(hiddenMs / this._interval(t)),
                        TIMING.VISIBILITY_COMPENSATE_MAX
                    );
                }
            }
        }
    },

    _updateFPS(now) {
        const delta = now - this._lastFrameTime;
        this._lastFrameTime = now;
        if (delta > 0 && delta < 500) {
            this._frameDelta = this._frameDelta * TIMING.FPS_EMA_ALPHA + delta * (1 - TIMING.FPS_EMA_ALPHA);
            PerfState.fps = Math.round(1000 / this._frameDelta);
            PerfState.cpuLoad = Math.max(0, Math.min(1, (this._frameDelta - TIMING.FRAME_BUDGET_MS) / 100));
        }
    },

    _tick(now) {
        if (this._taskMap.size === 0) return;

        const cfg = this._cfg();
        const t0 = Clock.mono();
        const telemetryEnabled = cfg.telemetry.enabled;
        this._updateFPS(now);
        const vis = Utils.visible();
        const bgMult = (!vis && cfg.perf.adaptive) ? cfg.perf.backgroundMultiplier : 1;
        const cpuMult = (cfg.scheduler.fps && PerfState.cpuLoad > cfg.scheduler.highLoadThreshold) ? 2 : 1;
        const budgetMs = vis ? LIMITS.SCHEDULER_TICK_BUDGET_MS : LIMITS.SCHEDULER_TICK_BUDGET_MS * 2;

        while (this._heap.length > 0 && this._heap[0].nextRun <= now) {
            const task = this._heapPop();
            if (!task) break;

            /* [NEW-F5] Skip individually-paused tasks */
            if (task.paused) {
                task.nextRun = now + this._interval(task);
                this._heapPush(task);
                continue;
            }

            if (!vis && task.backgroundSkip && !task.critical) {
                task.nextRun = now + this._interval(task) * bgMult * this.scale;
                this._heapPush(task);
                continue;
            }
            if (vis && task.foregroundSkip && !task.critical) {
                task.nextRun = now + this._interval(task) * this.scale;
                this._heapPush(task);
                continue;
            }

            const runs = task._compensateCount > 0 ? task._compensateCount + 1 : 1;
            for (let r = 0; r < runs; r++) {
                try {
                    const taskT0 = Clock.mono();
                    task.fn(now);
                    task.errorCount = 0;
                    /* [NEW-D6] Task execution stats */
                    const elapsed = Clock.mono() - taskT0;
                    if (telemetryEnabled) {
                        Telemetry.perfMetrics.taskStats.totalExecutions++;
                        if (elapsed > LIMITS.SCHEDULER_TICK_BUDGET_MS) {
                            Telemetry.push({ type: 'slow-task', id: task.id, ms: Math.round(elapsed * 10) / 10 });
                            Telemetry.perfMetrics.taskStats.slowTasks++;
                        }
                    }
                } catch (e) {
                    task.errorCount++;
                    Logger.warn('sched:' + task.id, e);
                    CircuitBreaker.record();
                    if (task.errorCount > CONST.TASK_MAX_CONSECUTIVE_ERRORS) { this.unregister(task.id); break; }
                }
            }
            task._compensateCount = 0;

            if (!this._taskMap.has(task.id)) continue;

            const effectiveMult = (task.critical && cfg.scheduler.priorityBoost) ? 1 : bgMult;
            task.nextRun = now + this._interval(task) * effectiveMult * cpuMult * this.scale;
            this._heapPush(task);

            if (!task.critical && Clock.mono() - t0 > budgetMs) break;
        }
        this.lastTick = now;
        if (telemetryEnabled)
            Telemetry.perfMetrics.schedulerTickMs = Clock.mono() - t0;
    },

    _ensureRunning() {
        if (this._running || this._paused) return;
        this._running = true;
        this._lastFrameTime = Clock.mono();
        const rafLoop = () => {
            if (!this._running || this._paused) return;
            if (this._taskMap.size === 0) {
                this._running = false;
                this._rafId = null;
                return;
            }
            if (Utils.visible()) {
                this._tick(Clock.mono());
                this._rafId = requestAnimationFrame(rafLoop);
            } else {
                this._hiddenSince = Clock.mono();
                this._rafId = null;
                this._startTimer();
            }
        };
        this._rafId = requestAnimationFrame(rafLoop);
    },

    _startTimer() {
        if (this._timerId || this._paused) return;
        const loop = () => {
            if (!this._running || this._paused) { this._timerId = null; return; }
            if (Utils.visible()) {
                this._timerId = null;
                this.onVisibilityReturn();
                this._ensureRunning();
                return;
            }
            this._tick(Clock.mono());
            const delay = this._getNextDelay();
            this._timerId = setTimeout(loop, delay);
        };
        this._timerId = setTimeout(loop, this._getNextDelay());
    },

    _getNextDelay() {
        if (this._heap.length === 0) return this._cfg().scheduler.background;
        const nearest = this._heap[0].nextRun - Clock.mono();
        return Math.max(TIMING.MIN_SCHEDULER_DELAY, Math.min(nearest, this._cfg().scheduler.background));
    },

    _stopLoop() {
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._timerId) { clearTimeout(this._timerId); this._timerId = null; }
    },

    stop() {
        this._running = false; this._paused = false;
        this._stopLoop();
        this._heap.length = 0;
        this._taskMap.clear();
    },

    destroy() { this.stop(); },
    get tasks() { return this._taskMap; }
};
GlobalResources.add(Scheduler);

/* ═══════════════════════════════════════════════════════════
 * §13  Media State Machine
 * @provides: MEDIA_STATE, STATE_CONFIG, VALID_TRANSITIONS, StateMachine
 * ═══════════════════════════════════════════════════════════ */

const MEDIA_STATE = Object.freeze({
    UNKNOWN: 'unknown', IDLE: 'idle', PLAYING: 'playing',
    PAUSED_USER: 'paused_user', PAUSED_AUTO: 'paused_auto',
    BUFFERING: 'buffering', STALLED: 'stalled', ENDED: 'ended',
    RECOVERING: 'recovering', VERIFIED: 'verified',
    ERROR: 'error', DRM: 'drm', FAILED: 'failed', DESTROYED: 'destroyed'
});

const STATE_CONFIG = deepFreeze({
    [MEDIA_STATE.UNKNOWN]:     { transitions: [MEDIA_STATE.IDLE, MEDIA_STATE.ERROR], timeout: null },
    [MEDIA_STATE.IDLE]:       { transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.BUFFERING, MEDIA_STATE.ERROR, MEDIA_STATE.ENDED], timeout: null },
    [MEDIA_STATE.PLAYING]:    { transitions: [MEDIA_STATE.PAUSED_USER, MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.BUFFERING, MEDIA_STATE.STALLED, MEDIA_STATE.ENDED, MEDIA_STATE.DRM, MEDIA_STATE.ERROR, MEDIA_STATE.RECOVERING], timeout: null },
    [MEDIA_STATE.PAUSED_USER]:{ transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.IDLE, MEDIA_STATE.ENDED, MEDIA_STATE.ERROR], timeout: null },
    [MEDIA_STATE.PAUSED_AUTO]:{ transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.RECOVERING, MEDIA_STATE.IDLE, MEDIA_STATE.ERROR, MEDIA_STATE.ENDED], timeout: null },
    [MEDIA_STATE.BUFFERING]:  { transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.STALLED, MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.ERROR, MEDIA_STATE.RECOVERING], timeout: { ms: 20000, target: MEDIA_STATE.PAUSED_AUTO } },
    [MEDIA_STATE.STALLED]:    { transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.BUFFERING, MEDIA_STATE.RECOVERING, MEDIA_STATE.ERROR, MEDIA_STATE.PAUSED_AUTO], timeout: { ms: 15000, target: MEDIA_STATE.PAUSED_AUTO } },
    [MEDIA_STATE.ENDED]:      { transitions: [MEDIA_STATE.IDLE, MEDIA_STATE.PLAYING, MEDIA_STATE.ERROR], timeout: null },
    [MEDIA_STATE.RECOVERING]: { transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.ERROR, MEDIA_STATE.IDLE, MEDIA_STATE.VERIFIED, MEDIA_STATE.FAILED], timeout: null },
    [MEDIA_STATE.VERIFIED]:   { transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.IDLE, MEDIA_STATE.ERROR], timeout: null },
    [MEDIA_STATE.ERROR]:      { transitions: [MEDIA_STATE.IDLE, MEDIA_STATE.RECOVERING], timeout: null },
    [MEDIA_STATE.DRM]:        { transitions: [MEDIA_STATE.PLAYING, MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.RECOVERING, MEDIA_STATE.ERROR], timeout: { ms: 60000, target: MEDIA_STATE.PAUSED_AUTO } },
    [MEDIA_STATE.FAILED]:     { transitions: [MEDIA_STATE.RECOVERING, MEDIA_STATE.IDLE], timeout: null },
    [MEDIA_STATE.DESTROYED]:  { transitions: [], timeout: null }
});

const VALID_TRANSITIONS = Object.freeze(
    Object.fromEntries(
        Object.entries(STATE_CONFIG).map(([state, cfg]) => [state, new Set(cfg.transitions)])
    )
);

const LOOSE_ALLOWED_SOURCES = new Set([MEDIA_STATE.ERROR, MEDIA_STATE.STALLED, MEDIA_STATE.BUFFERING]);
const LOOSE_ALLOWED_TARGETS = new Set([MEDIA_STATE.RECOVERING, MEDIA_STATE.PLAYING, MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.IDLE]);

const StateMachine = {
    _guards: new Map(),
    _hooks: new Map(),
    _stateTimers: new WeakMap(),
    _activeTimerIds: new Set(),

    registerGuard(from, to, guard) {
        const key = from + '→' + to;
        if (!this._guards.has(key)) this._guards.set(key, []);
        this._guards.get(key).push(guard);
    },
    registerHook(state, hook) {
        if (!this._hooks.has(state)) this._hooks.set(state, []);
        this._hooks.get(state).push(hook);
    },
    _isAllowed(old, next, reason) {
        const allowed = VALID_TRANSITIONS[old];
        if (allowed && allowed.has(next)) return true;
        if (LOOSE_ALLOWED_SOURCES.has(old) && LOOSE_ALLOWED_TARGETS.has(next)) {
            Logger.warn('loose transition ' + old + ' → ' + next + ' (' + reason + ')');
            Telemetry.push({ type: 'loose-transition', from: old, to: next, reason });
            return true;
        }
        Logger.warn('blocked transition ' + old + ' → ' + next + ' (' + reason + ')');
        Telemetry.push({ type: 'blocked-transition', from: old, to: next, reason });
        return false;
    },

    _clearStateTimer(instance) {
        const timer = this._stateTimers.get(instance);
        if (timer) {
            clearTimeout(timer);
            this._activeTimerIds.delete(timer);
            this._stateTimers.delete(instance);
        }
    },

    _setStateTimer(instance, state) {
        this._clearStateTimer(instance);
        const cfg = STATE_CONFIG[state];
        if (!cfg || !cfg.timeout) return;
        const { ms, target } = cfg.timeout;
        const recoveryTimeout = getConfig().recovery.timeout;
        const scaledMs = Math.max(ms, recoveryTimeout * 1.5);
        const timer = setTimeout(() => {
            this._activeTimerIds.delete(timer);
            this._stateTimers.delete(instance);
            if (!instance || !instance.media) return;
            if (instance.state === MEDIA_STATE.DESTROYED) return;
            if (!instance.media.isConnected) return;
            if (instance.state === state) {
                Logger.warn('state timeout: ' + state + ' → ' + target);
                this.transition(instance, target, REASONS.STATE_TIMEOUT_PREFIX + state);
            }
        }, scaledMs);
        this._activeTimerIds.add(timer);
        this._stateTimers.set(instance, timer);
    },

    transition(instance, next, reason = 'unknown') {
        if (!instance || !instance.media) return false;
        if (instance.state === MEDIA_STATE.DESTROYED) return false;
        if (instance._transitioning) return false;
        const old = instance.state;
        if (old === next) return false;
        if (!this._isAllowed(old, next, reason)) return false;
        const guards = this._guards.get(old + '→' + next);
        if (guards) {
            for (const g of guards) {
                try { if (!g(instance, reason)) return false; }
                catch (e) { Logger.trace('guard-error', e); return false; }
            }
        }
        instance._transitioning = true;
        try {
            this._clearStateTimer(instance);
            instance.state = next;
            const record = { from: old, to: next, reason, time: Clock.wall() };
            if (!instance.historyRing)
                instance.historyRing = new RingHistory(getConfig().limits.historyLength);
            instance.historyRing.push(record);
            this._setStateTimer(instance, next);
            const hooks = this._hooks.get(next);
            if (hooks) {
                for (const h of hooks) Utils.safe(() => h(instance, record), 'state-hook');
            }
            MediaStore.notifyStateChange({ media: instance.media, instance, ...record });
            Telemetry.push({ type: 'state', from: old, to: next, reason });
            Logger.trace('state', old, '=>', next, reason);
        } finally { instance._transitioning = false; }
        return true;
    },

    cleanupInstance(instance) {
        if (instance) this._clearStateTimer(instance);
    },

    cleanupAll() {
        for (const timerId of this._activeTimerIds) clearTimeout(timerId);
        this._activeTimerIds.clear();
        this._guards.clear();
        this._hooks.clear();
    }
};

MediaStore._onRemove = (instance) => {
    if (instance) instance.state = MEDIA_STATE.DESTROYED;
    StateMachine.cleanupInstance(instance);
};

/* ═══════════════════════════════════════════════════════════
 * §14  Pause Analyzer
 * [FIX-D4] Uses shared PAUSE_CAUSES constant.
 * @provides: PauseAnalyzer
 * ═══════════════════════════════════════════════════════════ */
const PauseAnalyzer = {
    _ring: new RingHistory(DEFAULTS.limits.pauseLogLimit),
    get limit() { return getConfig().limits.pauseLogLimit; },
    record(d) { this._ring.push({ ...d, ts: Utils.now() }); },
    isAuto(cause) { return PAUSE_CAUSES.includes(cause); },
    stats() {
        return this._ring.aggregate((r, e) => {
            r[e.cause] = (r[e.cause] || 0) + 1;
            return r;
        }, {});
    },
    get log() { return this._ring.toArray(); },
    clear() { this._ring.clear(); }
};

/* ═══════════════════════════════════════════════════════════
 * §15  User Intent
 * @provides: UserIntent
 * ═══════════════════════════════════════════════════════════ */
const UserIntent = {
    lastAction: 0, lastMedia: null,
    _pauseHistory: new RingHistory(LIMITS.PAUSE_HISTORY_MAX),
    lastPauseSource: null,
    _pauseIndex: new WeakMap(),

    mark(media) { this.lastAction = Clock.wall(); this.lastMedia = media; },
    recent() { return Clock.wall() - this.lastAction < getConfig().intent.timeout; },

    recordPause(media, isUserInitiated) {
        const now = Clock.wall();
        this._pauseHistory.push({ ts: now, ref: new WeakRef(media), isUserInitiated });
        if (!this._pauseIndex.has(media)) this._pauseIndex.set(media, []);
        const arr = this._pauseIndex.get(media);
        arr.push({ ts: now, isUserInitiated });
        this._pruneArray(arr, now - getConfig().intent.multiPauseWindow);
    },

    _pruneArray(arr, cutoff) {
        if (arr.length === 0) return;
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].ts < cutoff) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) arr.splice(0, lo);
    },

    isIntentionalPause(media) {
        const cfg = getConfig().intent;
        const arr = this._pauseIndex.get(media);
        if (!arr || arr.length === 0) return false;
        const now = Clock.wall();
        this._pruneArray(arr, now - cfg.multiPauseWindow);
        if (arr.length === 0) return false;
        let count = 0;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].isUserInitiated) count++;
        }
        return count >= cfg.multiPauseCount;
    },

    extractSource(stack) {
        if (!stack) return;
        const lines = stack.split('\n');
        for (const line of lines) {
            const m = line.match(/https?:\/\/[^\s)]+/);
            if (m && !m[0].includes('aps23') && !m[0].includes('userscript') &&
                !m[0].includes('moz-extension') && !m[0].includes('chrome-extension')) {
                this.lastPauseSource = m[0];
                return;
            }
        }
    }
};

document.addEventListener('pointerdown', e => {
    UserIntent.lastAction = Clock.wall();
    const target = e.target;
    if (!target) return;
    const mediaEl = Utils.isMedia(target) ? target : target.closest?.('video, audio');
    if (mediaEl) {
        UserIntent.mark(mediaEl);
    } else if (MediaStore.size <= LIMITS.INLINE_MEDIA_THRESHOLD) {
        for (const ins of MediaStore.list()) {
            if (ins.media.contains(target)) { UserIntent.mark(ins.media); break; }
        }
    }
    if (MediaStore.size > 0) {
        for (const ins of MediaStore.list()) {
            if (ins.restoreMute !== undefined && !ins.media.paused) {
                ins.media.muted = ins.restoreMute;
                delete ins.restoreMute;
            }
        }
    }
}, true);

document.addEventListener('keydown', () => { UserIntent.lastAction = Clock.wall(); }, true);

/* ═══════════════════════════════════════════════════════════
 * §16  Intent Engine
 * [FIX-P0.1] scoreWithRect buffer isolation.
 * [FIX-C1] _factorScores accepts cfg parameter to avoid repeated getConfig().
 * @provides: IntentEngine
 * ═══════════════════════════════════════════════════════════ */
const IntentEngine = {
    momentum: new WeakMap(),
    _containerCache: new WeakMap(),
    _intersectionRatios: new WeakMap(),
    _observer: null,
    _dirty: new Set(),
    _styleQueue: new Map(),
    _styleRafScheduled: false,
    _styleResults: new WeakMap(),
    _factorScratch: { interaction: 0, visibility: 0, audio: 0, progress: 0, duration: 0, momentum: 0, container: 0 },
    _factorOut: { interaction: 0, visibility: 0, audio: 0, progress: 0, duration: 0, momentum: 0, container: 0 },

    defaultWeights: {
        interaction: 0.30, visibility: 0.18, audio: 0.12,
        progress: 0.12, duration: 0.10, momentum: 0.10, container: 0.08
    },
    _weights: null, _lastAdjust: 0,
    get weights() { return this._weights || this.defaultWeights; },
    get dirtyCount() { return this._dirty.size; },
    setAdaptiveWeights(w) { this._weights = w; },
    resetWeights() { this._weights = null; },

    markDirty(ins) {
        if (ins && ins.state !== MEDIA_STATE.DESTROYED) this._dirty.add(ins);
    },

    /* [FIX-C1] cfg threaded through */
    evaluateDirty(cfg) {
        if (this._dirty.size === 0) return false;
        const resolvedCfg = cfg || getConfig();
        let changed = false;
        for (const ins of this._dirty) {
            if (ins.state === MEDIA_STATE.DESTROYED) continue;
            if (!ins.media.isConnected) continue;
            const oldScore = ins.score;
            ins.score = this.score(ins, resolvedCfg);
            if (Math.abs(ins.score - oldScore) > CONST.SCORE_CHANGE_EPSILON) changed = true;
        }
        this._dirty.clear();
        return changed;
    },

    initObserver() {
        if (this._observer || typeof IntersectionObserver === 'undefined') return;
        this._observer = new IntersectionObserver(entries => {
            for (const e of entries) {
                this._intersectionRatios.set(e.target, e.intersectionRatio);
                const ins = MediaStore.get(e.target);
                if (ins) this.markDirty(ins);
            }
        }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    },

    observeMedia(media) {
        this.initObserver();
        if (this._observer && !this._intersectionRatios.has(media)) {
            this._intersectionRatios.set(media, 0);
            this._observer.observe(media);
            try {
                for (const r of this._observer.takeRecords()) {
                    if (r.target === media) {
                        this._intersectionRatios.set(media, r.intersectionRatio);
                        break;
                    }
                }
            } catch (e) { Logger.trace('observeMedia', e); }
        }
    },

    unobserveMedia(media) {
        this._observer?.unobserve(media);
        this._intersectionRatios.delete(media);
        this._containerCache.delete(media);
        this._styleResults.delete(media);
        this._styleQueue.delete(media);
        this.momentum.delete(media);
        const ins = MediaStore.get(media);
        if (ins) this._dirty.delete(ins);
    },

    recordPlay(ins) { this.momentum.set(ins.media, Clock.wall()); this.markDirty(ins); },

    /* [FIX-C1] cfg parameter */
    score(ins, cfg) {
        const m = ins.media;
        if (!m || !m.isConnected) return 0;
        return ScoreFunctions.composite(this.weights, this._factorScores(ins, cfg || getConfig()));
    },

    /* [FIX-P0.1] Shallow copy prevents mutation of shared _factorOut */
    scoreWithRect(ins, rect, cfg) {
        const m = ins.media;
        if (!m || !m.isConnected) return 0;
        const base = this._factorScores(ins, cfg || getConfig());
        const factors = { ...base };
        if (rect) {
            factors.visibility = (rect.width && rect.height)
                ? clamp01((rect.width * rect.height) / (innerWidth * innerHeight)) : 0;
        }
        return ScoreFunctions.composite(this.weights, factors);
    },

    _visRatio(media) {
        const ratio = this._intersectionRatios.get(media);
        if (ratio !== undefined) return ratio;
        const cfg = getConfig();
        const cacheKey = 'vis:' + (media.src || media.currentSrc || 'x');
        const cached = CacheManager.get(cacheKey);
        if (cached !== undefined) return cached;
        try {
            const r = media.getBoundingClientRect();
            const val = (r.width && r.height)
                ? clamp01((r.width * r.height) / (innerWidth * innerHeight)) : 0;
            CacheManager.set(cacheKey, val, cfg.limits.visibilityCacheTtl);
            return val;
        } catch (e) { Logger.trace('_visRatio', e); return 0; }
    },

    _hasPlayerToken(classList) {
        for (const cls of classList) {
            const lc = cls.toLowerCase();
            if (lc.includes('player') || lc.includes('video') || lc.includes('media')) return true;
        }
        return false;
    },

    _containerScore(media) {
        const cfg = getConfig();
        const cached = this._containerCache.get(media);
        if (cached && cached._ts > Clock.wall() - cfg.limits.containerCacheTtl) {
            return { score: cached.score, provisional: cached.pending };
        }
        if (cached) this._containerCache.delete(media);

        const styleResult = this._styleResults.get(media);
        if (styleResult) {
            const score = ScoreFunctions.container(styleResult.hasPlayerClass, styleResult.bestZ, styleResult.depth);
            this._containerCache.set(media, { score, _ts: Clock.wall(), pending: false });
            return { score, provisional: false };
        }

        let hasPlayerClass = false, depth = 0, playerNode = null;
        try {
            let node = media.parentElement;
            while (node && depth < LIMITS.CONTAINER_DEPTH_MAX) {
                depth++;
                if (node.classList && this._hasPlayerToken(node.classList)) {
                    hasPlayerClass = true;
                    playerNode = node;
                    break;
                }
                node = node.parentElement;
            }
        } catch (e) { Logger.trace('_containerScore walk', e); }

        if (playerNode) {
            this._enqueueStyleRead(media, playerNode, hasPlayerClass, depth);
            const score = ScoreFunctions.container(hasPlayerClass, 0, depth);
            this._containerCache.set(media, { score, _ts: Clock.wall(), pending: true });
            return { score, provisional: true };
        }

        const score = ScoreFunctions.container(false, 0, depth);
        this._containerCache.set(media, { score, _ts: Clock.wall(), pending: false });
        return { score, provisional: false };
    },

    _enqueueStyleRead(media, node, hasPlayerClass, depth) {
        if (this._styleQueue.has(media)) return;
        this._styleQueue.set(media, { node, hasPlayerClass, depth });
        if (!this._styleRafScheduled) {
            this._styleRafScheduled = true;
            requestAnimationFrame(() => {
                this._styleRafScheduled = false;
                this._processStyleQueue();
            });
        }
    },

    _processStyleQueue() {
        for (const [media, { node, hasPlayerClass, depth }] of this._styleQueue) {
            let bestZ = 0;
            try {
                const z = parseInt(getComputedStyle(node).zIndex, 10);
                if (isFinite(z) && z > bestZ) bestZ = z;
            } catch (e) { Logger.trace('_processStyleQueue', e); }
            this._styleResults.set(media, { hasPlayerClass, bestZ, depth });
            this._containerCache.delete(media);
        }
        this._styleQueue.clear();
        if (this._dirty.size > 0) ScoringPipeline.evaluateIncremental();
    },

    /* [FIX-C1] cfg parameter threaded to avoid repeated getConfig() */
    _factorScores(ins, cfg) {
        const m = ins.media, now = Clock.wall();
        const f = this._factorScratch;
        f.interaction = ScoreFunctions.interaction(
            UserIntent.lastMedia === m ? UserIntent.lastAction : 0,
            ins.lastInteraction, UserIntent.lastMedia === m, now, cfg.intent.decay);
        f.visibility = this._visRatio(m);
        f.audio = ScoreFunctions.audio(m.muted, m.volume);
        f.progress = ScoreFunctions.progress(m.currentTime, m.duration);
        f.duration = ScoreFunctions.duration(ins.created, now);
        f.momentum = ScoreFunctions.momentum(this.momentum.get(m), now);
        const containerResult = this._containerScore(m);
        f.container = containerResult.score;
        const out = this._factorOut;
        out.interaction = f.interaction;
        out.visibility = f.visibility;
        out.audio = f.audio;
        out.progress = f.progress;
        out.duration = f.duration;
        out.momentum = f.momentum;
        out.container = f.container;
        return out;
    },

    adjust(ins, success) {
        const cfg = getConfig();
        if (!cfg.intent.adaptiveWeight) return;
        const now = Clock.wall();
        if (now - this._lastAdjust < cfg.intent.adaptCooldown) return;
        this._lastAdjust = now;
        const scores = { ...this._factorScores(ins, cfg) };
        const factors = Object.keys(scores);
        const avg = factors.reduce((s, k) => s + scores[k], 0) / factors.length;
        const w = { ...this.weights };
        const lr = cfg.intent.adaptLearningRate;
        factors.forEach(k => {
            if (scores[k] > avg) {
                const d = lr * (scores[k] - avg);
                w[k] += success ? d : -d;
            }
        });
        let sum = 0;
        factors.forEach(k => {
            w[k] = clamp(w[k], cfg.intent.adaptMinWeight, cfg.intent.adaptMaxWeight);
            sum += w[k];
        });
        factors.forEach(k => { w[k] /= sum; });
        this.setAdaptiveWeights(w);
        LearningEngine.setWeights(location.hostname, w);
        Logger.log('adaptive weights updated', w);
    }
};

/* ═══════════════════════════════════════════════════════════
 * §17  Scoring Pipeline
 * [FIX-C1] cfg threaded to IntentEngine calls.
 * @provides: ScoringPipeline
 * ═══════════════════════════════════════════════════════════ */
const ScoringPipeline = {
    _rafPending: false,
    _fullEvalScheduled: false,
    _fullEvalTimer: null,

    scheduleFullEval(delay = 0) {
        if (this._fullEvalScheduled) return;
        this._fullEvalScheduled = true;
        const run = () => {
            this._fullEvalScheduled = false;
            this._fullEvalTimer = null;
            this.evaluateFull();
        };
        if (delay > 0) this._fullEvalTimer = setTimeout(run, delay);
        else requestAnimationFrame(run);
    },

    cancelScheduled() {
        if (this._fullEvalTimer) { clearTimeout(this._fullEvalTimer); this._fullEvalTimer = null; }
        this._fullEvalScheduled = false;
    },

    evaluateIncremental() {
        if (IntentEngine._dirty.size === 0) return false;
        if (this._rafPending) return true;
        this._rafPending = true;
        requestAnimationFrame(() => {
            this._rafPending = false;
            const cfg = getConfig();
            const changed = IntentEngine.evaluateDirty(cfg);
            if (changed) this._maybeSwitchActive();
        });
        return true;
    },

    evaluateFull() {
        const instances = MediaStore.list();
        const cfg = getConfig();
        let best = null, bestScore = 0;

        const needRect = [];
        const scored = [];
        for (const ins of instances) {
            if (ins.state === MEDIA_STATE.DESTROYED || ins.media.ended) continue;
            const isPausedNonRecoverable = ins.media.paused && !ins.recovering &&
                ins.state !== MEDIA_STATE.PAUSED_AUTO &&
                ins.state !== MEDIA_STATE.PAUSED_USER;
            if (isPausedNonRecoverable) { ins.score = 0; continue; }
            scored.push(ins);
            if (!ins.media.paused) {
                const ioRatio = IntentEngine._intersectionRatios.get(ins.media);
                if (ioRatio !== undefined) continue;
                if (ins.score < cfg.intent.threshold * 0.5) continue;
                needRect.push(ins);
            }
        }

        const rects = new Map();
        for (const ins of needRect) {
            try { rects.set(ins, ins.media.getBoundingClientRect()); }
            catch (e) { Logger.trace('evaluateFull rect', e); }
        }

        for (const ins of scored) {
            const rect = rects.get(ins) || null;
            const s = rect
                ? IntentEngine.scoreWithRect(ins, rect, cfg)
                : IntentEngine.score(ins, cfg);
            ins.score = s;
            if (s > bestScore) { bestScore = s; best = ins; }
        }

        IntentEngine._dirty.clear();
        this._setActive(best, bestScore);
    },

    _maybeSwitchActive() {
        const current = MediaStore.getActive();
        if (!current) { this.evaluateFull(); return; }
        let best = current, bestScore = current.score;
        for (const ins of MediaStore.list()) {
            if (ins.state === MEDIA_STATE.DESTROYED || ins.media.ended) continue;
            if (ins.score > bestScore) { bestScore = ins.score; best = ins; }
        }
        this._setActive(best, bestScore);
    },

    _setActive(best, bestScore) {
        const cfg = getConfig();
        const newId = (best && bestScore >= cfg.intent.threshold) ? best.id : null;
        const oldActive = MediaStore.getActive();
        if (newId !== (oldActive?.id ?? null)) {
            MediaStore.setActive(newId);
            ActiveMedia.history.push({
                from: oldActive?.media?.currentSrc || null,
                to: best?.media?.currentSrc || null,
                time: Clock.wall()
            });
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §18  Active Media Manager
 * @provides: ActiveMedia
 * ═══════════════════════════════════════════════════════════ */
const ActiveMedia = {
    history: new RingHistory(DEFAULTS.intent.history),
    evaluate() { ScoringPipeline.evaluateFull(); },
    isActive(media) { return MediaStore.getActive()?.media === media; }
};

/* ═══════════════════════════════════════════════════════════
 * §19  Stream Intelligence Engine
 * [FIX-P2.2] analyze returns { ok, buffer } to avoid re-read.
 * @provides: StreamState, StreamEngine
 * ═══════════════════════════════════════════════════════════ */
const StreamState = Object.freeze({
    UNKNOWN: 'unknown', NORMAL: 'normal', LOW_BUFFER: 'low_buffer',
    MSE_ERROR: 'mse_error', DRM_WAIT: 'drm_wait', NETWORK_ERROR: 'network_error'
});

const StreamEngine = {
    _streams: new WeakMap(),
    register(ins) {
        if (this._streams.has(ins.media)) return this._streams.get(ins.media);
        const stream = {
            type: 'native', state: StreamState.UNKNOWN,
            bufferAhead: 0, mse: false, hls: false, eme: false
        };
        this._streams.set(ins.media, stream);
        this.detect(ins);
        return stream;
    },
    get(media) { return this._streams.get(media) || null; },
    detect(ins) {
        const media = ins.media;
        const stream = this._streams.get(media);
        if (!stream) return;
        try {
            const src = media.currentSrc || media.src || '';
            if (src.includes('.m3u8')) stream.hls = true;
            if (src.startsWith('blob:')) stream.mse = true;
            if (typeof MediaSource !== 'undefined' && media.srcObject instanceof MediaSource)
                stream.mse = true;
        } catch (e) { Logger.trace('StreamEngine.detect', e); }
    },
    bufferAhead(media) {
        try {
            const b = media.buffered;
            for (let i = 0; i < b.length; i++) {
                if (media.currentTime >= b.start(i) && media.currentTime <= b.end(i))
                    return b.end(i) - media.currentTime;
            }
        } catch (e) { Logger.trace('bufferAhead', e); }
        return 0;
    },
    /* [FIX-P2.2] Returns buffer value to avoid re-read */
    analyze(ins) {
        let stream = this._streams.get(ins.media);
        if (!stream) stream = this.register(ins);
        const buffer = this.bufferAhead(ins.media);
        stream.bufferAhead = buffer;
        if (buffer < THRESHOLDS.MIN_BUFFER_AHEAD && !ins.media.paused) {
            stream.state = StreamState.LOW_BUFFER;
            return { ok: false, buffer };
        }
        stream.state = StreamState.NORMAL;
        return { ok: true, buffer };
    },
    isMSE(media) {
        try { if (media.srcObject instanceof MediaSource) return true; } catch (_) {}
        try { if (media.srcObject && typeof media.srcObject.addSourceBuffer === 'function') return true; } catch (_) {}
        try { return (media.currentSrc || '').startsWith('blob:'); } catch (_) {}
        return false;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §20  Buffer Predictor
 * [FIX-P2.2] predict accepts bufferOverride.
 * @provides: BufferPredictor
 * ═══════════════════════════════════════════════════════════ */
const BufferPredictor = {
    _history: new WeakMap(),
    sample(ins) {
        let ring = this._history.get(ins.media);
        if (!ring) {
            ring = new RingHistory(LIMITS.BUFFER_PREDICTOR_SAMPLES);
            this._history.set(ins.media, ring);
        }
        const buffer = StreamEngine.bufferAhead(ins.media);
        ring.push({ buffer, time: Clock.wall() });
    },
    velocity(ins) {
        const ring = this._history.get(ins.media);
        if (!ring || ring.length < 2) return 0;
        const first = ring.first(), last = ring.last();
        const dt = (last.time - first.time) / TIMING.BUFFER_VELOCITY_WINDOW;
        if (dt === 0) return 0;
        return (last.buffer - first.buffer) / dt;
    },
    /* [FIX-P2.2] Accepts pre-read buffer to avoid double traversal */
    predict(ins, bufferOverride) {
        this.sample(ins);
        const buffer = bufferOverride ?? StreamEngine.bufferAhead(ins.media);
        const speed = this.velocity(ins);
        return speed < 0 && buffer < LIMITS.BUFFER_PREDICTOR_LOW;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §20.1  Recovery Throttle
 * @provides: RecoveryThrottle
 * ═══════════════════════════════════════════════════════════ */
const RecoveryThrottle = {
    _state: new WeakMap(),
    canAttempt(media) {
        const s = this._state.get(media);
        if (!s) return true;
        const backoff = Math.min(
            THRESHOLDS.RECOVERY_THROTTLE_MAX,
            THRESHOLDS.RECOVERY_THROTTLE_BASE * Math.pow(2, s.count));
        return Clock.wall() - s.lastAttempt >= backoff;
    },
    recordAttempt(media) {
        const s = this._state.get(media) || { count: 0, lastAttempt: 0 };
        s.count++;
        s.lastAttempt = Clock.wall();
        this._state.set(media, s);
    },
    recordSuccess(media) {
        this._state.set(media, { count: 0, lastAttempt: Clock.wall() });
    },
    reset(media) { this._state.delete(media); },
    /* [NEW] Expose state for debug API */
    getState(media) { return this._state.get(media) || null; }
};

/* ═══════════════════════════════════════════════════════════
 * §21  Media Registry
 * [FIX-D2] createMediaInstance factory function.
 * [FIX-P0.5] emptied timer dedup + abort check.
 * @provides: createMediaInstance, MediaRegistry
 * ═══════════════════════════════════════════════════════════ */

/* [NEW-D2] Instance factory */
function createMediaInstance(media) {
    return {
        media, state: MEDIA_STATE.UNKNOWN, userPaused: false,
        created: Clock.wall(), lastTime: media.currentTime || 0,
        lastProgress: Clock.wall(), lastPlay: 0, lastPause: 0,
        lastInteraction: 0, score: 0,
        historyRing: new RingHistory(getConfig().limits.historyLength),
        recovering: false, restoreMute: undefined,
        _recoveryReason: null, _hlsTimer: null, _hlsActive: false,
        _hlsNoProgress: 0, _hlsLastTime: 0,
        _transitioning: false,
        _muteRestoreTimer: null,
        _emptiedTimer: null,
        recoveryLevel: 0, escalateCount: 0,
        metrics: { playCount: 0, pauseCount: 0, errorCount: 0, recoverCount: 0, escalateCount: 0 },
        id: 0, ac: new AbortController()
    };
}

const MediaRegistry = {
    refs: new Map(),
    _finalReg: new FinalizationRegistry(id => {
        const ref = MediaRegistry.refs.get(id);
        if (ref) {
            const m = ref.deref();
            if (m) MediaStore.remove(m);
            MediaRegistry.refs.delete(id);
        }
    }),

    _passesFilter(media) {
        const cfg = getConfig();
        const { blacklist, whitelist, maxManaged } = cfg.filters;
        if (MediaStore.size >= maxManaged) return false;
        const src = media.currentSrc || media.src || '';
        if (whitelist.length > 0 && !whitelist.some(p =>
            SafeRegex.test(p, src) ||
            (media.matches && Utils.safe(() => media.matches(p), 'filter-match').value)
        )) return false;
        if (blacklist.length > 0 && blacklist.some(p =>
            SafeRegex.test(p, src) ||
            (media.matches && Utils.safe(() => media.matches(p), 'filter-match').value)
        )) return false;
        return true;
    },

    add(media) {
        if (!Utils.isMedia(media) || MediaStore.get(media)) return;
        if (!this._passesFilter(media)) return;
        const instance = createMediaInstance(media);
        const id = MediaStore.add(media, instance);
        if (id === null) return;
        this.refs.set(id, new WeakRef(media));
        this._finalReg.register(media, id);
        StateMachine.transition(instance, MEDIA_STATE.IDLE, REASONS.REGISTER);
        this._bind(media, instance);
        Logger.log('media add', media.currentSrc);
    },

    remove(media) {
        const ins = MediaStore.get(media);
        if (!ins) return;
        if (ins._hlsTimer) { clearTimeout(ins._hlsTimer); ins._hlsTimer = null; }
        if (ins._muteRestoreTimer) { clearTimeout(ins._muteRestoreTimer); ins._muteRestoreTimer = null; }
        if (ins._emptiedTimer) { clearTimeout(ins._emptiedTimer); ins._emptiedTimer = null; }
        StateMachine.cleanupInstance(ins);
        RecoveryThrottle.reset(media);
        ins.ac.abort();
        MediaStore.remove(media);
    },

    get(media) { return MediaStore.get(media); },
    list() { return MediaStore.list(); },
    cleanup() {
        for (const ins of [...MediaStore.list()]) {
            if (ins.state === MEDIA_STATE.DESTROYED) continue;
            if (!ins.media.isConnected) this.remove(ins.media);
        }
    },

    _bind(media, instance) {
        const opts = { capture: true, signal: instance.ac.signal };
        const handler = (e) => this._onMediaEvent(e, media, instance);
        const events = ['play', 'playing', 'pause', 'waiting', 'stalled',
                        'ended', 'timeupdate', 'volumechange', 'emptied',
                        'error', 'pointerdown'];
        for (const evt of events) {
            media.addEventListener(evt, handler, opts);
        }
    },

    _onMediaEvent(e, media, instance) {
        if (instance.state === MEDIA_STATE.DESTROYED) return;

        switch (e.type) {
            case 'play':
                instance.lastPlay = Clock.wall();
                instance.userPaused = false;
                instance.lastProgress = Clock.wall();
                instance.metrics.playCount++;
                EventBus.emit(MEDIA_EVENTS.PLAY_STARTED, { media, instance });
                break;

            case 'playing':
                instance.lastProgress = Clock.wall();
                EventBus.emit(MEDIA_EVENTS.PLAYING, { media, instance });
                break;

            case 'pause':
                instance.lastPause = Clock.wall();
                instance.metrics.pauseCount++;
                EventBus.emit(MEDIA_EVENTS.PAUSED, { media, instance });
                break;

            case 'waiting':
                EventBus.emit(MEDIA_EVENTS.BUFFERING, { media, instance });
                break;

            case 'stalled':
                EventBus.emit(MEDIA_EVENTS.STALLED, { media, instance });
                break;

            case 'ended':
                EventBus.emit(MEDIA_EVENTS.ENDED, { media, instance });
                break;

            case 'timeupdate':
                if (Math.abs(media.currentTime - instance.lastTime) > TIMING.TIMEUPDATE_EPSILON) {
                    instance.lastTime = media.currentTime;
                    instance.lastProgress = Clock.wall();
                    EventBus.emit(MEDIA_EVENTS.PROGRESS, { media, instance });
                }
                break;

            case 'volumechange':
                EventBus.emit(MEDIA_EVENTS.VOLUME_CHANGED, { media, instance });
                break;

            case 'emptied': {
                const isMSE = StreamEngine.isMSE(media);
                const grace = isMSE
                    ? getConfig().timing.emptiedGrace * LIMITS.MSE_EMPTIED_GRACE_MULT
                    : getConfig().timing.emptiedGrace;
                /* [FIX-P0.5] Deduplicate emptied timers */
                if (instance._emptiedTimer) clearTimeout(instance._emptiedTimer);
                instance._emptiedTimer = setTimeout(() => {
                    instance._emptiedTimer = null;
                    if (instance.ac.signal.aborted) return;
                    if (instance.state === MEDIA_STATE.DESTROYED) return;
                    if (isMSE && (!media.paused || media.readyState >= 2)) return;
                    if (!media.error && !media.src && !media.currentSrc) {
                        MediaRegistry.remove(media);
                    }
                }, grace);
                break;
            }

            case 'error':
                instance.metrics.errorCount++;
                EventBus.emit(MEDIA_EVENTS.ERROR_OCCURRED, { media, instance });
                break;

            case 'pointerdown':
                instance.lastInteraction = Clock.wall();
                EventBus.emit(MEDIA_EVENTS.INTERACTION, { media, instance });
                break;
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §22  Unified Discovery
 * @provides: DOMQuery, ShadowObserver, Discovery
 * ═══════════════════════════════════════════════════════════ */

const DOMQuery = {
    find(root) {
        if (!root) return [];
        const results = [];
        try {
            const direct = root.querySelectorAll?.('video,audio');
            if (direct) for (const m of direct) results.push(m);
        } catch (e) { Logger.trace('DOMQuery.find', e); }
        return results;
    }
};

const ShadowObserver = {
    _observers: new WeakMap(),
    _visited: new WeakSet(),

    isVisited(shadowRoot) { return this._visited.has(shadowRoot); },
    markVisited(shadowRoot) { this._visited.add(shadowRoot); },

    observe(shadowRoot, onMediaAdded, onMediaRemoved) {
        if (this._observers.has(shadowRoot)) return;
        try {
            const mo = new MutationObserver(records => {
                for (const rec of records) {
                    for (const node of rec.addedNodes) {
                        if (!(node instanceof Element)) continue;
                        if (Utils.isMedia(node)) { onMediaAdded(node); continue; }
                        if (node.querySelectorAll) {
                            for (const m of node.querySelectorAll('video,audio')) onMediaAdded(m);
                        }
                        if (node.shadowRoot && !this._visited.has(node.shadowRoot)) {
                            this._visited.add(node.shadowRoot);
                            this.observe(node.shadowRoot, onMediaAdded, onMediaRemoved);
                        }
                    }
                    for (const node of rec.removedNodes) {
                        if (Utils.isMedia(node)) onMediaRemoved(node);
                    }
                }
            });
            mo.observe(shadowRoot, { childList: true, subtree: true });
            this._observers.set(shadowRoot, mo);
        } catch (e) { Logger.trace('ShadowObserver.observe', e); }
    },

    disconnect(shadowRoot) {
        const mo = this._observers.get(shadowRoot);
        if (mo) { mo.disconnect(); this._observers.delete(shadowRoot); }
        this._visited.delete(shadowRoot);
    },

    reset() {
        for (const mo of this._observers.values()) mo.disconnect();
        this._observers = new WeakMap();
        this._visited = new WeakSet();
    }
};

const Discovery = {
    find(root, depth = 0, incremental = true) {
        if (!root) return [];
        const cfg = getConfig();
        const results = DOMQuery.find(root);
        if (cfg.scanner.shadow && depth < cfg.shadow.maxDepth) {
            this._walkShadowHosts(root, depth, incremental, results);
        }
        return results;
    },

    _walkShadowHosts(root, depth, incremental, results) {
        const cfg = getConfig();
        try {
            if (typeof document.createTreeWalker !== 'function') {
                this._walkShadowHostsFallback(root, depth, incremental, results);
                return;
            }
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
                acceptNode(node) {
                    return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                }
            });
            let count = 0;
            let node = walker.nextNode();
            while (node && count < cfg.scanner.maxNodes) {
                count++;
                if (node.shadowRoot) {
                    if (incremental && ShadowObserver.isVisited(node.shadowRoot)) {
                        node = walker.nextNode(); continue;
                    }
                    ShadowObserver.markVisited(node.shadowRoot);
                    ShadowObserver.observe(node.shadowRoot,
                        m => MediaRegistry.add(m),
                        m => MediaRegistry.remove(m));
                    const nested = this.find(node.shadowRoot, depth + 1, incremental);
                    for (const m of nested) results.push(m);
                }
                node = walker.nextNode();
            }
            if (count >= cfg.scanner.maxNodes) Telemetry.perfMetrics.scanNodeHits++;
        } catch (e) {
            Logger.trace('_walkShadowHosts', e);
            this._walkShadowHostsFallback(root, depth, incremental, results);
        }
    },

    _walkShadowHostsFallback(root, depth, incremental, results) {
        const cfg = getConfig();
        const els = root.querySelectorAll?.(':defined');
        if (!els) return;
        let count = 0;
        for (const el of els) {
            if (count >= cfg.scanner.maxNodes) { Telemetry.perfMetrics.scanNodeHits++; break; }
            if (el.shadowRoot) {
                if (incremental && ShadowObserver.isVisited(el.shadowRoot)) continue;
                ShadowObserver.markVisited(el.shadowRoot);
                ShadowObserver.observe(el.shadowRoot,
                    m => MediaRegistry.add(m),
                    m => MediaRegistry.remove(m));
                const nested = this.find(el.shadowRoot, depth + 1, incremental);
                for (const m of nested) results.push(m);
            }
            count++;
        }
    },

    markVisited(shadowRoot) { ShadowObserver.markVisited(shadowRoot); },
    isVisited(shadowRoot) { return ShadowObserver.isVisited(shadowRoot); },
    disconnectShadow(shadowRoot) { ShadowObserver.disconnect(shadowRoot); },
    invalidate(shadowRoot) { ShadowObserver._visited.delete(shadowRoot); },
    invalidateAll() { ShadowObserver._visited = new WeakSet(); },
    reset() { ShadowObserver.reset(); }
};

/* ═══════════════════════════════════════════════════════════
 * §23  Media Scanner
 * @provides: MediaScanner
 * ═══════════════════════════════════════════════════════════ */
const MediaScanner = {
    running: false, queue: [], _queueSet: new Set(), _lastFullScan: 0,

    scan(root = document, force = false) {
        if (!root) return;
        const cfg = getConfig();
        if (root === document) {
            const now = Clock.wall();
            if (!force && now - this._lastFullScan < cfg.scanner.throttle) return;
            this._lastFullScan = now;
        }
        if (cfg.telemetry.enabled) Telemetry.perfMetrics.scanCount++;
        Utils.safe(() => {
            const t0 = cfg.telemetry.enabled ? Clock.mono() : 0;
            if (force) Discovery.invalidateAll();
            const list = Discovery.find(root, 0, !force);
            for (const m of list) this.enqueue(m);
            this.process();
            if (cfg.telemetry.enabled)
                Telemetry.perfMetrics.lastScanDuration = Clock.mono() - t0;
        }, 'scanner');
    },

    enqueue(media) {
        if (!Utils.isMedia(media) || this._queueSet.has(media)) return;
        this._queueSet.add(media);
        this.queue.push(media);
    },

    process() {
        if (this.running) return;
        this.running = true;
        const cfg = getConfig();
        const run = () => {
            let count = 0;
            let head = 0;
            while (head < this.queue.length && count < cfg.scanner.chunk) {
                const m = this.queue[head++];
                this._queueSet.delete(m);
                MediaRegistry.add(m);
                count++;
            }
            if (head > 0) this.queue.splice(0, head);
            if (this.queue.length) {
                if (typeof scheduler !== 'undefined' && scheduler.postTask) {
                    scheduler.postTask(() => run(), { priority: 'background', delay: cfg.scanner.delay });
                } else if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(() => run(), { timeout: cfg.scanner.delay * 5 });
                } else {
                    setTimeout(run, cfg.scanner.delay);
                }
            } else {
                this.running = false;
            }
        };
        run();
    }
};

/* ═══════════════════════════════════════════════════════════
 * §24  DOM Observer
 * [FIX-C5] Empty-subtree skip before querySelectorAll.
 * @provides: DOMObserver
 * ═══════════════════════════════════════════════════════════ */
const DOMObserver = {
    observer: null, _queue: [], _scheduled: false,

    start() {
        if (this.observer) return;
        this.observer = new MutationObserver(records => {
            for (let i = 0; i < records.length; i++) this._queue.push(records[i]);
            if (this._queue.length > TIMING.DOM_OBSERVER_QUEUE_MAX) {
                Logger.warn('DOMObserver: queue overflow, degrading to full rescan');
                this._queue.length = 0;
                if (!this._scheduled) {
                    this._scheduled = true;
                    setTimeout(() => {
                        this._scheduled = false;
                        MediaScanner.scan(document, true);
                    }, TIMING.DOM_OBSERVER_BG_DELAY);
                }
                return;
            }
            if (!this._scheduled) {
                this._scheduled = true;
                if (Utils.visible()) requestAnimationFrame(() => this._process());
                else setTimeout(() => this._process(), TIMING.DOM_OBSERVER_BG_DELAY);
            }
        });
        this.observer.observe(document.documentElement, { childList: true, subtree: true });
    },

    _process() {
        this._scheduled = false;
        const muts = this._queue;
        this._queue = [];
        let needFrame = false;
        for (const mut of muts) {
            for (const node of mut.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (AntiDetect.isInternal(node)) continue;
                this._handleAddedNode(node);
                if (node.tagName === 'IFRAME') needFrame = true;
            }
            for (const node of mut.removedNodes) {
                this._handleRemovedNode(node);
            }
        }
        if (needFrame) setTimeout(() => FrameBridge.scanIframes(), TIMING.IFRAME_SCAN_DELAY);
    },

    _handleAddedNode(node) {
        if (Utils.isMedia(node)) { MediaRegistry.add(node); return; }
        /* [FIX-C5] Skip querySelectorAll on empty subtrees */
        if (node.querySelectorAll && node.childElementCount > 0) {
            const medias = node.querySelectorAll('video,audio');
            if (medias.length < LIMITS.INLINE_MEDIA_THRESHOLD) {
                for (const m of medias) MediaRegistry.add(m);
            } else {
                MediaScanner.scan(node);
            }
        }
        if (node.shadowRoot) {
            Discovery.markVisited(node.shadowRoot);
            ShadowObserver.observe(node.shadowRoot,
                m => MediaRegistry.add(m),
                m => MediaRegistry.remove(m));
            for (const m of Discovery.find(node.shadowRoot, 1)) MediaRegistry.add(m);
        } else if (node.querySelectorAll && node.childElementCount > 0) {
            try {
                const els = node.querySelectorAll(':defined');
                let n = 0;
                for (const el of els) {
                    if (n++ > LIMITS.SHADOW_SUBTREE_WALK_MAX) break;
                    if (el.shadowRoot && !Discovery.isVisited(el.shadowRoot)) {
                        Discovery.markVisited(el.shadowRoot);
                        ShadowObserver.observe(el.shadowRoot,
                            m => MediaRegistry.add(m),
                            m => MediaRegistry.remove(m));
                        for (const m of Discovery.find(el.shadowRoot, 1)) MediaRegistry.add(m);
                    }
                }
            } catch (e) { Logger.trace('_handleAddedNode shadow', e); }
        }
    },

    _handleRemovedNode(node) {
        if (Utils.isMedia(node)) { MediaRegistry.remove(node); }
        else if (node.querySelectorAll) {
            try {
                node.querySelectorAll('video,audio').forEach(m => MediaRegistry.remove(m));
            } catch (e) { Logger.trace('_handleRemovedNode', e); }
        }
        if (node.shadowRoot) Discovery.disconnectShadow(node.shadowRoot);
        if (node.querySelectorAll) {
            try {
                const els = node.querySelectorAll(':defined');
                let n = 0;
                for (const el of els) {
                    if (n++ > LIMITS.SHADOW_SUBTREE_WALK_MAX) break;
                    if (el.shadowRoot) Discovery.disconnectShadow(el.shadowRoot);
                }
            } catch (e) { Logger.trace('_handleRemovedNode shadow', e); }
        }
    },

    stop() {
        this.observer?.disconnect();
        this.observer = null;
        this._queue.length = 0;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §25  Frame Bridge
 * [FIX-E2] targetOrigin length guard.
 * @provides: FrameBridge
 * ═══════════════════════════════════════════════════════════ */
const FrameBridge = {
    frames: new WeakSet(),
    _knownOrigins: new LRUCache(LIMITS.FRAME_BRIDGE_ORIGIN_MAX),

    init() {
        window.addEventListener('message', e => {
            const data = e.data;
            if (!data || typeof data !== 'object') return;
            if (data.__APS23 !== true) return;
            if (this._knownOrigins.size > 0 && e.origin && !this._knownOrigins.has(e.origin)) {
                Logger.trace('FrameBridge: message from unknown origin', e.origin);
                return;
            }
            if (data.type === 'media') EventBus.emit(APS_EVENTS.FRAME_MEDIA, data);
        }, true);
    },

    scanIframes() {
        if (!getConfig().scanner.iframe) return;
        Utils.safe(() => {
            document.querySelectorAll('iframe').forEach(f => this.observe(f));
        }, 'iframe-scan');
    },

    observe(frame) {
        if (this.frames.has(frame)) return;
        this.frames.add(frame);
        frame.addEventListener('load', () => this.inspect(frame), { once: true });
        this.inspect(frame);
    },

    inspect(frame) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_) {}
        if (doc) {
            Utils.safe(() => {
                for (const m of Discovery.find(doc)) MediaRegistry.add(m);
            }, 'iframe-inspect');
            return;
        }

        let targetOrigin = null;
        try {
            if (frame.src) {
                const u = new URL(frame.src, location.href);
                if (u.origin !== 'null' && u.origin !== 'file://') {
                    targetOrigin = u.origin;
                    this._knownOrigins.set(u.origin, true);
                }
            }
        } catch (e) { Logger.trace('FrameBridge.inspect:url', e); }

        if (!targetOrigin) {
            Logger.trace('FrameBridge: skipping frame with unresolvable origin');
            return;
        }

        /* [FIX-E2] Origin length guard */
        if (targetOrigin.length > CONST.TARGET_ORIGIN_MAX_LEN) {
            Logger.warn('FrameBridge: origin too long, skipping:', targetOrigin.length);
            return;
        }

        if (!/^https?:\/\/(\[[\da-fA-F:]+\]|[a-zA-Z0-9._-]+)(:\d+)?$/.test(targetOrigin)) {
            Logger.warn('FrameBridge: suspicious origin format, skipping:', targetOrigin);
            return;
        }

        try {
            frame.contentWindow.postMessage({ __APS23: true, type: 'hello' }, targetOrigin);
        } catch (e) { Logger.trace('FrameBridge.inspect:hello', e); }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §26  Site Plugin Registry + Lifecycle + DOM Utils + HotReload
 * [FIX-P2.1] Plugin list cached; only rebuilt on mutation.
 * [FIX-D5] Reject native-code functions in rules.
 * @provides: PLUGIN_BEHAVIORS, SitePluginRegistry, PluginLifecycle,
 *           PlayerDOMUtils, PluginHotReload
 * ═══════════════════════════════════════════════════════════ */

const PLUGIN_BEHAVIORS = {
    protectRate(ins) {
        ins.media.addEventListener('ratechange', () => {
            if (ins.media.playbackRate === 0) ins.media.playbackRate = 1;
        }, { capture: true, signal: ins.ac.signal });
    },
    hidePauseOverlay(selector) {
        const o = document.querySelector(selector);
        if (o) o.style.display = 'none';
    },
    clickSelector(selector) {
        document.querySelector(selector)?.click();
    }
};

const SitePluginRegistry = {
    _plugins: [],
    _active: null,
    _cache: new WeakMap(),
    _regexCache: new LRUCache(CONST.REGEX_CACHE_SIZE),
    _pluginsDirty: true,
    _builtins: [
        {
            name: 'YouTube', version: 3, match: 'youtube\\.com|youtu\\.be',
            config: { interval: 2000, retry: 5, protectRate: true },
            detect() {
                let s = 0;
                if (window.yt) s += 50;
                if (document.querySelector('.ytp-player-content,#movie_player')) s += 50;
                return s;
            },
            init(ins) { PLUGIN_BEHAVIORS.protectRate(ins); },
            onPause(ins, cause) { return cause === 'ad' ? 'allow' : 'veto'; },
            onResume() { PLUGIN_BEHAVIORS.hidePauseOverlay('.ytp-pause-overlay'); },
            recover(ins) {
                Utils.safe(() => {
                    if (ins.media.playbackRate === 0) ins.media.playbackRate = 1;
                    PLUGIN_BEHAVIORS.hidePauseOverlay('.ytp-pause-overlay');
                }, 'yt-recover');
                return Native.media.play.call(ins.media);
            },
            dispose() {}
        },
        {
            name: 'Bilibili', version: 2, match: 'bilibili\\.com|b23\\.tv',
            config: { interval: 2500, retry: 3, protectRate: true },
            detect() {
                let s = 0;
                if (document.querySelector('.bpx-player-container')) s += 80;
                if (window.player) s += 20;
                return s;
            },
            recover(ins) {
                Utils.safe(() => { PLUGIN_BEHAVIORS.clickSelector('.bilibili-player-dialog button'); }, 'bili-recover');
                return Native.media.play.call(ins.media);
            }
        },
        {
            name: 'Netflix', version: 2, match: 'netflix\\.com',
            config: { interval: 5000, retry: 2, protectRate: false },
            detect() { return document.querySelector('[data-uia="video-container"]') ? 100 : 0; },
            onPause(ins, cause) { return cause === 'idle_timer' ? 'recover' : 'veto'; },
            recover(ins) {
                Utils.safe(() => { PLUGIN_BEHAVIORS.clickSelector('[data-uia="play-button"]'); }, 'nfx-recover');
                return Native.media.play.call(ins.media);
            }
        },
        {
            name: 'Twitch', version: 1, match: 'twitch\\.tv',
            config: { interval: 2000, retry: 3, protectRate: true },
            detect() { return document.querySelector('[data-a-target="player"]') ? 100 : 0; },
            recover(ins) {
                Utils.safe(() => { PLUGIN_BEHAVIORS.clickSelector('[data-a-target="player-play-pause-button"]'); }, 'tw-recover');
                return Native.media.play.call(ins.media);
            }
        },
        {
            name: 'Coursera', version: 1, match: 'coursera\\.org',
            config: { interval: 3000, retry: 3, protectRate: true },
            detect() { return document.querySelector('[data-testid="still-watching-modal"]') ? 100 : 50; },
            onPause(ins, cause) { return cause === 'idle_timer' ? 'recover' : 'veto'; },
            recover(ins) {
                Utils.safe(() => {
                    const d = document.querySelector('[data-testid="still-watching-modal"]');
                    if (d) d.querySelector('button')?.click();
                }, 'csr-recover');
                return Native.media.play.call(ins.media);
            }
        },
        { name: 'VideoJS',  version: 1, match: '.', config: { interval: 5000, retry: 3, protectRate: true }, detect() { return window.videojs ? 90 : 0; }, recover(ins) { return Native.media.play.call(ins.media); } },
        { name: 'JWPlayer', version: 1, match: '.', config: { interval: 5000, retry: 3, protectRate: true }, detect() { return window.jwplayer ? 90 : 0; }, recover(ins) { return Native.media.play.call(ins.media); } },
        { name: 'Plyr',     version: 1, match: '.', config: { interval: 5000, retry: 3, protectRate: true }, detect() { return (window.Plyr || document.querySelector('.plyr')) ? 85 : 0; }, recover(ins) { return Native.media.play.call(ins.media); } },
        { name: 'HLS.js',   version: 1, match: '.', config: { interval: 5000, retry: 3, protectRate: true }, detect() { return window.Hls ? 70 : 0; }, recover(ins) { return Native.media.play.call(ins.media); } },
        { name: 'Shaka',    version: 1, match: '.', config: { interval: 5000, retry: 3, protectRate: true }, detect() { return window.shaka ? 80 : 0; }, recover(ins) { return Native.media.play.call(ins.media); } },
        { name: 'DASH.js',  version: 1, match: '.', config: { interval: 5000, retry: 3, protectRate: true }, detect() { return window.dashjs ? 70 : 0; }, recover(ins) { return Native.media.play.call(ins.media); } },
        { name: 'Default',  version: 1, match: '.', config: { interval: DEFAULTS.recovery.interval, retry: DEFAULTS.recovery.retry, protectRate: true }, detect() { return 1; }, recover(ins) { return Native.media.play.call(ins.media); } }
    ],

    _loadCustom() {
        let custom = [];
        Utils.safe(() => {
            const raw = localStorage.getItem(getConfig().strategy.storageKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed._schemaVersion !== PluginHotReload._SCHEMA_VERSION) {
                    Logger.warn('rules-load: schema version mismatch, migrating');
                    const migrated = PluginHotReload._migrate(parsed);
                    if (migrated) localStorage.setItem(getConfig().strategy.storageKey, JSON.stringify(migrated));
                    return;
                }
                const rules = Array.isArray(parsed) ? parsed : (parsed?.rules || []);
                custom = rules.filter(r => PluginHotReload._validateRuleShape(r));
                if (custom.length < rules.length)
                    Logger.warn('rules-load: dropped', rules.length - custom.length, 'invalid rules');
            }
        }, 'rules-load');
        return custom;
    },

    /* [FIX-P2.1] Only rebuild when dirty */
    _buildPlugins() {
        if (!this._pluginsDirty) return;
        const map = new Map();
        for (const p of this._builtins) map.set(p.name, p);
        for (const p of this._loadCustom()) {
            const ex = map.get(p.name);
            if (!ex || (p.version || 0) >= (ex.version || 0)) map.set(p.name, p);
        }
        this._plugins = [...map.values()];
        this._pluginsDirty = false;
    },

    invalidate() { this._pluginsDirty = true; },

    _getRegex(pattern) {
        const cached = this._regexCache.get(pattern);
        if (cached !== undefined) return cached;
        const re = SafeRegex.create(pattern);
        this._regexCache.set(pattern, re);
        return re;
    },

    detect() {
        this._buildPlugins();
        const target = location.hostname + location.pathname;
        this._active = null;
        for (const plugin of this._plugins) {
            try {
                const re = this._getRegex(plugin.match);
                if (re && re.test(target)) { this._active = plugin; break; }
            } catch (e) { Logger.trace('plugin detect', e); }
        }
        if (!this._active) this._active = this._plugins[this._plugins.length - 1];
        Logger.log('plugin →', this._active?.name);
    },

    get config() {
        if (!this._active) this.detect();
        return this._active.config;
    },
    get activeName() { return this._active?.name || 'unknown'; },

    detectAdapter(ins) {
        let cached = this._cache.get(ins.media);
        if (cached) return cached;
        let best = this._active, bestScore = -1;
        for (const plugin of this._plugins) {
            try {
                const s = plugin.detect();
                if (s > bestScore) { bestScore = s; best = plugin; }
            } catch (e) { Logger.trace('detectAdapter', e); }
        }
        this._cache.set(ins.media, best);
        Utils.safe(() => best.init?.(ins), 'plugin-init:' + best.name);
        Logger.log('adapter →', best.name);
        return best;
    },

    recover(ins) {
        const adapter = this.detectAdapter(ins);
        return Utils.safe(() => adapter.recover(ins), 'plugin-recover:' + adapter.name);
    }
};

const PluginLifecycle = {
    notifyPause(ins, cause) {
        const adapter = SitePluginRegistry.detectAdapter(ins);
        if (typeof adapter.onPause === 'function') {
            try { return adapter.onPause(ins, cause); }
            catch (e) { Logger.trace('onPause', e); return 'veto'; }
        }
        return 'veto';
    },
    notifyResume(ins) {
        const adapter = SitePluginRegistry.detectAdapter(ins);
        Utils.safe(() => adapter.onResume?.(ins), 'plugin-resume:' + adapter.name);
    },
    disposeAll() {
        for (const p of SitePluginRegistry._plugins) {
            Utils.safe(() => p.dispose?.(), 'plugin-dispose:' + p.name);
        }
    }
};

const PlayerDOMUtils = {
    getContainer(media) {
        if (!media) return null;
        try {
            let el = media.parentElement;
            for (let i = 0; i < LIMITS.PLAYER_CLASS_DEPTH && el; i++) {
                const cls = (el.className || '').toString().toLowerCase();
                const id = (el.id || '').toLowerCase();
                if (cls.match(/player|video-wrap|player-container|video-player/) ||
                    id.match(/player|video/)) return el;
                el = el.parentElement;
            }
        } catch (e) { Logger.trace('getContainer', e); }
        return null;
    },
    hasCustomControls(media) {
        const container = this.getContainer(media);
        if (!container) return false;
        try {
            return !!container.querySelector('[class*="control"],[class*="toolbar"],[data-control]');
        } catch (_) { return false; }
    }
};

const _RULE_DANGEROUS_PATTERNS = [
    /eval\s*\(/, /new\s+Function/, /__proto__/, /constructor\s*\[/,
    /Reflect\.construct/, /globalThis\s*\[/, /window\s*\[/,
    /\[\s*['"](?:eval|Function|constructor|__proto__|prototype)['"]\s*\]/,
    /`[^`]*\$\{/, /['"][^'"]*['"]\s*\+\s*['"]/, /String\.fromCharCode/,
    /atob\s*\(/, /Array\.prototype\.join/, /\.call\s*\(\s*this/,
    /\.apply\s*\(\s*this/, /import\s*\(/, /require\s*\(/,
    /Function\s*\(\s*['"]return/, /self\s*\[/,
    /\(\s*0\s*,\s*(?:eval|Function)/
];

const PluginHotReload = {
    _SCHEMA_VERSION: 2,
    _ALLOWED_KEYS: new Set(['name', 'match', 'version', 'config', 'detect', 'recover', 'onPause', 'onResume', 'init', 'dispose']),
    _FN_KEYS: ['detect', 'recover', 'onPause', 'onResume', 'init', 'dispose'],

    _migrate(parsed) {
        try {
            if (Array.isArray(parsed)) return { _schemaVersion: this._SCHEMA_VERSION, rules: parsed };
            if (parsed && typeof parsed === 'object') {
                parsed._schemaVersion = this._SCHEMA_VERSION;
                return parsed;
            }
        } catch (e) { Logger.trace('rules migrate', e); }
        return null;
    },

    upsert(rule, { dryRun = false } = {}) {
        if (!rule.name || !rule.match) return { ok: false, reason: 'missing name/match' };
        if (!this._validateRuleShape(rule)) return { ok: false, reason: 'validation failed' };
        if (dryRun) return { ok: true, reason: 'dry-run passed' };
        const i = SitePluginRegistry._plugins.findIndex(r => r.name === rule.name);
        if (i >= 0) SitePluginRegistry._plugins[i] = rule;
        else SitePluginRegistry._plugins.push(rule);
        SitePluginRegistry.invalidate();
        SitePluginRegistry.detect();
        return { ok: true };
    },

    _validateRuleShape(rule) {
        if (!rule || typeof rule !== 'object') return false;
        if (typeof rule.name !== 'string' || rule.name.length > THRESHOLDS.RULE_NAME_MAX) return false;
        if (typeof rule.match !== 'string' || rule.match.length > THRESHOLDS.RULE_MATCH_MAX) return false;
        for (const key of Object.keys(rule)) {
            if (!this._ALLOWED_KEYS.has(key)) return false;
        }
        if (rule.config && typeof rule.config === 'object') {
            if (rule.config.interval !== undefined &&
                (rule.config.interval < 500 || rule.config.interval > 60000)) return false;
            if (rule.config.retry !== undefined &&
                (rule.config.retry < 1 || rule.config.retry > 20)) return false;
        }
        for (const key of this._FN_KEYS) {
            if (typeof rule[key] === 'function') {
                let body;
                try { body = Function.prototype.toString.call(rule[key]); }
                catch (_) { Logger.warn('Cannot inspect fn body:', key); return false; }
                /* [FIX-D5] Reject native-code functions */
                if (body.includes('[native code]')) return false;
                if (body.length > THRESHOLDS.RULE_FN_BODY_MAX) return false;
                for (const pattern of _RULE_DANGEROUS_PATTERNS) {
                    if (pattern.test(body)) return false;
                }
            }
        }
        const src = JSON.stringify(rule);
        for (const pattern of _RULE_DANGEROUS_PATTERNS) {
            if (pattern.test(src)) return false;
        }
        if (src.length > THRESHOLDS.RULE_MAX_LENGTH) return false;
        return true;
    },

    remove(name) {
        SitePluginRegistry._plugins = SitePluginRegistry._plugins.filter(r => r.name !== name);
        SitePluginRegistry.invalidate();
        SitePluginRegistry.detect();
    },
    list() { return SitePluginRegistry._plugins.map(r => r.name); },
    persist() {
        const builtin = new Set(SitePluginRegistry._builtins.map(b => b.name));
        const custom = SitePluginRegistry._plugins.filter(r => !builtin.has(r.name));
        Utils.safe(() =>
            localStorage.setItem(getConfig().strategy.storageKey,
                JSON.stringify({ _schemaVersion: this._SCHEMA_VERSION, rules: custom })),
            'rules-save');
    },

    async import(source, { expectedHash = null, dryRun = false } = {}) {
        let rules;
        try {
            if (source.startsWith('http://') || source.startsWith('https://')) {
                const url = new URL(source);
                if (!['https:', 'http:'].includes(url.protocol)) { Logger.warn('blocked protocol'); return; }
                const trusted = LIMITS.TRUSTED_RULE_DOMAINS.some(
                    d => url.hostname === d || url.hostname.endsWith('.' + d));
                if (!trusted) { Logger.warn('Blocked untrusted rule source:', url.hostname); return; }
                const ac = new AbortController();
                const tid = setTimeout(() => ac.abort(), CONST.RULE_FETCH_TIMEOUT_MS);
                const res = await fetch(source, { signal: ac.signal });
                clearTimeout(tid);
                const text = await res.text();
                if (expectedHash) {
                    try {
                        const data = new TextEncoder().encode(text);
                        const hashBuf = await crypto.subtle.digest('SHA-256', data);
                        const hex = [...new Uint8Array(hashBuf)]
                            .map(b => b.toString(16).padStart(2, '0')).join('');
                        if (hex !== expectedHash.toLowerCase()) {
                            Logger.error('Rule import: hash mismatch', hex, '≠', expectedHash);
                            return;
                        }
                    } catch (he) { Logger.warn('Hash verification unavailable', he); }
                }
                rules = JSON.parse(text);
            } else { rules = JSON.parse(source); }
        } catch (e) { Logger.warn('rules import failed', e); return; }
        if (rules && rules._schemaVersion && Array.isArray(rules.rules)) rules = rules.rules;
        if (!Array.isArray(rules)) rules = [rules];
        for (const r of rules) this.upsert(r, { dryRun });
        if (!dryRun) this.persist();
    }
};

/* ═══════════════════════════════════════════════════════════
 * §27  Learning Engine
 * [FIX-F2] Config hot-reload listener.
 * @provides: LearningEngine
 * ═══════════════════════════════════════════════════════════ */
const LearningEngine = {
    _CURRENT_VERSION: 7,
    storage: DEFAULTS.learning.storage,
    data: {},
    _saveTimer: null,
    _lastSaved: '',
    _dirtySites: new Set(),
    _ready: false,
    _pendingOps: [],

    scheduleLoad() {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => this.load(), { timeout: 2000 });
        } else {
            setTimeout(() => this.load(), 100);
        }
    },

    load() {
        if (this._ready) return;
        try {
            this.data = JSON.parse(localStorage.getItem(this.storage)) || {};
            this._migrate();
        } catch (e) { Logger.trace('LearningEngine.load', e); this.data = {}; }
        this._ready = true;
        for (const op of this._pendingOps) op();
        this._pendingOps.length = 0;
        /* [FIX-F2] Register config hot-reload after load */
        this._registerConfigReload();
    },

    /* [NEW-F2] React to config changes for storage key */
    _registerConfigReload() {
        EventBus.on(APS_EVENTS.CONFIG_CHANGED, () => {
            const newStorage = getConfig().learning.storage;
            if (newStorage !== this.storage) {
                Logger.log('LearningEngine: storage key changed', this.storage, '→', newStorage);
                this.storage = newStorage;
            }
        });
    },

    save() {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            if (this._dirtySites.size === 0) return;
            try {
                this._prune();
                const json = JSON.stringify(this.data);
                if (json === this._lastSaved) { this._dirtySites.clear(); return; }
                this._lastSaved = json;
                localStorage.setItem(this.storage, json);
                this._dirtySites.clear();
            } catch (e) { Logger.trace('LearningEngine.save', e); }
        }, getConfig().learning.writeDebounce);
    },

    _migrate() {
        if (!this.data._meta) {
            this.data = { _meta: { version: this._CURRENT_VERSION, updated: Clock.wall() } };
            return;
        }
        const ver = this.data._meta.version || 0;
        if (ver < this._CURRENT_VERSION) {
            if (ver < 5) {
                this.data = { _meta: { version: this._CURRENT_VERSION, updated: Clock.wall() } };
                Logger.log('LearningEngine: migrated from v' + ver + ' (data reset)');
            } else {
                this.data._meta.version = this._CURRENT_VERSION;
                this.data._meta.updated = Clock.wall();
            }
        }
    },

    _prune() {
        const cfg = getConfig().learning;
        const sites = Object.keys(this.data).filter(k => k !== '_meta');
        const triggerCount = Math.ceil(cfg.maxSites * THRESHOLDS.LEARNING_PRUNE_TRIGGER);
        if (sites.length <= triggerCount) return;
        const cutoff = Clock.wall() - cfg.ttlDays * CONST.MS_PER_DAY;
        for (const s of sites) {
            if ((this.data[s]._lastAccess ?? 0) < cutoff) delete this.data[s];
        }
        const remaining = Object.keys(this.data).filter(k => k !== '_meta');
        if (remaining.length > cfg.maxSites) {
            remaining.sort((a, b) =>
                (this.data[a]._lastAccess ?? 0) - (this.data[b]._lastAccess ?? 0));
            remaining.slice(0, remaining.length - cfg.maxSites)
                .forEach(s => delete this.data[s]);
        }
    },

    record(site, reason, result) {
        if (!this._ready) { this._pendingOps.push(() => this.record(site, reason, result)); return; }
        if (!getConfig().learning.enabled) return;
        if (!this.data[site]) this.data[site] = { _lastAccess: Clock.wall() };
        if (!this.data[site][reason])
            this.data[site][reason] = { success: 0, failed: 0, lastFail: 0 };
        if (result) this.data[site][reason].success++;
        else {
            this.data[site][reason].failed++;
            this.data[site][reason].lastFail = Clock.wall();
        }
        this.data[site]._lastAccess = Clock.wall();
        this._dirtySites.add(site);
        this.save();
    },

    shouldRecover(site, reason) {
        const item = this.data?.[site]?.[reason];
        if (!item) return true;
        if (item.lastFail && Clock.wall() - item.lastFail > CONST.LEARNING_FAIL_EXPIRY_DAYS * CONST.MS_PER_DAY) {
            delete this.data[site][reason]; this.save(); return true;
        }
        return item.success >= item.failed;
    },

    recordStrategy(site, name, success) {
        if (!this._ready) { this._pendingOps.push(() => this.recordStrategy(site, name, success)); return; }
        if (!getConfig().learning.enabled) return;
        const key = 'strat:' + name;
        if (!this.data[site]) this.data[site] = { _lastAccess: Clock.wall() };
        if (!this.data[site][key]) this.data[site][key] = { success: 0, failed: 0 };
        if (success) this.data[site][key].success++;
        else this.data[site][key].failed++;
        this.data[site]._lastAccess = Clock.wall();
        this._dirtySites.add(site);
        this.save();
    },

    strategySuccessRate(site, name) {
        const item = this.data?.[site]?.['strat:' + name];
        if (!item) return CONST.NEUTRAL_CONFIDENCE;
        const total = item.success + item.failed;
        return total === 0 ? CONST.NEUTRAL_CONFIDENCE : item.success / total;
    },

    confidence(site, reason) {
        const item = this.data?.[site]?.[reason];
        if (!item) return CONST.NEUTRAL_CONFIDENCE;
        return (item.success + 1) / (item.success + item.failed + 2);
    },

    getWeights(site) { return this.data?.[site]?._weights || null; },
    setWeights(site, weights) {
        if (!getConfig().learning.enabled) return;
        if (!this.data[site]) this.data[site] = { _lastAccess: Clock.wall() };
        this.data[site]._weights = weights;
        this.data[site]._lastAccess = Clock.wall();
        this._dirtySites.add(site);
        this.save();
    },

    get dirtyCount() { return this._dirtySites.size; }
};
LearningEngine.scheduleLoad();

/* ═══════════════════════════════════════════════════════════
 * §28  Recovery Reasons + Failure Classifier + Strategy Router
 * [FIX-P0.4] CircuitBreaker.allowRequest() wired.
 * [NEW-F3] Active-instance priority boost.
 * @provides: RecoveryReason, RecoveryLevel, RecoveryPriorityMap,
 *           RecoveryBudget, enqueueRecovery, FailureClassifier, StrategyRouter
 * ═══════════════════════════════════════════════════════════ */
const RecoveryReason = Object.freeze({
    AUTO_PAUSE: 'auto_pause', STALL: 'stall', BUFFER: 'buffer',
    BACKGROUND: 'background', ERROR: 'error', DRM: 'drm',
    BUFFER_LOW: 'buffer_low', NETWORK: 'network', MSE_ERROR: 'mse_error',
    DETACHED: 'detached', UNKNOWN: 'unknown'
});

const RecoveryLevel = Object.freeze({
    SOFT: 1, BUFFER: 2, STREAM: 3, PLAYER: 4, HARD: 5
});

const RecoveryPriorityMap = Object.freeze({
    [RecoveryReason.STALL]:       10,
    [RecoveryReason.DRM]:          9,
    [RecoveryReason.ERROR]:        8,
    [RecoveryReason.NETWORK]:      7,
    [RecoveryReason.MSE_ERROR]:    7,
    [RecoveryReason.BUFFER]:       6,
    [RecoveryReason.BUFFER_LOW]:   6,
    [RecoveryReason.AUTO_PAUSE]:   5,
    [RecoveryReason.BACKGROUND]:   3,
    [RecoveryReason.UNKNOWN]:      2,
    [RecoveryReason.DETACHED]:     0
});

/* [NEW-A6] Global recovery budget throttle */
const RecoveryBudget = {
    _windowStart: 0,
    _totalAttempts: 0,

    canProceed() {
        const now = Clock.wall();
        if (now - this._windowStart > CONST.RECOVERY_BUDGET_WINDOW_MS) {
            this._windowStart = now;
            this._totalAttempts = 0;
        }
        this._totalAttempts++;
        if (this._totalAttempts > CONST.RECOVERY_BUDGET_MAX) {
            Logger.warn('RecoveryBudget: window limit reached, deferring');
            return false;
        }
        return true;
    },
    reset() { this._windowStart = 0; this._totalAttempts = 0; }
};

/* [FIX-P0.4] CircuitBreaker.allowRequest() enforced */
/* [NEW-F3] Active-instance priority boost */
function enqueueRecovery(ins, reason, priorityOverride) {
    if (!ins || !ins.media) return;
    if (ins.state === MEDIA_STATE.DESTROYED) return;
    if (ins.userPaused) return;
    if (!RecoveryThrottle.canAttempt(ins.media)) return;
    if (!CircuitBreaker.allowRequest()) return;
    /* [NEW-A6] Global budget check */
    if (!RecoveryBudget.canProceed()) return;
    if (!Object.values(RecoveryReason).includes(reason)) {
        Logger.warn('Unknown recovery reason, remapping:', reason);
        reason = RecoveryReason.UNKNOWN;
    }
    let priority = priorityOverride ?? RecoveryPriorityMap[reason] ?? 0;
    /* [NEW-F3] Boost active instance priority */
    if (MediaStore.getActive()?.media === ins.media) priority += 2;
    const dispatcher = ServiceContainer.get('recoveryDispatcher');
    if (dispatcher) dispatcher.enqueue(ins, reason, priority);
}

const FailureClassifier = {
    classify(ins) {
        const media = ins.media;
        if (ins.userPaused) return null;
        if (!media.isConnected)
            return { reason: RecoveryReason.DETACHED, level: RecoveryLevel.HARD };
        if (ins.state === MEDIA_STATE.ERROR)
            return { reason: RecoveryReason.NETWORK, level: RecoveryLevel.STREAM };
        const stream = StreamEngine.get(media);
        if (stream?.state === StreamState.MSE_ERROR)
            return { reason: RecoveryReason.MSE_ERROR, level: RecoveryLevel.STREAM };
        if (stream?.state === StreamState.DRM_WAIT)
            return { reason: RecoveryReason.DRM, level: RecoveryLevel.SOFT };
        if (ins.state === MEDIA_STATE.STALLED)
            return { reason: RecoveryReason.STALL, level: RecoveryLevel.BUFFER };
        if (stream?.state === StreamState.LOW_BUFFER)
            return { reason: RecoveryReason.BUFFER_LOW, level: RecoveryLevel.BUFFER };
        if (ins.state === MEDIA_STATE.PAUSED_AUTO)
            return { reason: RecoveryReason.AUTO_PAUSE, level: RecoveryLevel.SOFT };
        if (media.paused && !media.ended)
            return { reason: RecoveryReason.UNKNOWN, level: RecoveryLevel.SOFT };
        return null;
    }
};

const StrategyRouter = {
    route(ins, failure) {
        if (!failure)
            return { execute: false, strategy: 'none', priority: 0, reason: 'no-failure' };
        const cfg = getConfig();
        const intent = ins.score ?? 0;
        if (intent < cfg.intent.minThreshold)
            return { execute: false, strategy: 'low-intent', priority: 0, reason: 'intent-below-threshold' };
        if (ins.userPaused)
            return { execute: false, strategy: 'user-paused', priority: 0, reason: 'user-action' };
        if (failure.reason === RecoveryReason.DRM && ins.state === MEDIA_STATE.DRM) {
            const stream = StreamEngine.get(ins.media);
            if (stream?.eme && ins.media.readyState < THRESHOLDS.READY_STATE_MIN)
                return { execute: false, strategy: 'wait-drm', priority: 0, reason: 'drm-pending' };
        }
        if (failure.reason === RecoveryReason.DETACHED)
            return { execute: false, strategy: 'detached', priority: 0, reason: 'node-removed' };
        const conf = LearningEngine.confidence(location.hostname, failure.reason);
        if (conf < THRESHOLDS.LOW_CONFIDENCE_BLOCK)
            return { execute: false, strategy: 'low-confidence', priority: 0, reason: 'learning-reject' };
        const level = Math.min(
            failure.level + (ins.escalateCount > 2 ? 1 : 0), cfg.recovery.maxLevel);
        switch (level) {
            case RecoveryLevel.SOFT:   return { execute: true, strategy: 'soft-resume',     priority: 50, level, reason: failure.reason };
            case RecoveryLevel.BUFFER: return { execute: true, strategy: 'buffer-recover',  priority: 60, level, reason: failure.reason };
            case RecoveryLevel.STREAM: return { execute: true, strategy: 'stream-rebuild',  priority: 70, level, reason: failure.reason };
            case RecoveryLevel.PLAYER: return { execute: true, strategy: 'player-delegate', priority: 80, level, reason: failure.reason };
            case RecoveryLevel.HARD:   return { execute: true, strategy: 'hard-reload',     priority: 90, level, reason: failure.reason };
            default:                   return { execute: true, strategy: 'soft-resume',     priority: 50, level: RecoveryLevel.SOFT, reason: failure.reason };
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §29  Recovery Strategy Registry + Definitions
 * [FIX-P3.6] ESCALATION_MAP hoisted.
 * [NEW-D3] tryPlay helper to reduce duplication.
 * @provides: RecoveryStrategyRegistry, tryPlay, STRATEGY_DEFINITIONS, ESCALATION_MAP
 * ═══════════════════════════════════════════════════════════ */
const RecoveryStrategyRegistry = {
    _strategies: [],
    _chainCache: null,
    register(name, fn, { priority = 0, condition = null } = {}) {
        this._strategies.push({ name, fn, priority, effectivePriority: priority, condition });
        this._sort();
    },
    unregister(name) { this._strategies = this._strategies.filter(s => s.name !== name); this._chainCache = null; },
    /* [FIX-C4] Cached chain */
    chain() {
        if (!this._chainCache) this._chainCache = [...this._strategies];
        return this._chainCache;
    },
    _sort() { this._strategies.sort((a, b) => b.effectivePriority - a.effectivePriority); this._chainCache = null; },
    reweight() {
        if (!getConfig().learning.enabled) return;
        const site = location.hostname;
        for (const s of this._strategies) {
            const rate = LearningEngine.strategySuccessRate(site, s.name);
            s.effectivePriority = s.priority * (0.5 + rate);
        }
        this._sort();
        Logger.log('strategy chain reweighted', this.chain().map(s => s.name));
    },
    clearAll() { this._strategies = []; this._chainCache = null; }
};

/* [FIX-P3.6] Hoisted from _escalate closure */
const ESCALATION_MAP = Object.freeze({
    [RecoveryLevel.BUFFER]: 'buffer-recover',
    [RecoveryLevel.STREAM]: 'stream-rebuild',
    [RecoveryLevel.PLAYER]: 'player-delegate',
    [RecoveryLevel.HARD]:   'hard-reload'
});

/* [NEW-D3] Shared play helper */
async function tryPlay(ins) {
    await Native.safePlayWithFallback(ins.media, TIMING.MUTED_RESTORE_DEFAULT, ins);
    return !ins.media.paused;
}

const STRATEGY_DEFINITIONS = {
    adapter: {
        fn: async (ins) => {
            const r = SitePluginRegistry.recover(ins);
            if (!r.ok) Logger.warn('adapter recover plugin step failed', r.error);
            return tryPlay(ins);
        },
        opts: { priority: 100 }
    },
    drm: {
        fn: async (ins) => {
            try {
                await Native.media.play.call(ins.media);
                if (!ins.media.paused) return true;
                await Utils.sleep(TIMING.DRM_RETRY_DELAY);
                await Native.media.play.call(ins.media);
                return !ins.media.paused;
            } catch (_) { return false; }
        },
        opts: { priority: 90, condition: (ins, reason) => reason === RecoveryReason.DRM }
    },
    seek: {
        fn: async (ins) => {
            const m = ins.media;
            if (m.seekable.length > 0) {
                const end = m.seekable.end(m.seekable.length - 1);
                m.currentTime = Math.min(m.currentTime + TIMING.SEEK_NUDGE, end);
            }
            await Native.media.play.call(m);
            return !m.paused;
        },
        opts: { priority: 80 }
    },
    muted: {
        fn: async (ins) => {
            if (!getConfig().recovery.mutedFallback || ins.media.muted) return false;
            const old = ins.media.muted;
            try {
                ins.media.muted = true;
                await Native.media.play.call(ins.media);
                if (!ins.media.paused) { ins.restoreMute = old; return true; }
            } catch (e) { Logger.trace('muted-strategy', e); }
            finally { if (ins.media.paused) { try { ins.media.muted = old; } catch (_) {} } }
            return false;
        },
        opts: { priority: 70 }
    },
    native: {
        fn: async (ins) => {
            await Native.media.play.call(ins.media);
            return !ins.media.paused;
        },
        opts: { priority: 60 }
    },
    'soft-resume': {
        fn: async (ins) => tryPlay(ins),
        opts: { priority: 50 }
    },
    'buffer-recover': {
        fn: async (ins) => {
            try {
                const m = ins.media;
                if (m.seekable.length > 0) {
                    const end = m.seekable.end(m.seekable.length - 1);
                    m.currentTime = Math.min(m.currentTime + TIMING.SEEK_NUDGE, end);
                }
            } catch (e) { Logger.trace('buffer-recover-seek', e); }
            return tryPlay(ins);
        },
        opts: { priority: 55 }
    },
    'stream-rebuild': {
        fn: async (ins) => {
            StreamEngine.register(ins);
            StreamEngine.detect(ins);
            return tryPlay(ins);
        },
        opts: { priority: 45 }
    },
    'player-delegate': {
        fn: async (ins) => {
            SitePluginRegistry.recover(ins);
            await Utils.sleep(TIMING.PLAYER_DELEGATE_WAIT);
            if (ins.media.paused) return tryPlay(ins);
            return !ins.media.paused;
        },
        opts: { priority: 40 }
    },
    'hard-reload': {
        fn: async (ins) => {
            const media = ins.media;
            const src = media.currentSrc || media.src;
            if (!src) return false;
            media.src = '';
            media.removeAttribute('src');
            await Utils.sleep(TIMING.HARD_RELOAD_CLEAR_WAIT);
            media.src = src;
            Native.safeLoad(media);
            await Utils.sleep(TIMING.HARD_RELOAD_LOAD_WAIT);
            return tryPlay(ins);
        },
        opts: {
            priority: 30,
            condition: (ins) => !StreamEngine.isMSE(ins.media)
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §30  Recovery Planner
 * @provides: RecoveryPlanner
 * ═══════════════════════════════════════════════════════════ */
const RecoveryPlanner = {
    plan(ins, reason) {
        const cfg = getConfig();
        let base = cfg.recovery.delay;
        if (reason === RecoveryReason.BUFFER_LOW || reason === RecoveryReason.BUFFER) base = 800;
        if (reason === RecoveryReason.NETWORK || reason === RecoveryReason.ERROR) base = 1200;
        if (reason === RecoveryReason.DRM) base = 2000;
        if (reason === RecoveryReason.MSE_ERROR) base = 1000;
        if (reason === RecoveryReason.STALL) base = 600;
        const conf = LearningEngine.confidence(location.hostname, reason);
        if (conf < THRESHOLDS.VERY_LOW_CONFIDENCE) base *= 2;
        return { reason, delay: base, muteFallback: !ins.media.muted };
    }
};

/* ═══════════════════════════════════════════════════════════
 * §31  Retry Strategy
 * @provides: RetryStrategy
 * ═══════════════════════════════════════════════════════════ */
const RetryStrategy = {
    async execute(task, policy = {}, token = null) {
        const maxRetry = policy.retry || getConfig().recovery.retry;
        let lastError;
        for (let i = 0; i < maxRetry; i++) {
            if (token?.cancelled) throw new APSError('cancelled', { code: 'E_CANCELLED' });
            try { return await task(i); }
            catch (e) {
                lastError = e;
                if (token?.cancelled) throw new APSError('cancelled', { code: 'E_CANCELLED' });
                if (i < maxRetry - 1) {
                    const delay = Math.min(TIMING.RETRY_MAX_DELAY, TIMING.RETRY_BASE_MS * Math.pow(2, i));
                    await Utils.sleep(delay, token);
                }
            }
        }
        throw lastError;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §32  Recovery Dispatcher
 * [FIX-P1.3] Exponential backoff on flush depth limit.
 * @provides: RecoveryDispatcher, recoverActive, recoverAll
 * ═══════════════════════════════════════════════════════════ */
const RecoveryDispatcher = {
    _queue: new Map(),
    _inflight: new Map(),
    _flushScheduled: false,
    _flushing: false,
    _flushDepth: 0,
    _flushBackoff: CONST.FLUSH_RETRY_BASE_MS,
    _executor: null,

    isInflight(media) { return this._inflight.has(media); },

    enqueue(instance, reason, priority = 0) {
        if (!instance?.media) return;
        if (instance.state === MEDIA_STATE.DESTROYED) return;
        if (instance.userPaused) return;
        if (this._inflight.has(instance.media)) return;
        const existing = this._queue.get(instance.media);
        if (existing && existing.priority >= priority) return;
        this._queue.set(instance.media, { instance, reason, priority, ts: Clock.wall() });
        this._scheduleFlush();
    },

    _scheduleFlush() {
        if (this._flushScheduled) return;
        this._flushScheduled = true;
        queueMicrotask(() => {
            this._flushScheduled = false;
            this._flush();
        });
    },

    /* [FIX-P1.3] Exponential backoff instead of fixed 100ms */
    _flush() {
        if (this._flushing) return;
        if (this._flushDepth >= CONST.MAX_FLUSH_DEPTH) {
            Logger.warn('RecoveryDispatcher: flush depth limit, backing off', this._flushBackoff);
            const delay = this._flushBackoff;
            this._flushBackoff = Math.min(this._flushBackoff * CONST.FLUSH_BACKOFF_MULTIPLIER, CONST.FLUSH_BACKOFF_MAX_MS);
            setTimeout(() => {
                this._flushBackoff = CONST.FLUSH_RETRY_BASE_MS;
                this._flush();
            }, delay);
            return;
        }
        this._flushing = true;
        this._flushDepth++;
        try {
            if (CircuitBreaker.isOpen()) { this._queue.clear(); return; }
            if (this._queue.size === 0) return;
            if (!this._executor) { Logger.warn('RecoveryDispatcher: no executor set'); return; }

            const now = Clock.wall();
            for (const [, item] of this._queue) {
                if (now - item.ts > TIMING.PRIORITY_AGE_INTERVAL &&
                    item.priority < THRESHOLDS.MAX_AGED_PRIORITY) {
                    item.priority++;
                    item.ts = now;
                }
            }

            const items = [...this._queue.values()]
                .sort((a, b) => b.priority - a.priority || a.ts - b.ts);
            this._queue.clear();

            for (const item of items) {
                const { instance, reason, priority } = item;
                const media = instance.media;
                if (this._inflight.has(media)) continue;
                if (this._inflight.size >= LIMITS.RECOVERY_MAX_CONCURRENT) {
                    this._queue.set(media, { instance, reason, priority: item.priority, ts: item.ts });
                    continue;
                }
                const p = Utils.safeAsync(
                    () => this._executor(instance, reason),
                    'dispatch:' + reason
                ).finally(() => {
                    this._inflight.delete(media);
                    if (this._queue.size > 0) this._scheduleFlush();
                });
                this._inflight.set(media, p);
            }
        } finally {
            this._flushing = false;
            this._flushDepth--;
        }
    },

    flush() { this._flush(); },
    clear() { this._queue.clear(); },
    get size() { return this._queue.size; },
    get pending() { return this._inflight.size; }
};

function recoverActive() {
    const ins = MediaStore.getActive();
    if (ins && !ins.userPaused && ins.state !== MEDIA_STATE.DESTROYED) {
        enqueueRecovery(ins, RecoveryReason.BACKGROUND);
    }
}

function recoverAll() {
    for (const ins of MediaStore.list()) {
        if (ins.state === MEDIA_STATE.PAUSED_AUTO && !ins.userPaused &&
            !RecoveryDispatcher.isInflight(ins.media)) {
            enqueueRecovery(ins, RecoveryReason.BACKGROUND);
        }
    }
}

/* ═══════════════════════════════════════════════════════════
 * §33  Recovery Engine
 * [FIX-P3.6] Uses module-level ESCALATION_MAP.
 * @provides: RecoveryEngine
 * ═══════════════════════════════════════════════════════════ */
const RecoveryEngine = {
    recovering: new WeakSet(),
    attempts: new WeakMap(),
    _guardTimers: new WeakMap(),
    _cancelTokens: new WeakMap(),

    async recover(instance, reason = RecoveryReason.UNKNOWN) {
        const media = instance?.media;
        if (!instance || !media) return false;
        if (instance.state === MEDIA_STATE.DESTROYED) return false;
        if (instance.userPaused || media.error) return false;
        if (this.recovering.has(media)) return false;
        if (!RecoveryThrottle.canAttempt(media)) return false;

        const log = Logger.scope('recover:' + (media.currentSrc || '').slice(0, 60));

        this.recovering.add(media);
        instance.recovering = true;
        instance._recoveryReason = reason;
        instance.metrics.recoverCount++;
        RecoveryThrottle.recordAttempt(media);

        const token = new CancellationToken();
        this._cancelTokens.set(media, token);

        const cfg = getConfig();
        const guard = setTimeout(() => {
            if (this.recovering.has(media)) {
                log.warn('guard timeout – force clearing');
                token.cancel();
                this.recovering.delete(media);
                instance.recovering = false;
                instance._recoveryReason = null;
                StateMachine.transition(instance, MEDIA_STATE.PAUSED_AUTO, REASONS.RECOVER_GUARD_TIMEOUT);
            }
        }, cfg.recovery.recoveringTimeout);
        this._guardTimers.set(media, guard);

        try {
            return await this._doRecover(instance, reason, token, log);
        } finally {
            clearTimeout(guard);
            this._guardTimers.delete(media);
            this._cancelTokens.delete(media);
            this.recovering.delete(media);
            instance.recovering = false;
            instance._recoveryReason = null;
        }
    },

    cancelRecovery(media) {
        const token = this._cancelTokens.get(media);
        if (token) token.cancel();
    },

    async _doRecover(instance, reason, token, log) {
        const media = instance.media;
        const t0 = Clock.wall();
        const cfg = getConfig();

        if (token.cancelled) return false;
        if (!this._prepareRecovery(instance, reason)) return false;

        const siteConfig = SitePluginRegistry.config;
        const maxRetry = siteConfig.retry ?? cfg.recovery.retry;
        StateMachine.transition(instance, MEDIA_STATE.RECOVERING, REASONS.RECOVERY_PREFIX + reason);

        const count = (this.attempts.get(media) || 0) + 1;
        this.attempts.set(media, count);

        if (count > maxRetry) {
            const escalated = await this._escalate(instance, reason, t0, token, log);
            if (escalated) return true;
            return this._finalizeRecovery(instance, reason, false, null, false, t0);
        }

        const { success, usedStrategy, timedOut, rejected } =
            await this._executeStrategies(instance, reason, siteConfig, count, token, log);

        if (token.cancelled) return false;

        if (success) return this._finalizeRecovery(instance, reason, true, usedStrategy, false, t0);
        if (timedOut) return this._finalizeRecovery(instance, reason, false, usedStrategy, true, t0);
        if (rejected) return this._finalizeRecovery(instance, reason, false, null, false, t0);

        const escalated = await this._escalate(instance, reason, t0, token, log);
        if (escalated) return true;
        return this._finalizeRecovery(instance, reason, false, usedStrategy, false, t0);
    },

    _prepareRecovery(instance, reason) {
        const media = instance.media;
        const cfg = getConfig();
        if (media.ended) {
            if (!cfg.recovery.recoverEnded) return false;
            Utils.safe(() => {
                media.currentTime = Math.max(0, media.duration - TIMING.RECOVER_ENDED_SEEK);
            }, 'recover-ended-seek');
            StateMachine.transition(instance, MEDIA_STATE.IDLE, REASONS.RECOVER_ENDED);
        }
        if (!media.isConnected) { MediaRegistry.remove(media); return false; }
        if (!EMEGuard.canRecover(instance)) return false;
        return true;
    },

    async _executeStrategies(instance, reason, siteConfig, count, token, log) {
        const cfg = getConfig();
        let success = false, usedStrategy = null;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; token.cancel(); }, cfg.recovery.timeout);

        try {
            if (!LearningEngine.shouldRecover(location.hostname, reason)) {
                StateMachine.transition(instance, MEDIA_STATE.PAUSED_AUTO, REASONS.BLOCKED_BY_LEARNING);
                return { success: false, usedStrategy: null, timedOut: false, rejected: true };
            }

            const failure = FailureClassifier.classify(instance);
            if (failure) {
                const decision = StrategyRouter.route(instance, failure);
                if (!decision.execute) {
                    log.debug('Router rejected:', decision.strategy, decision.reason);
                    Telemetry.push({ type: 'recovery-rejected', strategy: decision.strategy, reason: decision.reason });
                    return { success: false, usedStrategy: null, timedOut: false, rejected: true };
                }
            }

            const plan = RecoveryPlanner.plan(instance, reason);
            if (plan.delay > 0) await Utils.sleep(plan.delay, token);
            if (token.cancelled)
                return { success: false, usedStrategy: null, timedOut, rejected: false };

            const chain = RecoveryStrategyRegistry.chain();
            const raceCandidates = chain.filter(s =>
                s.effectivePriority >= LIMITS.PARALLEL_RACE_PRIORITY_THRESHOLD &&
                (!s.condition || s.condition(instance, reason)));
            const serialCandidates = chain.filter(s =>
                s.effectivePriority < LIMITS.PARALLEL_RACE_PRIORITY_THRESHOLD &&
                (!s.condition || s.condition(instance, reason)));

            const attempt = async () => {
                const raceResult = await this._racePhase(raceCandidates, instance, reason, token);
                if (raceResult.success) {
                    usedStrategy = raceResult.strategy;
                    return true;
                }
                const serialResult = await this._serialPhase(serialCandidates, instance, reason, token);
                if (serialResult) {
                    usedStrategy = serialResult.strategy;
                    return true;
                }
                return false;
            };

            const chainAttempts = Math.max(1, Math.min(count, 3));
            try {
                success = await RetryStrategy.execute(attempt, { retry: chainAttempts }, token);
            } catch (e) { log.debug('chain-exhausted', e); success = false; }

            if (!success && !token.cancelled) {
                const base = siteConfig.interval ?? cfg.recovery.interval;
                const backoff = Math.min(base * Math.pow(2, count - 1), cfg.recovery.maxBackoff);
                await Utils.sleep(backoff, token);
            }
        } finally { clearTimeout(timer); }
        return { success, usedStrategy, timedOut, rejected: false };
    },

    async _racePhase(candidates, instance, reason, token) {
        if (candidates.length === 0 || token.cancelled) return { success: false, strategy: null };
        try {
            const results = await Promise.allSettled(
                candidates.map(entry =>
                    Utils.safeAsync(() => entry.fn(instance, reason), 'race:' + entry.name)
                )
            );
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status === 'fulfilled' && r.value.ok && r.value.value === true) {
                    return { success: true, strategy: candidates[i].name };
                }
            }
        } catch (e) { Logger.trace('parallel-race-error', e); }
        return { success: false, strategy: null };
    },

    async _serialPhase(candidates, instance, reason, token) {
        for (const entry of candidates) {
            if (token.cancelled) break;
            if (instance.state === MEDIA_STATE.DESTROYED) break;
            const r = await Utils.safeAsync(
                () => entry.fn(instance, reason), 'strategy:' + entry.name);
            if (r.ok && r.value === true) return { strategy: entry.name };
        }
        return null;
    },

    /* [FIX-P3.6] Uses module-level ESCALATION_MAP */
    async _escalate(instance, reason, t0, token, log) {
        const cfg = getConfig();
        let depth = 0;
        let currentLevel = instance.recoveryLevel || RecoveryLevel.SOFT;

        while (depth < LIMITS.ESCALATION_MAX_DEPTH) {
            if (token?.cancelled) return false;
            if (currentLevel >= cfg.recovery.maxLevel) {
                StateMachine.transition(instance, MEDIA_STATE.FAILED, REASONS.MAX_LEVEL_REACHED);
                return false;
            }

            const nextLevel = currentLevel + 1;
            instance.escalateCount++;
            instance.metrics.escalateCount++;
            instance.recoveryLevel = nextLevel;

            EventBus.emit(APS_EVENTS.RECOVERY_ESCALATE, {
                instance, from: currentLevel, to: nextLevel
            });

            const stratName = ESCALATION_MAP[nextLevel];
            if (!stratName) {
                StateMachine.transition(instance, MEDIA_STATE.FAILED, REASONS.NO_ESCALATION_STRATEGY);
                return false;
            }

            const def = STRATEGY_DEFINITIONS[stratName];
            if (!def) {
                StateMachine.transition(instance, MEDIA_STATE.FAILED, REASONS.MISSING_ESCALATION_DEF);
                return false;
            }

            if (def.opts?.condition && !def.opts.condition(instance, reason)) {
                StateMachine.transition(instance, MEDIA_STATE.FAILED,
                    REASONS.ESCALATION_COND_BLOCKED + stratName);
                return false;
            }

            try {
                const r = await Utils.safeAsync(
                    () => def.fn(instance, reason), 'escalate:' + stratName);
                if (r.ok && r.value === true) {
                    if (cfg.recovery.verifyDelay > 0) await Utils.sleep(cfg.recovery.verifyDelay, token);
                    if (!instance.media.paused) {
                        StateMachine.transition(instance, MEDIA_STATE.VERIFIED,
                            REASONS.ESCALATED_PREFIX + nextLevel);
                        instance.recoveryLevel = 0;
                        instance.escalateCount = 0;
                        this._finalizeRecovery(instance, reason, true, stratName, false, t0);
                        return true;
                    }
                } else {
                    log.warn('escalate failed at L' + nextLevel + ':' + stratName);
                }
            } catch (e) { log.warn('escalate-error:' + stratName, e); }

            currentLevel = nextLevel;
            depth++;
        }

        StateMachine.transition(instance, MEDIA_STATE.FAILED, REASONS.ALL_LEVELS_EXHAUSTED);
        return false;
    },

    _finalizeRecovery(instance, reason, success, usedStrategy, timedOut, t0) {
        const elapsed = Clock.wall() - t0;
        Telemetry.recordRecoveryTime(elapsed);

        if (timedOut) {
            StateMachine.transition(instance, MEDIA_STATE.PAUSED_AUTO, REASONS.RECOVERY_TIMEOUT);
            LearningEngine.record(location.hostname, reason, false);
            Telemetry.push({ type: 'recovery-fail', reason, ms: elapsed, timeout: true });
            EventBus.emit(APS_EVENTS.RECOVERY_FAILED, instance);
            return false;
        }

        if (success) {
            if (instance.state !== MEDIA_STATE.VERIFIED) {
                StateMachine.transition(instance, MEDIA_STATE.PLAYING, REASONS.RECOVERY_SUCCESS);
            }
            this.attempts.delete(instance.media);
            instance.recoveryLevel = 0;
            instance.escalateCount = 0;
            RecoveryThrottle.recordSuccess(instance.media);
            LearningEngine.record(location.hostname, reason, true);
            if (usedStrategy)
                LearningEngine.recordStrategy(location.hostname, usedStrategy, true);
            PluginLifecycle.notifyResume(instance);
            IntentEngine.adjust(instance, true);
            Telemetry.push({ type: 'recovery-ok', reason, strategy: usedStrategy, ms: elapsed });
            EventBus.emit(APS_EVENTS.RECOVERY_SUCCESS, instance);
            CircuitBreaker.recordSuccess();
        } else {
            if (instance.state !== MEDIA_STATE.FAILED) {
                StateMachine.transition(instance, MEDIA_STATE.PAUSED_AUTO, REASONS.RECOVERY_FAILED);
            }
            LearningEngine.record(location.hostname, reason, false);
            if (usedStrategy) {
                LearningEngine.recordStrategy(location.hostname, usedStrategy, false);
            } else {
                for (const s of RecoveryStrategyRegistry.chain())
                    LearningEngine.recordStrategy(location.hostname, s.name, false);
            }
            IntentEngine.adjust(instance, false);
            Telemetry.push({ type: 'recovery-fail', reason, strategy: usedStrategy, ms: elapsed });
            EventBus.emit(APS_EVENTS.RECOVERY_FAILED, instance);
        }
        return success;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §34  Watchdog
 * [FIX-P2.2] Single buffer read shared with BufferPredictor.
 * [FIX-C3] cfg parameter threading.
 * @provides: Watchdog
 * ═══════════════════════════════════════════════════════════ */
const Watchdog = {
    data: new WeakMap(),
    track(ins) {
        this.data.set(ins.media, { time: ins.media.currentTime, stamp: Clock.wall() });
    },

    /* [FIX-C3] cfg parameter */
    check(ins, cfg) {
        const resolvedCfg = cfg || getConfig();
        if (!resolvedCfg.watchdog.enabled) return;
        if (ins.state === MEDIA_STATE.DESTROYED || ins.recovering) return;
        const m = ins.media;
        if (!m.isConnected) { MediaRegistry.remove(m); return; }
        if (m.paused || m.ended) return;

        /* [FIX-P2.2] Single analyze call, pass buffer to predictor */
        const { buffer } = StreamEngine.analyze(ins);
        if (BufferPredictor.predict(ins, buffer)) {
            EventBus.emit(APS_EVENTS.BUFFER_WARNING, ins);
            if (!ins.userPaused && !RecoveryDispatcher.isInflight(m)) {
                enqueueRecovery(ins, RecoveryReason.BUFFER_LOW);
            }
        }

        const d = this.data.get(m);
        if (!d) { this.track(ins); return; }
        const moved = Math.abs(m.currentTime - d.time) > resolvedCfg.watchdog.epsilon;
        if (moved) { this.track(ins); return; }

        if (m.readyState >= THRESHOLDS.READY_STATE_HAVE_FUTURE &&
            buffer > THRESHOLDS.WATCHDOG_BUFFER_SAFE) {
            this.track(ins);
            return;
        }

        if (Clock.wall() - d.stamp > resolvedCfg.watchdog.timeout) {
            StateMachine.transition(ins, MEDIA_STATE.STALLED, REASONS.WATCHDOG);
            enqueueRecovery(ins, RecoveryReason.STALL);
            this.track(ins);
        }
    },

    /* [FIX-C3] cfg resolved once at sweep level */
    sweepAll() {
        const cfg = getConfig();
        const active = MediaStore.getActive();
        if (active && !active.media.paused && !active.userPaused) {
            this.check(active, cfg);
        }
        for (const ins of MediaStore.list()) {
            if (ins === active) continue;
            if (ins.state === MEDIA_STATE.DESTROYED) continue;
            if (ins.media.paused || ins.media.ended) continue;
            if (ins.userPaused) continue;
            this.check(ins, cfg);
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §35  HLS / MSE Shield
 * [FIX-B7] try/catch in scheduled run.
 * @provides: HLSShield
 * ═══════════════════════════════════════════════════════════ */
const HLSShield = {
    isMSE(media) { return StreamEngine.isMSE(media); },

    attach(instance) {
        const cfg = getConfig();
        const media = instance.media;
        if (!cfg.hls.enabled || !this.isMSE(media) || instance._hlsActive) return;
        instance._hlsActive = true;
        instance._hlsNoProgress = 0;
        instance._hlsLastTime = media.currentTime;
        instance.ac.signal.addEventListener('abort',
            () => this.detach(instance), { once: true });
        this._schedule(instance);
    },
    detach(instance) {
        instance._hlsActive = false;
        if (instance._hlsTimer) { clearTimeout(instance._hlsTimer); instance._hlsTimer = null; }
    },
    resetProgress(instance) {
        instance._hlsNoProgress = 0;
        instance._hlsLastTime = instance.media.currentTime;
    },

    buffer(media) { return StreamEngine.bufferAhead(media); },

    /* [FIX-B7] try/catch in run to prevent silent timer loss */
    _schedule(instance) {
        const cfg = getConfig();
        const media = instance.media;
        const run = () => {
            if (!instance._hlsActive || instance.state === MEDIA_STATE.DESTROYED) return;
            if (instance._hlsNoProgress >= LIMITS.HLS_MAX_SCHEDULE_COUNT) {
                Logger.warn('HLS shield: no-progress limit reached, detaching');
                this.detach(instance);
                return;
            }
            if (!media.isConnected || media.ended) { this.detach(instance); return; }
            try {
                this.check(instance);
            } catch (e) {
                Logger.trace('HLS shield check error', e);
            }
            if (!instance._hlsActive) return;
            let delay = cfg.hls.checkInterval;
            if (!Utils.visible() && cfg.perf.adaptive)
                delay *= cfg.perf.backgroundMultiplier;
            instance._hlsTimer = setTimeout(run, delay);
        };
        instance._hlsTimer = setTimeout(run, cfg.hls.checkInterval);
    },

    check(instance) {
        const cfg = getConfig();
        const media = instance.media;
        if (media.paused || media.ended || !media.isConnected) { this.detach(instance); return; }
        if (instance.userPaused) return;

        const prevTime = instance._hlsLastTime ?? 0;
        const advanced = media.currentTime > prevTime + TIMING.TIMEUPDATE_EPSILON;
        instance._hlsLastTime = media.currentTime;

        if (!media.paused && advanced) {
            instance._hlsNoProgress = 0;
        } else {
            instance._hlsNoProgress++;
        }

        if (this.buffer(media) < cfg.hls.bufferThreshold &&
            media.readyState < THRESHOLDS.READY_STATE_HAVE_FUTURE) {
            enqueueRecovery(instance, RecoveryReason.BUFFER);
        }
        try {
            if (media.srcObject instanceof MediaSource &&
                media.srcObject.readyState === 'ended') {
                media.currentTime += cfg.hls.nudge;
            }
        } catch (e) { Logger.trace('HLS nudge', e); }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §36  EME Guard
 * @provides: EMEGuard
 * ═══════════════════════════════════════════════════════════ */
const EMEGuard = {
    drm: new WeakSet(),
    _patched: false,
    _originalUpdate: null,

    bind(instance) {
        const cfg = getConfig();
        const media = instance.media;
        if (!cfg.eme.enabled || this.drm.has(media)) return;
        this.drm.add(media);
        const opts = { capture: true, signal: instance.ac.signal };
        media.addEventListener('encrypted', () => {
            if (instance.state === MEDIA_STATE.DESTROYED) return;
            const stream = StreamEngine.get(media);
            if (stream) { stream.state = StreamState.DRM_WAIT; stream.eme = true; }
            StateMachine.transition(instance, MEDIA_STATE.DRM, REASONS.ENCRYPTED);
        }, opts);
        media.addEventListener('waitingforkey', () => {
            if (instance.state === MEDIA_STATE.DESTROYED) return;
            StateMachine.transition(instance, MEDIA_STATE.DRM, REASONS.WAITING_KEY);
        }, opts);
        media.addEventListener('keyadded', () => {
            if (instance.state === MEDIA_STATE.DESTROYED) return;
            if (media.paused && !instance.userPaused)
                enqueueRecovery(instance, RecoveryReason.DRM);
        }, opts);
        this._patchMediaKeySession();
    },

    _patchMediaKeySession() {
        if (this._patched) return;
        if (typeof MediaKeySession === 'undefined') return;
        this._patched = true;
        try {
            this._originalUpdate = MediaKeySession.prototype.update;
            const self = this;
            MediaKeySession.prototype.update = async function (...args) {
                const result = await self._originalUpdate.apply(this, args);
                EventBus.emit(APS_EVENTS.DRM_UPDATE, this);
                return result;
            };
        } catch (e) { Logger.trace('EME patch', e); }
    },

    unpatch() {
        if (this._patched && this._originalUpdate) {
            try { MediaKeySession.prototype.update = this._originalUpdate; }
            catch (e) { Logger.trace('EME unpatch', e); }
            this._originalUpdate = null;
            this._patched = false;
        }
    },

    canRecover(instance) {
        if (instance.state !== MEDIA_STATE.DRM) return true;
        return instance.media.readyState >= THRESHOLDS.READY_STATE_MIN;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §37  MSE Monitor
 * [FIX] Closure-based orig reference.
 * @provides: MSEMonitor
 * ═══════════════════════════════════════════════════════════ */
const MSEMonitor = {
    installed: false,
    _originalAddSourceBuffer: null,

    install() {
        if (this.installed || !getConfig().stream.mse) return;
        if (typeof MediaSource === 'undefined') return;
        this.installed = true;
        try {
            this._originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
            const orig = this._originalAddSourceBuffer;
            MediaSource.prototype.addSourceBuffer = function (...args) {
                const buffer = orig.apply(this, args);
                EventBus.emit(APS_EVENTS.MSE_BUFFER_CREATED, { mediaSource: this, buffer });
                return buffer;
            };
        } catch (e) { Logger.warn('MSE patch failed', e); }
    },

    uninstall() {
        if (this.installed && this._originalAddSourceBuffer) {
            try { MediaSource.prototype.addSourceBuffer = this._originalAddSourceBuffer; }
            catch (e) { Logger.trace('MSE unpatch', e); }
            this._originalAddSourceBuffer = null;
            this.installed = false;
        }
    }
};

/* ═══════════════════════════════════════════════════════════
 * §38  PageBridge Layer 1
 * [FIX-P1.4] install() returns Promise<boolean>.
 * [FIX-B5] _scheduleRetry blob Promise .catch.
 * NOTE: Injected bridge code uses Symbol.for (requires ES6).
 * @provides: PageBridge
 * ═══════════════════════════════════════════════════════════ */

const _BRIDGE_TEMPLATE = `
/* APS23 L1 Bridge v__PROTO_VER__ — requires ES6 Symbol support */
(function(CFG) {
var ID = CFG.id;
var SYM_ORIG = Symbol.for('APS23_BRIDGE_ORIGINALS');
var SYM_DESTROY = Symbol.for('APS23_BRIDGE_DESTROY');

function emit(t, d) {
    try { window.dispatchEvent(new CustomEvent(ID + '_up', { detail: { type: t, data: d, ver: CFG.protoVer } })); } catch (e) {}
}
var veto = new WeakSet();
window.addEventListener(ID + '_down', function (e) {
    var d = e.detail || {};
    if (d.action === 'veto' && d.el) veto.add(d.el);
    if (d.action === 'unveto' && d.el) veto.delete(d.el);
}, true);
var recentEvent = { type: '', ts: 0 };
var EVENT_MAP = { visibilitychange: 'visibility', blur: 'focus', focusout: 'focus', pagehide: 'visibility', freeze: 'visibility' };
Object.keys(EVENT_MAP).forEach(function (t) {
    document.addEventListener(t, function () { recentEvent.type = EVENT_MAP[t]; recentEvent.ts = Date.now(); }, true);
});
['click', 'pointerdown', 'mousedown', 'keydown', 'touchstart'].forEach(function (t) {
    document.addEventListener(t, function () { recentEvent.type = 'user'; recentEvent.ts = Date.now(); }, true);
});
var STACK_PATTERNS = [
    [/visibilitychange|document\\.hidden|visibilitystate/i, 'visibility'],
    [/blur|focusout|hasfocus/i, 'focus'],
    [/click|pointerdown|mousedown|keydown|touchstart/i, 'user'],
    [/ads|advert|ima|vast/i, 'ad'],
    [/autoplay|policy/i, 'autoplay_policy'],
    [/timer|timeout|interval|idle|inactivity|still.watching/i, 'idle_timer']
];
function classifyPause(stack) {
    if (Date.now() - recentEvent.ts < CFG.userEventWindow && recentEvent.type) return recentEvent.type;
    if (stack) {
        for (var i = 0; i < STACK_PATTERNS.length; i++) {
            if (STACK_PATTERNS[i][0].test(stack)) return STACK_PATTERNS[i][1];
        }
    }
    return 'site_logic';
}

var _p = HTMLMediaElement.prototype.pause;
var _pStr = _p.toString();
try {
    HTMLMediaElement.prototype.pause = function () {
        var stack = '';
        try { stack = new Error().stack || ''; } catch (e) {}
        var cause = classifyPause(stack);
        if (CFG.veto && cause !== 'user' && veto.has(this)) {
            emit('pause_blocked', { src: this.currentSrc || this.src || '' });
            return;
        }
        emit('pause', { src: this.currentSrc || this.src || '', time: this.currentTime, cause: cause, stack: stack.substring(0, CFG.stackMax) });
        return _p.call(this);
    };
    HTMLMediaElement.prototype.pause.toString = function () { return _pStr; };
} catch (e) {}

var _hGet = null, _vGet = null;
if (CFG.fakeVis) {
    try {
        var _h = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
        _hGet = (_h && typeof _h.get === 'function') ? _h.get : null;
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: function () {
                var v = _hGet ? _hGet.call(this) : false;
                if (v) emit('hidden_read', {});
                return false;
            }
        });
    } catch (e) {}
    try {
        var _v = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        _vGet = (_v && typeof _v.get === 'function') ? _v.get : null;
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: function () {
                var v = _vGet ? _vGet.call(this) : 'visible';
                if (v === 'hidden') emit('vis_read', {});
                return 'visible';
            }
        });
    } catch (e) {}
}

var _hf = Document.prototype.hasFocus;
var _hfStr = (typeof _hf === 'function') ? _hf.toString() : '';
if (CFG.fakeFocus) {
    try {
        document.hasFocus = function () {
            var r = (typeof _hf === 'function') ? _hf.call(this) : true;
            if (!r) emit('focus_read', {});
            return true;
        };
        document.hasFocus.toString = function () { return _hfStr; };
    } catch (e) {}
}

window[SYM_ORIG] = { pause: _p, hiddenGet: _hGet, visGet: _vGet, hasFocus: _hf };
window[SYM_DESTROY] = function () {
    try { HTMLMediaElement.prototype.pause = _p; } catch (e) {}
    try {
        if (_hGet) Object.defineProperty(document, 'hidden', { get: _hGet, configurable: true });
        else Object.defineProperty(document, 'hidden', { value: false, configurable: true, writable: true });
    } catch (e) {}
    try {
        if (_vGet) Object.defineProperty(document, 'visibilityState', { get: _vGet, configurable: true });
        else Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
    } catch (e) {}
    try { if (_hf) document.hasFocus = _hf; } catch (e) {}
    try { delete window[SYM_ORIG]; } catch (e) {}
    try { delete window[SYM_DESTROY]; } catch (e) {}
};

emit('ready', { ver: CFG.protoVer });
})(__CFG_JSON__);
`;

const PageBridge = {
    injected: false, degraded: false,
    id: Utils.randomId(),
    _compiledSource: null,
    _retryTimer: null,

    _getSource() {
        if (this._compiledSource) return this._compiledSource;
        const cfg = getConfig();
        const cfgJson = JSON.stringify({
            id: this.id, veto: !!cfg.bridge.veto,
            fakeVis: !!cfg.shield.fakeVisibility, fakeFocus: !!cfg.shield.fakeFocus,
            stackMax: THRESHOLDS.STACK_SUBSTRING_MAX,
            protoVer: LIMITS.BRIDGE_PROTOCOL_VERSION,
            userEventWindow: TIMING.USER_EVENT_WINDOW
        }).replace(/</g, '\\u003c');
        this._compiledSource = _BRIDGE_TEMPLATE
            .replace('__PROTO_VER__', String(LIMITS.BRIDGE_PROTOCOL_VERSION))
            .replace('__CFG_JSON__', cfgJson);
        return this._compiledSource;
    },

    /* [FIX-P1.4] Returns Promise<boolean> */
    async install() {
        const cfg = getConfig();
        if (!cfg.bridge.enabled || this.injected) return this.injected;
        const code = this._getSource();
        if (this._tryInline(code)) return true;
        if (cfg.bridge.cspFallback) {
            const ok = await this._tryBlob(code);
            if (ok) return true;
            this.degraded = true;
            Logger.warn('Bridge blob injection failed – scheduling retry');
            this._scheduleRetry(code);
            return false;
        }
        this.degraded = true;
        Logger.warn('Bridge injection failed (CSP?) – scheduling retry');
        this._scheduleRetry(code);
        return false;
    },

    _getNonce() {
        try {
            const s = document.querySelector('script[nonce]');
            return s?.nonce || '';
        } catch (_) { return ''; }
    },

    _tryInline(code) {
        return Utils.safe(() => {
            const host = document.head || document.documentElement;
            if (!host) return false;
            const s = document.createElement('script');
            s.textContent = code;
            const nonce = this._getNonce();
            if (nonce) s.nonce = nonce;
            AntiDetect.mark(s);
            host.appendChild(s);
            s.remove();
            this.injected = true;
            return true;
        }, 'bridge-inline').value === true;
    },

    _tryBlob(code) {
        return new Promise((resolve) => {
            const r = Utils.safe(() => {
                const b = new Blob([code], { type: 'application/javascript' });
                const url = URL.createObjectURL(b);
                const s = document.createElement('script');
                s.src = url;
                AntiDetect.mark(s);
                s.onload = () => {
                    this.injected = true;
                    URL.revokeObjectURL(url);
                    s.remove();
                    resolve(true);
                };
                s.onerror = () => {
                    URL.revokeObjectURL(url);
                    s.remove();
                    resolve(false);
                };
                (document.head || document.documentElement).appendChild(s);
            }, 'bridge-blob');
            if (!r.ok) resolve(false);
        });
    },

    /* [FIX-B5] .catch on blob retry Promise */
    _scheduleRetry(code) {
        if (this._retryTimer) return;
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            if (this.injected) return;
            if (this._tryInline(code)) { this.degraded = false; return; }
            this._tryBlob(code).then(ok => {
                if (ok) {
                    this.degraded = false;
                    Logger.log('Bridge injection succeeded on retry');
                }
            }).catch(e => {
                Logger.trace('bridge-retry-blob-error', e);
            });
        }, TIMING.BRIDGE_RETRY_DELAY);
    },

    listen(handler) {
        window.addEventListener(this.id + '_up', e => handler(e.detail), true);
    },
    send(action, el) {
        Utils.safe(() =>
            window.dispatchEvent(new CustomEvent(this.id + '_down', { detail: { action, el } })),
            'bridge-send');
    },
    veto(m)   { if (getConfig().bridge.veto) this.send('veto', m); },
    unveto(m) { this.send('unveto', m); },

    destroy() {
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        try {
            const destroy = window[Symbol.for('APS23_BRIDGE_DESTROY')];
            if (typeof destroy === 'function') destroy();
        } catch (_) {}
    }
};

/* ═══════════════════════════════════════════════════════════
 * §39  Bridge Handler
 * @provides: setupBridge
 * ═══════════════════════════════════════════════════════════ */
function setupBridge() {
    if (!getConfig().bridge.enabled) return;
    PageBridge.listen(msg => {
        if (msg.ver !== undefined && msg.ver !== LIMITS.BRIDGE_PROTOCOL_VERSION) {
            Logger.warn('Bridge protocol version mismatch:', msg.ver);
        }
        switch (msg.type) {
            case 'ready':
                Logger.log('L1 ready (proto v' + (msg.data?.ver || msg.ver || '?') + ')');
                break;
            case 'pause': {
                PauseAnalyzer.record(msg.data);
                UserIntent.extractSource(msg.data.stack);
                Telemetry.push({ type: 'pause', cause: msg.data.cause, src: msg.data.src });
                if (!PauseAnalyzer.isAuto(msg.data.cause)) break;
                const src = msg.data.src;
                for (const ins of MediaStore.list()) {
                    if (ins.state === MEDIA_STATE.DESTROYED) continue;
                    if ((ins.media.currentSrc || ins.media.src || '') !== src) continue;
                    if (ins.userPaused) break;
                    const decision = PluginLifecycle.notifyPause(ins, msg.data.cause);
                    if (decision === 'allow') break;
                    StateMachine.transition(ins, MEDIA_STATE.PAUSED_AUTO,
                        REASONS.BRIDGE_PREFIX + msg.data.cause);
                    if (decision !== 'veto-only') {
                        enqueueRecovery(ins, RecoveryReason.AUTO_PAUSE);
                    }
                    break;
                }
                break;
            }
            case 'pause_blocked':
                Logger.trace('vetoed:', msg.data?.src);
                break;
            case 'hidden_read': case 'vis_read': case 'focus_read':
                Logger.trace('L1 shield:', msg.type);
                break;
        }
    });
}

/* ═══════════════════════════════════════════════════════════
 * §40  Visibility Shield
 * @provides: VisibilityShield
 * ═══════════════════════════════════════════════════════════ */
const VisibilityShield = {
    enabled: false,
    _visHandler: null, _freezeHandler: null, _focusHandler: null, _blurHandler: null,
    _hiddenSince: 0,

    init() {
        const cfg = getConfig();
        if (!cfg.shield.visibility || this.enabled) return;
        this.enabled = true;
        const mode = cfg.shield.stopPropagation;
        this._visHandler = (e) => {
            Utils.invalidateVisibility();
            RuntimeState.visible = Utils.visible();
            if (RuntimeState.visible) {
                if (this._hiddenSince > 0 &&
                    Clock.wall() - this._hiddenSince > TIMING.LONG_HIDDEN_THRESHOLD) {
                    BackgroundShield.onLongHiddenReturn();
                }
                this._hiddenSince = 0;
                MediaStore.emitPageEvent(APS_EVENTS.PAGE_VISIBLE, {});
                Scheduler.onVisibilityReturn();
                setTimeout(recoverActive, TIMING.VISIBILITY_RECOVER_DELAY);
            } else {
                this._hiddenSince = Clock.wall();
                if (mode === 'aggressive' && e) e.stopImmediatePropagation();
                MediaStore.emitPageEvent(APS_EVENTS.PAGE_HIDDEN, {});
            }
        };
        document.addEventListener('visibilitychange', this._visHandler, true);
        this._freezeHandler = (e) => {
            if (mode === 'aggressive' && e) e.stopImmediatePropagation();
        };
        ['freeze', 'pagehide'].forEach(t =>
            document.addEventListener(t, this._freezeHandler, true));
        if (cfg.shield.focus) {
            this._focusHandler = () => {
                Utils.invalidateVisibility();
                RuntimeState.visible = true;
                MediaStore.emitPageEvent(APS_EVENTS.PAGE_FOCUS, {});
            };
            window.addEventListener('focus', this._focusHandler, true);
            this._blurHandler = (e) => {
                Utils.invalidateVisibility();
                RuntimeState.visible = false;
                if (mode === 'aggressive' && !Utils.visible() && e) e.stopImmediatePropagation();
                MediaStore.emitPageEvent(APS_EVENTS.PAGE_BLUR, {});
            };
            window.addEventListener('blur', this._blurHandler, true);
        }
    },
    destroy() {
        if (this._visHandler)
            document.removeEventListener('visibilitychange', this._visHandler, true);
        if (this._freezeHandler)
            ['freeze', 'pagehide'].forEach(t =>
                document.removeEventListener(t, this._freezeHandler, true));
        if (this._focusHandler)
            window.removeEventListener('focus', this._focusHandler, true);
        if (this._blurHandler)
            window.removeEventListener('blur', this._blurHandler, true);
        this._visHandler = this._freezeHandler = this._focusHandler = this._blurHandler = null;
        this.enabled = false;
    }
};

/* ═══════════════════════════════════════════════════════════
 * §41  Background Shield
 * [FIX-P3.4] _audioTimedOut flag.
 * [FIX-B6] Idempotent lock resolve guard.
 * @provides: BackgroundShield
 * ═══════════════════════════════════════════════════════════ */
const BackgroundShield = {
    worker: null, audioCtx: null, osc: null, lockResolve: null, active: false,
    _workerUrl: null,
    _lockInterval: null,
    _lockSafetyTimer: null,
    _resumeHandler: null,
    _resumeEvents: ['click', 'touchstart', 'pointerdown'],
    _audioTimeout: null,
    _audioTimedOut: false,
    _lastWorkerFlush: 0,
    _fallbackTimer: null,
    _lockResolved: false,

    start() {
        const cfg = getConfig();
        if (!cfg.background.enabled || this.active) return;
        this.active = true;
        if (cfg.background.worker) this._startWorker();
        if (cfg.background.silentAudio) this._startSilentAudio();
        if (cfg.background.navigatorLock) this._acquireLock();
        Logger.log('Background shield active');
    },

    stop() {
        this.active = false;
        if (this.worker) {
            this.worker.postMessage('stop');
            this.worker.terminate();
            this.worker = null;
            if (this._workerUrl) { URL.revokeObjectURL(this._workerUrl); this._workerUrl = null; }
        }
        if (this._fallbackTimer) { clearInterval(this._fallbackTimer); this._fallbackTimer = null; }
        if (this.osc) { Utils.safe(() => this.osc.stop(), 'osc-stop'); this.osc = null; }
        if (this.audioCtx) { Utils.safe(() => this.audioCtx.close(), 'ctx-close'); this.audioCtx = null; }
        this._removeResumeListeners();
        if (this._lockInterval) { clearInterval(this._lockInterval); this._lockInterval = null; }
        if (this.lockResolve && !this._lockResolved) {
            this._lockResolved = true;
            this.lockResolve();
            this.lockResolve = null;
        }
        if (this._lockSafetyTimer) { clearTimeout(this._lockSafetyTimer); this._lockSafetyTimer = null; }
        if (this._audioTimeout) { clearTimeout(this._audioTimeout); this._audioTimeout = null; }
    },

    onLongHiddenReturn() {
        if (!this.active) return;
        if (this._audioTimedOut) {
            Logger.log('BackgroundShield: rebuilding AudioContext after timeout');
            this._audioTimedOut = false;
            this.audioCtx = null;
            this.osc = null;
            this._startSilentAudio();
        } else if (this.audioCtx && this.audioCtx.state === 'closed') {
            this.audioCtx = null;
            this.osc = null;
            this._startSilentAudio();
        }
    },

    _removeResumeListeners() {
        if (this._resumeHandler) {
            for (const t of this._resumeEvents)
                document.removeEventListener(t, this._resumeHandler, true);
            this._resumeHandler = null;
        }
    },

    _workerTick() {
        const now = Clock.wall();
        if (now - this._lastWorkerFlush < TIMING.WORKER_FLUSH_THROTTLE) return;
        this._lastWorkerFlush = now;
        for (const ins of MediaStore.list()) {
            if (ins.state === MEDIA_STATE.DESTROYED) continue;
            if (ins.media.paused && !ins.userPaused &&
                ins.media.readyState >= THRESHOLDS.READY_STATE_MIN &&
                !RecoveryDispatcher.isInflight(ins.media)) {
                enqueueRecovery(ins, RecoveryReason.BACKGROUND);
            }
        }
        RecoveryDispatcher.flush();
    },

    _startWorker() {
        const cfg = getConfig();
        Utils.safe(() => {
            const ping = Math.max(THRESHOLDS.WORKER_PING_MIN,
                Math.min(THRESHOLDS.WORKER_PING_MAX, cfg.background.workerPing | 0));
            const code = 'let timer=null;self.onmessage=e=>{if(e.data==="start")timer=setInterval(()=>postMessage("tick"),' +
                ping + ');if(e.data==="stop")clearInterval(timer);};';
            const blob = new Blob([code], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            this._workerUrl = url;
            try {
                this.worker = new Worker(url);
            } catch (e) {
                Logger.warn('Worker blocked (CSP?), falling back to setInterval');
                URL.revokeObjectURL(url);
                this._workerUrl = null;
                this._fallbackTimer = setInterval(() => this._workerTick(), ping);
                return;
            }
            this.worker.onmessage = () => this._workerTick();
            this.worker.postMessage('start');
        }, 'bg-worker');
    },

    _startSilentAudio() {
        Utils.safe(() => {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { Logger.trace('AudioContext API unavailable'); return; }
            let ctx;
            try { ctx = new AC(); }
            catch (e) { Logger.trace('AudioContext creation failed', e); return; }
            this.audioCtx = ctx;
            if (ctx.state !== 'suspended') { this._initAudioOsc(ctx); return; }
            const resume = () => {
                ctx.resume().then(() => this._initAudioOsc(ctx)).catch(() => {});
                this._removeResumeListeners();
                if (this._audioTimeout) { clearTimeout(this._audioTimeout); this._audioTimeout = null; }
            };
            this._resumeHandler = resume;
            for (const t of this._resumeEvents)
                document.addEventListener(t, resume, { once: true, capture: true });
            this._audioTimeout = setTimeout(() => {
                this._removeResumeListeners();
                this._audioTimeout = null;
                Utils.safe(() => ctx.close(), 'audio-timeout-close');
                this.audioCtx = null;
                this._audioTimedOut = true;
                Logger.log('Silent audio: timeout, AudioContext closed');
            }, TIMING.AUDIO_RESUME_TIMEOUT);
        }, 'bg-audio');
    },

    _initAudioOsc(ctx) {
        if (!this.active) return;
        this.osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = LIMITS.SILENT_AUDIO_GAIN;
        this.osc.connect(gain);
        gain.connect(ctx.destination);
        this.osc.start();
    },

    _acquireLock() {
        this._lockResolved = false;
        Utils.safeAsync(async () => {
            if (!navigator.locks) return;
            const hasRecoverable = () => MediaStore.list().some(i =>
                i.state !== MEDIA_STATE.DESTROYED && !i.media.ended && !i.media.error);
            await navigator.locks.request(Utils.randomId() + '_keepalive', { mode: 'shared' }, () =>
                new Promise(resolve => {
                    this.lockResolve = resolve;
                    const safeResolve = () => {
                        if (this._lockResolved) return;
                        this._lockResolved = true;
                        resolve();
                        this.lockResolve = null;
                    };
                    const check = () => {
                        if (!this.active || !hasRecoverable()) {
                            clearInterval(this._lockInterval);
                            this._lockInterval = null;
                            if (this._lockSafetyTimer) {
                                clearTimeout(this._lockSafetyTimer);
                                this._lockSafetyTimer = null;
                            }
                            safeResolve();
                        }
                    };
                    this._lockInterval = setInterval(check, CONST.LOCK_CHECK_INTERVAL);
                    this._lockSafetyTimer = setTimeout(() => {
                        clearInterval(this._lockInterval);
                        this._lockInterval = null;
                        safeResolve();
                    }, TIMING.LOCK_MAX_HOLD);
                }));
        }, 'bg-lock');
    }
};

/* ═══════════════════════════════════════════════════════════
 * §42  WakeLock Manager
 * @provides: WakeLockManager
 * ═══════════════════════════════════════════════════════════ */
const WakeLockManager = {
    lock: null,
    _visListener: null,
    _monitorTimer: null,

    async request() {
        if (!getConfig().background.lock || !navigator.wakeLock || this.lock) return;
        try {
            this.lock = await navigator.wakeLock.request('screen');
            this.lock.addEventListener('release', () => {
                this.lock = null;
                if (Utils.visible() && MediaStore.size > 0) {
                    setTimeout(() => this.request(), TIMING.WAKELOCK_DEBOUNCE);
                }
            });
        } catch (e) {
            this.lock = null;
            Logger.trace('wakeLock request denied', e);
        }
    },
    release() {
        if (this.lock) { Utils.safe(() => this.lock.release(), 'wake-release'); this.lock = null; }
    },
    initVisibilityListener() {
        if (this._visListener) return;
        this._visListener = () => {
            if (document.hidden) this.release();
            else this.monitor();
        };
        document.addEventListener('visibilitychange', this._visListener, true);
    },
    destroyVisibilityListener() {
        if (this._visListener) {
            document.removeEventListener('visibilitychange', this._visListener, true);
            this._visListener = null;
        }
        if (this._monitorTimer) { clearTimeout(this._monitorTimer); this._monitorTimer = null; }
    },
    monitor() {
        if (this._monitorTimer) clearTimeout(this._monitorTimer);
        this._monitorTimer = setTimeout(() => {
            this._monitorTimer = null;
            const hasRecoverable = MediaStore.list().some(i =>
                i.state !== MEDIA_STATE.DESTROYED && !i.media.ended && !i.media.error);
            if (hasRecoverable && Utils.visible()) this.request();
            else this.release();
        }, TIMING.WAKELOCK_DEBOUNCE);
    }
};

/* ═══════════════════════════════════════════════════════════
 * §43  MediaSession Adapter
 * @provides: MediaSessionAdapter
 * ═══════════════════════════════════════════════════════════ */
const MediaSessionAdapter = {
    _current: null,
    _resolveTitle(media) {
        try {
            return media.closest('[class*="player"]')?.getAttribute('aria-label') ||
                document.querySelector('h1')?.textContent?.trim() || document.title || 'Media';
        } catch (_) { return document.title || 'Media'; }
    },
    update(instance) {
        if (!getConfig().mediaSession || !navigator.mediaSession) return;
        if (instance === this._current) return;
        this._current = instance;
        if (!instance || !instance.media) {
            Utils.safe(() => {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.playbackState = 'none';
                ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a =>
                    navigator.mediaSession.setActionHandler(a, null));
            }, 'session-clear');
            return;
        }
        const media = instance.media;
        Utils.safe(() => {
            if ('MediaMetadata' in window) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: this._resolveTitle(media), artist: location.hostname,
                    artwork: media.poster ? [{ src: media.poster }] : []
                });
            }
            navigator.mediaSession.playbackState = media.paused ? 'paused' : 'playing';
            navigator.mediaSession.setActionHandler('play', () => {
                instance.userPaused = false;
                enqueueRecovery(instance, RecoveryReason.BACKGROUND);
                RecoveryDispatcher.flush();
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                instance.userPaused = true;
                Native.media.pause.call(media);
            });
            navigator.mediaSession.setActionHandler('seekbackward', () => {
                if (media.duration && isFinite(media.duration))
                    media.currentTime = Math.max(0, media.currentTime - CONST.MEDIA_SESSION_SEEK_STEP);
            });
            navigator.mediaSession.setActionHandler('seekforward', () => {
                if (media.duration && isFinite(media.duration))
                    media.currentTime = Math.min(media.duration, media.currentTime + CONST.MEDIA_SESSION_SEEK_STEP);
            });
            navigator.mediaSession.setActionHandler('seekto', d => {
                if (d.seekTime != null && media.duration && isFinite(media.duration))
                    media.currentTime = Math.min(media.duration, d.seekTime);
            });
        }, 'session-update');
    },
    syncPosition(instance) {
        if (!getConfig().mediaSession || !navigator.mediaSession) return;
        const media = instance.media;
        Utils.safe(() => {
            if (media.duration && isFinite(media.duration)) {
                navigator.mediaSession.setPositionState({
                    duration: media.duration, playbackRate: media.playbackRate,
                    position: Math.min(media.currentTime, media.duration)
                });
            }
        }, 'pos-state');
    }
};

/* ═══════════════════════════════════════════════════════════
 * §44  PlaybackRate Guard
 * @provides: PlaybackRateGuard
 * ═══════════════════════════════════════════════════════════ */
const PlaybackRateGuard = {
    bind(instance) {
        instance.media.addEventListener('ratechange', () => {
            if (instance.state === MEDIA_STATE.DESTROYED) return;
            if (getConfig().shield.rate && SitePluginRegistry.config.protectRate !== false) {
                if (instance.media.playbackRate <= 0) instance.media.playbackRate = 1;
            }
        }, { capture: true, signal: instance.ac.signal });
    }
};

/* ═══════════════════════════════════════════════════════════
 * §45  Overlay / Scroll Cleaner
 * @provides: OverlayCleaner
 * ═══════════════════════════════════════════════════════════ */
const OverlayCleaner = {
    clean() {
        if (!getConfig().utility.hideOverlay) return;
        Utils.safe(() => {
            const sel = '[class="popup"],[class*="modal"],[class*="overlay"],[class*="mask"],[id*="popup"],[id*="modal"]';
            const wl = ['.player', '.video-player', '.controls', '.subtitle', '[data-control]'];
            document.querySelectorAll(sel).forEach(el => {
                if (wl.some(s => { try { return el.closest(s); } catch (_) { return false; } })) return;
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) return;
                const a = (r.width * r.height) / (innerWidth * innerHeight);
                if (a > LIMITS.OVERLAY_AREA_MIN && a < LIMITS.OVERLAY_AREA_MAX)
                    el.style.setProperty('visibility', 'hidden', 'important');
            });
        }, 'overlay');
    },
    unlockScroll() {
        if (!getConfig().utility.unlockScroll || !document.body) return;
        [document.body, document.documentElement].forEach(el => {
            if (el.style.overflow === 'hidden') el.style.removeProperty('overflow');
        });
    }
};

/* ═══════════════════════════════════════════════════════════
 * §46  Performance Monitor + Resource Controller
 * @provides: PerformanceMonitor, ResourceController
 * ═══════════════════════════════════════════════════════════ */
const PerformanceMonitor = {
    samples: new RingHistory(CONST.PERF_SAMPLE_SIZE),
    start() {
        Scheduler.register('perf-monitor', () => this.measure(), CONST.PERF_MONITOR_INTERVAL, 1, { backgroundSkip: true });
    },
    measure() {
        const fps = PerfState.fps;
        this.samples.push(fps);
        const { sum, count } = this.samples.aggregate(
            (acc, v) => ({ sum: acc.sum + v, count: acc.count + 1 }),
            { sum: 0, count: 0 }
        );
        const avg = count > 0 ? sum / count : 60;
        if (avg < THRESHOLDS.FPS_HIGH_LOAD) PerfState.cpu = 'high';
        else if (avg < THRESHOLDS.FPS_MEDIUM_LOAD) PerfState.cpu = 'medium';
        else PerfState.cpu = 'normal';
        EventBus.emit(APS_EVENTS.PERFORMANCE, { fps: avg, cpu: PerfState.cpu });
    }
};

const ResourceController = {
    init() {
        EventBus.on(APS_EVENTS.PERFORMANCE, data => {
            if (data.cpu === 'high') Scheduler.scale = THRESHOLDS.SCHEDULER_SCALE_HIGH;
            else if (data.cpu === 'medium') Scheduler.scale = THRESHOLDS.SCHEDULER_SCALE_MEDIUM;
            else Scheduler.scale = THRESHOLDS.SCHEDULER_SCALE_NORMAL;
        });
    }
};

/* ═══════════════════════════════════════════════════════════
 * §47  Health Monitor
 * @provides: HealthMonitor
 * ═══════════════════════════════════════════════════════════ */
const HealthMonitor = {
    check() { return RuntimeMonitor.report(); },
    start() {
        Scheduler.register('health', () => {
            const stats = this.check();
            EventBus.emit(APS_EVENTS.HEALTH, stats);
        }, getConfig().health.interval, 1, { backgroundSkip: true });

        EventBus.on(APS_EVENTS.HEALTH, stats => {
            Telemetry.push({
                type: 'health',
                fps: stats.fps, cpu: stats.cpu,
                mediaCount: stats.mediaCount,
                errors: stats.errors, lifecycle: stats.lifecycle
            });
        });
    }
};

/* ═══════════════════════════════════════════════════════════
 * §48  Runtime Monitor
 * @provides: RuntimeMonitor
 * ═══════════════════════════════════════════════════════════ */
const RuntimeMonitor = {
    stats: { registered: 0, recoveries: 0, success: 0, failed: 0, errors: 0, escalations: 0 },

    init() {
        MediaStore.subscribe(APS_EVENTS.INSTANCE_ADDED, () => {
            this.stats.registered++;
        }, { scope: 'internal', priority: 10 });
        MediaStore.subscribe(APS_EVENTS.STATE_CHANGE, (e) => {
            if (e.to === MEDIA_STATE.RECOVERING) this.stats.recoveries++;
            if ((e.to === MEDIA_STATE.PLAYING || e.to === MEDIA_STATE.VERIFIED) &&
                (e.reason === REASONS.RECOVERY_SUCCESS || e.reason.startsWith(REASONS.ESCALATED_PREFIX))) {
                this.stats.success++;
            }
            if (e.reason === REASONS.RECOVERY_FAILED || e.reason === REASONS.RECOVERY_TIMEOUT ||
                e.reason === REASONS.ALL_LEVELS_EXHAUSTED || e.reason === REASONS.MAX_LEVEL_REACHED) {
                this.stats.failed++;
            }
        }, { scope: 'internal', priority: 10 });
        EventBus.on(APS_EVENTS.RECOVERY_ESCALATE, () => { this.stats.escalations++; });
    },

    report() {
        const active = MediaStore.getActive();
        let mem = 0;
        try { mem = performance.memory ? performance.memory.usedJSHeapSize : 0; } catch (_) {}
        return {
            ...this.stats,
            version: APS.version,
            lifecycle: APS.lifecycle,
            modules: ModuleRegistry.status,
            services: ServiceContainer.names,
            mediaCount: MediaStore.size,
            active: active?.media.currentSrc || null,
            visible: RuntimeState.visible,
            online: RuntimeState.online,
            fps: PerfState.fps,
            cpu: PerfState.cpu,
            cpuLoad: PerfState.cpuLoad,
            adapter: active ? SitePluginRegistry.detectAdapter(active).name : null,
            strategy: SitePluginRegistry.activeName,
            bridge: PageBridge.injected,
            bridgeDegraded: PageBridge.degraded,
            circuitOpen: RuntimeState.circuitOpen,
            circuitState: CircuitBreaker._state,
            dispatchQueue: RecoveryDispatcher.size,
            dispatchPending: RecoveryDispatcher.pending,
            telemetryBuffer: Telemetry.buffer.length,
            perfMetrics: Telemetry.metrics(),
            schedulerScale: Scheduler.scale,
            clockDrift: Clock.drift(),
            memory: mem,
            learningDirty: LearningEngine.dirtyCount
        };
    }
};

/* ═══════════════════════════════════════════════════════════
 * §49  Lifecycle
 * [FIX-A7] Per-phase timeout guard.
 * [FIX-P3.7] GlobalResources.destroyAll in Phase 9.
 * @provides: Lifecycle
 * ═══════════════════════════════════════════════════════════ */
const Lifecycle = {
    _pageshowHandler: null,
    _focusHandler: null,
    _onlineHandler: null,
    _offlineHandler: null,
    _resumeHandler: null,
    _errorHandler: null,
    _rejectionHandler: null,

    destroy() {
        if (APS.destroyed) return;
        APS.destroyed = true;
        APS.lifecycle = APS_LIFECYCLE.STOPPED;

        const t0 = Clock.wall();
        const TIMEOUT = CONST.DESTROY_TIMEOUT_MS;

        const phase = (name, fn) => {
            if (Clock.wall() - t0 > TIMEOUT) {
                Logger.error('Lifecycle destroy timeout at phase: ' + name + ' – force cleanup');
                try { MediaStore.fullReset(); } catch (_) {}
                try { EventBus.clear(); } catch (_) {}
                try { delete window.__APS23; } catch (_) {}
                Logger.info('APS23 destroyed (forced)');
                return false;
            }
            try { fn(); } catch (e) { Logger.warn('Lifecycle phase error: ' + name, e); }
            return true;
        };

        /* Phase 1: Stop scheduling and observation */
        if (!phase('stop-scheduling', () => {
            Scheduler.stop();
            CircuitBreaker.reset();
            GlobalResources.remove(Scheduler);
            DOMObserver.stop();
            ScoringPipeline.cancelScheduled();
        })) return;

        /* Phase 2: Cancel in-flight recoveries */
        if (!phase('cancel-recoveries', () => {
            for (const ins of MediaStore.list()) {
                RecoveryEngine.cancelRecovery(ins.media);
            }
            RecoveryDispatcher.clear();
        })) return;

        /* Phase 3: Stop background services */
        if (!phase('stop-background', () => {
            BackgroundShield.stop();
            WakeLockManager.release();
            WakeLockManager.destroyVisibilityListener();
            VisibilityShield.destroy();
        })) return;

        /* Phase 4: Dispose modules and services */
        if (!phase('dispose-modules', () => {
            ModuleRegistry.disposeAll();
            PluginLifecycle.disposeAll();
            /* Note: ServiceContainer.dispose is async but we call synchronously here;
               remaining async cleanup happens in Phase 9 */
            try { ServiceContainer.dispose(); } catch (_) {}
        })) return;

        /* Phase 5: Unpatch native APIs */
        if (!phase('unpatch', () => {
            EMEGuard.unpatch();
            MSEMonitor.uninstall();
            PageBridge.destroy();
        })) return;

        /* Phase 6: Per-instance cleanup */
        if (!phase('instance-cleanup', () => {
            for (const ins of MediaStore.list()) {
                IntentEngine.unobserveMedia(ins.media);
                StateMachine.cleanupInstance(ins);
                ins.ac.abort();
            }
            IntentEngine._observer?.disconnect();
            Discovery.reset();
            StateMachine.cleanupAll();
        })) return;

        /* Phase 7: Clear state */
        if (!phase('clear-state', () => {
            PauseAnalyzer.clear();
            Telemetry.clear();
            RuntimeState.invalidateAll();
        })) return;

        /* Phase 8: Remove global listeners */
        if (!phase('remove-listeners', () => {
            if (this._pageshowHandler)
                window.removeEventListener('pageshow', this._pageshowHandler, true);
            if (this._focusHandler)
                window.removeEventListener('focus', this._focusHandler, true);
            if (this._onlineHandler)
                window.removeEventListener('online', this._onlineHandler, true);
            if (this._offlineHandler)
                window.removeEventListener('offline', this._offlineHandler, true);
            if (this._resumeHandler)
                document.removeEventListener('resume', this._resumeHandler, true);
            if (this._errorHandler)
                window.removeEventListener('error', this._errorHandler, true);
            if (this._rejectionHandler)
                window.removeEventListener('unhandledrejection', this._rejectionHandler, true);
        })) return;

        /* Phase 9: Final cleanup */
        phase('final-cleanup', () => {
            MediaStore.fullReset();
            EventBus.clear();
            GlobalResources.destroyAll();
            try { delete window.__APS23; } catch (e) { Logger.trace('delete __APS23', e); }
        });

        Logger.info('APS23 destroyed');
    }
};

/* ═══════════════════════════════════════════════════════════
 * §50  Global Error Isolation
 * @provides: setupErrorIsolate
 * ═══════════════════════════════════════════════════════════ */
function setupErrorIsolate() {
    Lifecycle._errorHandler = (e) => {
        RuntimeState.errors++;
        const rm = ServiceContainer.get('runtimeMonitor');
        if (rm?.stats) rm.stats.errors++;
        CircuitBreaker.record();
        if (getConfig().debug) Logger.error('error', e.message);
    };
    window.addEventListener('error', Lifecycle._errorHandler, true);

    Lifecycle._rejectionHandler = (e) => {
        RuntimeState.errors++;
        const rm = ServiceContainer.get('runtimeMonitor');
        if (rm?.stats) rm.stats.errors++;
        CircuitBreaker.record();
        if (getConfig().debug) Logger.error('promise', e.reason);
    };
    window.addEventListener('unhandledrejection', Lifecycle._rejectionHandler, true);
}

/* ═══════════════════════════════════════════════════════════
 * §51  Debug Console API
 * Diagnostic queries and runtime controls.
 * [NEW]      4 additional entries: recoveryBudget, moduleHealth,
 *            taskStats, assertEnabled.
 * @provides: mountDebugAPI
 * ═══════════════════════════════════════════════════════════ */
function mountDebugAPI() {
    if (!getConfig().debug) return;

    const debugQueries = {
        lifecycle()       { return APS.lifecycle; },
        modules()         { return ModuleRegistry.status; },
        services()        { return ServiceContainer.names; },
        media() {
            return MediaStore.list().map(i => ({
                src: i.media.currentSrc, state: i.state, score: i.score,
                time: i.media.currentTime, duration: i.media.duration,
                history: i.historyRing ? i.historyRing.toArray() : [],
                metrics: i.metrics,
                recoveryLevel: i.recoveryLevel, escalateCount: i.escalateCount,
                stream: StreamEngine.get(i.media)
            }));
        },
        active() {
            const a = MediaStore.getActive();
            return a ? { src: a.media.currentSrc, state: a.state, score: a.score, metrics: a.metrics } : null;
        },
        adapter() {
            const a = MediaStore.getActive();
            return a ? SitePluginRegistry.detectAdapter(a).name : null;
        },
        strategy()        { return SitePluginRegistry.activeName; },
        stats()           { return RuntimeMonitor.report(); },
        learning()        { return LearningEngine.data; },
        pauseLog()        { return PauseAnalyzer.log; },
        pauseStats()      { return PauseAnalyzer.stats(); },
        bridge() {
            return { injected: PageBridge.injected, degraded: PageBridge.degraded,
                     protocol: LIMITS.BRIDGE_PROTOCOL_VERSION };
        },
        visible()         { return RuntimeState.visible; },
        online()          { return RuntimeState.online; },
        wakeLock()        { return !!WakeLockManager.lock; },
        telemetry()       { return Telemetry.dump(); },
        telemetryExport(format) { return Telemetry.export(format); },
        perfMetrics()     { return Telemetry.metrics(); },
        adaptiveWeights() { return IntentEngine.weights; },
        dispatchQueue()   { return RecoveryDispatcher.size; },
        dispatchPending() { return RecoveryDispatcher.pending; },
        hlsInfo() {
            return MediaStore.list()
                .filter(i => HLSShield.isMSE(i.media))
                .map(i => ({
                    src: i.media.currentSrc,
                    bufferAhead: HLSShield.buffer(i.media).toFixed(2) + 's',
                    noProgress: i._hlsNoProgress
                }));
        },
        strategyChain() {
            return RecoveryStrategyRegistry.chain().map(s => ({
                name: s.name, priority: s.priority, effectivePriority: s.effectivePriority
            }));
        },
        clockDrift()      { return { drift: Clock.drift(), offset: Clock._offset }; },
        cacheSize()       { return CacheManager.size; },
        circuitState()    { return CircuitBreaker._state; },

        /* ── Extended diagnostics ────────────────────────────── */
        bootLayers() {
            const { layers, cyclic } = ModuleRegistry.topoLayers();
            return { layers, cyclic };
        },
        lastPauseSource() { return UserIntent.lastPauseSource; },
        dirtyCount()      { return IntentEngine.dirtyCount; },
        priorityBoostedTasks() {
            const result = [];
            for (const [, t] of Scheduler.tasks) {
                if (t.critical) result.push({ id: t.id, priority: t.priority, nextRun: t.nextRun });
            }
            return result;
        },
        idleTasks() {
            const result = [];
            for (const [, t] of Scheduler.tasks) {
                if (t.foregroundSkip) result.push({ id: t.id, interval: t.interval });
            }
            return result;
        },
        containerScoreDetail(media) {
            const m = typeof media === 'string'
                ? MediaStore.list().find(i => i.media.currentSrc === media)?.media
                : media;
            if (!m) return null;
            const cached = IntentEngine._containerCache.get(m);
            const styleResult = IntentEngine._styleResults.get(m);
            return {
                cached: cached ? { score: cached.score, pending: cached.pending, ts: cached._ts } : null,
                styleResult: styleResult || null,
                hasPlayerClass: styleResult?.hasPlayerClass ?? false,
                bestZ: styleResult?.bestZ ?? 0,
                depth: styleResult?.depth ?? 0
            };
        },
        playerContainer(media) {
            const m = typeof media === 'string'
                ? MediaStore.list().find(i => i.media.currentSrc === media)?.media
                : media;
            if (!m) return null;
            const container = PlayerDOMUtils.getContainer(m);
            if (!container) return null;
            return {
                tagName: container.tagName,
                id: container.id || null,
                className: container.className || null,
                zIndex: getComputedStyle(container).zIndex
            };
        },
        hasCustomControls(media) {
            const m = typeof media === 'string'
                ? MediaStore.list().find(i => i.media.currentSrc === media)?.media
                : media;
            if (!m) return false;
            return PlayerDOMUtils.hasCustomControls(m);
        },
        bufferPrediction(media) {
            const m = typeof media === 'string'
                ? MediaStore.list().find(i => i.media.currentSrc === media)?.media
                : media;
            if (!m) return null;
            const ins = MediaStore.get(m);
            if (!ins) return null;
            const buffer = StreamEngine.bufferAhead(m);
            const velocity = BufferPredictor.velocity(ins);
            const willStall = BufferPredictor.predict(ins, buffer);
            return { buffer: buffer.toFixed(2) + 's', velocity: velocity.toFixed(3) + ' B/s', willStall };
        },
        configDirtyPaths()  { return ConfigStore.dirtyPaths; },
        recoveryThrottle(media) {
            const m = typeof media === 'string'
                ? MediaStore.list().find(i => i.media.currentSrc === media)?.media
                : media;
            if (!m) return null;
            return RecoveryThrottle.getState(m);
        },
        activeStateTimers() { return StateMachine._activeTimerIds.size; },

        /* ── Recovery diagnostics ───────────────────────────────────── */
        recoveryBudget() {
            return {
                windowStart: RecoveryBudget._windowStart,
                totalAttempts: RecoveryBudget._totalAttempts,
                maxPerWindow: CONST.RECOVERY_BUDGET_MAX,
                windowMs: CONST.RECOVERY_BUDGET_WINDOW_MS,
                remaining: Math.max(0, CONST.RECOVERY_BUDGET_MAX - RecoveryBudget._totalAttempts)
            };
        },
        moduleHealth()      { return ModuleRegistry.verifyAll(); },
        taskStats()         { return Telemetry.perfMetrics.taskStats; },
        assertEnabled()     { return Assert._enabled; }
    };

    const debugControls = {
        recover()           { recoverAll(); RecoveryDispatcher.flush(); },
        scan()              { MediaScanner.scan(); FrameBridge.scanIframes(); },
        forceScan()         { MediaScanner.scan(document, true); FrameBridge.scanIframes(); return 'Forced full rescan'; },
        reweightStrategies(){ RecoveryStrategyRegistry.reweight(); return 'Strategy chain reweighted'; },
        resetAdaptiveWeights() {
            IntentEngine.resetWeights();
            LearningEngine.setWeights(location.hostname, null);
            return 'Adaptive weights reset';
        },
        clearUserPause() {
            for (const i of MediaStore.list()) {
                i.userPaused = false;
                if (i.state === MEDIA_STATE.PAUSED_USER)
                    StateMachine.transition(i, MEDIA_STATE.IDLE, REASONS.CLEAR_USER_PAUSE);
            }
        },
        clearTelemetry()    { Telemetry.clear(); },
        rebuildStrategyChain() { CompositionRoot._registerStrategies(); return 'Strategy chain rebuilt'; },
        resyncClock()       { Clock.resync(); return 'Clock resynced, drift: ' + Clock.drift().toFixed(1) + 'ms'; },
        cancelRecovery(src) {
            let count = 0;
            for (const ins of MediaStore.list()) {
                if (!src || ins.media.currentSrc === src) {
                    RecoveryEngine.cancelRecovery(ins.media);
                    count++;
                }
            }
            return count + ' recoveries cancelled';
        },
        pruneCache() {
            RuntimeState.pruneCaches();
            return 'Cache pruned, size: ' + RuntimeState.cacheSize;
        },
        resetConfigPath(path) {
            ConfigStore.resetPath(path);
            Scheduler.invalidateCfg();
            return 'Config path "' + path + '" reset to default';
        },
        resetCircuitBreaker() { CircuitBreaker.reset(); return 'Circuit breaker reset'; },
        destroy()             { Lifecycle.destroy(); },

        /* ── Extended diagnostics ────────────────────────────── */
        resetShadowCache() {
            Discovery.reset();
            return 'Shadow DOM cache reset';
        },
        flushDirty() {
            const changed = IntentEngine.evaluateDirty(getConfig());
            return 'Dirty eval: ' + (changed ? 'score changed' : 'no change') + ', dirty=' + IntentEngine.dirtyCount;
        },

        /* ── Recovery diagnostics ───────────────────────────────────── */
        resetRecoveryBudget() {
            RecoveryBudget.reset();
            return 'Recovery budget reset';
        },
        pauseTask(id) {
            Scheduler.pauseTask(id);
            return 'Task "' + id + '" paused';
        },
        resumeTask(id) {
            Scheduler.resumeTask(id);
            return 'Task "' + id + '" resumed';
        },
        enableAssert()  { Assert.enable(); return 'Assertions enabled'; },
        disableAssert() { Assert.disable(); return 'Assertions disabled'; }
    };

    window.__APS23 = {
        version: APS.version,
        get config() { return getConfig(); },
        configure(patch, opts) { return configureRuntime(patch, opts); },
        debug: debugQueries,
        control: debugControls,
        rules: PluginHotReload,
        strategies: {
            list() { return RecoveryStrategyRegistry.chain().map(s => s.name); },
            register: RecoveryStrategyRegistry.register.bind(RecoveryStrategyRegistry),
            unregister: RecoveryStrategyRegistry.unregister.bind(RecoveryStrategyRegistry)
        }
    };

    try {
        Native.obj.defineProperty(window, '__APS23',
            { enumerable: false, configurable: true, writable: true });
    } catch (e) { Logger.trace('mountDebugAPI defineProperty', e); }
}

/* ═══════════════════════════════════════════════════════════
 * §52  Config Validator + configureRuntime
 * @provides: ConfigValidator, configureRuntime
 * ═══════════════════════════════════════════════════════════ */
const ConfigValidator = {
    _rules: {
        'recovery.retry':              { type: 'number', min: 1, max: 20 },
        'recovery.interval':           { type: 'number', min: 1000, max: 120000 },
        'recovery.timeout':            { type: 'number', min: 1000, max: 60000 },
        'recovery.maxBackoff':         { type: 'number', min: 5000, max: 300000 },
        'recovery.recoveringTimeout':  { type: 'number', min: 5000, max: 120000 },
        'recovery.maxLevel':           { type: 'number', min: 1, max: 10 },
        'recovery.confidence':         { type: 'number', min: 0, max: 1 },
        'recovery.verifyDelay':        { type: 'number', min: 0, max: 10000 },
        'watchdog.interval':           { type: 'number', min: 1000, max: 60000 },
        'watchdog.timeout':            { type: 'number', min: 2000, max: 60000 },
        'scheduler.foreground':        { type: 'number', min: 100, max: 10000 },
        'scheduler.background':        { type: 'number', min: 500, max: 30000 },
        'scanner.interval':            { type: 'number', min: 2000, max: 300000 },
        'scanner.maxNodes':            { type: 'number', min: 50, max: 5000 },
        'intent.threshold':            { type: 'number', min: 0.05, max: 0.95 },
        'intent.history':              { type: 'number', min: 10, max: 500 },
        'intent.multiPauseCount':      { type: 'number', min: 1, max: 10 },
        'circuitBreaker.maxErrors':    { type: 'number', min: 5, max: 500 },
        'circuitBreaker.windowMs':     { type: 'number', min: 5000, max: 300000 },
        'circuitBreaker.cooldownMs':   { type: 'number', min: 5000, max: 300000 },
        'telemetry.bufferSize':        { type: 'number', min: 50, max: 5000 },
        'filters.maxManaged':          { type: 'number', min: 1, max: 50 },
        'shadow.maxDepth':             { type: 'number', min: 1, max: 12 },
        'health.interval':             { type: 'number', min: 2000, max: 120000 },
        'antiDetect.stealth':          { type: 'string', enum: ['none', 'basic', 'paranoid'] },
        'shield.stopPropagation':      { type: 'string', enum: ['passive', 'aggressive'] },
        'recovery.strategyChain':      {
            type: 'array',
            validate: (arr) => Array.isArray(arr) && arr.every(s => typeof s === 'string' && s.length < CONST.CONFIG_STR_MAX_LEN)
        },
        'filters.blacklist': {
            type: 'array',
            validate: (arr) => Array.isArray(arr) && arr.every(s => typeof s === 'string' && s.length < CONST.CONFIG_ARRAY_STR_MAX_LEN)
        },
        'filters.whitelist': {
            type: 'array',
            validate: (arr) => Array.isArray(arr) && arr.every(s => typeof s === 'string' && s.length < CONST.CONFIG_ARRAY_STR_MAX_LEN)
        }
    },

    validate(patch) {
        const errors = [];
        this._validateShape(patch, DEFAULTS, '', errors, new WeakSet());
        if (errors.length) return { ok: false, errors, value: patch };
        const flat = this._flatten(patch);
        for (const [path, rule] of Object.entries(this._rules)) {
            if (!(path in flat)) continue;
            const val = flat[path];
            const actualType = Array.isArray(val) ? 'array' : typeof val;
            if (actualType !== rule.type) {
                errors.push(path + ': expected ' + rule.type + ', got ' + actualType); continue;
            }
            if (rule.type === 'number' && !isFinite(val)) {
                errors.push(path + ': value is NaN or Infinity'); continue;
            }
            if (rule.enum && !rule.enum.includes(val)) {
                errors.push(path + ': value "' + val + '" not in [' + rule.enum.join(', ') + ']'); continue;
            }
            if (rule.validate && !rule.validate(val)) {
                errors.push(path + ': custom validation failed'); continue;
            }
            if (rule.min !== undefined && val < rule.min)
                errors.push(path + ': ' + val + ' < min ' + rule.min);
            if (rule.max !== undefined && val > rule.max)
                errors.push(path + ': ' + val + ' > max ' + rule.max);
        }
        const defaultsFlat = this._flatten(DEFAULTS);
        for (const [path, val] of Object.entries(flat)) {
            if (!(path in defaultsFlat)) {
                errors.push(path + ': unknown config key'); continue;
            }
            const expectedType = typeof defaultsFlat[path];
            const actualType = typeof val;
            if (Array.isArray(defaultsFlat[path])) {
                if (!Array.isArray(val)) errors.push(path + ': expected array, got ' + actualType);
            } else if (actualType !== expectedType && val !== null) {
                errors.push(path + ': expected ' + expectedType + ', got ' + actualType);
            }
        }
        return { ok: errors.length === 0, errors, value: patch };
    },

    _validateShape(value, schema, path, errors, ancestors) {
        const label = path || 'config';
        if (Array.isArray(schema)) {
            if (!Array.isArray(value)) errors.push(label + ': expected array');
            return;
        }
        if (schema && typeof schema === 'object') {
            if (!value || Object.prototype.toString.call(value) !== '[object Object]') {
                errors.push(label + ': expected configuration object');
                return;
            }
            if (ancestors.has(value)) {
                errors.push(label + ': circular configuration reference');
                return;
            }
            ancestors.add(value);
            for (const key of Object.keys(value)) {
                const childPath = path ? path + '.' + key : key;
                if (!Object.prototype.hasOwnProperty.call(schema, key)) {
                    errors.push(childPath + ': unknown config key');
                    continue;
                }
                this._validateShape(value[key], schema[key], childPath, errors, ancestors);
            }
            ancestors.delete(value);
            return;
        }
        if (typeof value !== typeof schema || value === null) {
            errors.push(label + ': expected ' + typeof schema);
        } else if (typeof value === 'number' && !Number.isFinite(value)) {
            errors.push(label + ': expected finite number');
        }
    },

    _flatten(obj, prefix = '') {
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
            const path = prefix ? prefix + '.' + k : k;
            if (v && typeof v === 'object' && !Array.isArray(v))
                Object.assign(result, this._flatten(v, path));
            else result[path] = v;
        }
        return result;
    }
};

const CONFIG_PERSIST_KEY = 'APS23_CONFIG';

function configureRuntime(patch, { persist = false } = {}) {
    const result = ConfigValidator.validate(patch);
    if (!result.ok) {
        Logger.error('Config validation failing:', result.errors);
        return { ok: false, errors: result.errors };
    }
    ConfigStore.patch(result.value);
    Scheduler.invalidateCfg();
    PageBridge._compiledSource = null;
    Scheduler.rescheduleAll();
    ScoringPipeline.scheduleFullEval(0);
    EventBus.emit(APS_EVENTS.CONFIG_CHANGED, result.value);
    Logger.log('config patched', result.value);

    if (persist) {
        Utils.safe(() => {
            localStorage.setItem(CONFIG_PERSIST_KEY, JSON.stringify({
                _schemaVersion: ConfigStore._schemaVersion,
                overrides: ConfigStore._overrides
            }));
        }, 'config-persist');
    }
    return { ok: true };
}

/* ═══════════════════════════════════════════════════════════
 * §53  Composition Root
 * [FIX-P3.8] init() returns Promise.
 * [FIX-P1.4] Async bridge install.
 * @provides: CompositionRoot
 * ═══════════════════════════════════════════════════════════ */
const CompositionRoot = {
    async init() {
        if (APS.started) return;
        APS.started = true;
        RuntimeState.started = true;
        APS.lifecycle = APS_LIFECYCLE.BOOTING;
        Logger.info('APS23 starting');

        if (!Native.init()) {
            APS.lifecycle = APS_LIFECYCLE.STOPPED;
            return;
        }

        RecoveryDispatcher._executor = (ins, reason) => RecoveryEngine.recover(ins, reason);

        this._restoreSavedConfig();
        this._registerServices();
        this._registerModules();
        await this._bootModules();
    },

    _restoreSavedConfig() {
        Utils.safe(() => {
            const raw = localStorage.getItem(CONFIG_PERSIST_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                const overrides = parsed?.overrides ?? parsed;
                const result = ConfigValidator.validate(overrides);
                if (result.ok) {
                    ConfigStore.patch(result.value);
                    Logger.log('Saved config restored');
                } else {
                    Logger.warn('Saved config invalid, discarding:', result.errors);
                    localStorage.removeItem(CONFIG_PERSIST_KEY);
                }
            }
        }, 'config-restore');
    },

    _registerServices() {
        ServiceContainer.register('mediaStore',         () => MediaStore);
        ServiceContainer.register('eventBus',           () => EventBus);
        ServiceContainer.register('scheduler',          () => Scheduler);
        ServiceContainer.register('stateMachine',       () => StateMachine);
        ServiceContainer.register('intentEngine',       () => IntentEngine);
        ServiceContainer.register('recoveryDispatcher', () => RecoveryDispatcher);
        ServiceContainer.register('recoveryEngine',     () => RecoveryEngine);
        ServiceContainer.register('learningEngine',     () => LearningEngine);
        ServiceContainer.register('telemetry',          () => Telemetry);
        ServiceContainer.register('runtimeMonitor',     () => RuntimeMonitor);
        ServiceContainer.register('mediaRegistry',      () => MediaRegistry);
        ServiceContainer.register('streamEngine',       () => StreamEngine);
        ServiceContainer.register('pluginRegistry',     () => SitePluginRegistry);
        ServiceContainer.register('strategyRegistry',   () => RecoveryStrategyRegistry);
        ServiceContainer.register('emeGuard',           () => EMEGuard);
        ServiceContainer.register('pauseAnalyzer',      () => PauseAnalyzer);
        ServiceContainer.register('configStore',        () => ConfigStore);
        ServiceContainer.register('scoringPipeline',    () => ScoringPipeline);
        ServiceContainer.register('cacheManager',       () => CacheManager);
        ServiceContainer.register('watchdog',           () => Watchdog);
        ServiceContainer.register('hlsShield',          () => HLSShield);
        ServiceContainer.register('bufferPredictor',    () => BufferPredictor);
    },

    _registerModules() {
        ModuleRegistry.register('state-machine',    { init: () => this._registerStateMachineExtensions() }, []);
        ModuleRegistry.register('bridge',           { init: () => this._installBridge() },                []);
        ModuleRegistry.register('plugins',          { init: () => this._initPlugins() },                  []);
        ModuleRegistry.register('learned-weights',  { init: () => this._loadLearnedWeights() },           ['plugins']);
        ModuleRegistry.register('shields',          { init: () => this._startShields() },                 ['bridge']);
        ModuleRegistry.register('strategies',       { init: () => this._registerStrategies() },           ['plugins']);
        ModuleRegistry.register('store-wiring',     { init: () => this._wireStore() },                    ['state-machine', 'bridge', 'plugins']);
        ModuleRegistry.register('media-events',     { init: () => this._wireMediaEvents() },              ['state-machine', 'store-wiring']);
        ModuleRegistry.register('scanners',         { init: () => this._startScanners() },                ['store-wiring', 'shields']);
        ModuleRegistry.register('scheduler-tasks',  { init: () => this._registerSchedulerTasks() },       ['strategies', 'scanners', 'shields']);
        ModuleRegistry.register('global-events',    { init: () => this._bindGlobalEvents() },             ['scheduler-tasks']);
    },

    async _bootModules() {
        const allOk = await ModuleRegistry.startInLayers();
        if (allOk && APS.lifecycle !== APS_LIFECYCLE.DEGRADED) {
            APS.lifecycle = APS_LIFECYCLE.READY;
        }
        this._finalize();
    },

    _registerStateMachineExtensions() {
        StateMachine.registerGuard(MEDIA_STATE.PLAYING, MEDIA_STATE.RECOVERING,
            (ins) => !ins.userPaused);
        StateMachine.registerGuard(MEDIA_STATE.PAUSED_AUTO, MEDIA_STATE.RECOVERING,
            (ins) => !ins.userPaused);
        StateMachine.registerHook(MEDIA_STATE.PLAYING, (ins) => {
            SitePluginRegistry.detectAdapter(ins);
            WakeLockManager.request();
            HLSShield.resetProgress(ins);
            if (ins.restoreMute !== undefined) {
                ins._muteRestoreTimer = setTimeout(() => {
                    try { if (ins.media.isConnected) ins.media.muted = ins.restoreMute; }
                    catch (e) { Logger.trace('mute-restore-hook', e); }
                    delete ins.restoreMute;
                    ins._muteRestoreTimer = null;
                }, getConfig().timing.muteRestore);
            }
            if (ActiveMedia.isActive(ins.media)) MediaSessionAdapter.syncPosition(ins);
        });
        StateMachine.registerHook(MEDIA_STATE.VERIFIED, (ins) => {
            PluginLifecycle.notifyResume(ins);
            if (ActiveMedia.isActive(ins.media)) MediaSessionAdapter.syncPosition(ins);
        });
    },

    async _installBridge() {
        const r = await Utils.safeAsync(() => PageBridge.install(), 'init-bridge');
        if (!r.ok || r.value === false) Logger.warn('Bridge install failed – continuing without L1');
        Utils.safe(setupBridge, 'init-bridge-rx');
    },

    _initPlugins() { Utils.safe(() => SitePluginRegistry.detect(), 'init-strategy'); },

    _loadLearnedWeights() {
        if (!getConfig().intent.adaptiveWeight) return;
        const saved = LearningEngine.getWeights(location.hostname);
        if (saved) {
            IntentEngine.setAdaptiveWeights(saved);
            Logger.log('Adaptive weights loaded');
        }
    },

    _startShields() {
        Utils.safe(() => VisibilityShield.init(),          'shield-visibility');
        Utils.safe(() => BackgroundShield.start(),         'shield-background');
        Utils.safe(() => DOMObserver.start(),              'shield-dom-observer');
        Utils.safe(() => FrameBridge.init(),               'shield-frame-bridge');
        Utils.safe(() => RuntimeMonitor.init(),            'shield-runtime-monitor');
        Utils.safe(() => IntentEngine.initObserver(),      'shield-intent-observer');
        Utils.safe(setupErrorIsolate,                      'shield-error-isolate');
        Utils.safe(() => MSEMonitor.install(),             'shield-mse');
        Utils.safe(() => ResourceController.init(),        'shield-resource-ctrl');
        Utils.safe(() => PerformanceMonitor.start(),       'shield-perf');
        Utils.safe(() => HealthMonitor.start(),            'shield-health');
        Utils.safe(() => WakeLockManager.initVisibilityListener(), 'shield-wakelock');
        if (getConfig().debug) Assert.enable();
        if (getConfig().antiDetect.stealth !== 'none') {
            Utils.safe(() => AntiDetect.applyStealth(), 'shield-stealth');
        }
    },

    _wireStore() {
        this._wireInstanceEvents();
        this._wirePageEvents();
    },

    _wireInstanceEvents() {
        MediaStore.subscribe(APS_EVENTS.INSTANCE_ADDED, ({ instance }) => {
            Utils.safe(() => SitePluginRegistry.detectAdapter(instance), 'wire-adapter');
            Utils.safe(() => IntentEngine.observeMedia(instance.media),  'wire-observe');
            Utils.safe(() => PlaybackRateGuard.bind(instance),           'wire-rate');
            Utils.safe(() => HLSShield.attach(instance),                 'wire-hls');
            Utils.safe(() => EMEGuard.bind(instance),                    'wire-eme');
            Utils.safe(() => StreamEngine.register(instance),            'wire-stream');
            Utils.safe(() => {
                if (!MediaStore.getActive()) MediaSessionAdapter.update(instance);
            }, 'wire-session');
            ScoringPipeline.scheduleFullEval(getConfig().timing.evaluateDelayAdd);
        }, { scope: 'internal', priority: 10 });

        MediaStore.subscribe(APS_EVENTS.INSTANCE_REMOVED, ({ instance }) => {
            Utils.safe(() => IntentEngine.unobserveMedia(instance.media), 'wire-unobserve');
            Utils.safe(() => WakeLockManager.monitor(),                   'wire-wake');
            ScoringPipeline.scheduleFullEval(getConfig().timing.evaluateDelayRemove);
        }, { scope: 'internal', priority: 10 });

        MediaStore.subscribe(APS_EVENTS.ACTIVE_CHANGED, ({ old, current }) => {
            Utils.safe(() => {
                const oldIns = old != null ? MediaStore.getById(old) : null;
                const curIns = current != null ? MediaStore.getById(current) : null;
                if (oldIns?.media) PageBridge.unveto(oldIns.media);
                if (curIns?.media) PageBridge.veto(curIns.media);
                MediaSessionAdapter.update(curIns);
            }, 'wire-active');
        }, { scope: 'internal', priority: 10 });
    },

    _wirePageEvents() {
        MediaStore.subscribe(APS_EVENTS.PAGE_VISIBLE, () => {
            for (const ins of MediaStore.list()) {
                if (ins.state === MEDIA_STATE.PAUSED_AUTO &&
                    !RecoveryDispatcher.isInflight(ins.media)) {
                    enqueueRecovery(ins, RecoveryReason.BACKGROUND);
                }
            }
            RecoveryDispatcher.flush();
            WakeLockManager.monitor();
        }, { scope: 'internal', priority: 5 });
    },

    _wireMediaEvents() {
        EventBus.on(MEDIA_EVENTS.PLAY_STARTED, ({ media, instance }) => {
            StateMachine.transition(instance, MEDIA_STATE.PLAYING, REASONS.NATIVE_PLAY);
            IntentEngine.recordPlay(instance);
            ScoringPipeline.scheduleFullEval(0);
        });

        EventBus.on(MEDIA_EVENTS.PLAYING, ({ instance }) => {
            StateMachine.transition(instance, MEDIA_STATE.PLAYING, REASONS.PLAYING);
            IntentEngine.markDirty(instance);
        });

        EventBus.on(MEDIA_EVENTS.PAUSED, ({ media, instance }) => {
            const cfg = getConfig();
            const recentUser = (Clock.wall() - UserIntent.lastAction < cfg.intent.timeout) &&
                               UserIntent.lastMedia === media;
            if (recentUser) {
                instance.userPaused = true;
                UserIntent.recordPause(media, true);
                StateMachine.transition(instance, MEDIA_STATE.PAUSED_USER, REASONS.USER);
            } else if (UserIntent.isIntentionalPause(media)) {
                instance.userPaused = true;
                StateMachine.transition(instance, MEDIA_STATE.PAUSED_USER, REASONS.MULTI_PAUSE_GUARD);
            } else {
                UserIntent.recordPause(media, false);
                StateMachine.transition(instance, MEDIA_STATE.PAUSED_AUTO, REASONS.AUTO);
            }
            IntentEngine.markDirty(instance);
            if (instance.state === MEDIA_STATE.PAUSED_AUTO) {
                setTimeout(() => enqueueRecovery(instance, RecoveryReason.AUTO_PAUSE),
                           cfg.timing.recoverDelay);
            }
        });

        EventBus.on(MEDIA_EVENTS.BUFFERING, ({ instance }) => {
            StateMachine.transition(instance, MEDIA_STATE.BUFFERING, REASONS.BUFFERING);
            IntentEngine.markDirty(instance);
        });

        EventBus.on(MEDIA_EVENTS.STALLED, ({ instance }) => {
            StateMachine.transition(instance, MEDIA_STATE.STALLED, REASONS.STALLED);
            IntentEngine.markDirty(instance);
        });

        EventBus.on(MEDIA_EVENTS.ENDED, ({ instance }) => {
            StateMachine.transition(instance, MEDIA_STATE.ENDED, REASONS.ENDED);
            IntentEngine.markDirty(instance);
        });

        EventBus.on(MEDIA_EVENTS.PROGRESS, ({ instance }) => {
            IntentEngine.markDirty(instance);
        });

        EventBus.on(MEDIA_EVENTS.VOLUME_CHANGED, ({ instance }) => {
            IntentEngine.markDirty(instance);
            ScoringPipeline.evaluateIncremental();
        });

        EventBus.on(MEDIA_EVENTS.ERROR_OCCURRED, ({ media, instance }) => {
            if (media.error && !instance.userPaused) {
                StateMachine.transition(instance, MEDIA_STATE.ERROR, REASONS.MEDIA_ERROR);
                IntentEngine.markDirty(instance);
                enqueueRecovery(instance, RecoveryReason.ERROR);
            }
        });

        EventBus.on(MEDIA_EVENTS.INTERACTION, ({ instance }) => {
            IntentEngine.markDirty(instance);
        });
    },

    _startScanners() {
        MediaScanner.scan();
        FrameBridge.scanIframes();
        for (const ins of MediaStore.list()) {
            SitePluginRegistry.detectAdapter(ins);
            IntentEngine.observeMedia(ins.media);
            StreamEngine.register(ins);
        }
    },

    _registerStrategies() {
        RecoveryStrategyRegistry.clearAll();
        const cfg = getConfig();
        const chain = cfg.recovery.strategyChain;
        const known = Object.keys(STRATEGY_DEFINITIONS);

        for (const name of chain) {
            const def = STRATEGY_DEFINITIONS[name];
            if (!def) { Logger.warn('Unknown strategy in chain, skipping:', name); continue; }
            RecoveryStrategyRegistry.register(name, def.fn, def.opts);
        }

        for (const name of known) {
            if (!chain.includes(name)) {
                const def = STRATEGY_DEFINITIONS[name];
                RecoveryStrategyRegistry.register(name, def.fn, {
                    ...def.opts,
                    priority: Math.max(1, (def.opts.priority || 0) - THRESHOLDS.STRATEGY_FALLBACK_PRIORITY_PENALTY)
                });
                Logger.log('Fallback strategy appended:', name);
            }
        }

        Logger.log('Strategy chain registered:', RecoveryStrategyRegistry.chain().map(s => s.name));
    },

    _registerSchedulerTasks() {
        this._registerCoreTasks();
        this._registerOptionalTasks();
    },

    _registerCoreTasks() {
        const cfg = getConfig();
        Scheduler.register('recovery-flush', () => RecoveryDispatcher.flush(),
            cfg.scheduler.foreground, 20);

        Scheduler.register('scan', () => {
            MediaScanner.scan();
            FrameBridge.scanIframes();
        }, () => MediaStore.size > 0 ? getConfig().scanner.interval : getConfig().scanner.idleInterval,
           1, { backgroundSkip: true });

        Scheduler.register('watchdog', () => {
            Watchdog.sweepAll();
        }, cfg.watchdog.interval, 10);

        Scheduler.register('score-incremental', () => {
            ScoringPipeline.evaluateIncremental();
        }, CONST.SCORE_INCREMENTAL_INTERVAL, 6, { backgroundSkip: true });

        Scheduler.register('score-full', () => {
            if (MediaStore.size) ScoringPipeline.evaluateFull();
        }, CONST.SCORE_FULL_INTERVAL, 3, { backgroundSkip: true });

        Scheduler.register('recovery-sweep', () => {
            MediaStore.forEach(ins => {
                if (ins.state === MEDIA_STATE.PAUSED_AUTO &&
                    !RecoveryDispatcher.isInflight(ins.media)) {
                    enqueueRecovery(ins, RecoveryReason.AUTO_PAUSE);
                }
            });
        }, () => SitePluginRegistry.config.interval || getConfig().recovery.interval, 8);

        Scheduler.register('strategy-reweight', () => RecoveryStrategyRegistry.reweight(),
            CONST.STRATEGY_REWEIGHT_INTERVAL, 1, { backgroundSkip: true });
        Scheduler.register('cleanup', () => MediaRegistry.cleanup(),
            cfg.scanner.gcInterval, 2);
        Scheduler.register('wake-monitor', () => WakeLockManager.monitor(), CONST.WAKE_MONITOR_INTERVAL, 3);

        Scheduler.register('stream-monitor', () => {
            MediaStore.forEach(ins => {
                if (ins.state === MEDIA_STATE.DESTROYED) return;
                StreamEngine.analyze(ins);
            });
        }, CONST.STREAM_MONITOR_INTERVAL, 5, { backgroundSkip: true });

        Scheduler.register('bg-buffer-sample', () => {
            MediaStore.forEach(ins => {
                if (ins.state === MEDIA_STATE.DESTROYED) return;
                BufferPredictor.sample(ins);
            });
        }, CONST.BG_BUFFER_SAMPLE_INTERVAL, 2, { foregroundSkip: true });

        Scheduler.register('cache-prune', () => {
            RuntimeState.pruneCaches();
        }, LIMITS.CACHE_PRUNE_INTERVAL, 0, { backgroundSkip: false });

        Scheduler.register('memory-guard', () => {
            if (!performance.memory) return;
            const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory;
            if (jsHeapSizeLimit <= 0) return;
            const ratio = usedJSHeapSize / jsHeapSizeLimit;
            if (ratio > THRESHOLDS.MEMORY_PRESSURE_RATIO) {
                Logger.warn('Memory pressure: graduated cleanup');
                CacheManager.pruneExpired();
                if (performance.memory.usedJSHeapSize / jsHeapSizeLimit > THRESHOLDS.MEMORY_PRESSURE_RATIO) {
                    CacheManager.invalidateAll();
                }
                Scheduler.invalidateCfg();
            }
        }, CONST.MEMORY_GUARD_INTERVAL, 0, { backgroundSkip: false });
    },

    _registerOptionalTasks() {
        const cfg = getConfig();
        if (cfg.antiDetect.stealth !== 'none') {
            Scheduler.register('stealth-reapply', () => AntiDetect.applyStealth(),
                cfg.antiDetect.stealthReapply || CONST.STEALTH_REAPPLY_DEFAULT, 1, { backgroundSkip: true });
        }
        if (cfg.utility.unlockScroll) {
            Scheduler.register('scroll-unlock', () => OverlayCleaner.unlockScroll(),
                CONST.UTILITY_CLEAN_INTERVAL, 1, { backgroundSkip: true });
        }
        if (cfg.utility.hideOverlay) {
            Scheduler.register('overlay-clean', () => OverlayCleaner.clean(),
                CONST.UTILITY_CLEAN_INTERVAL, 1, { backgroundSkip: true });
        }
    },

    _bindGlobalEvents() {
        Lifecycle._pageshowHandler = () =>
            setTimeout(() => { recoverAll(); RecoveryDispatcher.flush(); }, TIMING.GLOBAL_RECOVER_DELAY);
        Lifecycle._focusHandler = () =>
            setTimeout(() => { recoverAll(); RecoveryDispatcher.flush(); }, TIMING.GLOBAL_RECOVER_DELAY);
        Lifecycle._onlineHandler = () => {
            RuntimeState.online = true;
            EventBus.emit(APS_EVENTS.ONLINE_CHANGED, {});
            setTimeout(() => { recoverAll(); RecoveryDispatcher.flush(); }, TIMING.GLOBAL_RECOVER_DELAY);
        };
        Lifecycle._offlineHandler = () => {
            RuntimeState.online = false;
            EventBus.emit(APS_EVENTS.OFFLINE_CHANGED, {});
            Logger.log('Network offline – recovery paused until reconnect');
        };
        Lifecycle._resumeHandler = () =>
            setTimeout(() => { recoverAll(); RecoveryDispatcher.flush(); }, TIMING.GLOBAL_RECOVER_DELAY);

        window.addEventListener('pageshow', Lifecycle._pageshowHandler, true);
        window.addEventListener('focus', Lifecycle._focusHandler, true);
        window.addEventListener('online', Lifecycle._onlineHandler, true);
        window.addEventListener('offline', Lifecycle._offlineHandler, true);
        document.addEventListener('resume', Lifecycle._resumeHandler, true);

        EventBus.on(APS_EVENTS.BUFFER_WARNING, (ins) => {
            if (!ins.recovering && !ins.media.paused && !ins.userPaused) {
                enqueueRecovery(ins, RecoveryReason.BUFFER_LOW);
            }
        });
    },

    _finalize() {
        Telemetry.init();
        mountDebugAPI();
        Telemetry.push({ type: 'boot', version: APS.version });
        Logger.info('APS23 ready ·', SitePluginRegistry.activeName,
                     '· lifecycle:', APS.lifecycle);
    }
};

/* ═══════════════════════════════════════════════════════════
 * §54  Boot
 * @provides: boot
 * ═══════════════════════════════════════════════════════════ */
function boot() {
    try {
        if (window !== window.top) return;
    } catch (_) { return; }

    if (document.documentElement) {
        CompositionRoot.init();
        return;
    }

    let pollTimer = null;
    let mo = null;

    const cleanup = () => {
        document.removeEventListener('DOMContentLoaded', onReady);
        if (mo) { mo.disconnect(); mo = null; }
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    };

    const onReady = () => {
        cleanup();
        if (!APS.started) CompositionRoot.init();
    };

    document.addEventListener('DOMContentLoaded', onReady);

    if (typeof MutationObserver !== 'undefined') {
        mo = new MutationObserver((_, obs) => {
            if (document.documentElement) {
                cleanup();
                if (!APS.started) CompositionRoot.init();
            }
        });
        mo.observe(document, { childList: true });
    }

    let delay = CONST.BOOT_INITIAL_DELAY;
    const start = Date.now();

    const poll = () => {
        if (APS.started) return;
        if (Date.now() - start > CONST.BOOT_TIMEOUT_MS) {
            cleanup();
            Logger.error('Boot timeout: documentElement never appeared');
            return;
        }
        if (document.documentElement) {
            cleanup();
            CompositionRoot.init();
            return;
        }
        delay = Math.min(delay * CONST.BOOT_DELAY_MULTIPLIER, CONST.BOOT_MAX_POLL_DELAY);
        pollTimer = setTimeout(poll, delay);
    };
    pollTimer = setTimeout(poll, delay);
}

GlobalResources.add(() => Lifecycle.destroy());
window.addEventListener('pagehide', event => {
    // A cached page keeps its runtime so pageshow can resume recovery.
    if (!event.persisted) Lifecycle.destroy();
});

boot();
})();
