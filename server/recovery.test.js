import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverProject, isBadStatus } from './recovery.js';

// Build a mock driver whose probe() returns the next scripted status each call.
function mockDriver(statuses) {
  const events = [];
  let i = 0;
  let restarts = 0;
  let fixes = 0;
  return {
    events, get restarts() { return restarts; }, get fixes() { return fixes; },
    origin: () => 'http://localhost:3002',
    probe: async () => statuses[i++],
    restart: async () => { restarts++; },
    errorLog: () => 'TypeError: boom at page.tsx:10',
    runFix: async () => { fixes++; },
    emit: (event, data) => events.push({ event, data }),
  };
}

test('isBadStatus flags 5xx and unreachable', () => {
  assert.equal(isBadStatus(500), true);
  assert.equal(isBadStatus(null), true);
  assert.equal(isBadStatus(200), false);
  assert.equal(isBadStatus(404), false);
});

test('healthy on first probe → no restart, no fix', async () => {
  const d = mockDriver([200]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'healthy');
  assert.equal(d.restarts, 0);
  assert.equal(d.fixes, 0);
});

test('500 then healthy after restart → recovered-by-restart', async () => {
  const d = mockDriver([500, 200]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'recovered-by-restart');
  assert.equal(d.restarts, 1);
  assert.equal(d.fixes, 0);
});

test('still 500 after restart, healthy after fix → recovered-by-fix', async () => {
  const d = mockDriver([500, 500, 200]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'recovered-by-fix');
  assert.equal(d.restarts, 2); // clean restart + restart after fix
  assert.equal(d.fixes, 1);
});

test('still 500 after fix → failed, no further attempts', async () => {
  const d = mockDriver([500, 500, 500]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'failed');
  assert.equal(d.restarts, 2);
  assert.equal(d.fixes, 1);
  assert.equal(d.events.at(-1).event, 'recovery:end');
  assert.equal(d.events.at(-1).data.outcome, 'failed');
});
