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
let aveSbModel = null;       // model alias the sidebar sends with each task
let aveThreads = { activeId: null, threads: [] }; // per-project chat threads
let aveActiveId = null;      // id of the active thread
const AVE_MAX_MSGS = 200;
// Models the picker offers. Labels are cosmetic; values must match the
// server's ALLOWED_MODELS. /status may narrow/confirm this list at runtime.
const AVE_MODELS = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
];

function aveSbCfg() { return window.__AVE_CONFIG__ || {}; }

/* ---- persistence: one project keeps multiple chat threads ---- */
function aveThreadsKey() { return 'ave-threads:' + (aveSbCfg().projectId || 'default'); }
function aveLegacyKey() { return 'ave-chat:' + (aveSbCfg().projectId || 'default'); }
function aveNewId() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function aveThreadTitle(msgs) {
  const first = (msgs || []).find((m) => m.role === 'user');
  const t = first ? String(first.text || '').replace(/\s+/g, ' ').trim() : '';
  return t ? (t.length > 42 ? t.slice(0, 42) + '…' : t) : 'New chat';
}
function aveBlankThread() {
  return { id: aveNewId(), title: 'New chat', sessionId: null, messages: [], usage: null, attached: null, open: true, updatedAt: Date.now() };
}
function aveSaveThreads() { try { localStorage.setItem(aveThreadsKey(), JSON.stringify(aveThreads)); } catch {} }
function aveActiveThread() { return aveThreads.threads.find((x) => x.id === aveActiveId) || null; }

/** Load all threads for this project (migrating the old single-chat store). */
function aveLoadThreads() {
  try {
    const raw = localStorage.getItem(aveThreadsKey());
    if (raw) { const s = JSON.parse(raw); if (s && Array.isArray(s.threads)) return s; }
  } catch {}
  try { // migrate legacy single chat
    const old = JSON.parse(localStorage.getItem(aveLegacyKey()) || 'null');
    if (old && Array.isArray(old.messages) && old.messages.length) {
      const t = { id: aveNewId(), title: aveThreadTitle(old.messages), sessionId: old.sessionId || null,
        messages: old.messages, usage: old.usage || null, attached: old.attached || null, open: old.open !== false, updatedAt: Date.now() };
      return { activeId: t.id, threads: [t] };
    }
  } catch {}
  return { activeId: null, threads: [] };
}

/** Persist the current working state into the active thread. */
function aveSaveState() {
  const t = aveActiveThread();
  if (!t) return;
  t.messages = aveChatLog.slice(-AVE_MAX_MSGS);
  t.sessionId = aveSbSession;
  t.usage = aveSbUsage;
  t.attached = aveSbAttached;
  t.open = aveSb ? aveSb.classList.contains('open') : true;
  t.title = aveThreadTitle(aveChatLog);
  t.updatedAt = Date.now();
  aveThreads.activeId = aveActiveId;
  aveSaveThreads();
}
function aveSaveThrottled() {
  if (aveSaveTimer) return;
  aveSaveTimer = setTimeout(() => { aveSaveTimer = null; aveSaveState(); }, 300);
}

/* Model choice persists separately so clearing the chat keeps it. */
function aveModelKey() { return 'ave-model:' + (aveSbCfg().projectId || 'default'); }
function aveLoadModel() { try { return localStorage.getItem(aveModelKey()) || null; } catch { return null; } }
function aveSaveModel(m) { try { localStorage.setItem(aveModelKey(), m); } catch {} }

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
      <select class="ave-sb-model" title="Model Claude uses for edits">
        ${AVE_MODELS.map((m) => `<option value="${aveSbEsc(m.value)}">${aveSbEsc(m.label)}</option>`).join('')}
      </select>
      <button class="ave-sb-new" title="New chat (fresh context)">＋</button>
      <button class="ave-sb-hist" title="Chat history">🕘</button>
      <button class="ave-sb-min" title="Minimize">—</button>
    </div>
    <div class="ave-sb-histmenu" hidden>
      <div class="ave-hm-head"><span>Chats</span><button class="ave-hm-close" title="Close">×</button></div>
      <div class="ave-hm-list"></div>
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
  aveSb.querySelector('.ave-sb-new').onclick = aveNewChat;
  aveSb.querySelector('.ave-sb-hist').onclick = aveToggleHistoryMenu;
  aveSb.querySelector('.ave-hm-close').onclick = aveCloseHistoryMenu;
  aveSb.querySelector('.ave-hm-list').addEventListener('click', (e) => {
    const del = e.target.closest('.ave-hm-del');
    if (del) { e.stopPropagation(); aveDeleteThread(del.dataset.id); return; }
    const item = e.target.closest('.ave-hm-item');
    if (item) aveSwitchThread(item.dataset.id);
  });
  aveSb.querySelector('.ave-sb-send').onclick = aveSbSend;
  aveSb.querySelector('.ave-sb-pick').onclick = aveSbTogglePick;

  // Model picker — remember the choice per project, independent of the chat.
  const modelSel = aveSb.querySelector('.ave-sb-model');
  aveSbModel = aveLoadModel();
  if (aveSbModel) modelSel.value = aveSbModel;
  aveSbModel = modelSel.value; // fall back to the first option if saved value is gone
  modelSel.onchange = () => {
    aveSbModel = modelSel.value;
    aveSaveModel(aveSbModel);
    aveSbStatus('Model: ' + (modelSel.options[modelSel.selectedIndex]?.text || aveSbModel));
  };

  const input = aveSb.querySelector('.ave-sb-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aveSbSend(); }
  });

  // Load chat threads for this project and restore the active one.
  aveThreads = aveLoadThreads();
  if (!aveThreads.threads.length) { const t = aveBlankThread(); aveThreads = { activeId: t.id, threads: [t] }; }
  aveActiveId = aveThreads.activeId || aveThreads.threads[0].id;
  aveSaveThreads();
  const active = aveActiveThread();
  aveLoadActiveIntoUI();
  aveCheckServer();
  aveToggleSidebar(!(active && active.open === false)); // default open
}

/** Load the active thread's transcript/session/context into the UI. */
function aveLoadActiveIntoUI() {
  const t = aveActiveThread();
  aveChatLog = (t && t.messages) || [];
  aveSbSession = (t && t.sessionId) || null;
  aveSbAttached = (t && t.attached) || null;
  aveCurAssistant = null;
  const chip = aveSb.querySelector('.ave-sb-chip');
  if (aveSbAttached) aveRestoreAttachment(aveSbAttached); else chip.hidden = true;
  aveSbMsgs().innerHTML = '';
  if (aveChatLog.length) aveRenderLog();
  else aveSbHint('Describe a change, or pick an element. This is a fresh context.');
  aveSbSetUsage((t && t.usage) || null);
}

/** Start a brand-new chat with a fresh Claude context. */
function aveNewChat() {
  aveSaveState();
  const t = aveBlankThread();
  aveThreads.threads.unshift(t);
  aveActiveId = t.id; aveThreads.activeId = t.id;
  aveLoadActiveIntoUI();
  aveSaveThreads();
  aveCloseHistoryMenu();
  aveSbStatus('New chat — fresh context');
  setTimeout(() => aveSb.querySelector('.ave-sb-input')?.focus(), 50);
}

function aveSwitchThread(id) {
  if (id === aveActiveId) { aveCloseHistoryMenu(); return; }
  aveSaveState();
  aveActiveId = id; aveThreads.activeId = id;
  aveLoadActiveIntoUI();
  aveSaveThreads();
  aveCloseHistoryMenu();
}

/** Permanently delete a chat thread. */
function aveDeleteThread(id) {
  const t = aveThreads.threads.find((x) => x.id === id);
  if (!t) return;
  if (!confirm('Delete this chat permanently?\n\n' + (t.title || 'New chat'))) return;
  aveThreads.threads = aveThreads.threads.filter((x) => x.id !== id);
  if (id === aveActiveId) {
    if (!aveThreads.threads.length) aveThreads.threads.push(aveBlankThread());
    aveActiveId = aveThreads.threads[0].id; aveThreads.activeId = aveActiveId;
    aveLoadActiveIntoUI();
  }
  aveSaveThreads();
  aveRenderHistoryMenu();
}

function aveRenderHistoryMenu() {
  const list = aveSb.querySelector('.ave-hm-list');
  if (!aveThreads.threads.length) { list.innerHTML = '<div class="ave-hm-empty">No chats yet</div>'; return; }
  const sorted = aveThreads.threads.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  list.innerHTML = sorted.map((t) => `
    <div class="ave-hm-item ${t.id === aveActiveId ? 'active' : ''}" data-id="${aveSbEsc(t.id)}">
      <span class="ave-hm-title">${aveSbEsc(t.title || 'New chat')}</span>
      <button class="ave-hm-del" data-id="${aveSbEsc(t.id)}" title="Delete permanently">×</button>
    </div>`).join('');
}

function aveToggleHistoryMenu() {
  const m = aveSb.querySelector('.ave-sb-histmenu');
  if (m.hasAttribute('hidden')) { aveRenderHistoryMenu(); m.removeAttribute('hidden'); }
  else m.setAttribute('hidden', '');
}
function aveCloseHistoryMenu() {
  const m = aveSb.querySelector('.ave-sb-histmenu');
  if (m) m.setAttribute('hidden', '');
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

/** Reconcile the model picker with the server's allowed list + default. */
function aveSyncModels(models, defaultModel) {
  const sel = aveSb && aveSb.querySelector('.ave-sb-model');
  if (!sel) return;
  if (Array.isArray(models) && models.length) {
    const label = (v) => (AVE_MODELS.find((m) => m.value === v)?.label) || (v.charAt(0).toUpperCase() + v.slice(1));
    sel.innerHTML = models
      .map((v) => `<option value="${aveSbEsc(v)}">${aveSbEsc(label(v))}</option>`)
      .join('');
  }
  const saved = aveLoadModel();
  const has = (v) => v && [...sel.options].some((o) => o.value === v);
  // Saved choice wins; otherwise follow the server default.
  sel.value = has(saved) ? saved : (has(defaultModel) ? defaultModel : sel.options[0]?.value || '');
  aveSbModel = sel.value;
}

async function aveCheckServer() {
  const dot = aveSb.querySelector('.ave-sb-dot');
  try {
    const r = await fetch((aveSbCfg().serverUrl || '') + '/status');
    const s = await r.json();
    dot.className = 'ave-sb-dot ' + (s.cliAvailable ? 'ok' : 'bad');
    aveSyncModels(s.models, s.model);
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
        model: aveSbModel || undefined,
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
