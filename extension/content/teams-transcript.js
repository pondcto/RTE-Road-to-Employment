// ============================================================
// RTE - Microsoft Teams Transcript Capture (Optimized)
//
// 1.5s interval. Sends FULL visible caption batch.
// The background manages block ordering and deduplication.
// ============================================================

(function () {
  if (window.__rteTeamsInit) return;
  window.__rteTeamsInit = true;

  const INTERVAL_MS = 1500;
  let observer = null;
  let trackingInterval = null;
  let lastBatchJSON = '';

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

  // ── Send batch ──
  function sendBatch() {
    const captions = extractCaptions();
    const json = JSON.stringify(captions);
    if (json === lastBatchJSON) return;
    lastBatchJSON = json;

    chrome.runtime.sendMessage({
      type: 'captionBatch', platform: 'teams', captions,
    }).catch(() => {});
  }

  // ── Start / Stop ──
  function start() {
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return; pending = true;
      requestAnimationFrame(() => { sendBatch(); pending = false; });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    trackingInterval = setInterval(sendBatch, INTERVAL_MS);
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
    lastBatchJSON = '';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ping') return true;
    if (msg.type === 'rteDeactivated') { stop(); return; }
  });

  const readyCheck = setInterval(() => {
    if (document.querySelector('video,[data-tid],[class*="calling"],[class*="meeting"]') || document.readyState === 'complete') {
      clearInterval(readyCheck); start();
    }
  }, 1000);
})();
