/* ===== overlay.js — main controller =====
   Toggle with Ctrl+Shift+E. Concatenated last in the bundle, so the helpers
   from highlight.js and popup.js are already defined. */

let aveActive = false;
let aveHoverEl = null;

/** Build a reasonably unique CSS selector for an element. */
function aveGetSelector(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 4) {
    let part = node.tagName.toLowerCase();
    const cls = Array.from(node.classList)
      .filter((c) => !c.startsWith('ave-'))
      .slice(0, 2);
    if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');

    // Disambiguate among same-type siblings with :nth-of-type.
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    if (node.id) {
      parts[0] = `#${CSS.escape(node.id)}`;
      break;
    }
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Pull the 10 most relevant computed styles. */
function aveCollectCss(el) {
  const cs = window.getComputedStyle(el);
  const keys = [
    'display', 'position', 'color', 'background-color', 'background',
    'font-size', 'font-weight', 'padding', 'margin', 'border-radius',
  ];
  const out = {};
  for (const k of keys) {
    const v = cs.getPropertyValue(k);
    if (v) out[k] = v.trim();
  }
  return out;
}

/** Guess which source file owns this element. */
function aveGuessFile(el) {
  // 1. explicit hint
  const withAttr = el.closest('[data-file]');
  if (withAttr) return withAttr.getAttribute('data-file');
  // 2. fall back to the current page path.
  let p = window.location.pathname;
  if (!p || p === '/' || p.endsWith('/')) p += 'index.html';
  return p.replace(/^\//, '');
}

/** Collect everything Claude needs about the clicked element. */
function aveCollectContext(el) {
  let html = el.outerHTML || '';
  if (html.length > 500) html = html.slice(0, 500) + '…(truncated)';
  return {
    selector: aveGetSelector(el),
    classList: Array.from(el.classList).filter((c) => !c.startsWith('ave-')),
    html,
    css: aveCollectCss(el),
    file: aveGuessFile(el),
  };
}

// ---- Event handlers ----
function aveOnMove(e) {
  if (!aveActive) return;
  const el = e.target;
  if (aveIsIgnored(el)) {
    aveHideHighlight();
    aveHoverEl = null;
    return;
  }
  aveHoverEl = el;
  aveShowHighlight(el);
}

function aveOnClick(e) {
  if (!aveActive) return;
  const el = e.target;
  if (aveIsIgnored(el)) return; // let clicks inside the popup work
  e.preventDefault();
  e.stopPropagation();
  const ctx = aveCollectContext(el);
  aveAttachElement(ctx); // hand off to the chat sidebar (sidebar.js)
}

function aveOnScrollResize() {
  if (aveActive && aveHoverEl) aveShowHighlight(aveHoverEl);
}

function aveSetActive(on) {
  aveActive = on;
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (!on) aveHideHighlight();
  // Keep the sidebar's pick button in sync (sidebar.js owns the button).
  const pick = document.querySelector('#ave-sidebar .ave-sb-pick');
  if (pick) pick.classList.toggle('active', on);
  console.log(`[AVE] overlay ${on ? 'ON' : 'OFF'}`);
}

// ---- Wiring ----
document.addEventListener('mousemove', aveOnMove, true);
document.addEventListener('click', aveOnClick, true);
window.addEventListener('scroll', aveOnScrollResize, true);
window.addEventListener('resize', aveOnScrollResize, true);

document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+E toggles the overlay.
  if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
    e.preventDefault();
    aveSetActive(!aveActive);
  }
  // Esc turns the picker off (the sidebar stays; minimize it with its — button).
  if (e.key === 'Escape' && aveActive) {
    aveSetActive(false);
  }
});

// ---- Hot reload client ----
(function aveConnectHotReload() {
  const cfg = window.__AVE_CONFIG__ || {};
  if (!cfg.wsUrl) return;
  try {
    const ws = new WebSocket(cfg.wsUrl);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'reload') {
          // Defer reload while a chat task is streaming, so we don't drop the
          // rest of the stream (final summary + session id) and can persist it.
          if (typeof aveSbBusy !== 'undefined' && aveSbBusy) {
            avePendingReload = true;
            console.log('[AVE] change during task — reload deferred until done');
            return;
          }
          console.log('[AVE] reloading after change:', data.file);
          location.reload();
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => setTimeout(aveConnectHotReload, 1500); // auto-reconnect
  } catch (err) {
    console.warn('[AVE] hot-reload socket failed:', err.message);
  }
})();

console.log('%c[AVE] AI Visual Editor loaded — press Ctrl+Shift+E to start', 'color:#3b82f6;font-weight:bold');
