'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('userscript metadata and runtime version match the package release', () => {
    const root = path.resolve(__dirname, '..');
    const source = readFileSync(path.join(root, 'APS.user.js'), 'utf8');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(source.startsWith('// ==UserScript=='));
    assert.equal(source.match(/^\/\/ @version\s+(\S+)/m)?.[1], pkg.version);
    assert.equal(source.match(/const APS = \{[\s\S]*?version: '([^']+)'/)?.[1], pkg.version);
    assert.equal(pkg.license, 'GPL-3.0-or-later');
    assert.equal(source.match(/^\/\/ @license\s+(\S+)/m)?.[1], pkg.license);
});
