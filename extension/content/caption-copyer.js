// ============================================================
// RTE - Caption Copyer (Integrated from MsgCopyer)
//
// Captures live captions from Google Meet, Microsoft Teams,
// and Zoom using multiple detection strategies.
// Press Ctrl+Shift+C to copy captions to clipboard.
//
// Integration with RTE:
//   When RTE is active, the copy command retrieves the processed
//   transcript from the background service worker (same text sent
//   to Google Translate). When RTE is inactive, falls back to
//   independent caption capture.
// ============================================================

(() => {
  'use strict';

  if (window.__rteCaptionCopyerInit) return;
  window.__rteCaptionCopyerInit = true;

  // ======================= CONSTANTS =======================

  const POLL_MS            = 300;
  const SEARCH_MS          = 2000;
  const MUTATION_EVAL_MS   = 3000;
  const MAX_ENTRIES        = 10000;
  const COPY_DEBOUNCE_MS   = 500;
  const TOAST_DURATION_MS  = 3000;
  const MIN_MUTATION_HITS  = 5;

  // Known UI / icon-font strings for filtering
  const UI_TOKENS = [
    'more_vert', 'frame_person', 'visual_effects', 'mic_off', 'mic_none',
    'videocam', 'videocam_off', 'present_to_all', 'call_end', 'back_hand',
    'emoji_objects', 'closed_caption', 'settings', 'pan_tool', 'push_pin',
    'volume_up', 'volume_off', 'screen_share', 'stop_screen_share',
    'keyboard_arrow_down', 'keyboard_arrow_up', 'fiber_manual_record',
    'radio_button_checked', 'check_box', 'chat_bubble', 'people_alt',
    'info_outline', 'security',
    'Backgrounds and effects', 'More options', 'Turn off', 'Turn on',
    'Raise hand', 'Lower hand', 'Share screen', 'Stop sharing',
    'Leave call', 'End call', 'You are presenting',
    'Press Down Arrow', 'Press Up Arrow', 'Press Enter', 'Press Escape',
    'hover tray', 'Escape to close', 'Tab to navigate', 'Arrow to',
    'press and hold', 'right-click', 'to open the', 'to close it',
    'format_size', 'format_color_text', 'format_color_fill',
    'Font size', 'Font color', 'caption settings', 'Open caption',
  ];

  // Platform-specific CSS selectors
  const SELECTORS = {
    gmeet: { containers: [], entries: [] },
    teams: {
      containers: [
        '[data-tid="closed-captions-renderer"]',
        '[data-tid="live-captions-renderer"]',
        '[aria-label*="caption" i]',
        '[aria-label*="subtitle" i]',
        '.ts-captions-container',
        '[class*="captionsContainer"]',
        '[class*="captions-banner"]',
        '[class*="CaptionsBanner"]',
      ],
      entries: [
        '[data-tid="closed-caption-item"]',
        '[data-tid="live-caption-item"]',
        '[class*="captionItem"]',
        '[class*="CaptionItem"]',
        '[class*="caption-line"]',
      ],
    },
    zoom: {
      containers: [
        '.closed-caption-wrap',
        '#live-transcription-content',
        '[aria-label*="caption" i]',
        '[aria-label*="subtitle" i]',
        '[aria-label*="transcript" i]',
        '.meeting-subtitles',
        '[class*="closedcaption"]',
        '[class*="closed-caption"]',
        '.subtitle-message-container',
      ],
      entries: [
        '.closed-caption-single-message',
        '.closedcaption-single-message',
        '[class*="subtitle-message-item"]',
        '[class*="transcription-item"]',
        '[class*="transcript-message"]',
      ],
    },
  };

  // ======================= STATE =======================

  let platform          = null;
  let sentenceCount     = 5;
  let captionContainer  = null;
  let containerObserver = null;
  let isDirty           = true;
  let previousTexts     = [];
  const capturedEntries = [];
  let lastCopyTs        = 0;

  // Mutation-tracking state
  let bodyObserver      = null;
  const mutationHits    = new Map();

  // Candidate verification state
  let pendingCandidate     = null;
  let pendingCandidateText = '';
  let pendingCandidateTs   = 0;

  // Text-change scanning state
  const textScanPrev  = new Map();
  const textScanHits  = new Map();

  // Known speaker names
  const knownSpeakers = new Set();

  // Custom shortcut for copy-captions (default: Ctrl+Shift+C)
  let copyCaptionsShortcut = 'Ctrl+Shift+C';

  // Track intervals for cleanup
  const intervals = [];

  // ======================= BOOT =======================

  function boot() {
    platform = detectPlatform();
    if (!platform) return;

    console.log('[RTE CaptionCopyer] Active on', platform);

    loadSettings();
    listenForKeys();
    listenForMessages();

    // 1. Selector-based search
    searchBySelectors();
    intervals.push(setInterval(searchBySelectors, SEARCH_MS));

    // 2. Mutation-tracking
    startMutationTracking();
    intervals.push(setInterval(evaluateMutationCandidates, MUTATION_EVAL_MS));

    // 3. Text-change scanning
    intervals.push(setInterval(scanForTextChanges, 800));

    // 4. Poll the found container
    intervals.push(setInterval(poll, POLL_MS));

    showToast('RTE CaptionCopyer active — enable captions, then ' + copyCaptionsShortcut + ' to copy');
  }

  function detectPlatform() {
    const h = location.hostname;
    if (h === 'meet.google.com') return 'gmeet';
    if (h.includes('teams.microsoft.com') || h.includes('teams.live.com')) return 'teams';
    if (h.includes('zoom.us')) return 'zoom';
    return null;
  }

  // ======================= SETTINGS =======================

  function loadSettings() {
    try {
      // Load sentence count from sync storage
      chrome.storage.sync.get({ sentenceCount: 5 }, (r) => {
        if (chrome.runtime.lastError) return;
        sentenceCount = r.sentenceCount;
      });

      // Load custom shortcuts
      chrome.storage.local.get(['customShortcuts'], (r) => {
        if (chrome.runtime.lastError) return;
        if (r.customShortcuts && r.customShortcuts['copy-captions']) {
          copyCaptionsShortcut = r.customShortcuts['copy-captions'];
        }
      });

      // Also check sync storage for shortcuts
      chrome.storage.sync.get(['customShortcuts'], (r) => {
        if (chrome.runtime.lastError) return;
        if (r.customShortcuts && r.customShortcuts['copy-captions']) {
          copyCaptionsShortcut = r.customShortcuts['copy-captions'];
        }
      });

      chrome.storage.onChanged.addListener((changes) => {
        if (changes.sentenceCount) sentenceCount = changes.sentenceCount.newValue;
        if (changes.customShortcuts?.newValue?.['copy-captions']) {
          copyCaptionsShortcut = changes.customShortcuts.newValue['copy-captions'];
        }
      });
    } catch (_) { /* storage unavailable */ }
  }

  // ======================= INPUT HANDLING =======================

  function parseShortcut(combo) {
    const parts = combo.split('+');
    return {
      ctrl: parts.includes('Ctrl'),
      shift: parts.includes('Shift'),
      alt: parts.includes('Alt'),
      key: parts[parts.length - 1],
    };
  }

  function listenForKeys() {
    document.addEventListener('keydown', (e) => {
      // Parse the configured shortcut
      const sc = parseShortcut(copyCaptionsShortcut);

      // Check if the pressed keys match
      const ctrlMatch = sc.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
      const shiftMatch = sc.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = sc.alt ? e.altKey : !e.altKey;

      let keyMatch = false;
      if (sc.key.length === 1) {
        keyMatch = e.code === 'Key' + sc.key.toUpperCase() || e.key.toUpperCase() === sc.key.toUpperCase();
      } else {
        keyMatch = e.key === sc.key || e.code === sc.key;
      }

      if (ctrlMatch && shiftMatch && altMatch && keyMatch) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        doCopy();
      }
    }, true);
  }

  function listenForMessages() {
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg.action === 'copy-captions') {
          doCopy();
          sendResponse({ ok: true });
          return true;
        } else if (msg.action === 'get-copyer-status') {
          sendResponse({
            platform,
            hasContainer: !!captionContainer,
            count: capturedEntries.length,
          });
          return true;
        } else if (msg.type === 'rteDeactivated') {
          // Clean up intervals and observers
          for (const id of intervals) clearInterval(id);
          intervals.length = 0;
          if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
          if (containerObserver) { containerObserver.disconnect(); containerObserver = null; }
          captionContainer = null;
          textScanPrev.clear();
          textScanHits.clear();
          mutationHits.clear();
          return;
        }
      });
    } catch (_) { /* not in extension context */ }
  }

  // ======================= CONTENT VALIDATION =======================

  function looksLikeCaptions(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    const lower = trimmed.toLowerCase();

    // Count how many UI tokens appear as EXACT standalone matches (with underscores)
    // Only count underscore-based icon ligatures, not common English phrases
    let iconHits = 0;
    const words = trimmed.split(/\s+/);
    for (const w of words) {
      if (w.includes('_') && UI_TOKENS.some(t => t.toLowerCase() === w.toLowerCase())) iconHits++;
    }

    // If 3+ icon ligatures in the text, it's UI garbage
    if (iconHits >= 3) return false;

    // If text is ONLY icon ligatures, reject
    if (iconHits > 0 && iconHits === words.length) return false;

    // Reject text that reads like keyboard navigation instructions
    if (/\b(?:press|arrow|escape|tab)\b/i.test(lower) &&
        /\bto\s+(?:open|close|navigate|select|move|toggle)\b/i.test(lower)) {
      return false;
    }

    // Reject very short text where average "word" is abnormally tiny (icon fonts)
    if (words.length > 5) {
      const avg = words.reduce((s, w) => s + w.length, 0) / words.length;
      if (avg < 2) return false;
    }

    return true;
  }

  function looksLikeSpeakerName(text, element) {
    if (!text) return false;
    if (knownSpeakers.has(text)) return true;
    if (text.length > 40) return false;

    // Reject if it contains sentence-ending punctuation (spoken text, not a name)
    if (/[.!?;]/.test(text)) return false;

    const words = text.split(/\s+/);
    if (words.length < 1 || words.length > 4) return false;

    // If element has many siblings, it's likely a word inside a text container
    if (element && element.parentElement) {
      const siblingCount = element.parentElement.children.length;
      if (siblingCount > 5) return false;
    }

    // Accept "You" (Google Meet local user) and other single-word display names
    if (words.length === 1) {
      const w = text.trim();
      // Accept if it's short and doesn't look like a sentence fragment
      if (w.length <= 20 && !/\s/.test(w) && !/[.!?,;]/.test(w)) {
        knownSpeakers.add(w);
        return true;
      }
      return false;
    }

    // Multi-word: accept names in any script (Latin, Thai, CJK, Arabic, etc.)
    // A name is typically short, no sentence punctuation, and ≤4 words
    knownSpeakers.add(text);
    return true;
  }

  // ======================= CONTAINER DISCOVERY (SELECTORS) =======================

  function searchBySelectors() {
    if (captionContainer && document.contains(captionContainer)) {
      pendingCandidate = null;
      return;
    }

    if (pendingCandidate) {
      if (!document.contains(pendingCandidate)) {
        pendingCandidate = null;
      } else {
        const nowText = pendingCandidate.innerText.trim();
        if (nowText !== pendingCandidateText && nowText && looksLikeCaptions(nowText)) {
          attachContainer(pendingCandidate, 'verified selector candidate');
          return;
        }
        if (Date.now() - pendingCandidateTs > 10000) {
          pendingCandidate = null;
        } else {
          return;
        }
      }
    }

    captionContainer = null;
    const cfg = SELECTORS[platform];
    if (!cfg) return;

    for (const sel of cfg.containers) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) {
          const txt = el.innerText.trim();
          if (txt && looksLikeCaptions(txt)) {
            pendingCandidate = el;
            pendingCandidateText = txt;
            pendingCandidateTs = Date.now();
            return;
          }
        }
      } catch (_) { /* invalid or unsupported selector */ }
    }
  }

  // ======================= CONTAINER DISCOVERY (MUTATION TRACKING) =======================

  function startMutationTracking() {
    bodyObserver = new MutationObserver((mutations) => {
      if (captionContainer) return;
      if (mutations.length > 500) return;

      for (const m of mutations) {
        let el = null;

        if (m.type === 'characterData') {
          if (!m.target.parentElement) continue;
          el = m.target.parentElement;
        } else if (m.type === 'childList' && m.addedNodes.length > 0) {
          let hasText = false;
          for (const n of m.addedNodes) {
            if (n.textContent && n.textContent.trim().length > 1) { hasText = true; break; }
          }
          if (!hasText) continue;
          el = m.target;
          if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
        }

        if (!el) continue;

        for (let i = 0; i < 8; i++) {
          const p = el.parentElement;
          if (!p || p === document.body || p === document.documentElement) break;
          try {
            const r = p.getBoundingClientRect();
            if (r.height > 400) break;
          } catch (_) { break; }
          el = p;
        }

        mutationHits.set(el, (mutationHits.get(el) || 0) + 1);
      }
    });

    bodyObserver.observe(document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  function evaluateMutationCandidates() {
    if (captionContainer && document.contains(captionContainer)) {
      mutationHits.clear();
      return;
    }

    let best = null;
    let bestCount = 0;

    for (const [el, count] of mutationHits) {
      if (count > bestCount && document.contains(el) && isVisible(el)) {
        bestCount = count;
        best = el;
      }
    }

    mutationHits.clear();

    if (!best || bestCount < MIN_MUTATION_HITS) return;

    let container = best;
    let cur = container;
    for (let lvl = 0; lvl < 6; lvl++) {
      const p = cur.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      try {
        const r = p.getBoundingClientRect();
        if (r.height > 500) break;
        let captionKids = 0;
        for (const ch of p.children) {
          const ct = ch.innerText?.trim();
          if (ct && ct.length > 3 && looksLikeCaptions(ct)) captionKids++;
        }
        if (captionKids >= 2) { container = p; cur = p; }
        else break;
      } catch (_) { break; }
    }

    const txt = container.innerText?.trim();
    if (txt && txt.length >= 10 && txt.length < 3000 && looksLikeCaptions(txt)) {
      attachContainer(container, 'mutation tracking (' + bestCount + ' hits)');
    }
  }

  // ======================= CONTAINER DISCOVERY (TEXT-CHANGE SCANNING) =======================

  function scanForTextChanges() {
    if (captionContainer) {
      textScanPrev.clear();
      textScanHits.clear();
      return;
    }

    const viewH = window.innerHeight;
    let bestEl   = null;
    let bestArea = Infinity;

    for (const el of document.querySelectorAll('div, span, section')) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < viewH * 0.45 || rect.top > viewH) continue;
        if (rect.height < 12 || rect.height > 350) continue;
        if (rect.width < 120) continue;

        const text = el.innerText?.trim();
        if (!text || text.length < 5 || text.length > 3000) continue;

        const prev = textScanPrev.get(el);
        textScanPrev.set(el, text);

        if (prev === undefined) continue;
        if (prev === text) continue;

        const hits = (textScanHits.get(el) || 0) + 1;
        textScanHits.set(el, hits);

        if (hits >= 2 && looksLikeCaptions(text)) {
          const area = rect.width * rect.height;
          if (area < bestArea) {
            bestArea = area;
            bestEl   = el;
          }
        }
      } catch (_) { /* skip */ }
    }

    if (bestEl) {
      let container = bestEl;
      let cur = container;
      for (let lvl = 0; lvl < 6; lvl++) {
        const p = cur.parentElement;
        if (!p || p === document.body || p === document.documentElement) break;
        try {
          const pr = p.getBoundingClientRect();
          if (pr.height > 500) break;
          let captionKids = 0;
          for (const ch of p.children) {
            const ct = ch.innerText?.trim();
            if (ct && ct.length > 3 && looksLikeCaptions(ct)) captionKids++;
          }
          if (captionKids >= 2) { container = p; cur = p; }
          else break;
        } catch (_) { break; }
      }

      attachContainer(container, 'text-change scan');
      textScanPrev.clear();
      textScanHits.clear();
      return;
    }

    if (textScanPrev.size > 200) {
      for (const [el] of textScanPrev) {
        if (!document.contains(el)) {
          textScanPrev.delete(el);
          textScanHits.delete(el);
        }
      }
    }
  }

  // ======================= ATTACH / OBSERVE =======================

  function attachContainer(el, source) {
    captionContainer = el;
    isDirty = true;
    previousTexts = [];
    pendingCandidate = null;
    console.log('[RTE CaptionCopyer] Caption container found via ' + (source || 'unknown'));

    if (containerObserver) containerObserver.disconnect();
    containerObserver = new MutationObserver(() => { isDirty = true; });
    containerObserver.observe(el, { childList: true, subtree: true, characterData: true });
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // ======================= CAPTION POLLING =======================

  function poll() {
    if (!captionContainer || !isDirty) return;
    isDirty = false;

    if (!document.contains(captionContainer)) {
      captionContainer = null;
      previousTexts = [];
      return;
    }

    const current = extractTexts();
    diffAndStore(current);
    previousTexts = current;
  }

  function extractByDOMWalk(container) {
    const entries = [];
    let speaker  = null;
    let parts    = [];

    function save() {
      if (speaker) {
        const msg = parts.join(' ').trim();
        entries.push(speaker + (msg ? ': ' + msg : ':'));
        knownSpeakers.add(speaker);
      } else if (parts.length > 0) {
        const msg = parts.join(' ').trim();
        if (msg && looksLikeCaptions(msg)) entries.push(msg);
      }
      speaker = null;
      parts   = [];
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) parts.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'IMG' || node.tagName === 'SVG' ||
          node.tagName === 'BUTTON' || node.tagName === 'INPUT') return;

      if (node.children.length === 0) {
        const t = node.textContent.trim();
        if (!t) return;
        if (looksLikeSpeakerName(t, node)) {
          save();
          speaker = t;
        } else {
          parts.push(t);
        }
        return;
      }

      for (const ch of node.childNodes) walk(ch);
    }

    walk(container);
    save();
    return entries;
  }

  function isLikelyName(text) {
    if (!text) return false;
    if (knownSpeakers.has(text)) return true;
    if (text.length > 40) return false;
    if (/[.!?;]/.test(text)) return false; // Sentence punctuation = not a name
    const words = text.split(/\s+/);
    if (words.length < 1 || words.length > 4) return false;
    // Accept names in any script — just check it's short and not a sentence
    return true;
  }

  function groupSpeakerLines(lines) {
    const entries = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (isLikelyName(line)) {
        knownSpeakers.add(line);
        const textParts = [];
        i++;
        while (i < lines.length && !isLikelyName(lines[i])) {
          if (looksLikeCaptions(lines[i])) textParts.push(lines[i]);
          i++;
        }
        const msg = textParts.join(' ').trim();
        entries.push(line + (msg ? ': ' + msg : ':'));
      } else {
        if (looksLikeCaptions(line) && line.length > 10) entries.push(line);
        i++;
      }
    }
    return entries;
  }

  function extractTexts() {
    if (!captionContainer) return [];

    const cfg = SELECTORS[platform];
    let out = [];

    // 1. Structured entry selectors
    if (cfg.entries && cfg.entries.length) {
      for (const sel of cfg.entries) {
        try {
          const els = captionContainer.querySelectorAll(sel);
          if (els.length) {
            els.forEach((e) => {
              const t = norm(e.innerText);
              if (t && looksLikeCaptions(t)) out.push(t);
            });
            if (out.length) return out;
          }
        } catch (_) { /* skip */ }
      }
    }

    // 2. innerText + speaker grouping
    const raw = captionContainer.innerText?.trim();
    if (raw) {
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        out = groupSpeakerLines(lines);
        if (out.length > 0) return out;
      }
    }

    // 3. DOM walker fallback
    {
      const walked = extractByDOMWalk(captionContainer);
      const hasContent = walked.some((e) => {
        const cp = e.indexOf(': ');
        return cp > 0 && cp < e.length - 2;
      });
      if (walked.length > 0 && hasContent) return walked;
    }

    // 4. Raw fallback
    if (raw && looksLikeCaptions(raw)) {
      return [raw.replace(/\n/g, ' ').trim()];
    }
    return [];
  }

  function norm(s) {
    return s ? s.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '';
  }

  // ======================= DIFF & STORE =======================

  function diffAndStore(current) {
    if (!current.length) return;

    for (const prev of previousTexts) {
      if (!stillVisible(prev, current)) {
        pushEntry(formatEntry(prev));
      }
    }
  }

  function stillVisible(text, currentTexts) {
    for (const cur of currentTexts) {
      if (cur === text) return true;
      if (cur.startsWith(text)) return true;
      if (text.length > 10 && cur.length > 10) {
        const common = prefixLen(text, cur);
        if (common > Math.min(text.length, cur.length) * 0.6) return true;
      }
      if (areSimilarEntries(text, cur)) return true;
    }
    return false;
  }

  function prefixLen(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    return i;
  }

  function areSimilarEntries(a, b) {
    const sepA = a.indexOf(': ');
    const sepB = b.indexOf(': ');
    const spkA = sepA > 0 ? a.substring(0, sepA) : '';
    const spkB = sepB > 0 ? b.substring(0, sepB) : '';

    if (spkA && spkB && spkA !== spkB) return false;

    const msgA = (sepA > 0 ? a.substring(sepA + 2) : a).toLowerCase();
    const msgB = (sepB > 0 ? b.substring(sepB + 2) : b).toLowerCase();

    if (msgA.startsWith(msgB) || msgB.startsWith(msgA)) return true;

    const strip = (w) => w.replace(/[^a-z0-9]/g, '');
    const setA = new Set(msgA.split(/\s+/).map(strip).filter(Boolean));
    const setB = new Set(msgB.split(/\s+/).map(strip).filter(Boolean));

    if (setA.size < 3 || setB.size < 3) return false;

    const smaller = setA.size <= setB.size ? setA : setB;
    const larger  = setA.size <= setB.size ? setB : setA;

    let overlap = 0;
    for (const w of smaller) if (larger.has(w)) overlap++;

    return overlap / smaller.size >= 0.6;
  }

  function formatEntry(raw) {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length >= 2) {
      const first = lines[0];
      const nameCandidate =
        first.length < 40 &&
        !first.includes(': ') &&
        !/[.!?;,]$/.test(first);
      if (nameCandidate) {
        knownSpeakers.add(first);
        return first + ': ' + lines.slice(1).join(' ');
      }
    }

    if (lines.length === 1 && knownSpeakers.has(lines[0])) {
      return lines[0] + ':';
    }

    return lines.join(' ');
  }

  function pushEntry(text) {
    text = text.trim();
    if (!text) return;
    if (!looksLikeCaptions(text)) return;

    if (capturedEntries.length) {
      const last = capturedEntries[capturedEntries.length - 1];
      if (last === text) return;
      if (text.startsWith(last) || last.startsWith(text)) {
        capturedEntries[capturedEntries.length - 1] =
          text.length > last.length ? text : last;
        return;
      }
      if (areSimilarEntries(text, last)) {
        capturedEntries[capturedEntries.length - 1] =
          text.length > last.length ? text : last;
        return;
      }
    }

    capturedEntries.push(text);
    if (capturedEntries.length > MAX_ENTRIES) {
      capturedEntries.splice(0, capturedEntries.length - MAX_ENTRIES);
    }
  }

  // ======================= COPY TO CLIPBOARD =======================

  /**
   * Main copy function. Tries RTE's transcript first (the text sent to
   * Translator), falls back to locally captured captions.
   */
  async function doCopy() {
    const now = Date.now();
    if (now - lastCopyTs < COPY_DEBOUNCE_MS) return;
    lastCopyTs = now;

    // Try to get the processed transcript from RTE background
    // (this is the same text sent to Google Translate in real-time)
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'getTranscriptForCopy', sentenceCount },
          (resp) => {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(resp);
          }
        );
      });

      if (response && response.text && response.text.trim()) {
        writeClipboard(response.text);
        const count = response.count || 'some';
        showToast('Copied ' + count + ' sentence' + (count === 1 ? '' : 's') + ' from RTE transcript');
        return;
      }
    } catch (_) {
      // Background not available — use local capture
    }

    // Fallback: use locally captured captions
    const all = buildFullList();

    if (!all.length) {
      showToast('No captions captured yet. Please enable Closed Captions (CC) or Live Captions in your meeting.');
      return;
    }

    const n =
      sentenceCount === 'all'
        ? all.length
        : Math.min(Number(sentenceCount) || 5, all.length);

    const selected = all.slice(-n);
    const text = selected.join('\n\n');

    writeClipboard(text);
    showToast('Copied ' + selected.length + ' sentence' + (selected.length === 1 ? '' : 's') + ' to clipboard');
  }

  function buildFullList() {
    const result = capturedEntries.slice();

    for (const raw of extractTexts()) {
      const text = formatEntry(raw);
      if (!text || !looksLikeCaptions(text)) continue;

      if (result.length) {
        const last = result[result.length - 1];
        if (last === text) continue;
        if (text.startsWith(last) || last.startsWith(text)) {
          result[result.length - 1] = text.length > last.length ? text : last;
          continue;
        }
        if (areSimilarEntries(text, last)) {
          result[result.length - 1] = text.length > last.length ? text : last;
          continue;
        }
      }
      result.push(text);
    }

    return result;
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* ignore */ }
    document.body.removeChild(ta);
  }

  // ======================= TOAST =======================

  function showToast(message) {
    const ID = '__rte_caption_toast';
    let el = document.getElementById(ID);
    if (el) el.remove();

    el = document.createElement('div');
    el.id = ID;
    el.textContent = message;
    Object.assign(el.style, {
      position:       'fixed',
      bottom:         '80px',
      left:           '50%',
      transform:      'translateX(-50%)',
      background:     'rgba(30,30,30,0.92)',
      color:          '#fff',
      padding:        '10px 24px',
      borderRadius:   '8px',
      fontFamily:     "'Segoe UI',Roboto,sans-serif",
      fontSize:       '13px',
      lineHeight:     '1.4',
      zIndex:         '2147483647',
      boxShadow:      '0 4px 16px rgba(0,0,0,0.25)',
      transition:     'opacity 0.3s ease',
      opacity:        '0',
      pointerEvents:  'none',
      whiteSpace:     'nowrap',
    });
    document.body.appendChild(el);

    requestAnimationFrame(() => { el.style.opacity = '1'; });

    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 350);
    }, TOAST_DURATION_MS);
  }

  // ======================= START =======================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
