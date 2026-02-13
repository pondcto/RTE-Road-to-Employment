// ============================================================
// RTE - Overlay UI (Optimized)
// Floating panel for AI responses with streaming, markdown
// rendering, custom shortcuts, and drag support.
// ============================================================

(function () {
  if (window.__rteOverlayInitialised) return;
  window.__rteOverlayInitialised = true;

  // ── DOM ──
  const overlay = document.createElement('div');
  overlay.id = 'rte-overlay';
  overlay.innerHTML = `
    <div class="rte-overlay-header" id="rte-overlay-header">
      <div class="rte-overlay-title">
        <span class="rte-overlay-icon">⚡</span>
        <span id="rte-overlay-title-text">RTE Assistant</span>
      </div>
      <div class="rte-overlay-actions">
        <button id="rte-overlay-copy" class="rte-overlay-btn" title="Copy to clipboard">📋</button>
        <button id="rte-overlay-close" class="rte-overlay-btn" title="Close">✕</button>
      </div>
    </div>
    <div class="rte-overlay-body" id="rte-overlay-body">
      <div class="rte-overlay-loading" id="rte-overlay-loading">
        <div class="rte-spinner"></div><span>Generating response...</span>
      </div>
      <div class="rte-overlay-content" id="rte-overlay-content"></div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (id) => document.getElementById(id);
  const headerEl = $('rte-overlay-header');
  const titleEl = $('rte-overlay-title-text');
  const bodyEl = $('rte-overlay-body');
  const loadingEl = $('rte-overlay-loading');
  const contentEl = $('rte-overlay-content');
  const copyBtn = $('rte-overlay-copy');
  const closeBtn = $('rte-overlay-close');

  let isStreaming = false;
  let streamedText = '';
  let renderPending = false;
  let userScrolledUp = false;  // Track if user manually scrolled away from bottom

  // Detect user scrolling during streaming
  bodyEl.addEventListener('scroll', () => {
    if (!isStreaming) return;
    // If user is near the bottom (within 30px), consider them "following"
    const atBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 30;
    userScrolledUp = !atBottom;
  }, { passive: true });

  // ── Custom Shortcuts ──
  const DEFAULTS = {
    'generate-question': 'Ctrl+Shift+Q', 'generate-simple-answer': 'Ctrl+Shift+A',
    'generate-detailed-answer': 'Ctrl+Shift+E', 'clear-translate': 'Ctrl+Shift+Z',
    'copy-captions': 'Ctrl+Shift+C',
  };
  let shortcuts = { ...DEFAULTS };

  // Load from sync first, then local as fallback
  function loadShortcuts() {
    chrome.storage.sync.get(['customShortcuts'], (syncResult) => {
      if (!chrome.runtime.lastError && syncResult.customShortcuts) {
        shortcuts = syncResult.customShortcuts;
      } else {
        chrome.storage.local.get(['customShortcuts'], (localResult) => {
          if (!chrome.runtime.lastError && localResult.customShortcuts) {
            shortcuts = localResult.customShortcuts;
          }
        });
      }
    });
  }
  loadShortcuts();
  chrome.storage.onChanged.addListener((c) => {
    if (c.customShortcuts?.newValue) shortcuts = c.customShortcuts.newValue;
  });

  function eventToCombo(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    const p = [];
    if (e.ctrlKey || e.metaKey) p.push('Ctrl');
    if (e.altKey) p.push('Alt');
    if (e.shiftKey) p.push('Shift');
    if (!p.length) return null;
    let k = e.key;
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    else k = { Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter', Tab: 'Tab' }[k] || k;
    p.push(k);
    return p.join('+');
  }

  document.addEventListener('keydown', (e) => {
    const combo = eventToCombo(e);
    if (!combo) return;
    const reverseMap = Object.fromEntries(Object.entries(shortcuts).map(([c, k]) => [k, c]));
    const cmd = reverseMap[combo];
    if (!cmd) return;
    // Let caption-copyer.js handle copy-captions directly (needs user gesture for clipboard)
    if (cmd === 'copy-captions') return;
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'customCommand', command: cmd });
  }, true);

  // ── Drag ──
  let dragging = false, dx = 0, dy = 0;
  headerEl.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    const rect = overlay.getBoundingClientRect();
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    overlay.style.transition = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Switch to absolute pixel positioning (remove centering transform)
    overlay.style.left = (e.clientX - dx) + 'px';
    overlay.style.top = (e.clientY - dy) + 'px';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'none';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; overlay.style.transition = ''; }
  });

  // ── Actions ──
  closeBtn.addEventListener('click', () => { overlay.classList.remove('rte-overlay-visible'); isStreaming = false; });
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(streamedText || contentEl.textContent).then(() => {
      copyBtn.textContent = '✓'; setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
    }).catch(() => {});
  });

  // ── Markdown Renderer ──
  function md(text) {
    if (!text) return '';
    let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const out = []; let ul = false, ol = false;
    const close = () => { if (ul) { out.push('</ul>'); ul = false; } if (ol) { out.push('</ol>'); ol = false; } };

    for (const line of h.split('\n')) {
      const hm = line.match(/^(#{1,3})\s+(.+)$/);
      if (hm) { close(); out.push(`<h${hm[1].length + 2} class="rte-md-h">${inline(hm[2])}</h${hm[1].length + 2}>`); continue; }
      const um = line.match(/^[\s]*[-*]\s+(.+)$/);
      if (um) { if (ol) close(); if (!ul) { out.push('<ul class="rte-md-ul">'); ul = true; } out.push(`<li>${inline(um[1])}</li>`); continue; }
      const om = line.match(/^[\s]*(\d+)\.\s+(.+)$/);
      if (om) { if (ul) close(); if (!ol) { out.push('<ol class="rte-md-ol">'); ol = true; } out.push(`<li>${inline(om[2])}</li>`); continue; }
      if (!line.trim()) { close(); out.push('<div class="rte-md-br"></div>'); continue; }
      close(); out.push(`<p class="rte-md-p">${inline(line)}</p>`);
    }
    close();
    return out.join('');
  }

  function inline(t) {
    return t
      .replace(/\*\*(.+?)\*\*/g, '<strong class="rte-md-bold">$1</strong>')
      .replace(/__(.+?)__/g, '<strong class="rte-md-bold">$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em class="rte-md-italic">$1</em>')
      .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em class="rte-md-italic">$1</em>')
      .replace(/`(.+?)`/g, '<code class="rte-md-code">$1</code>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
  }

  function render(text, cursor) {
    contentEl.innerHTML = md(text) + (cursor ? '<span class="rte-cursor"></span>' : '');
  }

  // Throttle rendering during streaming (every ~80ms via rAF)
  function renderThrottled(text, cursor) {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { render(text, cursor); renderPending = false; });
  }

  // ── Message Handler ──
  const LABELS = {
    'question': '💬  Suggested Questions',
    'simple-answer': '💡  Quick Answer',
    'detailed-answer': '📝  Detailed Answer',
  };

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'streamStart':
        isStreaming = true; streamedText = ''; userScrolledUp = false;
        titleEl.textContent = LABELS[msg.mode] || 'RTE Assistant';
        loadingEl.style.display = 'none'; contentEl.style.display = 'block';
        overlay.classList.remove('rte-overlay-error');
        overlay.classList.add('rte-overlay-visible', 'rte-streaming');
        // Reset position to center of screen
        overlay.style.top = '50%';
        overlay.style.left = '50%';
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
        overlay.style.transform = '';
        render('', true);
        bodyEl.scrollTop = 0;
        break;

      case 'streamChunk':
        if (!isStreaming) break;
        streamedText += msg.token;
        renderThrottled(streamedText, true);
        // Only auto-scroll if user hasn't manually scrolled up
        if (!userScrolledUp) {
          bodyEl.scrollTop = bodyEl.scrollHeight;
        }
        break;

      case 'streamEnd':
        isStreaming = false;
        overlay.classList.remove('rte-streaming');
        render(streamedText, false);
        // Only auto-scroll if user hasn't manually scrolled up
        if (!userScrolledUp) {
          bodyEl.scrollTop = bodyEl.scrollHeight;
        }
        userScrolledUp = false;
        break;

      case 'showOverlay':
        isStreaming = false; overlay.classList.remove('rte-streaming');
        titleEl.textContent = LABELS[msg.mode] || 'RTE Assistant';
        if (msg.content === null) {
          loadingEl.style.display = 'flex'; contentEl.style.display = 'none';
          streamedText = ''; render('', false);
          overlay.classList.remove('rte-overlay-error');
        } else {
          loadingEl.style.display = 'none'; contentEl.style.display = 'block';
          streamedText = msg.content; render(msg.content, false);
          overlay.classList.toggle('rte-overlay-error', !!msg.isError);
        }
        overlay.classList.add('rte-overlay-visible');
        break;
    }
  });
})();
