import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectPackageManager,
  detectStack,
  buildDevCommand,
  getFreePort,
} from './devservers.js';

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-dev-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('detectPackageManager reads the lockfile', () => {
  assert.equal(detectPackageManager(tmpProject({ 'pnpm-lock.yaml': '' })), 'pnpm');
  assert.equal(detectPackageManager(tmpProject({ 'yarn.lock': '' })), 'yarn');
  assert.equal(detectPackageManager(tmpProject({ 'package-lock.json': '' })), 'npm');
  assert.equal(detectPackageManager(tmpProject({})), 'npm'); // default
});

test('detectStack recognizes next and vite from package.json', () => {
  const next = tmpProject({ 'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }) });
  assert.equal(detectStack(next), 'next');
  const vite = tmpProject({ 'package.json': JSON.stringify({ devDependencies: { vite: '5.0.0' } }) });
  assert.equal(detectStack(vite), 'vite');
  assert.equal(detectStack(tmpProject({ 'package.json': '{}' })), 'other');
});

test('buildDevCommand forces the port for next, per package manager', () => {
  assert.deepEqual(
    buildDevCommand({ pm: 'npm', stack: 'next', port: 3002 }),
    { cmd: 'npm', args: ['run', 'dev', '--', '-p', '3002'] }
  );
  assert.deepEqual(
    buildDevCommand({ pm: 'pnpm', stack: 'next', port: 3002 }),
    { cmd: 'pnpm', args: ['dev', '-p', '3002'] }
  );
  assert.deepEqual(
    buildDevCommand({ pm: 'yarn', stack: 'next', port: 3002 }),
    { cmd: 'yarn', args: ['dev', '-p', '3002'] }
  );
});

test('buildDevCommand does not force a port for non-next stacks', () => {
  assert.deepEqual(
    buildDevCommand({ pm: 'npm', stack: 'vite', port: 3002 }),
    { cmd: 'npm', args: ['run', 'dev'] }
  );
});

test('getFreePort returns a usable port number', async () => {
  const p = await getFreePort();
  assert.equal(typeof p, 'number');
  assert.ok(p > 0 && p < 65536);
});
