import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';

import {
  detectPackageManager,
  detectStack,
  buildDevCommand,
  getFreePort,
  probeHttpStatus,
  createDevManager,
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

test('probeHttpStatus returns the status code of a reachable server', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 500; res.end('boom'); });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const status = await probeHttpStatus(`http://localhost:${port}/`);
  assert.equal(status, 500);
  server.close();
});

test('probeHttpStatus returns null when nothing is listening', async () => {
  const status = await probeHttpStatus('http://localhost:1/', 300);
  assert.equal(status, null);
});

test('DevManager start/restart/stop drives a child dev server', async () => {
  // A project whose "dev script" is a 1-line node http server on $PORT.
  const dir = tmpProject({
    'package.json': JSON.stringify({
      scripts: { dev: 'node server.js' },
    }),
    'server.js':
      "require('http').createServer((q,s)=>{s.end('ok')}).listen(process.env.PORT||0,()=>console.log('ready'))",
  });
  const projects = new Map([['demo', { id: 'demo', root: dir }]]);
  const events = [];
  const mgr = createDevManager({
    projects,
    runTask: async () => ({ summary: 'fixed', editedFiles: [] }),
    broadcast: (e, d) => events.push({ e, d }),
  });

  // Force the port via env since this stub reads process.env.PORT.
  const port = await getFreePort();
  projects.get('demo').origin = `http://localhost:${port}`;

  const view = await mgr.start('demo', { port });
  assert.equal(view.managed, true);
  assert.equal(view.running, true);
  assert.equal(view.port, port);

  const status = await probeHttpStatus(`http://localhost:${port}/`);
  assert.equal(status, 200);

  await mgr.stop('demo');
  assert.equal(mgr.status('demo').running, false);

  mgr.shutdownAll();
});
