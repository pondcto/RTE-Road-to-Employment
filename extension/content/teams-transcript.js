// ============================================================
// RTE - Microsoft Teams Transcript Capture (Optimized)
//
// Same 3s interval approach as Google Meet.
// ============================================================

(function () {
  if (window.__rteTeamsInit) return;
  window.__rteTeamsInit = true;

  const INTERVAL_MS = 3000;
  const speakerState = new Map();
  let activeSpeakers = new Set();
  let observer = null;

  // ── Caption Extraction ──
  const CAPTION_SELECTORS = [
    '[data-tid="closed-caption-text"]', '[data-tid="live-captions-renderer"]',
    '.captions-container', '.ts-live-captions', '[class*="liveCaptions"]', '[class*="caption"]',
  ];

  function extractCaptions() {
    const results = [];

    for (const sel of CAPTION_SELECTORS) {
      const container = document.querySelector(sel);
      if (!container) continue;
      for (const line of container.querySelectorAll('[class*="line"],[class*="entry"],[class*="item"],div>div')) {
        const r = parseLine(line);
        if (r.text) results.push(r);
      }
      if (results.length) return results;
    }

    for (const el of document.querySelectorAll('[class*="caption"],[class*="subtitle"],[class*="transcript"]')) {
      const r = parseLine(el);
      if (r.text && r.text.length > 3) results.push(r);
    }
    return results;
  }

  function parseLine(el) {
    let speaker = 'Participant', text = '';
    const nameEl = el.querySelector('[class*="speaker"],[class*="name"],[class*="author"],[data-tid*="name"]');
    if (nameEl) speaker = nameEl.textContent.trim();
    const textEl = el.querySelector('[class*="text"],[class*="content"],[class*="body"],[data-tid*="text"]');
    if (textEl) text = textEl.textContent.trim();
    if (!text) {
      const full = el.textContent.trim();
      const m = full.match(/^(.{1,30}):\s*(.+)$/s);
      if (m) { speaker = m[1].trim(); text = m[2].trim(); }
      else text = full;
    }
    return { speaker, text };
  }

  // ── Delta Logic ──
  function sendNewContent(speaker, entry) {
    if (!entry.currentText || entry.currentText === entry.lastSentText) return;
    let textToSend, isNewTurn;
    if (!entry.lastSentText) {
      textToSend = entry.currentText; isNewTurn = true;
    } else if (entry.currentText.startsWith(entry.lastSentText)) {
      const delta = entry.currentText.slice(entry.lastSentText.length).trim();
      if (!delta) { entry.lastSentText = entry.currentText; return; }
      textToSend = delta; isNewTurn = false;
    } else if (entry.currentText.length > entry.lastSentLength + 20) {
      const delta = entry.currentText.slice(entry.lastSentLength).trim();
      if (!delta) { entry.lastSentText = entry.currentText; entry.lastSentLength = entry.currentText.length; return; }
      textToSend = delta; isNewTurn = false;
    } else {
      entry.lastSentText = entry.currentText; entry.lastSentLength = entry.currentText.length; return;
    }
    chrome.runtime.sendMessage({ type: 'transcript', platform: 'teams', speaker, text: textToSend, isNewTurn }).catch(() => {});
    entry.lastSentText = entry.currentText; entry.lastSentLength = entry.currentText.length;
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
      if (!current.has(prev)) { const e = speakerState.get(prev); if (e) { sendNewContent(prev, e); speakerState.delete(prev); } }
    }
    activeSpeakers = current;
  }

  // ── Start ──
  function start() {
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return; pending = true;
      requestAnimationFrame(() => { updateTracking(); pending = false; });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(updateTracking, INTERVAL_MS);
    setInterval(() => { for (const [s, e] of speakerState) sendNewContent(s, e); }, INTERVAL_MS);
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'ping') return true; });

  const readyCheck = setInterval(() => {
    if (document.querySelector('video,[data-tid],[class*="calling"],[class*="meeting"]') || document.readyState === 'complete') {
      clearInterval(readyCheck); start();
    }
  }, 1000);
})();
