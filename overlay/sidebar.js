/* ===== sidebar.js — vibe-coding chat panel =====
   Concatenated into the overlay bundle (before overlay.js). Renders a docked
   sidebar with a chat area that talks to the editor server's /task SSE endpoint
   and keeps the Claude session going across messages. */

let aveSb = null;          // root sidebar element
let aveFab = null;         // floating toggle button
let aveSbSession = null;   // CLI session id → continues the conversation
let aveSbAttached = null;  // element context attached to the next message
let aveSbBusy = false;
let aveChatLog = [];        // persisted transcript: [{role, text, ctx?, trace:[{t,cls}], files?}]
let aveCurAssistant = null; // current streaming assistant entry within aveChatLog
let avePendingReload = false; // hot-reload deferred until the active task finishes
let aveSaveTimer = null;
let aveSbUsage = null;       // last context-window usage {contextTokens, contextWindow, pct, costUsd}
const AVE_MAX_MSGS = 200;

function aveSbCfg() { return window.__AVE_CONFIG__ || {}; }

/* ---- persistence: keep chat + context across page/hot reloads ---- */
function aveStoreKey() { return 'ave-chat:' + (aveSbCfg().projectId || 'default'); }
function aveSaveState() {
  try {
    localStorage.setItem(aveStoreKey(), JSON.stringify({
      v: 1,
      sessionId: aveSbSession,
      attached: aveSbAttached,
      usage: aveSbUsage,
      open: aveSb ? aveSb.classList.contains('open') : true,
      messages: aveChatLog.slice(-AVE_MAX_MSGS),
    }));
  } catch (e) { /* storage unavailable / full — ignore */ }
}
function aveSaveThrottled() {
  if (aveSaveTimer) return;
  aveSaveTimer = setTimeout(() => { aveSaveTimer = null; aveSaveState(); }, 300);
}
function aveLoadState() {
  try { return JSON.parse(localStorage.getItem(aveStoreKey()) || 'null'); }
  catch { return null; }
}
function aveClearState() { try { localStorage.removeItem(aveStoreKey()); } catch {} }

function aveInitSidebar() {
  if (document.getElementById('ave-sidebar')) return;
  const cfg = aveSbCfg();

  // Mount our UI on <html> (not <body>) so it stays viewport-fixed even when
  // <body> gets a transform to push its content left.
  const mount = document.documentElement;

  aveFab = document.createElement('button');
  aveFab.id = 'ave-fab';
  aveFab.title = 'AI Visual Editor';
  aveFab.textContent = '✦';
  aveFab.onclick = () => aveToggleSidebar(true);
  mount.appendChild(aveFab);

  aveSb = document.createElement('aside');
  aveSb.id = 'ave-sidebar';
  aveSb.innerHTML = `
    <div class="ave-sb-head">
      <span class="ave-sb-dot"></span>
      <span class="ave-sb-title">AI Editor</span>
      <span class="ave-sb-project">${cfg.projectId ? aveSbEsc(cfg.projectId) : ''}</span>
      <button class="ave-sb-clear" title="Clear chat">⌫</button>
      <button class="ave-sb-min" title="Minimize">—</button>
    </div>
    <div class="ave-sb-msgs"></div>
    <div class="ave-sb-foot">
      <div class="ave-sb-ctx" hidden title="How full the Claude conversation context is. The CLI auto-compacts when it gets close to full.">
        <div class="ave-ctx-bar"><div class="ave-ctx-fill"></div></div>
        <span class="ave-ctx-text"></span>
      </div>
      <div class="ave-sb-chip" hidden></div>
      <div class="ave-sb-inputrow">
        <button class="ave-sb-pick" title="Pick an element (Ctrl+Shift+E)">◎</button>
        <textarea class="ave-sb-input" rows="1" placeholder="Describe a change…"></textarea>
        <button class="ave-sb-send" title="Send (Enter)">↑</button>
      </div>
      <div class="ave-sb-status"></div>
    </div>`;
  mount.appendChild(aveSb);

  aveSb.querySelector('.ave-sb-min').onclick = () => aveToggleSidebar(false);
  aveSb.querySelector('.ave-sb-clear').onclick = aveSbClear;
  aveSb.querySelector('.ave-sb-send').onclick = aveSbSend;
  aveSb.querySelector('.ave-sb-pick').onclick = aveSbTogglePick;

  const input = aveSb.querySelector('.ave-sb-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aveSbSend(); }
  });

  // Restore the previous conversation + context (survives page/hot reloads).
  const saved = aveLoadState();
  if (saved && Array.isArray(saved.messages) && saved.messages.length) {
    aveSbSession = saved.sessionId || null;
    aveChatLog = saved.messages;
    aveRenderLog();
    if (saved.attached) aveRestoreAttachment(saved.attached);
    if (saved.usage) aveSbSetUsage(saved.usage);
  } else {
    aveSbHint('Pick an element or just describe what you want to change.');
  }
  aveCheckServer();
  aveToggleSidebar(!(saved && saved.open === false)); // default open
}

function aveSbClear() {
  aveChatLog = [];
  aveSbSession = null;
  aveSbAttached = null;
  aveCurAssistant = null;
  aveSbSetUsage(null);
  aveClearState();
  aveSb.querySelector('.ave-sb-chip').hidden = true;
  aveSbMsgs().innerHTML = '';
  aveSbHint('Pick an element or just describe what you want to change.');
  aveSbStatus('Cleared');
}

function aveToggleSidebar(open) {
  if (!aveSb) return;
  aveSb.classList.toggle('open', open);
  aveFab.classList.toggle('hide', open);
  // Push the page (body) left instead of covering it.
  document.body.classList.add('ave-push-anim');
  document.body.classList.toggle('ave-pushed', open);
  if (open) setTimeout(() => aveSb.querySelector('.ave-sb-input')?.focus(), 180);
  aveSaveState();
}

/** Toggle the element picker from the sidebar button (delegates to overlay.js). */
function aveSbTogglePick() {
  const willActivate = !aveActive; // aveActive lives in overlay.js
  aveSetActive(willActivate);      // overlay.js
  aveSb.querySelector('.ave-sb-pick').classList.toggle('active', willActivate);
  aveSbStatus(willActivate ? 'Pick an element on the page…' : '');
}

/** Show the attached-element chip (used both on click and on restore). */
function aveRestoreAttachment(ctx) {
  aveSbAttached = ctx;
  const chip = aveSb.querySelector('.ave-sb-chip');
  chip.hidden = false;
  chip.innerHTML = `<span class="chip-sel" title="${aveSbEsc(ctx.selector)}">◳ ${aveSbEsc(ctx.selector)}</span><button title="Detach">✕</button>`;
  chip.querySelector('button').onclick = () => { aveSbAttached = null; chip.hidden = true; aveSaveState(); };
}

/** Called by overlay.js when an element is clicked in picker mode. */
function aveAttachElement(ctx) {
  aveRestoreAttachment(ctx);
  aveSetActive(false); // turn picker off so the page is usable
  aveSb.querySelector('.ave-sb-pick').classList.remove('active');
  aveToggleSidebar(true);
  aveSbStatus('Element attached — describe the change.');
  aveSaveState();
}

async function aveCheckServer() {
  const dot = aveSb.querySelector('.ave-sb-dot');
  try {
    const r = await fetch((aveSbCfg().serverUrl || '') + '/status');
    const s = await r.json();
    dot.className = 'ave-sb-dot ' + (s.cliAvailable ? 'ok' : 'bad');
    aveSbStatus(s.cliAvailable ? 'Ready' : 'Claude CLI not found on the server', s.cliAvailable ? 'ok' : 'err');
  } catch {
    dot.className = 'ave-sb-dot bad';
    aveSbStatus('Editor server offline', 'err');
  }
}

async function aveSbSend() {
  if (aveSbBusy) return;
  const input = aveSb.querySelector('.ave-sb-input');
  const prompt = input.value.trim();
  if (!prompt) { input.focus(); return; }

  const cfg = aveSbCfg();
  const ctx = aveSbAttached;
  aveSbAddUser(prompt, ctx);
  input.value = '';
  input.style.height = 'auto';

  // Clear the attachment chip.
  aveSbAttached = null;
  aveSb.querySelector('.ave-sb-chip').hidden = true;

  const bubble = aveSbAddAssistant();
  aveSbBusy = true;
  aveSbSetBusy(true);
  aveSbStatus('Claude is working…');

  let res;
  try {
    res = await fetch((cfg.serverUrl || '') + '/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        context: ctx || undefined,
        projectId: cfg.projectId || null,
        sessionId: aveSbSession || undefined,
      }),
    });
  } catch {
    aveSbTrace(bubble, '✗ editor server offline', 't-err');
    aveSbStatus('Server offline', 'err');
    aveSbBusy = false; aveSbSetBusy(false);
    return;
  }

  if (!res.ok || !res.body) {
    let msg = 'Request failed (' + res.status + ')';
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    aveSbTrace(bubble, '✗ ' + msg, 't-err');
    aveSbStatus(msg, 'err');
    aveSbBusy = false; aveSbSetBusy(false);
    return;
  }

  await aveSbConsume(res.body, bubble);
  aveSbBusy = false;
  aveSbSetBusy(false);
  aveSaveState();
  aveMaybeReload(); // a hot-reload may have been deferred while we were streaming
}

/** Run a reload that was deferred until the task finished (see overlay.js). */
function aveMaybeReload() {
  if (avePendingReload) {
    avePendingReload = false;
    setTimeout(() => location.reload(), 250); // let the final save flush
  }
}

/** Parse the SSE stream into the assistant bubble. */
async function aveSbConsume(body, bubble) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const md = bubble.querySelector('.ave-md');
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evm = chunk.match(/^event: (.+)$/m);
      const dm = chunk.match(/^data: (.+)$/m);
      if (!dm) continue;
      const event = evm ? evm[1].trim() : 'message';
      let data = {};
      try { data = JSON.parse(dm[1]); } catch {}

      if (event === 'text' && data.delta) {
        md.textContent += data.delta;
        if (aveCurAssistant) aveCurAssistant.text = md.textContent;
        aveSaveThrottled();
      } else if (event === 'tool') {
        aveSbTrace(bubble, `› ${data.name} ${aveSbToolArg(data.input)}`, 't-tool');
      } else if (event === 'edited') {
        aveSbTrace(bubble, `✎ edited ${data.file}`, 't-edit');
      } else if (event === 'compacted') {
        aveSbTrace(bubble, '🗜 context auto-compacted by Claude', 't-compact');
      } else if (event === 'usage') {
        aveSbSetUsage(data);
      } else if (event === 'tool_error') {
        aveSbTrace(bubble, `✗ ${data.name}: ${data.error}`, 't-err');
      } else if (event === 'done') {
        if (data.sessionId) aveSbSession = data.sessionId;
        if (data.usage) aveSbSetUsage(data.usage);
        if (!md.textContent.trim() && data.summary) md.textContent = data.summary;
        if (aveCurAssistant) {
          aveCurAssistant.text = md.textContent;
          aveCurAssistant.files = data.editedFiles || [];
        }
        aveSbStatus(data.editedFiles && data.editedFiles.length
          ? `Done ✓ — edited ${data.editedFiles.join(', ')}` : 'Done ✓', 'ok');
        aveSaveState();
      } else if (event === 'error') {
        aveSbTrace(bubble, '✗ ' + (data.message || 'error'), 't-err');
        aveSbStatus('Error', 'err');
        aveSaveState();
      }
      aveSbScroll();
    }
  }
}

/* ---- small render helpers ---- */
function aveSbMsgs() { return aveSb.querySelector('.ave-sb-msgs'); }
function aveSbScroll() { const m = aveSbMsgs(); m.scrollTop = m.scrollHeight; }

/** Build a DOM bubble from a stored message object. */
function aveMsgEl(msg) {
  const el = document.createElement('div');
  if (msg.role === 'user') {
    el.className = 'ave-msg user';
    el.innerHTML = (msg.ctx ? `<div class="ave-ctxnote">◳ ${aveSbEsc(msg.ctx.selector)}</div>` : '') + aveSbEsc(msg.text);
    return el;
  }
  el.className = 'ave-msg assistant';
  el.innerHTML = `<div class="ave-md"></div><div class="ave-trace"></div>`;
  el.querySelector('.ave-md').textContent = msg.text || '';
  const trace = el.querySelector('.ave-trace');
  (msg.trace || []).forEach((t) => {
    const line = document.createElement('div');
    if (t.cls) line.className = t.cls;
    line.textContent = t.t;
    trace.appendChild(line);
  });
  return el;
}

/** Re-render the whole transcript from aveChatLog (used on restore). */
function aveRenderLog() {
  const m = aveSbMsgs();
  m.innerHTML = '';
  aveChatLog.forEach((msg) => m.appendChild(aveMsgEl(msg)));
  aveSbScroll();
}

function aveSbAddUser(text, ctx) {
  const msg = { role: 'user', text, ctx: ctx || null };
  aveChatLog.push(msg);
  aveSbMsgs().appendChild(aveMsgEl(msg));
  aveSbScroll();
  aveSaveState();
}

function aveSbAddAssistant() {
  const msg = { role: 'assistant', text: '', trace: [], files: [] };
  aveChatLog.push(msg);
  aveCurAssistant = msg;
  const el = aveMsgEl(msg);
  aveSbMsgs().appendChild(el);
  aveSbScroll();
  aveSaveState();
  return el;
}

function aveSbTrace(bubble, text, cls) {
  const trace = bubble.querySelector('.ave-trace');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  trace.appendChild(line);
  if (aveCurAssistant) {
    aveCurAssistant.trace = aveCurAssistant.trace || [];
    aveCurAssistant.trace.push({ t: text, cls: cls || '' });
    aveSaveThrottled();
  }
}

function aveSbHint(text) {
  const el = document.createElement('div');
  el.className = 'ave-hint';
  el.textContent = text;
  aveSbMsgs().appendChild(el);
}

function aveSbStatus(text, cls) {
  const el = aveSb.querySelector('.ave-sb-status');
  el.className = 'ave-sb-status' + (cls ? ' ' + cls : '');
  el.textContent = text || '';
}

/** Render the context-usage meter (and persist it). */
function aveSbSetUsage(u) {
  aveSbUsage = u || null;
  const box = aveSb.querySelector('.ave-sb-ctx');
  if (!u || u.pct == null) { box.hidden = true; aveSaveThrottled(); return; }
  box.hidden = false;
  box.classList.remove('warn', 'danger');
  if (u.pct >= 90) box.classList.add('danger');
  else if (u.pct >= 70) box.classList.add('warn');
  box.querySelector('.ave-ctx-fill').style.width = Math.max(2, u.pct) + '%';
  box.querySelector('.ave-ctx-text').textContent =
    `context ${u.pct}% · ${aveFmtTok(u.contextTokens)}/${aveFmtTok(u.contextWindow)}` +
    (u.costUsd != null ? ` · $${u.costUsd.toFixed(3)}` : '');
  aveSaveThrottled();
}

function aveFmtTok(n) {
  n = n || 0;
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
}

function aveSbSetBusy(busy) {
  aveSb.querySelector('.ave-sb-send').disabled = busy;
}

function aveSbToolArg(input) {
  if (!input) return '';
  const f = input.file_path || input.path || input.pattern || '';
  return f ? `(${f})` : '';
}

function aveSbEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the sidebar as soon as this bundle runs (script is at end of <body>).
aveInitSidebar();
