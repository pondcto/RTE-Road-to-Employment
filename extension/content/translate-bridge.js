// ============================================================
// RTE - Google Translate Bridge (Optimized)
// Appends new transcript text. Caches the input element.
// ============================================================

(function () {
  if (window.__rteTranslateBridgeInit) return;
  window.__rteTranslateBridgeInit = true;

  chrome.runtime.sendMessage({ type: 'translateReady' }).catch(() => {});

  let cachedInput = null;

  function getInput() {
    if (cachedInput && cachedInput.isConnected) return cachedInput;
    const selectors = [
      'textarea[aria-label="Source text"]', 'textarea[jsname="BJE2fc"]',
      'textarea[data-initial-value]', 'div[contenteditable="true"][role="textbox"][aria-label="Source text"]',
      'textarea',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { cachedInput = el; return el; }
    }
    return null;
  }

  function setText(el, value) {
    if (el.tagName === 'TEXTAREA') {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
  }

  function appendText(newText) {
    const el = getInput();
    if (!el) return false;
    const current = el.tagName === 'TEXTAREA' ? (el.value || '') : (el.textContent || '');
    setText(el, current ? current + newText : newText);
    return true;
  }

  function clearText() {
    for (const btn of document.querySelectorAll('button[aria-label="Clear source text"],button[aria-label*="Clear"],button[jsname="WMmhGe"]')) {
      btn.click(); return true;
    }
    const el = getInput();
    if (!el) return false;
    setText(el, '');
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _, respond) => {
    if (msg.type === 'updateTranslation') respond({ ok: appendText(msg.text) });
    else if (msg.type === 'clearTranslation') respond({ ok: clearText() });
  });
})();
