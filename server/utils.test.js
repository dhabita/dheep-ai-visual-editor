import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, detectProjectInfo } from './utils.js';

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-utils-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('detectProjectInfo: Next.js App Router + Tailwind', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0', tailwindcss: '4.0.0' } }),
    'app/layout.tsx': 'export default function L(){}',
  });
  assert.deepEqual(detectProjectInfo(root), {
    framework: 'Next.js (App Router)',
    styling: 'Tailwind CSS',
  });
});

test('detectProjectInfo: no package.json → static HTML', () => {
  const root = makeFixture({ 'index.html': '<h1>x</h1>' });
  assert.deepEqual(detectProjectInfo(root), {
    framework: 'static HTML / unknown',
    styling: null,
  });
});

test('buildPrompt includes candidates and project type', () => {
  const out = buildPrompt({
    prompt: 'make it blue',
    context: { selector: '.hero', text: 'Welcome home', parents: 'main > section.hero' },
    intel: {
      candidates: [{ file: 'src/Hero.tsx', line: 12, snippet: '<h1>Welcome home</h1>', reason: 'text "Welcome home"' }],
      projectInfo: { framework: 'Vite + React', styling: 'Tailwind CSS' },
      fileSummary: [],
    },
  }, '/proj');
  assert.match(out, /Candidate source files/);
  assert.match(out, /src\/Hero\.tsx:12/);
  assert.match(out, /Project type: Vite \+ React, styling: Tailwind CSS/);
  assert.match(out, /Element text: Welcome home/);
  assert.match(out, /Ancestors: main > section\.hero/);
  assert.match(out, /TASK: make it blue/);
});

test('buildPrompt falls back to a file summary when there are no candidates', () => {
  const out = buildPrompt({
    prompt: 'change footer',
    context: {},
    intel: { candidates: [], projectInfo: null, fileSummary: ['index.html', 'styles.css'] },
  }, '/proj');
  assert.match(out, /Project files \(partial\)/);
  assert.match(out, /styles\.css/);
  assert.doesNotMatch(out, /Candidate source files/);
});

test('buildPrompt still works without intel (backwards compatible)', () => {
  const out = buildPrompt({ prompt: 'hi', context: { selector: '#a' } }, '/proj');
  assert.match(out, /TASK: hi/);
  assert.match(out, /CSS selector: #a/);
});
