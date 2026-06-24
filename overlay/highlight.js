/* ===== highlight.js — Figma-style hover highlight =====
   Concatenated into the overlay bundle; shares scope with overlay.js/popup.js. */

let aveHighlightEl = null;
let aveLabelEl = null;

function aveEnsureHighlightEls() {
  if (!aveHighlightEl) {
    aveHighlightEl = document.createElement('div');
    aveHighlightEl.id = 'ave-highlight';
    document.body.appendChild(aveHighlightEl);
  }
  if (!aveLabelEl) {
    aveLabelEl = document.createElement('div');
    aveLabelEl.id = 'ave-label';
    document.body.appendChild(aveLabelEl);
  }
}

/** Should this element be ignored by the highlighter? */
function aveIsIgnored(el) {
  if (!el || el === document.body || el === document.documentElement) return true;
  // Ignore the overlay's own UI.
  return Boolean(el.closest && el.closest('#ave-sidebar, #ave-fab, #ave-highlight, #ave-label'));
}

/** Draw the blue outline + selector/size label over `el`. */
function aveShowHighlight(el) {
  aveEnsureHighlightEls();
  const r = el.getBoundingClientRect();

  aveHighlightEl.style.display = 'block';
  aveHighlightEl.style.left = r.left + 'px';
  aveHighlightEl.style.top = r.top + 'px';
  aveHighlightEl.style.width = r.width + 'px';
  aveHighlightEl.style.height = r.height + 'px';

  const sel = aveGetSelector(el); // defined in overlay.js
  aveLabelEl.textContent = `${sel}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  aveLabelEl.style.display = 'block';

  // Position label just above the element, or below if there's no room.
  const labelTop = r.top - 22 < 4 ? r.top + 4 : r.top - 22;
  aveLabelEl.style.left = Math.max(4, r.left) + 'px';
  aveLabelEl.style.top = labelTop + 'px';
}

function aveHideHighlight() {
  if (aveHighlightEl) aveHighlightEl.style.display = 'none';
  if (aveLabelEl) aveLabelEl.style.display = 'none';
}
