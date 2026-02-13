// ============================================================
// RTE - Google Translate Bridge (Block-Based)
//
// Maintains structured text blocks [{speaker, text}].
// The textarea always shows the exact same text as the
// transcript — no fragmentation or duplication.
// ============================================================

(function () {
  if (window.__rteTranslateBridgeInit) return;
  window.__rteTranslateBridgeInit = true;

  chrome.runtime.sendMessage({ type: 'translateReady' }).catch(() => {});

  let cachedInput = null;

  // The structured blocks that make up the translate content
  let blocks = [];

  function getInput() {
    if (cachedInput && cachedInput.isConnected) return cachedInput;
    const selectors = [
      'textarea[aria-label="Source text"]', 'textarea[jsname="BJE2fc"]',
      'textarea[data-initial-value]', 'div[contenteditable="true"][role="textbox"][aria-label="Source text"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { cachedInput = el; return el; }
    }
    for (const ta of document.querySelectorAll('textarea')) {
      if (ta.offsetHeight > 20) { cachedInput = ta; return ta; }
    }
    return null;
  }

  function setValue(el, value) {
    if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
  }

  /**
   * Render all blocks into the textarea.
   * Format: "Speaker: text\n\nSpeaker: text\n\n..."
   */
  function renderBlocks() {
    const el = getInput();
    if (!el) return false;
    const text = blocks.map(b => `${b.speaker}: ${b.text}`).join('\n\n');
    setValue(el, text);
    return true;
  }

  /**
   * Set the complete list of blocks and render.
   */
  function setBlocks(newBlocks) {
    blocks = newBlocks || [];
    return renderBlocks();
  }

  /**
   * Update only the last block (current speaker's live text).
   * Much faster than re-rendering everything.
   */
  function updateLastBlock(speaker, text) {
    if (blocks.length > 0 && blocks[blocks.length - 1].speaker === speaker) {
      blocks[blocks.length - 1].text = text;
    } else {
      blocks.push({ speaker, text });
    }
    return renderBlocks();
  }

  /**
   * Append a finalized block (speaker finished talking).
   */
  function appendBlock(speaker, text) {
    blocks.push({ speaker, text });
    return renderBlocks();
  }

  function clearAll() {
    blocks = [];
    // Try native clear button first
    for (const btn of document.querySelectorAll('button[aria-label="Clear source text"],button[aria-label*="Clear"],button[jsname="WMmhGe"]')) {
      btn.click();
      return true;
    }
    const el = getInput();
    if (!el) return false;
    setValue(el, '');
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _, respond) => {
    switch (msg.type) {
      case 'translateSetBlocks':
        respond({ ok: setBlocks(msg.blocks) });
        break;
      case 'translateUpdateLive':
        respond({ ok: updateLastBlock(msg.speaker, msg.text) });
        break;
      case 'translateAppendBlock':
        respond({ ok: appendBlock(msg.speaker, msg.text) });
        break;
      case 'clearTranslation':
        respond({ ok: clearAll() });
        break;
      // Legacy support
      case 'updateTranslation':
        respond({ ok: updateLastBlock(msg.speaker || '...', msg.text) });
        break;
      default:
        return false;
    }
    return true;
  });
})();
