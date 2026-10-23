'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const scriptPath = path.resolve(__dirname, '..', process.env.APS_TEST_SOURCE || 'APS.user.js');
const source = readFileSync(scriptPath, 'utf8');

// Evaluate the actual configuration code without starting browser services.
function section(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing source section: ${start}`);
    return source.slice(first, last);
}

function loadConfig() {
    const code = [
        section('const CONST =', 'function clamp('),
        section('const LIMITS =', 'function getConfig()'),
        section('const ConfigValidator =', 'const CONFIG_PERSIST_KEY ='),
        '({ ConfigStore, ConfigValidator, DEFAULTS })'
    ].join('\n');
    return vm.runInNewContext(code, { structuredClone }, { timeout: 1000 });
}

test('default configuration passes validation, including array settings', () => {
    const { ConfigValidator, DEFAULTS } = loadConfig();
    const result = ConfigValidator.validate(DEFAULTS);
    assert.equal(result.ok, true, result.errors.join('\n'));
});

test('strategy and site filter arrays accept valid string entries', () => {
    const { ConfigValidator } = loadConfig();
    const result = ConfigValidator.validate({
        recovery: { strategyChain: ['adapter', 'native'] },
        filters: { blacklist: ['example.com'], whitelist: [] }
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
});

test('invalid array values and entries are rejected', () => {
    const { ConfigValidator } = loadConfig();
    for (const patch of [
        { recovery: { strategyChain: 'native' } },
        { recovery: { strategyChain: [42] } },
        { filters: { blacklist: [null] } },
        { filters: { whitelist: 'example.com' } }
    ]) {
        assert.equal(ConfigValidator.validate(patch).ok, false);
    }
});

test('repeated nested updates preserve old snapshots and support reset', () => {
    const { ConfigStore, DEFAULTS } = loadConfig();
    const first = ConfigStore.patch({ recovery: { interval: 2000 } });
    const second = ConfigStore.patch({ recovery: { interval: 3000 } });

    assert.equal(first.recovery.interval, 2000);
    assert.equal(second.recovery.interval, 3000);
    assert.equal(Object.isFrozen(first.recovery), true);
    assert.equal(Object.isFrozen(second.recovery), true);
    assert.equal(ConfigStore.resetPath('recovery.interval').recovery.interval,
        DEFAULTS.recovery.interval);
    assert.equal(second.recovery.interval, 3000);
});

test('configuration updates do not freeze caller-owned objects', () => {
    const { ConfigStore } = loadConfig();
    const patch = { recovery: { interval: 2000 }, filters: { blacklist: ['example.com'] } };
    ConfigStore.patch(patch);

    assert.equal(Object.isFrozen(patch.recovery), false);
    assert.equal(Object.isFrozen(patch.filters.blacklist), false);
});

test('caller mutations cannot change stored configuration', () => {
    const { ConfigStore } = loadConfig();
    const patch = { recovery: { interval: 2000 }, filters: { blacklist: ['example.com'] } };
    ConfigStore.patch(patch);
    patch.recovery.interval = 3000;
    patch.filters.blacklist.push('other.example');

    // An unrelated update must not expose subsequent caller mutations.
    const config = ConfigStore.patch({ debug: true });
    assert.equal(config.recovery.interval, 2000);
    assert.deepEqual(Array.from(config.filters.blacklist), ['example.com']);
});

test('invalid scalar settings remain rejected', () => {
    const { ConfigValidator } = loadConfig();
    for (const patch of [
        { recovery: { retry: 0 } },
        { recovery: { timeout: NaN } },
        { antiDetect: { stealth: 'unknown' } },
        { debug: 'true' },
        { unknownSetting: true }
    ]) {
        assert.equal(ConfigValidator.validate(patch).ok, false);
    }
});

test('malformed configuration is rejected without throwing or bypassing the schema', () => {
    const { ConfigValidator } = loadConfig();
    const circular = {};
    circular.recovery = circular;
    for (const patch of [null, [], 42, 'debug', circular,
        { recovery: null }, { debug: {} }, { debug: null },
        { recovery: { retry: {} } }, { recovery: { unknown: {} } },
        { unknown: {} }, { hls: { nudge: Infinity } },
        JSON.parse('{"__proto__":{"debug":true}}')]) {
        assert.equal(ConfigValidator.validate(patch).ok, false);
    }
    assert.equal(ConfigValidator.validate({}).ok, true);
    assert.equal(ConfigValidator.validate({ recovery: {} }).ok, true);
});
