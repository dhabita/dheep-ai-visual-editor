import path from 'node:path';
import fsp from 'node:fs/promises';
import { listProjectFiles } from './utils.js';

// Pre-search: find likely source files for a clicked element BEFORE spawning
// Claude, so the prompt can point at candidates instead of making the model
// search from scratch. Fail-open: any error returns [] and the task proceeds.

const SEARCHABLE_EXT = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.vue', '.svelte', '.astro',
]);
const MAX_FILE_BYTES = 300 * 1024;
const WIDESPREAD_FILE_COUNT = 5; // token in more files than this = weak signal
const WEIGHT = { text: 10, id: 8, class: 3 };
const SOURCE_HINT_SCORE = 15;

/** Turn the clicked-element context into ranked search tokens. */
export function extractSearchTokens(context = {}) {
  const tokens = [];
  const text = String(context.text || '').replace(/\s+/g, ' ').trim();
  if (text.length >= 8) {
    let snippet = text.slice(0, 60);
    if (text.length > 60 && snippet.includes(' ')) {
      snippet = snippet.slice(0, snippet.lastIndexOf(' '));
    }
    tokens.push({ kind: 'text', value: snippet.trim() });
  }
  const idMatch = String(context.selector || '').match(/#([A-Za-z0-9_-]{2,})/);
  if (idMatch) tokens.push({ kind: 'id', value: idMatch[1] });
  for (const c of context.classList || []) {
    if (typeof c === 'string' && c.length >= 3) tokens.push({ kind: 'class', value: c });
  }
  return tokens;
}

/**
 * Rank project files likely to contain the clicked element.
 * Returns up to `maxCandidates` of { file, line, snippet, reason }. Never rejects.
 */
export async function findCandidateFiles(projectRoot, context = {}, { maxCandidates = 5 } = {}) {
  try {
    const tokens = extractSearchTokens(context);
    const hintFile = context.sourceHint?.file ? String(context.sourceHint.file) : null;
    if (!tokens.length && !hintFile) return [];

    const files = (await listProjectFiles(projectRoot))
      .filter((f) => SEARCHABLE_EXT.has(path.extname(f).toLowerCase()));

    // Pass 1: raw matches per file + how many files each token appears in.
    const matches = new Map();       // file → [{ token, line, snippet }]
    const filesPerToken = new Map(); // token value → file count
    for (const file of files) {
      const full = path.join(projectRoot, file);
      let content;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        content = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      for (const token of tokens) {
        const idx = content.indexOf(token.value);
        if (idx === -1) continue;
        filesPerToken.set(token.value, (filesPerToken.get(token.value) || 0) + 1);
        const line = content.slice(0, idx).split('\n').length;
        const snippet = content.split('\n')[line - 1].trim().slice(0, 120);
        if (!matches.has(file)) matches.set(file, []);
        matches.get(file).push({ token, line, snippet });
      }
    }

    // Pass 2: score files, demoting tokens that match many files (utility
    // classes like Tailwind's demote themselves — no hardcoded list needed).
    const scored = [];
    for (const [file, fileMatches] of matches) {
      let score = 0;
      let best = fileMatches[0];
      let bestWeight = -1;
      const reasons = [];
      for (const m of fileMatches) {
        const spread = filesPerToken.get(m.token.value) || 1;
        const weight = spread > WIDESPREAD_FILE_COUNT ? 0.5 : WEIGHT[m.token.kind];
        score += weight;
        reasons.push(`${m.token.kind} "${m.token.value}"`);
        if (weight > bestWeight) { bestWeight = weight; best = m; }
      }
      if (hintFile && (file.endsWith(hintFile) || hintFile.endsWith(file))) {
        score += SOURCE_HINT_SCORE;
        reasons.push('framework source hint');
      }
      scored.push({ file, line: best.line, snippet: best.snippet, score, reason: reasons.join(', ') });
    }

    // The hinted file may contain no token match — still surface it.
    if (hintFile && !scored.some((s) => s.reason.includes('framework source hint'))) {
      const hit = files.find((f) => f.endsWith(hintFile) || hintFile.endsWith(f));
      if (hit) {
        scored.push({
          file: hit,
          line: context.sourceHint.line || 1,
          snippet: '',
          score: SOURCE_HINT_SCORE,
          reason: 'framework source hint',
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, maxCandidates)
      .map(({ file, line, snippet, reason }) => ({ file, line, snippet, reason }));
  } catch {
    return []; // pre-search must never block a task
  }
}
