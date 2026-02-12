// ============================================================
// RTE - Google Meet Transcript Capture (Optimized)
//
// Captures captions every 3s, sends only NEW content.
// Filters UI text, handles speech-recognition rewrites.
// ============================================================

(function () {
  if (window.__rteMeetInit) return;
  window.__rteMeetInit = true;

  const INTERVAL_MS = 3000;
  const MIN_SPEECH_LENGTH = 10;

  const speakerState = new Map();
  let activeSpeakers = new Set();
  let observer = null;

  // ── UI Text Filter ──
  const UI_RE = /^(more options|visual effects|backgrounds|reframe|devices|settings|turn on|turn off|present now|raise hand|leave call|end call|captions|subtitles|recording|layout|participants|chat|activities|mute|unmute|camera|microphone|screen sharing|send|cancel|arrow_|jump to|you're |meeting|call ended|joining|waiting|admit|deny|pin|unpin|remove|report|block|details)/i;

  function isUIText(text) {
    if (!text || text.length < 3) return true;
    if (text.length < MIN_SPEECH_LENGTH && !/[.!?,]/.test(text)) return true;
    return UI_RE.test(text.trim());
  }

  // ── Caption Extraction ──
  function extractCaptions() {
    const results = [];
    const blocks = document.querySelectorAll('div[jscontroller] div[class] > div[class]');
    const threshold = window.innerHeight * 0.6;

    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (rect.top < threshold || rect.height < 10 || rect.height > 200) continue;
      if (!block.querySelector('img')) continue;
      if (block.closest('[role="button"],[role="menu"],[role="toolbar"],[role="dialog"],button')) continue;

      const textNodes = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode.textContent.trim();
        if (t) textNodes.push(t);
      }

      if (textNodes.length >= 2) {
        const speaker = textNodes[0];
        const text = textNodes.slice(1).join(' ');
        if (!isUIText(text)) results.push({ speaker, text });
      }
    }
    return results;
  }

  // ── Delta Logic ──
  function sendNewContent(speaker, entry) {
    if (!entry.currentText || entry.currentText === entry.lastSentText) return;

    let textToSend, isNewTurn;

    if (!entry.lastSentText) {
      textToSend = entry.currentText;
      isNewTurn = true;
    } else if (entry.currentText.startsWith(entry.lastSentText)) {
      const delta = entry.currentText.slice(entry.lastSentText.length).trim();
      if (!delta) { entry.lastSentText = entry.currentText; return; }
      textToSend = delta;
      isNewTurn = false;
    } else if (entry.currentText.length > entry.lastSentLength + 20) {
      const delta = entry.currentText.slice(entry.lastSentLength).trim();
      if (!delta) { entry.lastSentText = entry.currentText; entry.lastSentLength = entry.currentText.length; return; }
      textToSend = delta;
      isNewTurn = false;
    } else {
      entry.lastSentText = entry.currentText;
      entry.lastSentLength = entry.currentText.length;
      return;
    }

    chrome.runtime.sendMessage({
      type: 'transcript', platform: 'meet', speaker, text: textToSend, isNewTurn,
    }).catch(() => {});

    entry.lastSentText = entry.currentText;
    entry.lastSentLength = entry.currentText.length;
  }

  // ── Tracking ──
  function updateTracking() {
    const captions = extractCaptions();
    const current = new Set();

    for (const { speaker, text } of captions) {
      current.add(speaker);
      let e = speakerState.get(speaker);
      if (!e) { e = { currentText: '', lastSentText: '', lastSentLength: 0 }; speakerState.set(speaker, e); }
      e.currentText = text;
    }

    for (const prev of activeSpeakers) {
      if (!current.has(prev)) {
        const e = speakerState.get(prev);
        if (e) { sendNewContent(prev, e); speakerState.delete(prev); }
      }
    }
    activeSpeakers = current;
  }

  // ── Start ──
  function start() {
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { updateTracking(); pending = false; });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    setInterval(updateTracking, INTERVAL_MS);
    setInterval(() => { for (const [s, e] of speakerState) sendNewContent(s, e); }, INTERVAL_MS);
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'ping') return true; });

  const readyCheck = setInterval(() => {
    if (document.querySelector('video') || document.querySelector('div[jscontroller]') || document.readyState === 'complete') {
      clearInterval(readyCheck);
      start();
    }
  }, 1000);
})();
