import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractSearchTokens, findCandidateFiles } from './search.js';

/** Write a throwaway project folder from a { relPath: content } map. */
function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-search-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('extractSearchTokens pulls text, id and classes', () => {
  const tokens = extractSearchTokens({
    text: 'Welcome to Nimbus Analytics',
    selector: '#hero-title > span.accent',
    classList: ['accent', 'xl'],
  });
  assert.deepEqual(tokens, [
    { kind: 'text', value: 'Welcome to Nimbus Analytics' },
    { kind: 'id', value: 'hero-title' },
    { kind: 'class', value: 'accent' },
  ]);
});

test('extractSearchTokens ignores short text and short classes', () => {
  const tokens = extractSearchTokens({ text: 'Hi', classList: ['xl'] });
  assert.deepEqual(tokens, []);
});

test('distinctive text ranks the containing file first', async () => {
  const root = makeFixture({
    'index.html': '<h1>Welcome to Nimbus Analytics</h1>',
    'about.html': '<h1>About us</h1>',
    'styles.css': '.hero { color: red }',
  });
  const out = await findCandidateFiles(root, { text: 'Welcome to Nimbus Analytics' });
  assert.equal(out[0].file, 'index.html');
  assert.equal(out[0].line, 1);
  assert.match(out[0].reason, /text/);
});

test('utility class found in many files is demoted below a unique match', async () => {
  const files = { 'components/Hero.jsx': '<div className="flex hero-card">Hi</div>' };
  for (let i = 0; i < 6; i++) files[`pages/p${i}.jsx`] = '<div className="flex">page</div>';
  const root = makeFixture(files);
  const out = await findCandidateFiles(root, { classList: ['flex', 'hero-card'] });
  assert.equal(out[0].file, 'components/Hero.jsx');
});

test('framework source hint surfaces the file even without token matches', async () => {
  const root = makeFixture({
    'src/components/Hero.tsx': 'export const Hero = () => <h1>{t.title}</h1>;',
    'src/other.tsx': 'export const O = () => null;',
  });
  const out = await findCandidateFiles(root, {
    sourceHint: { file: 'src/components/Hero.tsx', line: 1 },
  });
  assert.equal(out[0].file, 'src/components/Hero.tsx');
  assert.match(out[0].reason, /source hint/);
});

test('returns [] on a nonexistent root or empty context', async () => {
  assert.deepEqual(await findCandidateFiles('/nonexistent-ave-path', { text: 'whatever text here' }), []);
  const root = makeFixture({ 'index.html': '<h1>x</h1>' });
  assert.deepEqual(await findCandidateFiles(root, {}), []);
});
