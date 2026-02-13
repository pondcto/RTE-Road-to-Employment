// ============================================================
// RTE - Google Meet Transcript Capture (Hardened)
//
// Captures captions every 1.5s. Sends the FULL visible caption
// list as a batch — the background manages block ordering.
// This handles same-speaker multiple blocks correctly.
// ============================================================

(function () {
  if (window.__rteMeetInit) return;
  window.__rteMeetInit = true;

  const INTERVAL_MS = 1500;
  let observer = null;
  let trackingInterval = null;
  let lastBatchJSON = '';  // Dedup: don't send identical batches

  // ══════════════════════════════════════════════════════════
  // UI TEXT FILTERING
  // ══════════════════════════════════════════════════════════

  const ICON_LIGATURES = new Set([
    'more_vert', 'more_horiz', 'frame_person', 'visual_effects', 'mic_off',
    'mic_none', 'videocam', 'videocam_off', 'present_to_all',
    'call_end', 'back_hand', 'emoji_objects', 'closed_caption',
    'pan_tool', 'push_pin', 'volume_up', 'volume_off', 'volume_mute',
    'screen_share', 'stop_screen_share', 'keyboard_arrow_down',
    'keyboard_arrow_up', 'keyboard_arrow_left', 'keyboard_arrow_right',
    'fiber_manual_record', 'radio_button_checked', 'radio_button_unchecked',
    'check_box', 'check_box_outline_blank', 'chat_bubble',
    'people_alt', 'person_add', 'person_remove',
    'info_outline', 'lock_person', 'lock_open',
    'meeting_room', 'sentiment_satisfied', 'thumb_up', 'thumb_down',
    'computer_arrow_up', 'open_in_new', 'content_copy',
    'format_size', 'format_color_text', 'format_color_fill',
    'help_outline', 'arrow_back', 'arrow_forward', 'arrow_upward',
    'arrow_downward', 'chevron_left', 'chevron_right', 'expand_more',
    'expand_less', 'fullscreen', 'fullscreen_exit', 'zoom_in', 'zoom_out',
    'visibility_off', 'attach_file', 'play_arrow', 'skip_next',
    'skip_previous', 'record_voice_over', 'spatial_audio',
    'co_present', 'desktop_windows', 'signal_cellular_alt', 'mic',
  ]);

  const UI_PHRASES = [
    'more options', 'audio settings', 'video settings',
    'turn on microphone', 'turn off microphone', 'turn on camera', 'turn off camera',
    'turn on captions', 'turn off captions',
    'present now', 'share screen', 'stop sharing', 'raise hand', 'lower hand',
    'leave call', 'end call', 'send a reaction', 'host controls',
    'meeting details', 'chat with everyone', 'meeting tools', 'call ends soon',
    'this call is open to anyone',
    'developing an extension', 'add-on would work better',
    'extensions frequently cause', 'altering the page',
    'developers.google.com',
    'caption settings', 'font size', 'font color',
    'backgrounds and effects',
    'jump to bottom', 'scroll to bottom', 'new messages',
    'transcript', 'view transcript',
  ];

  const UI_PHRASE_RE = new RegExp(
    UI_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i'
  );

  function isUIText(text) {
    if (!text) return true;
    const t = text.trim();
    if (t.length === 0) return true;
    if (t.includes('_') && ICON_LIGATURES.has(t.toLowerCase())) return true;
    if (UI_PHRASE_RE.test(t)) return true;
    if (/^https?:\/\//.test(t)) return true;
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) return true;
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(t)) return true;
    if (/^\(?(ctrl|shift|alt)\s*\+/i.test(t)) return true;
    return false;
  }

  function isValidSpeaker(name) {
    if (!name || name.trim().length === 0 || name.length > 50) return false;
    const t = name.trim();
    if (t.includes('_') && ICON_LIGATURES.has(t.toLowerCase())) return false;
    if (/^https?:\/\//.test(t)) return false;
    if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) return false;
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(t)) return false;
    if (UI_PHRASE_RE.test(t)) return false;
    return true;
  }

  function isGarbageText(text) {
    if (!text) return true;
    const words = text.trim().split(/\s+/);
    if (words.length === 0) return true;
    let lig = 0;
    for (const w of words) { if (w.includes('_') && ICON_LIGATURES.has(w.toLowerCase())) lig++; }
    if (lig >= 3) return true;
    if (words.length > 2 && lig / words.length > 0.5) return true;
    let hits = 0;
    const lower = text.toLowerCase();
    for (const p of UI_PHRASES) { if (lower.includes(p)) hits++; }
    if (hits >= 2) return true;
    if (/https?:\/\/\S+/.test(text)) return true;
    if (/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(text) && words.length < 5) return true;
    return false;
  }

  function cleanText(text) {
    if (!text) return '';
    let c = text;
    c = c.split(/\s+/).filter(w => !(w.includes('_') && ICON_LIGATURES.has(w.toLowerCase()))).join(' ');
    c = c.replace(/\b\d{1,2}:\d{2}\s*(AM|PM)\b/gi, '');
    c = c.replace(/\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/gi, '');
    c = c.replace(/https?:\/\/\S+/gi, '');
    c = c.replace(/\(?(ctrl|shift|alt)\s*\+\s*\w+\)?/gi, '');
    c = c.replace(/\s{2,}/g, ' ').trim();
    return c;
  }

  // ══════════════════════════════════════════════════════════
  // CAPTION EXTRACTION
  //
  // Google Meet live captions appear as small blocks at the
  // bottom of the screen. Each has ONE speaker avatar (img),
  // a short name, and 1-3 sentences of text.
  //
  // Key constraints to avoid grabbing transcript panels,
  // chat, or other large containers:
  //   - Block height: 10-130px (live captions are compact)
  //   - Position: bottom 40% of viewport
  //   - Text length: max ~500 chars per block
  //   - Must have exactly 1 img (avatar), not many
  //   - Must NOT be scrollable (transcript panels are)
  // ══════════════════════════════════════════════════════════

  function extractCaptions() {
    const results = [];
    const blocks = document.querySelectorAll('div[jscontroller] div[class] > div[class]');
    const viewH = window.innerHeight;
    const threshold = viewH * 0.6;

    for (const block of blocks) {
      const rect = block.getBoundingClientRect();

      // Position: must be in the bottom 40% of the viewport
      if (rect.top < threshold) continue;

      // Size: live caption blocks are compact (not transcript panels)
      // Allow up to 180px for multi-line captions, but reject large panels
      if (rect.height < 10 || rect.height > 180) continue;

      // Must have an avatar image
      const imgs = block.querySelectorAll('img');
      if (imgs.length === 0) continue;
      // Too many images = participant grid or gallery, not a caption
      if (imgs.length > 2) continue;

      // Skip scrollable containers (transcript panel has overflow:auto/scroll)
      const style = window.getComputedStyle(block);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') continue;

      // Skip blocks inside known UI containers
      if (block.closest(
        '[role="button"],[role="menu"],[role="toolbar"],[role="dialog"],' +
        '[role="navigation"],[role="tablist"],[role="menubar"],' +
        'button,[data-panel-id],[role="complementary"]'
      )) continue;

      // Skip blocks with many interactive elements
      if (block.querySelectorAll('button, [role="button"], input, select, a').length > 2) continue;

      // Extract text nodes (skip icon ligatures)
      const textNodes = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode.textContent.trim();
        if (t && !(t.includes('_') && ICON_LIGATURES.has(t.toLowerCase()))) {
          textNodes.push(t);
        }
      }

      if (textNodes.length >= 2) {
        const speaker = textNodes[0];
        if (!isValidSpeaker(speaker)) continue;

        const rawText = textNodes.slice(1).join(' ');

        // KEY: Live captions are SHORT. If text is too long, this is a
        // transcript panel or chat, not a live caption block.
        if (rawText.length > 500) continue;

        const text = cleanText(rawText);
        if (text && text.length >= 1 && !isUIText(text) && !isGarbageText(text)) {
          results.push({ speaker, text });
        }
      }
    }
    return results;
  }

  // ══════════════════════════════════════════════════════════
  // SEND — Batch of ALL visible captions at once
  // ══════════════════════════════════════════════════════════

  function sendBatch() {
    const captions = extractCaptions();

    // Dedup: don't send if nothing changed
    const json = JSON.stringify(captions);
    if (json === lastBatchJSON) return;
    lastBatchJSON = json;

    chrome.runtime.sendMessage({
      type: 'captionBatch',
      platform: 'meet',
      captions,  // [{speaker, text}, {speaker, text}, ...]
    }).catch(() => {});
  }

  // ══════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════

  function start() {
    let pending = false;
    observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
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
    if (document.querySelector('video') || document.querySelector('div[jscontroller]') || document.readyState === 'complete') {
      clearInterval(readyCheck);
      start();
    }
  }, 1000);
})();
