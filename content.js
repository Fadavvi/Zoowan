/**
 * Zoowan — content script.
 * Watches for text selections inside editable areas (input / textarea / contenteditable)
 * and shows a floating toolbar with AI actions. Results are rendered in an isolated
 * Shadow DOM so page CSS cannot break the UI (and vice versa).
 */
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  if (window.__zoowanLoaded) return;
  window.__zoowanLoaded = true;

  const MIN_CHARS = 2;

  // ---------------------------------------------------------------- state
  let hostEl = null;
  let shadow = null;
  const els = {};
  const actionButtons = {};
  let savedRange = null;      // cloned range of the selection when the toolbar is shown
  let currentEditable = null; // the editable element that owns the selection
  let reqCounter = 0;
  let activeReqId = null;
  let visible = false;

  // Google Docs canvas-variant state (document rendered to <canvas>, no native DOM selection).
  let gdocsSel = null;     // {start, end} model offsets of the current Google-Docs selection
  let lastPointer = null;  // {x, y} last pointerup/mouseup client coords (canvas anchor)

  // Whole-area mode state: a corner icon docked to the focused editable element.
  // Clicking it opens the menu with the ENTIRE field content as input.
  let cornerTarget = null; // currently focused editable element (corner-icon anchor)
  let cornerMode = false;  // toolbar was opened from the corner icon → actions use the whole area

  // ---------------------------------------------------------------- ignored URLs
  // Pages whose URL matches an entry in lg_ignoredUrls stay silent: no toolbar, no popup.
  // An entry ignores every page on the same origin whose path starts with the entry's path:
  //   https://pastebin.com                      → whole site
  //   https://docs.google.com/document/d/ABC123 → just that document (query params don't matter)
  let ignoredUrls = [];
  function isUrlIgnored() {
    if (!ignoredUrls.length) return false;
    for (const entry of ignoredUrls) {
      try {
        const e = new URL(entry);
        if (e.origin !== location.origin) continue;
        if (location.pathname.startsWith(e.pathname || '/')) return true;
      } catch (_) {}
    }
    return false;
  }
  api.storage.local.get('lg_ignoredUrls').then((s) => {
    ignoredUrls = (s && Array.isArray(s.lg_ignoredUrls)) ? s.lg_ignoredUrls.filter((x) => typeof x === 'string') : [];
  }).catch(() => {});
  if (api.storage.onChanged) api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.lg_ignoredUrls) return;
    const v = changes.lg_ignoredUrls.newValue;
    ignoredUrls = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    if (isUrlIgnored()) hideAll(); // ignore list changed while the popup was open
  });

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue;
        if (k === 'class') node.className = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ---------------------------------------------------------------- styles
  const CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; display: block; margin: 0; padding: 0; border: none; background: transparent; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .lg-wrap { display: flex; flex-direction: column; gap: 6px; align-items: stretch; width: max-content; max-width: min(920px, calc(100vw - 20px)); }
    .lg-hidden { display: none !important; }

    .lg-toolbar { display: flex; align-items: center; flex-wrap: wrap; row-gap: 4px; column-gap: 2px; padding: 6px; background: #ffffff; border: 1px solid rgba(17,24,39,.10); border-radius: 12px; box-shadow: 0 10px 28px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.10); }
    .lg-brand { font-size: 13px; color: #4f46e5; padding: 0 2px 0 7px; user-select: none; flex: none; }
    .lg-btn { appearance: none; border: none; background: transparent; padding: 6px 9px; border-radius: 8px; font-size: 13px; line-height: 1.2; color: #1f2937; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: background .12s ease, transform .05s ease; }
    .lg-btn:hover { background: #eef2ff; }
    .lg-btn:active { transform: scale(.97); }
    .lg-btn[disabled] { opacity: .45; cursor: default; pointer-events: none; }
    .lg-icon-btn { padding: 7px 8px; font-size: 13px; line-height: 1; }
    .lg-sep { width: 1px; height: 20px; background: rgba(17,24,39,.12); margin: 0 5px; flex: none; }

    .lg-panel { display: flex; flex-direction: column; max-height: min(70vh, 560px); background: #ffffff; border: 1px solid rgba(17,24,39,.10); border-radius: 12px; box-shadow: 0 10px 28px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.10); overflow: hidden; }
    .lg-panel-header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid rgba(17,24,39,.08); background: #f8fafc; }
    .lg-title { font-size: 13px; font-weight: 600; color: #111827; flex: 1; display: inline-flex; align-items: center; gap: 7px; min-width: 0; }
    .lg-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #c7d2fe; border-top-color: #4f46e5; animation: lgspin .8s linear infinite; display: inline-block; flex: none; }
    @keyframes lgspin { to { transform: rotate(360deg); } }

    .lg-custom { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(17,24,39,.08); }
    .lg-prompt { width: 100%; min-height: 56px; max-height: 150px; resize: vertical; border: 1px solid rgba(17,24,39,.16); border-radius: 8px; padding: 8px 10px; font-size: 13px; line-height: 1.5; color: #111827; background: transparent; outline: none; }
    .lg-prompt:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,.15); }
    .lg-clean { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: #4b5563; cursor: pointer; user-select: none; }
    .lg-clean input { accent-color: #4f46e5; margin: 0; width: 14px; height: 14px; flex: none; }
    .lg-prompt[disabled], .lg-result[disabled] { opacity: .65; }

    .lg-result { width: 100%; min-height: 76px; max-height: 320px; resize: vertical; border: none; outline: none; padding: 12px 14px; font-size: 14px; line-height: 1.55; color: #111827; background: transparent; }
    .lg-result:focus { box-shadow: inset 0 0 0 2px #c7d2fe; border-radius: 6px; }

    .lg-panel-footer { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-top: 1px solid rgba(17,24,39,.08); background: #f8fafc; }
    .lg-accept { appearance: none; background: #4f46e5; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; display: inline-flex; gap: 7px; align-items: center; }
    .lg-accept:hover { background: #4338ca; }
    .lg-accept[disabled] { opacity: .5; cursor: default; }
    .lg-secondary { appearance: none; background: #fff; border: 1px solid rgba(17,24,39,.16); color: #374151; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
    .lg-secondary:hover { background: #f3f4f6; }
    .lg-hint { margin-left: auto; font-size: 11px; color: #9ca3af; user-select: none; }

    .lg-error { padding: 12px 14px; font-size: 13px; line-height: 1.5; color: #b91c1c; background: #fef2f2; border-top: 1px solid rgba(17,24,39,.08); white-space: pre-wrap; word-break: break-word; }

    .lg-corner { position: fixed; z-index: 2147483647; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: #ffffff; color: #4f46e5; border: 1px solid rgba(17,24,39,.14); box-shadow: 0 6px 18px rgba(15,23,42,.25), 0 2px 5px rgba(15,23,42,.12); cursor: pointer; font-size: 14px; line-height: 1; padding: 0; user-select: none; transition: transform .1s ease, background .12s ease; }
    .lg-corner:hover { transform: scale(1.1); background: #eef2ff; }
    .lg-corner:active { transform: scale(.95); }

    @media (prefers-color-scheme: dark) {
      .lg-toolbar, .lg-panel { background: #1f2937; border-color: rgba(255,255,255,.08); }
      .lg-btn { color: #e5e7eb; }
      .lg-btn:hover { background: #374151; }
      .lg-brand { color: #a5b4fc; }
      .lg-sep { background: rgba(255,255,255,.14); }
      .lg-panel-header, .lg-panel-footer { background: #111827; border-color: rgba(255,255,255,.06); }
      .lg-title { color: #e5e7eb; }
      .lg-prompt { color: #e5e7eb; border-color: rgba(255,255,255,.18); }
      .lg-clean { color: #9ca3af; }
      .lg-result { color: #e5e7eb; }
      .lg-secondary { background: transparent; border-color: rgba(255,255,255,.18); color: #d1d5db; }
      .lg-secondary:hover { background: #1f2937; }
      .lg-hint { color: #6b7280; }
      .lg-error { background: #2a1416; color: #fca5a5; border-color: rgba(255,255,255,.06); }
      .lg-corner { background: #1f2937; color: #a5b4fc; border-color: rgba(255,255,255,.12); }
      .lg-corner:hover { background: #374151; }
    }
  `;

  // ---------------------------------------------------------------- UI build
  function ensureHost() {
    if (hostEl && document.documentElement.contains(hostEl)) return;
    hostEl = el('div', { id: 'zoowan-host' });
    Object.assign(hostEl.style, {
      all: 'initial', display: 'block', position: 'fixed', zIndex: '2147483647',
      top: '-9999px', left: '-9999px', margin: '0', padding: '0'
    });

    shadow = hostEl.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet]; // not subject to page CSP
    } catch (_) {
      shadow.appendChild(el('style', {}, CSS));
    }

    // Keep the page selection alive while interacting with the popup,
    // except when focusing the result textarea (which needs real focus).
    shadow.addEventListener('mousedown', (e) => {
      const t = e.target;
      // Let the two textareas take real focus; everything else keeps page selection alive.
      if ((els.result && els.result.contains(t)) || (els.promptInput && els.promptInput.contains(t))) return;
      e.preventDefault();
    }, true);

    const toolbar = el('div', { class: 'lg-toolbar' });
    toolbar.appendChild(el('span', { class: 'lg-brand', title: 'Zoowan — local LLM writing assistant' }, '✦'));
    for (const key of LG_ACTION_ORDER) {
      const a = LG_ACTIONS[key];
      const btn = el('button', {
        class: 'lg-btn', type: 'button', title: a.label,
        onclick: () => startAction(key)
      }, a.icon + '\u00a0' + a.label);
      actionButtons[key] = btn;
      toolbar.appendChild(btn);
    }
    els.customBtn = el('button', {
      class: 'lg-btn', type: 'button', title: 'Use your own prompt',
      onclick: openCustom
    }, '✍️\u00a0Custom');
    toolbar.appendChild(els.customBtn);
    toolbar.appendChild(el('span', { class: 'lg-sep' }));

    const closeBtn = el('button', {
      class: 'lg-btn lg-icon-btn', type: 'button', title: 'Close (Esc)',
      onclick: hideAll
    }, '✕');
    toolbar.appendChild(closeBtn);

    // ---- result panel
    const header = el('div', { class: 'lg-panel-header' });
    els.spinner = el('span', { class: 'lg-spinner lg-hidden' });
    els.titleText = el('span', {}, '');
    header.appendChild(els.spinner);
    header.appendChild(el('span', { class: 'lg-title' }, els.titleText));
    els.cancelBtn = el('button', {
      class: 'lg-btn lg-icon-btn lg-hidden', type: 'button', title: 'Cancel request',
      onclick: cancelRequest
    }, '⏹');
    header.appendChild(els.cancelBtn);

    // Custom prompt section (visible only in custom mode)
    els.customSection = el('div', { class: 'lg-custom lg-hidden' });
    els.promptInput = el('textarea', {
      class: 'lg-prompt', spellcheck: 'false',
      placeholder: 'e.g. Translate this to German · Make it rhyme · Summarize in one sentence'
    });
    els.promptInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCustom(); }
    });
    els.cleanInput = el('input', { type: 'checkbox' });
    els.cleanInput.checked = true;
    const cleanLabel = el('label', { class: 'lg-clean' }, els.cleanInput, el('span', {}, 'Clean output — only the result, no commentary'));
    els.customSection.appendChild(els.promptInput);
    els.customSection.appendChild(cleanLabel);

    els.result = el('textarea', { class: 'lg-result', spellcheck: 'false' });
    els.result.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); acceptResult(); }
    });

    const footer = el('div', { class: 'lg-panel-footer' });
    els.runBtn = el('button', { class: 'lg-accept lg-hidden', type: 'button', title: 'Run custom prompt (Ctrl+Enter)' }, '▶ Run');
    els.runBtn.addEventListener('click', runCustom);
    els.acceptBtn = el('button', { class: 'lg-accept', type: 'button', title: 'Replace selection (Ctrl+Enter)', disabled: '' }, '✓ Accept');
    els.acceptBtn.addEventListener('click', acceptResult);
    els.copyBtn = el('button', { class: 'lg-secondary', type: 'button', disabled: '' }, 'Copy');
    els.copyBtn.addEventListener('click', copyResult);
    els.dismissBtn = el('button', { class: 'lg-secondary', type: 'button', title: 'Dismiss (Esc)' }, '✕ Dismiss');
    els.dismissBtn.addEventListener('click', hideAll);
    footer.appendChild(els.runBtn);
    footer.appendChild(els.acceptBtn);
    footer.appendChild(els.copyBtn);
    footer.appendChild(el('span', { class: 'lg-hint' }, 'Ctrl+Enter to accept'));
    footer.appendChild(els.dismissBtn);

    els.errorBox = el('div', { class: 'lg-error lg-hidden' });

    const panel = el('div', { class: 'lg-panel lg-hidden' }, header, els.customSection, els.result, footer, els.errorBox);
    els.panel = panel;

    const wrap = el('div', { class: 'lg-wrap' }, toolbar, panel);
    els.wrap = wrap;
    els.toolbar = toolbar;

    // Restore the last custom prompt (best-effort; defaults apply until it loads).
    api.storage.local.get('lg_customPrompt').then((s) => {
      const c = (s && s.lg_customPrompt) || {};
      if (typeof c.prompt === 'string') els.promptInput.value = c.prompt;
      if (typeof c.clean === 'boolean') els.cleanInput.checked = c.clean;
    }).catch(() => {});

    // Whole-area corner icon (fixed-positioned inside this shadow root, viewport coordinates).
    els.corner = el('button', {
      class: 'lg-corner lg-hidden', type: 'button',
      title: 'Zoowan — apply to the whole text of this field',
      onmousedown: (e) => e.preventDefault(), // keep focus on the page's editable element
      onclick: openCornerMenu
    }, '✦');

    shadow.appendChild(wrap);
    shadow.appendChild(els.corner);
    document.documentElement.appendChild(hostEl);
  }

  // ---------------------------------------------------------------- selection detection
  function getEditableAncestor(node) {
    let n = node && (node.nodeType === Node.TEXT_NODE ? node.parentElement : node);
    while (n && n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return n;
      if (n.isContentEditable) return n;
      n = n.parentElement;
    }
    return null;
  }

  function getSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    // Ignore selections made inside our own popup.
    if (hostEl && hostEl.contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().replace(/\u00a0/g, ' ');
    if (text.trim().length < MIN_CHARS) return null;

    // Fast path: selection fully inside one editable element → undo-friendly insertion.
    // Otherwise we still offer the toolbar and splice a text node into read-only DOM on accept.
    let editable = null;
    const startEl = getEditableAncestor(range.startContainer);
    const endEl = getEditableAncestor(range.endContainer);
    if (startEl && startEl === endEl) editable = startEl;
    return { range: range.cloneRange(), text, editable };
  }

  /** Fallback for <input>/<textarea>: window.getSelection() can be unreliable there,
   *  but selectionStart/selectionEnd on the focused control itself always work. */
  function getFormControlSelection() {
    const ae = document.activeElement;
    if (!ae || !ae.tagName) return null;
    // Google Docs auto-focuses its title field on load with a phantom selection — ignore it.
    if (ae.classList && ae.classList.contains('docs-title-input')) return null;
    const tag = ae.tagName.toLowerCase();
    if (tag === 'input') {
      const t = String(ae.type || 'text').toLowerCase();
      if (!['text', 'search', 'url', 'tel', 'email', 'password'].includes(t)) return null;
    } else if (tag !== 'textarea') {
      return null;
    }
    const s = ae.selectionStart, e = ae.selectionEnd;
    if (typeof s !== 'number' || typeof e !== 'number' || s === e) return null;
    const lo = Math.min(s, e), hi = Math.max(s, e);
    const text = String(ae.value == null ? '' : ae.value).substring(lo, hi);
    if (text.trim().length < MIN_CHARS) return null;
    const range = document.createRange();
    try { range.selectNodeContents(ae); } catch (_) {}
    return { range, text, editable: ae, formOffsets: [lo, hi] };
  }

  // ---------------------------------------------------------------- Google Docs canvas variant
  /** In the "canvas" renderer Google draws the page to <canvas> and keeps NO native DOM selection.
   *  The internal `_docs_annotate_getAnnotatedText` API lives in the PAGE's main world, which our
   *  isolated-world content script cannot see. So we inject a tiny bridge into the page that runs the
   *  calls there (with retry) and hands primitives back to us over shared DOM attributes
   *  (plain strings cross isolated-world boundaries reliably, unlike event detail objects). */
  const GDOCS_BRIDGE_SRC = `
    (function () {
      if (window.__zwGdocsBridge) return;
      window.__zwGdocsBridge = true;
      var rootEl = document.documentElement;
      function getApi() {
        var fn = window._docs_annotate_getAnnotatedText;
        if (typeof fn !== 'function') return Promise.resolve(null);
        return new Promise(function (resolve) {
          var tries = 0;
          (function attempt() {
            try {
              Promise.resolve(fn()).then(function (api) {
                if (api && typeof api.getText === 'function' && typeof api.getSelection === 'function') resolve(api); else next();
              }, next);
            } catch (_) { next(); }
            function next() { if (++tries < 6) setTimeout(attempt, 200); else resolve(null); }
          })();
        });
      }
      var lastId = null;
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].attributeName !== 'data-zw-gc') continue;
          var req; try { req = JSON.parse(rootEl.getAttribute('data-zw-gc')); } catch (_) { continue; }
          if (!req || !req.id || req.id === lastId) continue;
          lastId = req.id;
          getApi().then(function (api) {
            var value;
            if (!api) value = { ok: false };
            else if (req.cmd === 'snap') {
              try { value = { ok: true, text: String(api.getText()), sel: api.getSelection() }; }
              catch (err) { value = { ok: false, err: String((err && err.message) || err) }; }
            } else if (req.cmd === 'set') {
              var ok = false;
              try { if (typeof api.setSelection === 'function' && req.payload) { api.setSelection(req.payload.start, req.payload.end); ok = true; } } catch (_) {}
              value = { ok: ok };
            } else value = { ok: false };
            rootEl.setAttribute('data-zw-gr', JSON.stringify({ id: req.id, value: value }));
          });
        }
      }).observe(rootEl, { attributes: true, attributeFilter: ['data-zw-gc'] });
    })();
  `;

  let gdocsBridgeInjected = false;
  function ensureGdocsBridge() {
    if (gdocsBridgeInjected) return;
    gdocsBridgeInjected = true;
    try {
      const s = document.createElement('script');
      s.textContent = GDOCS_BRIDGE_SRC;
      (document.documentElement || document.head).appendChild(s);
      setTimeout(() => s.remove(), 0);
    } catch (_) {}
  }

  /** Ask the main-world bridge to run a command; resolves with its value or null on timeout.
   *  Request/response travel as JSON strings in data-* attributes (reliable across worlds). */
  function gdocsRequest(cmd, payload) {
    return new Promise((resolve) => {
      const rootEl = document.documentElement;
      const id = 'zw' + Math.random().toString(36).slice(2);
      let done = false;
      const finish = (v) => { if (!done) { done = true; obs.disconnect(); clearTimeout(timer); resolve(v); } };
      const onMut = () => {
        let res; try { res = JSON.parse(rootEl.getAttribute('data-zw-gr')); } catch (_) { return; }
        if (res && res.id === id) finish(res.value);
      };
      const obs = new MutationObserver(onMut);
      obs.observe(rootEl, { attributes: true, attributeFilter: ['data-zw-gr'] });
      const timer = setTimeout(() => finish(null), 2500);
      ensureGdocsBridge();
      try { rootEl.setAttribute('data-zw-gc', JSON.stringify({ id, cmd, payload })); } catch (_) {}
    });
  }

  function isGoogleDocsHost() {
    return /google\./.test(location.hostname) && location.pathname.indexOf('/document/') === 0;
  }

  /** Read the current Google-Docs selection: {start, end, text} or null.
   *  The bridge returns the whole document plus model char offsets; we slice out the selection. */
  async function getGdocsSelection() {
    if (!isGoogleDocsHost()) return null;
    const snap = await gdocsRequest('snap');
    if (!snap || !snap.ok) return null;
    const full = String(snap.text == null ? '' : snap.text);
    const selArr = Array.isArray(snap.sel) ? snap.sel : [];
    const r = selArr.find((x) => x && typeof x.start === 'number' && typeof x.end === 'number' && x.end > x.start);
    if (!r) return null;
    const text = full.substring(r.start, r.end).replace(/\u00a0/g, ' ');
    if (text.trim().length < MIN_CHARS) return null;
    return { start: r.start, end: r.end, text };
  }

  /** Locate the hidden [contenteditable] input surface Google Docs routes keyboard/input through. */
  function findGdocsEditable() {
    function walk(doc) {
      let ce = null;
      try {
        const cands = doc.querySelectorAll('[contenteditable]');
        for (const c of cands) if (c.isContentEditable) { ce = c; break; }
      } catch (_) {}
      if (ce) return ce;
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (_) {}
      for (const f of frames) {
        let d = null; try { d = f.contentDocument; } catch (_) {}
        if (d) { const r = walk(d); if (r) return r; }
      }
      return null;
    }
    return walk(document);
  }

  /** Replace [start,end] of the Google-Docs model with newText via its input surface.
   *  Restores the selection through the bridge, then inserts via beforeinput (undo-friendly). */
  async function replaceGdocsText(start, end, newText) {
    try { await gdocsRequest('set', { start, end }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 250)); // let the model commit the restored selection
    const ce = findGdocsEditable();
    if (ce) {
      try {
        const ev = new InputEvent('beforeinput', { data: newText, inputType: 'insertText', bubbles: true, cancelable: true });
        if (ce.dispatchEvent(ev)) return; // handled → replaced
      } catch (_) {}
    }
    // Fallback: put the answer on the clipboard and paste over the (re-set) selection.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(newText).catch(() => {});
      document.execCommand('paste');
    } catch (_) {}
  }

  /** Unified selection capture across all three paths: DOM range, form control, Google-Docs canvas. */
  async function captureSelection() {
    let info = getSelectionInfo();
    if (!info) info = getFormControlSelection(); // bulletproof path for input/textarea
    if (!info && isGoogleDocsHost()) {
      const g = await getGdocsSelection();
      if (g) info = { text: g.text, editable: null, range: null, gdocs: true, start: g.start, end: g.end };
    }
    return info || null;
  }

  // ---------------------------------------------------------------- whole-area mode (corner icon)
  /** Capture the entire content of an editable element — input for "whole field" actions. */
  function captureWholeArea(ed) {
    ed = ed || cornerTarget;
    if (!ed || !document.documentElement.contains(ed)) return null;
    const tag = ed.tagName ? String(ed.tagName).toLowerCase() : '';
    let text, formOffsets = null;
    if (tag === 'input' || tag === 'textarea') {
      text = String(ed.value == null ? '' : ed.value);
      formOffsets = [0, text.length];
    } else if (ed.isContentEditable) {
      text = ed.innerText != null ? String(ed.innerText) : '';
    } else {
      return null;
    }
    const range = document.createRange();
    try { range.selectNodeContents(ed); } catch (_) {}
    if (!text || text.trim().length < MIN_CHARS) return null;
    return { text, editable: ed, range, formOffsets, wholeArea: true };
  }

  /** Open the action menu for the entire focused field (from the corner icon). */
  function openCornerMenu() {
    const info = captureWholeArea();
    if (!info) return;
    cornerMode = true;
    savedRange = info.range;
    currentEditable = info.editable;
    savedFormOffsets = info.formOffsets;
    gdocsSel = null;
    ensureHost();
    showToolbar(info); // anchors near the field (caret point at end of text / element rect)
  }

  function hasVisibleRect(ed) {
    try { const r = ed.getBoundingClientRect(); return r.width >= 16 && r.height >= 16; } catch (_) { return false; }
  }

  /** Dock the corner icon inside the bottom-right corner of the focused editable element. */
  function positionCorner() {
    if (!cornerTarget) return;
    const size = 30, pad = 8;
    let r; try { r = cornerTarget.getBoundingClientRect(); } catch (_) { return; }
    if (r.width < 4 || r.height < 4) { els.corner.classList.add('lg-hidden'); return; }
    let left = Math.round(r.right - size - pad);
    let top = Math.round(r.bottom - size - pad);
    if (left + size > window.innerWidth - 6) left = Math.max(6, Math.round(window.innerWidth - size - 6));
    if (top + size > window.innerHeight - 6) top = Math.max(6, Math.round(window.innerHeight - size - 6));
    els.corner.style.left = left + 'px';
    els.corner.style.top = top + 'px';
  }

  /** Show/hide the corner icon: only while a visible editable element has focus and no popup is open. */
  function updateCorner() {
    if (!els.corner) return;
    const on = !!cornerTarget && document.activeElement === cornerTarget && !visible && hasVisibleRect(cornerTarget);
    els.corner.classList.toggle('lg-hidden', !on);
    if (on) positionCorner();
  }

  let checkTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkSelection, 120);
  }

  function isInsideHost(e) {
    return !!(hostEl && e.target === hostEl); // shadow targets are retargeted to the host
  }

  let savedFormOffsets = null;

  /** Exhaustive diagnostics — visible in the page's devtools console (F12 → Console). */
  function logRejected() {
    const sel = window.getSelection();
    const ae = document.activeElement;
    const formSel = !!ae && !!ae.tagName && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') &&
      typeof ae.selectionStart === 'number' && ae.selectionStart !== ae.selectionEnd;
    if (!(sel && sel.rangeCount > 0 && !sel.isCollapsed) && !formSel) return; // nothing worth reporting

    let reason;
    if (!sel || sel.rangeCount === 0) {
      reason = 'no document selection (rangeCount=' + (sel ? sel.rangeCount : 'n/a') + ')';
    } else if (sel.isCollapsed) {
      reason = 'selection collapsed (caret only)';
    } else {
      const t = sel.toString().replace(/\u00a0/g, ' ').trim();
      const insidePopup = hostEl && hostEl.contains(sel.getRangeAt(0).commonAncestorContainer);
      reason = insidePopup ? 'inside Zoowan popup' : (t.length < MIN_CHARS ? 'too short (' + t.length + ' chars)' : 'no valid range');
    }
    if (ae && ae.tagName && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      reason += ' [activeElement: <' + ae.tagName.toLowerCase() + '> selectionStart=' + ae.selectionStart + ' selectionEnd=' + ae.selectionEnd + ']';
    }
    console.info('[Zoowan] selection ignored:', reason);
  }

  async function checkSelection() {
    if (isUrlIgnored()) { hideAll(); return; } // this page is on the ignore list — stay silent
    if (visible && cornerMode) return; // whole-area menu is open — only explicit close / focus loss dismisses it
    const info = await captureSelection();
    if (!info) { logRejected(); hideAll(); return; }
    savedRange = info.range || null;
    currentEditable = info.editable || null;
    savedFormOffsets = info.formOffsets || null;
    gdocsSel = info.gdocs ? { start: info.start, end: info.end } : null;
    ensureHost();
    showToolbar(info);
  }

  // ---------------------------------------------------------------- toolbar / panel
  /** Viewport coordinates of a caret offset inside an input/textarea, via a mirror div that
   *  replicates the control's exact text metrics (range rects are unreliable in form controls). */
  function getCaretPoint(element, offset) {
    if (typeof offset !== 'number' || offset < 0) return null;
    try {
      const style = window.getComputedStyle(element);
      const mirror = document.createElement('div');
      const props = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontStyle',
        'fontWeight', 'fontVariant', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'textTransform'];
      for (const p of props) mirror.style[p] = style[p];
      mirror.style.position = 'absolute';
      mirror.style.top = '-9999px';
      mirror.style.left = '0px';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.overflowWrap = 'break-word';
      mirror.textContent = String(element.value == null ? '' : element.value).slice(0, offset);
      const marker = document.createElement('span');
      marker.textContent = '\u200b'; // zero-width caret marker
      mirror.appendChild(marker);
      (document.body || document.documentElement).appendChild(mirror);
      const elRect = element.getBoundingClientRect();
      const x = elRect.left + marker.offsetLeft - element.scrollLeft;
      const yTop = elRect.top + marker.offsetTop - element.scrollTop;
      mirror.remove();
      const lh = parseFloat(style.lineHeight) || 20;
      // Pseudo-rect covering the caret's line: the toolbar docks just below it.
      return { left: x, right: x, top: yTop, bottom: yTop + lh };
    } catch (_) {
      return null;
    }
  }

  /** Positioning anchor for the popup: the caret point inside input/textarea (so the menu
   *  floats under the selected text itself), otherwise the selection's bounding rect. */
  function currentAnchorRect() {
    // Canvas variant has no DOM range rect — anchor under the pointer where the user released.
    if (gdocsSel && lastPointer) {
      return { left: lastPointer.x, right: lastPointer.x, top: lastPointer.y, bottom: lastPointer.y };
    }
    const ed = currentEditable;
    if (ed && ed.tagName && (ed.tagName === 'INPUT' || ed.tagName === 'TEXTAREA')) {
      let offsets = savedFormOffsets;
      if (!offsets && savedRange) offsets = [savedRange.startOffset, savedRange.endOffset];
      const point = getCaretPoint(ed, offsets ? Math.max(offsets[0], offsets[1]) : null);
      if (point) return point;
    }
    if (savedRange) {
      try { return savedRange.getBoundingClientRect(); } catch (_) {}
    }
    return null;
  }

  function positionAt(anchorRect) {
    const margin = 10;
    // Anchor scrolled out of view → park the popup off-screen.
    if (anchorRect.bottom < -margin || anchorRect.top > window.innerHeight + margin ||
        anchorRect.right < -margin || anchorRect.left > window.innerWidth + margin) {
      hostEl.style.top = '-9999px';
      hostEl.style.left = '-9999px';
      return;
    }
    hostEl.style.left = '0px';
    hostEl.style.top = '0px';
    const w = hostEl.offsetWidth || 320;
    const h = hostEl.offsetHeight || 48;
    let left = Math.round(anchorRect.left);
    let top = Math.round(anchorRect.bottom) + 6;
    if (left + w > window.innerWidth - margin) left = Math.max(margin, Math.round(window.innerWidth - w - margin));
    if (top + h > window.innerHeight - margin) {
      const above = anchorRect.top - h - 6;
      top = above >= margin ? Math.round(above) : margin;
    }
    hostEl.style.left = left + 'px';
    hostEl.style.top = top + 'px';
  }

  function showToolbar(info) {
    els.toolbar.classList.remove('lg-hidden');
    els.panel.classList.add('lg-hidden');
    for (const b of Object.values(actionButtons)) { b.disabled = false; }
    const anchor = currentAnchorRect();
    if (anchor) positionAt(anchor);
    visible = true;
    const kind = info.gdocs ? 'Google Docs canvas'
      : (info.wholeArea ? 'whole field <' + info.editable.tagName.toLowerCase() + '>'
        : (info.editable ? 'editable <' + info.editable.tagName.toLowerCase() + '>' : 'read-only DOM'));
    console.info('[Zoowan] toolbar shown (' + info.text.length + ' chars, ' + kind + ')');
    updateCorner(); // hide the corner icon while the menu is open
  }

  function hideAll() {
    if (!hostEl) return;
    hostEl.style.top = '-9999px';
    hostEl.style.left = '-9999px';
    els.toolbar.classList.add('lg-hidden');
    els.panel.classList.add('lg-hidden');
    visible = false;
    cornerMode = false;
    updateCorner(); // re-show the icon if an editable element still has focus
  }

  function setLoading(loading) {
    els.spinner.classList.toggle('lg-hidden', !loading);
    els.cancelBtn.classList.toggle('lg-hidden', !loading);
    for (const b of Object.values(actionButtons)) b.disabled = loading;
    els.customBtn.disabled = loading;
    els.promptInput.disabled = loading;
    els.cleanInput.disabled = loading;
    els.runBtn.disabled = loading;
  }

  // ---------------------------------------------------------------- actions
  /** Selection-based capture — or fresh whole-field content when the menu was opened from the corner icon. */
  async function captureForAction() {
    if (cornerMode) return captureWholeArea();
    return await captureSelection(); // DOM / form control / Google-Docs canvas
  }

  async function startAction(actionKey) {
    const info = await captureForAction();
    if (!info) return;
    savedRange = info.range || null;
    currentEditable = info.editable || null;
    savedFormOffsets = info.formOffsets || null;
    gdocsSel = info.gdocs ? { start: info.start, end: info.end } : null;

    const reqId = ++reqCounter;
    activeReqId = reqId;
    const action = LG_ACTIONS[actionKey];

    setCustomMode(false);
    els.toolbar.classList.add('lg-hidden');
    els.panel.classList.remove('lg-hidden');
    els.titleText.textContent = action.icon + '  ' + action.label;
    resetResultState();
    setLoading(true);
    handleResponse(reqId, { type: 'lg-llm', reqId, action: actionKey, text: info.text });

    const anchor = currentAnchorRect();
    if (anchor) positionAt(anchor);
  }

  function resetResultState() {
    els.result.value = '';
    els.result.disabled = true;
    els.acceptBtn.disabled = true;
    els.copyBtn.disabled = true;
    els.errorBox.textContent = '';
    els.errorBox.classList.add('lg-hidden');
  }

  /** Shared response handling for built-in and custom requests. */
  function handleResponse(reqId, payload) {
    api.runtime.sendMessage(payload)
      .then((res) => {
        if (activeReqId !== reqId) return; // stale response (cancelled or superseded)
        if (!res || !res.ok) throw new Error((res && res.error) || 'No response from Zoowan background.');
        els.result.value = res.text;
        els.result.disabled = false;
        els.acceptBtn.disabled = false;
        els.copyBtn.disabled = false;
      })
      .catch((err) => {
        if (activeReqId !== reqId) return;
        els.errorBox.textContent = '⚠️  ' + ((err && err.message) || String(err));
        els.errorBox.classList.remove('lg-hidden');
      })
      .finally(() => {
        if (activeReqId === reqId) { activeReqId = null; setLoading(false); }
      });
  }

  function setCustomMode(on) {
    els.customSection.classList.toggle('lg-hidden', !on);
    els.runBtn.classList.toggle('lg-hidden', !on);
  }

  async function openCustom() {
    const info = await captureForAction();
    if (!info) return;
    savedRange = info.range || null;
    currentEditable = info.editable || null;
    savedFormOffsets = info.formOffsets || null;
    gdocsSel = info.gdocs ? { start: info.start, end: info.end } : null;

    setCustomMode(true);
    els.toolbar.classList.add('lg-hidden');
    els.panel.classList.remove('lg-hidden');
    els.titleText.textContent = '✍️  Custom prompt';
    resetResultState();
    setLoading(false);
    const anchor = currentAnchorRect();
    if (anchor) positionAt(anchor);
  }

  async function runCustom() {
    const prompt = els.promptInput.value.trim();
    if (!prompt) { els.promptInput.focus(); return; }
    const info = await captureForAction();
    if (!info) {
      els.errorBox.textContent = '⚠️  No text selected — select some text and try again.';
      els.errorBox.classList.remove('lg-hidden');
      return;
    }
    savedRange = info.range || null;
    currentEditable = info.editable || null;
    savedFormOffsets = info.formOffsets || null;
    gdocsSel = info.gdocs ? { start: info.start, end: info.end } : null;

    const clean = els.cleanInput.checked;
    api.storage.local.set({ lg_customPrompt: { prompt, clean } }).catch(() => {});

    const reqId = ++reqCounter;
    activeReqId = reqId;
    resetResultState();
    setLoading(true);
    handleResponse(reqId, { type: 'lg-llm-custom', reqId, prompt, text: info.text, clean });
  }

  function cancelRequest() {
    if (activeReqId !== null) api.runtime.sendMessage({ type: 'lg-abort', reqId: activeReqId }).catch(() => {});
  }

  // ---------------------------------------------------------------- result handling
  function acceptResult() {
    const newText = els.result.value.replace(/^\s+|\s+$/g, '');
    if (!newText) return;
    // Google Docs canvas variant: no DOM range — replace via the model API + input surface.
    if (gdocsSel) {
      replaceGdocsText(gdocsSel.start, gdocsSel.end, newText);
      hideAll();
      return;
    }
    if (!savedRange) return;
    const range = savedRange.cloneRange();
    const editable = currentEditable;
    const sel = window.getSelection();

    if (editable && (editable.tagName === 'INPUT' || editable.tagName === 'TEXTAREA')) {
      // Native form control: restore the selection via setSelectionRange (the Range API is
      // unreliable for form controls), then insertText (undo-friendly) or setRangeText.
      const so = savedFormOffsets ? savedFormOffsets[0] : range.startOffset;
      const eo = savedFormOffsets ? savedFormOffsets[1] : range.endOffset;
      try { editable.focus(); } catch (_) {}
      let restored = false;
      try { editable.setSelectionRange(so, eo); restored = true; } catch (_) {}
      if (!restored) { try { sel.removeAllRanges(); sel.addRange(range); } catch (_2) {} }
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, newText); } catch (_) {}
      if (!inserted) {
        try { editable.setRangeText(newText, so, eo, 'end'); }
        catch (_) { editable.value = newText; }
        editable.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (editable && editable.isContentEditable) {
      // contenteditable: execCommand keeps native undo; fall back to node splicing.
      try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, newText); } catch (_) {}
      if (!inserted) {
        range.deleteContents();
        const frag = document.createDocumentFragment();
        frag.appendChild(document.createTextNode(newText));
        range.insertNode(frag);
        editable.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      // Read-only page text: splice a text node into the selection.
      range.deleteContents();
      const textNode = document.createTextNode(newText);
      range.insertNode(textNode);
      try {
        const r2 = document.createRange();
        r2.setStartAfter(textNode);
        r2.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r2);
      } catch (_) {}
    }
    hideAll();
  }

  async function copyResult() {
    const text = els.result.value;
    try {
      await navigator.clipboard.writeText(text);
      flashButton(els.copyBtn, 'Copied!');
    } catch (_) {
      const ta = el('textarea', {}, );
      Object.assign(ta.style, { position: 'fixed', opacity: '0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      flashButton(els.copyBtn, ok ? 'Copied!' : 'Copy failed');
    }
  }

  function flashButton(btn, label) {
    const old = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  // ---------------------------------------------------------------- events
  // Whole-area corner icon: follow focus between editable elements.
  document.addEventListener('focusin', (e) => {
    if (isInsideHost(e)) return; // focus inside our own popup
    const ed = getEditableAncestor(e.target);
    cornerTarget = ed || null;
    if (ed) ensureHost(); // make sure the shadow UI exists so the icon can be shown
    updateCorner();
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      // Focus moved into our own popup (result/prompt textarea) → keep the menu open.
      if (cornerMode && visible && !(ae === hostEl || (hostEl && hostEl.contains(ae)))) hideAll();
      updateCorner();
    }, 0);
  });

  const trackPointer = (e) => { if (typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }; };
  // pointerup in addition to mouseup: Google Docs canvas mode can suppress the compat mouse events.
  document.addEventListener('pointerup', (e) => { trackPointer(e); if (!isInsideHost(e)) scheduleCheck(); });
  document.addEventListener('mouseup', (e) => { trackPointer(e); if (!isInsideHost(e)) scheduleCheck(); });
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) scheduleCheck();
  });
  document.addEventListener('selectionchange', () => scheduleCheck());

  // Keep the popup glued to the selection while the page scrolls/resizes.
  const reposition = () => {
    if (visible) {
      const rect = currentAnchorRect();
      if (rect) positionAt(rect);
    }
    if (!els.corner.classList.contains('lg-hidden')) positionCorner(); // keep the icon glued to the field while scrolling
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) hideAll();
  });

  // Startup diagnostic — one line per frame, so you can verify the content script ran.
  console.info('[Zoowan] content script active on', location.href);
})();
