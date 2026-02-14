// ============================================================
// RTE - Microsoft Teams Transcript Capture (v2 DOM)
//
// Targets the exact Teams caption DOM structure:
//   Container: [data-tid="closed-caption-v2-window-wrapper"]
//   Entry:     .fui-ChatMessageCompact
//   Speaker:   [data-tid="author"]
//   Text:      [data-tid="closed-caption-text"]
//
// Sends FULL visible caption batch to background.
// ============================================================

(function () {
  if (window.__rteTeamsInit) return;
  window.__rteTeamsInit = true;

  const INTERVAL_MS = 1500;
  let observer = null;
  let trackingInterval = null;
  let lastBatchJSON = '';

  // ══════════════════════════════════════════════════════════
  // CAPTION EXTRACTION — Multiple approaches for resilience
  // ══════════════════════════════════════════════════════════

  function extractCaptions() {
    let results;

    // Strategy 1: Teams v2 exact selectors (from real DOM)
    results = extractTeamsV2();
    if (results.length > 0) return results;

    // Strategy 2: data-tid based (works across Teams versions)
    results = extractByDataTid();
    if (results.length > 0) return results;

    // Strategy 3: Fluent UI component classes
    results = extractByFluentUI();
    if (results.length > 0) return results;

    // Strategy 4: Broad fallback
    results = extractFallback();
    return results;
  }

  /**
   * Strategy 1: Teams v2 exact DOM structure
   * Container: [data-tid="closed-caption-v2-window-wrapper"]
   * Entries:   .fui-ChatMessageCompact
   * Speaker:   [data-tid="author"]
   * Text:      [data-tid="closed-caption-text"]
   */
  function extractTeamsV2() {
    const results = [];
    const container = document.querySelector('[data-tid="closed-caption-v2-window-wrapper"]');
    if (!container) return results;

    const entries = container.querySelectorAll('.fui-ChatMessageCompact');
    for (const entry of entries) {
      const authorEl = entry.querySelector('[data-tid="author"]');
      const textEl = entry.querySelector('[data-tid="closed-caption-text"]');

      const speaker = authorEl?.textContent?.trim() || 'Participant';
      const text = textEl?.textContent?.trim() || '';

      if (text && text.length > 0) {
        results.push({ speaker, text });
      }
    }
    return results;
  }

  /**
   * Strategy 2: data-tid based extraction
   * Works if Teams changes class names but keeps data-tid attributes
   */
  function extractByDataTid() {
    const results = [];

    // Find all caption text elements
    const textElements = document.querySelectorAll('[data-tid="closed-caption-text"]');
    if (textElements.length === 0) return results;

    for (const textEl of textElements) {
      const text = textEl.textContent?.trim();
      if (!text) continue;

      // Walk up to find the author in a sibling or ancestor
      let speaker = 'Participant';
      let parent = textEl.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        const authorEl = parent.querySelector('[data-tid="author"]');
        if (authorEl) {
          speaker = authorEl.textContent?.trim() || 'Participant';
          break;
        }
        parent = parent.parentElement;
      }

      results.push({ speaker, text });
    }
    return results;
  }

  /**
   * Strategy 3: Fluent UI class-based extraction
   * Teams uses fui-ChatMessageCompact for caption entries
   */
  function extractByFluentUI() {
    const results = [];

    // Try Fluent UI chat message components
    const entries = document.querySelectorAll(
      '.fui-ChatMessageCompact, [class*="ChatMessageCompact"], [class*="chatMessageCompact"]'
    );
    if (entries.length === 0) return results;

    for (const entry of entries) {
      // Find speaker: look for author-like elements
      let speaker = 'Participant';
      const authorEl = entry.querySelector(
        '[data-tid="author"], .fui-ChatMessageCompact__author, [class*="__author"], [class*="author"]'
      );
      if (authorEl) speaker = authorEl.textContent?.trim() || 'Participant';

      // Find text: look for caption text elements
      let text = '';
      const textEl = entry.querySelector(
        '[data-tid="closed-caption-text"], [class*="caption-text"], [class*="captionText"]'
      );
      if (textEl) text = textEl.textContent?.trim() || '';

      // Fallback: get the body text minus the author name
      if (!text) {
        const bodyEl = entry.querySelector('.fui-ChatMessageCompact__body, [class*="__body"]');
        if (bodyEl) {
          const fullText = bodyEl.textContent?.trim() || '';
          // Remove the speaker name from the beginning
          if (fullText.startsWith(speaker)) {
            text = fullText.slice(speaker.length).trim();
          } else {
            text = fullText;
          }
        }
      }

      if (text && text.length > 0) {
        results.push({ speaker, text });
      }
    }
    return results;
  }

  /**
   * Strategy 4: Broad fallback using container selectors
   */
  function extractFallback() {
    const results = [];
    const containerSelectors = [
      '[data-tid="closed-captions-renderer"]',
      '[data-tid="live-captions-renderer"]',
      '[aria-label*="caption" i]',
      '[aria-label*="subtitle" i]',
      '.captions-container',
      '[class*="captionsContainer"]',
      '[class*="liveCaptions"]',
    ];

    for (const sel of containerSelectors) {
      const container = document.querySelector(sel);
      if (!container) continue;

      // Try to find entries within
      for (const child of container.querySelectorAll('div[role="log"] > div, [role="log"] div > div')) {
        const fullText = child.textContent?.trim();
        if (!fullText || fullText.length < 2 || fullText.length > 500) continue;

        // Try to split "Speaker Text" pattern
        const match = fullText.match(/^(.{1,40}?)\s{2,}(.+)$/s);
        if (match) {
          results.push({ speaker: match[1].trim(), text: match[2].trim() });
        } else {
          results.push({ speaker: 'Participant', text: fullText });
        }
      }
      if (results.length > 0) return results;
    }

    return results;
  }

  // ══════════════════════════════════════════════════════════
  // SEND BATCH
  // ══════════════════════════════════════════════════════════

  function sendBatch() {
    const captions = extractCaptions();
    const json = JSON.stringify(captions);
    if (json === lastBatchJSON) return;
    lastBatchJSON = json;

    if (captions.length > 0) {
      chrome.runtime.sendMessage({
        type: 'captionBatch', platform: 'teams', captions,
      }).catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════

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
    if (document.querySelector('video,[data-tid],[class*="calling"],[class*="meeting"],[id*="meeting"]') || document.readyState === 'complete') {
      clearInterval(readyCheck);
      start();
    }
  }, 1000);
})();
