// ============================================================
// RTE - Background Service Worker (Optimized + MsgCopyer Integration)
// State persistence, AI calls, message routing, tab management.
// MV3 service workers are ephemeral — state is persisted to
// chrome.storage.session with keep-alive alarm.
//
// Settings (API keys, provider, shortcuts) are stored in
// chrome.storage.sync to survive extension uninstall/reinstall.
// ============================================================

// ── State ──
let state = {
  active: false,
  sourceLang: 'en',
  targetLang: 'th',
  translateTabId: null,
  meetingTabId: null,
  platform: null,
  fullTranscript: [],
  spellingCorrection: true,
};

let stateLoaded = false;
let debounceTimer = null;
let lastCommandTime = 0;
let lastCommandName = '';

const DEBOUNCE_MS = 500;
const DEBOUNCE_FIRST_MS = 150;  // Faster flush for first text of a new turn
const COMMAND_DEBOUNCE_MS = 500;
const KEEP_ALIVE_ALARM = 'rte-keep-alive';
const KEEP_ALIVE_MIN = 1;  // Chrome MV3 minimum is 1 minute

const DEFAULT_SHORTCUTS = {
  'generate-question': 'Ctrl+Shift+Q',
  'generate-simple-answer': 'Ctrl+Shift+A',
  'generate-detailed-answer': 'Ctrl+Shift+E',
  'clear-translate': 'Ctrl+Shift+Z',
  'copy-captions': 'Ctrl+Shift+C',
};

const PERSIST_KEYS = ['active', 'sourceLang', 'targetLang', 'translateTabId', 'meetingTabId', 'platform', 'spellingCorrection'];

// Keys that should be stored in sync storage (persist across reinstall)
const SYNC_SETTINGS_KEYS = ['aiProvider', 'openaiKey', 'anthropicKey', 'spellingCorrection', 'customShortcuts', 'sentenceCount'];

// ── Storage helpers ──
async function storageSet(data) {
  try { await chrome.storage.session.set(data); } catch { await chrome.storage.local.set(data); }
}
async function storageGet(keys) {
  try { return await chrome.storage.session.get(keys); } catch { return await chrome.storage.local.get(keys); }
}

/**
 * Get a setting from sync first, then fall back to local.
 */
async function getSettings(keys) {
  // Normalize keys to always be an array
  const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
  const syncData = await chrome.storage.sync.get(keyList).catch(() => ({}));
  const localData = await chrome.storage.local.get(keyList).catch(() => ({}));
  // Merge: sync takes precedence for non-undefined values
  const result = { ...localData };
  for (const key of keyList) {
    if (syncData[key] !== undefined) result[key] = syncData[key];
  }
  return result;
}

/**
 * Save settings to both sync and local storage.
 */
async function saveSettings(data) {
  const syncData = {};
  const localData = { ...data };

  for (const key of SYNC_SETTINGS_KEYS) {
    if (data[key] !== undefined) {
      syncData[key] = data[key];
    }
  }

  // Save to sync (persists across reinstall)
  if (Object.keys(syncData).length > 0) {
    try { await chrome.storage.sync.set(syncData); } catch { /* sync not available */ }
  }

  // Also save to local for immediate access
  await chrome.storage.local.set(localData);
}

// ── State Persistence ──
async function saveState() {
  const data = {};
  for (const k of PERSIST_KEYS) data['_sw_' + k] = state[k];
  data['_sw_transcript'] = state.fullTranscript.slice(-200);
  await storageSet(data);
}

async function loadState() {
  const keys = PERSIST_KEYS.map(k => '_sw_' + k).concat('_sw_transcript');
  const data = await storageGet(keys);

  if (data['_sw_active'] !== undefined) {
    for (const k of PERSIST_KEYS) { if (data['_sw_' + k] !== undefined) state[k] = data['_sw_' + k]; }
    if (data['_sw_transcript']) state.fullTranscript = data['_sw_transcript'];

    // Validate tab IDs
    for (const key of ['translateTabId', 'meetingTabId']) {
      if (state[key]) {
        try { await chrome.tabs.get(state[key]); }
        catch { state[key] = null; if (key === 'meetingTabId') state.platform = null; }
      }
    }
  }

  stateLoaded = true;
  if (state.active) startKeepAlive();
}

// ── Keep-Alive ──
function startKeepAlive() { chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: KEEP_ALIVE_MIN }); }
function stopKeepAlive() { chrome.alarms.clear(KEEP_ALIVE_ALARM); }

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEP_ALIVE_ALARM) return;
  if (state.active) saveState();
  else stopKeepAlive();
});

// ── Init ──
loadState();

chrome.runtime.onInstalled.addListener(async () => {
  // loadState already runs at top level; onStartup is handled below
  // Migrate settings from local to sync on install/update
  const localData = await chrome.storage.local.get(SYNC_SETTINGS_KEYS);
  const syncData = await chrome.storage.sync.get(SYNC_SETTINGS_KEYS).catch(() => ({}));

  // If sync has data (from previous install), restore to local
  const hasSync = SYNC_SETTINGS_KEYS.some(k => syncData[k] !== undefined);
  if (hasSync) {
    // Sync → Local (restore after reinstall)
    const merged = {};
    for (const k of SYNC_SETTINGS_KEYS) {
      if (syncData[k] !== undefined) merged[k] = syncData[k];
      else if (localData[k] !== undefined) merged[k] = localData[k];
    }
    await chrome.storage.local.set(merged);
  } else {
    // Local → Sync (first time or migration)
    const toSync = {};
    for (const k of SYNC_SETTINGS_KEYS) {
      if (localData[k] !== undefined) toSync[k] = localData[k];
    }
    // Set defaults for missing keys
    if (!toSync.aiProvider) toSync.aiProvider = 'openai';
    if (toSync.openaiKey === undefined) toSync.openaiKey = '';
    if (toSync.anthropicKey === undefined) toSync.anthropicKey = '';
    if (toSync.spellingCorrection === undefined) toSync.spellingCorrection = true;
    if (toSync.sentenceCount === undefined) toSync.sentenceCount = 5;

    try { await chrome.storage.sync.set(toSync); } catch { /* sync not available */ }
    await chrome.storage.local.set(toSync);
  }

  // Ensure documents array exists in local
  const docData = await chrome.storage.local.get(['documents']);
  if (!docData.documents) {
    await chrome.storage.local.set({ documents: [] });
  }

  // Also restore documents from sync if available (chunked)
  await restoreDocumentsFromSync();
});

// onStartup only fires on browser launch (not extension reload), so it's safe
chrome.runtime.onStartup.addListener(() => { if (!stateLoaded) loadState(); });

// ── Document Sync (Chunked) ──
// Documents can be large, so we chunk them for sync storage
const DOC_SYNC_PREFIX = '_doc_chunk_';
const DOC_SYNC_META = '_doc_meta';
const MAX_CHUNK_SIZE = 7000; // Under 8KB limit per sync item

async function syncDocumentsToSync(documents) {
  try {
    // Clear old chunks
    const allSync = await chrome.storage.sync.get(null);
    const oldKeys = Object.keys(allSync).filter(k => k.startsWith(DOC_SYNC_PREFIX) || k === DOC_SYNC_META);
    if (oldKeys.length > 0) {
      await chrome.storage.sync.remove(oldKeys);
    }

    if (!documents || documents.length === 0) return;

    // Serialize and chunk
    const json = JSON.stringify(documents);
    const chunks = {};
    let chunkIndex = 0;

    for (let i = 0; i < json.length; i += MAX_CHUNK_SIZE) {
      const chunkKey = DOC_SYNC_PREFIX + chunkIndex;
      chunks[chunkKey] = json.slice(i, i + MAX_CHUNK_SIZE);
      chunkIndex++;
    }

    // Check if it fits within sync quota (~100KB total minus other settings)
    const totalSize = Object.values(chunks).reduce((sum, c) => sum + c.length, 0);
    if (totalSize > 80000) {
      console.log('[RTE] Documents too large for sync storage (' + totalSize + ' bytes). Use Export/Import.');
      return;
    }

    chunks[DOC_SYNC_META] = { chunkCount: chunkIndex, totalSize: json.length };
    await chrome.storage.sync.set(chunks);
  } catch (e) {
    console.log('[RTE] Could not sync documents:', e.message);
  }
}

async function restoreDocumentsFromSync() {
  try {
    const meta = await chrome.storage.sync.get(DOC_SYNC_META);
    if (!meta[DOC_SYNC_META] || !meta[DOC_SYNC_META].chunkCount) return;

    const chunkCount = meta[DOC_SYNC_META].chunkCount;
    const chunkKeys = [];
    for (let i = 0; i < chunkCount; i++) {
      chunkKeys.push(DOC_SYNC_PREFIX + i);
    }

    const chunks = await chrome.storage.sync.get(chunkKeys);
    let json = '';
    for (let i = 0; i < chunkCount; i++) {
      const chunk = chunks[DOC_SYNC_PREFIX + i];
      if (!chunk) return; // Incomplete data
      json += chunk;
    }

    const documents = JSON.parse(json);
    if (Array.isArray(documents) && documents.length > 0) {
      // Only restore if local has no documents
      const localDocs = await chrome.storage.local.get(['documents']);
      if (!localDocs.documents || localDocs.documents.length === 0) {
        await chrome.storage.local.set({ documents });
        console.log('[RTE] Restored ' + documents.length + ' documents from sync');
      }
    }
  } catch (e) {
    console.log('[RTE] Could not restore documents from sync:', e.message);
  }
}

// ── Message Handling ──
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!stateLoaded) { loadState().then(() => route(msg, sender, respond)); return true; }
  return route(msg, sender, respond);
});

function route(msg, sender, respond) {
  switch (msg.type) {
    case 'activate': handleActivate(msg).then(respond); return true;
    case 'deactivate': handleDeactivate().then(respond); return true;
    case 'getStatus':
      respond({ active: state.active, sourceLang: state.sourceLang, targetLang: state.targetLang, platform: state.platform, transcriptCount: state.fullTranscript.length });
      break;
    case 'captionBatch': handleCaptionBatch(msg, sender); respond({ ok: true }); break;
    case 'transcript': handleLegacyTranscript(msg, sender); respond({ ok: true }); break;
    case 'translateReady': respond({ ok: true }); break;
    case 'customCommand': handleCustomCommand(msg.command, sender); respond({ ok: true }); break;
    case 'getTranscriptForCopy': handleGetTranscriptForCopy(msg, respond); return true;
    case 'saveSettings': handleSaveSettings(msg.data).then(respond); return true;
    case 'syncDocuments': handleSyncDocuments(msg.documents).then(respond); return true;
    default: respond({ error: 'Unknown message type' });
  }
}

// ── Copy Captions ──
function handleGetTranscriptForCopy(msg, respond) {
  if (!state.active || state.fullTranscript.length === 0) {
    respond({ text: '', count: 0 });
    return;
  }

  const sentenceCount = msg.sentenceCount || 'all';
  const transcript = state.fullTranscript;

  const n = sentenceCount === 'all'
    ? transcript.length
    : Math.min(Number(sentenceCount) || 5, transcript.length);

  const selected = transcript.slice(-n);

  // Format as "Speaker: text" entries joined by double newlines
  // This is the same format sent to Google Translate
  const text = selected.map(e => `${e.speaker}: ${e.text}`).join('\n\n');

  respond({ text, count: selected.length });
}

// ── Settings persistence ──
async function handleSaveSettings(data) {
  await saveSettings(data);
  return { ok: true };
}

async function handleSyncDocuments(documents) {
  await syncDocumentsToSync(documents);
  return { ok: true };
}

// ── Commands ──
async function handleCustomCommand(cmd, sender) { await dispatchCommand(cmd, sender?.tab?.id); }

async function dispatchCommand(cmd, senderTabId) {
  const now = Date.now();
  if (cmd === lastCommandName && (now - lastCommandTime) < COMMAND_DEBOUNCE_MS) return;
  lastCommandName = cmd; lastCommandTime = now;

  if (cmd === 'clear-translate') { await clearConversationHistory(); return; }

  if (cmd === 'copy-captions') {
    // Forward to the active tab's content script
    const tabId = state.meetingTabId || senderTabId;
    if (tabId) {
      safeSendTab(tabId, { action: 'copy-captions' });
    } else {
      // Try the currently active tab
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { action: 'copy-captions' }).catch(() => {});
        }
      } catch { /* no active tab */ }
    }
    return;
  }

  let tab = state.meetingTabId || senderTabId;
  // If we still don't know the meeting tab, try the active tab
  if (!tab) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id) tab = activeTab.id;
    } catch {}
  }
  if (!tab) return;
  // Remember the meeting tab for future commands
  if (!state.meetingTabId && tab) { state.meetingTabId = tab; }

  const typeMap = { 'generate-question': 'question', 'generate-simple-answer': 'simple-answer', 'generate-detailed-answer': 'detailed-answer' };
  const type = typeMap[cmd];
  if (!type) return;

  safeSendTab(tab, { type: 'streamStart', mode: type });
  try {
    await streamAIResponse(type, tab);
    safeSendTab(tab, { type: 'streamEnd' });
  } catch (err) {
    safeSendTab(tab, { type: 'showOverlay', mode: type, content: `Error: ${err.message}`, isError: true });
  }
}

// Chrome commands API (disabled when custom shortcuts active)
chrome.commands.onCommand.addListener(async (cmd) => {
  if (!stateLoaded) await loadState();
  const settings = await getSettings(['customShortcuts']);
  const customShortcuts = settings.customShortcuts;
  // For non-copy commands, check if custom shortcuts are set
  if (cmd !== 'copy-captions' && customShortcuts && Object.keys(DEFAULT_SHORTCUTS).some(k => k !== 'copy-captions' && customShortcuts[k] !== DEFAULT_SHORTCUTS[k])) return;
  await dispatchCommand(cmd, null);
});

// ── Clear Conversation History ──
// Ctrl+Shift+Z: Clears all saved transcript history, Google Translate text,
// and committed blocks. Gives a fresh start mid-meeting.
async function clearConversationHistory() {
  // Clear transcript and internal state
  state.fullTranscript = [];
  lastVisibleCaptions = [];
  committedBlocks.length = 0;
  translateDirty = false;
  pendingCorrectionId++;
  clearTimeout(debounceTimer);

  // Save cleared state
  await saveState();

  // Clear Google Translate text
  const tabId = state.translateTabId;
  if (tabId) {
    try { await chrome.tabs.get(tabId); } catch { state.translateTabId = null; saveState(); return; }

    try { await chrome.tabs.sendMessage(tabId, { type: 'clearTranslation' }); } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            for (const b of document.querySelectorAll('button[aria-label="Clear source text"],button[aria-label*="Clear"],button[jsname="WMmhGe"]')) { b.click(); return; }
            const ta = document.querySelector('textarea');
            if (ta) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); }
          },
        });
      } catch {}
    }
  }

  // Notify the meeting tab so the user sees confirmation
  if (state.meetingTabId) {
    safeSendTab(state.meetingTabId, {
      type: 'showOverlay',
      mode: 'clear',
      content: 'Conversation history cleared.',
      isError: false,
    });
  }
}

// ── Tab lifecycle ──
chrome.tabs.onRemoved.addListener((id) => {
  if (id === state.translateTabId) { state.translateTabId = null; saveState(); }
  if (id === state.meetingTabId) { state.meetingTabId = null; state.platform = null; saveState(); }
});

// ── Activate / Deactivate ──
async function handleActivate({ sourceLang, targetLang }) {
  state.sourceLang = sourceLang; state.targetLang = targetLang;
  state.fullTranscript = [];
  lastVisibleCaptions = []; translateDirty = false;
  committedBlocks.length = 0;

  const s = await getSettings(['spellingCorrection']);
  state.spellingCorrection = s.spellingCorrection !== false;

  try {
    const tab = await chrome.tabs.create({ url: `https://translate.google.com/?sl=${sourceLang}&tl=${targetLang}&op=translate`, active: false });
    state.translateTabId = tab.id;
  } catch (err) { return { ok: false, error: 'Failed to open Google Translate: ' + err.message }; }

  state.active = true;
  await saveState(); startKeepAlive();
  return { ok: true };
}

async function handleDeactivate() {
  const meetingTab = state.meetingTabId;
  state.active = false; state.platform = null; state.meetingTabId = null;
  state.fullTranscript = [];
  lastVisibleCaptions = []; translateDirty = false;
  committedBlocks.length = 0;
  pendingCorrectionId++; // Cancel any pending spelling corrections
  if (state.translateTabId) { try { await chrome.tabs.remove(state.translateTabId); } catch {} state.translateTabId = null; }
  // Notify content scripts to clean up (stop intervals/observers)
  if (meetingTab) { safeSendTab(meetingTab, { type: 'rteDeactivated' }); }
  await saveState(); stopKeepAlive();
  return { ok: true };
}

// ── Transcript Handling (Batch Architecture) ──
// Content scripts send {captions: [{speaker, text}, ...]} — ALL visible captions.
// We merge each batch into committed + visible blocks.
// Google Translate receives the exact same blocks.

let lastVisibleCaptions = [];  // The last batch received
let translateDirty = false;
let pendingCorrectionId = 0;

/**
 * Handle a batch of ALL currently visible captions from the meeting page.
 * This is the primary transcript handler.
 */
function handleCaptionBatch(msg, sender) {
  if (!state.active) return;
  if (sender.tab) { state.meetingTabId = sender.tab.id; state.platform = msg.platform || detectPlatform(sender.tab.url); }

  const captions = msg.captions || [];
  if (captions.length === 0 && lastVisibleCaptions.length === 0) return;

  // Find which old visible captions disappeared (committed/finalized)
  // and which new ones appeared or changed.
  const oldVisible = lastVisibleCaptions;
  const newVisible = captions;

  // Commit old captions that are no longer visible.
  // We compare structurally: an old caption is "gone" if it's not in the new batch.
  // Walk through old captions and check if each still exists in new batch (by position).
  // The key insight: captions are ordered top-to-bottom. Old ones fade from the top.
  // So we commit old captions from the start that don't appear in the new batch.

  if (oldVisible.length > 0 && newVisible.length > 0) {
    // Find which old captions were dropped
    const newTexts = newVisible.map(c => c.speaker + ':' + c.text);
    for (const old of oldVisible) {
      const key = old.speaker + ':' + old.text;
      if (!newTexts.includes(key)) {
        // This caption disappeared — commit it if not already in transcript
        commitCaption(old.speaker, old.text);
      }
    }
  } else if (oldVisible.length > 0 && newVisible.length === 0) {
    // All captions disappeared — commit all
    for (const old of oldVisible) {
      commitCaption(old.speaker, old.text);
    }
  }

  // Update the visible captions
  lastVisibleCaptions = newVisible.map(c => ({ speaker: c.speaker, text: c.text }));

  // The full transcript for display = committed blocks + current visible captions
  // But we need to avoid duplicating the last committed block if it's the same as
  // the first visible caption (the same speaker continuing).
  rebuildTranscript();
  translateDirty = true;

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushToTranslate, DEBOUNCE_FIRST_MS);
}

/**
 * Commit a finalized caption to the permanent transcript.
 * Merges with the last committed entry if same speaker.
 */
const committedBlocks = [];

function commitCaption(speaker, text) {
  if (!text) return;
  const last = committedBlocks[committedBlocks.length - 1];
  if (last && last.speaker === speaker && last.text === text) return; // Already committed
  if (last && last.speaker === speaker) {
    // Same speaker continuing — only update if text is longer/different
    if (text.length > last.text.length || !text.startsWith(last.text.slice(0, 10))) {
      last.text = text;
    }
  } else {
    committedBlocks.push({ speaker, text, timestamp: Date.now() });
  }
}

/**
 * Rebuild state.fullTranscript from committed + visible.
 */
function rebuildTranscript() {
  const result = committedBlocks.map(b => ({ ...b }));

  for (const cap of lastVisibleCaptions) {
    const last = result[result.length - 1];
    if (last && last.speaker === cap.speaker) {
      // Same speaker — update their text to latest visible version
      last.text = cap.text;
      last.timestamp = Date.now();
    } else {
      result.push({ speaker: cap.speaker, text: cap.text, timestamp: Date.now() });
    }
  }

  state.fullTranscript = result;
}

/**
 * Legacy handler for individual transcript messages (e.g., from Zoom via caption-copyer).
 */
function handleLegacyTranscript(msg, sender) {
  if (!state.active) return;
  if (sender.tab) { state.meetingTabId = sender.tab.id; state.platform = msg.platform || detectPlatform(sender.tab.url); }

  const speaker = msg.speaker || 'Unknown';
  const text = msg.fullText || msg.text || '';
  if (!text) return;

  const last = state.fullTranscript[state.fullTranscript.length - 1];
  if (last && last.speaker === speaker) {
    last.text = text;
    last.timestamp = Date.now();
  } else {
    state.fullTranscript.push({ speaker, text, timestamp: Date.now() });
  }

  translateDirty = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushToTranslate, DEBOUNCE_FIRST_MS);
}

async function flushToTranslate() {
  if (!state.translateTabId || !translateDirty) return;
  translateDirty = false;

  const transcript = state.fullTranscript;
  if (transcript.length === 0) return;

  // Only show the last 10 sentences in Google Translate
  const recentBlocks = transcript.slice(-10).map(e => ({
    speaker: e.speaker,
    text: e.text,
  }));

  safeSendTab(state.translateTabId, {
    type: 'translateSetBlocks',
    blocks: recentBlocks,
  });

  if (state.fullTranscript.length % 10 === 0) saveState();

  // Non-blocking spelling correction on the latest block
  const last = transcript[transcript.length - 1];
  if (state.spellingCorrection && last) {
    correctLastBlockAsync(last);
  }
}

async function correctLastBlockAsync(block) {
  const id = ++pendingCorrectionId;
  const originalText = block.text;
  try {
    const corrected = await correctSpelling(originalText);
    if (id === pendingCorrectionId && corrected && corrected !== originalText) {
      if (block.text === originalText) {
        block.text = corrected;
        if (state.translateTabId) {
          const recentBlocks = state.fullTranscript.slice(-20).map(e => ({ speaker: e.speaker, text: e.text }));
          safeSendTab(state.translateTabId, { type: 'translateSetBlocks', blocks: recentBlocks });
        }
      }
    }
  } catch {
    // Correction failed — original text stands
  }
}

// ── Spelling Correction ──
async function correctSpelling(text) {
  if (!text || text.trim().length < 8) return text;

  const settings = await getSettings(['aiProvider', 'openaiKey', 'anthropicKey']);

  const prompt = 'Fix spelling/grammar in the transcript below. Output ONLY the corrected text, nothing else. Keep the same format. If already correct, return unchanged. NEVER add explanations or commentary.';

  let result;
  if (settings.aiProvider === 'anthropic' && settings.anthropicKey) result = await callAI('anthropic', prompt, text, settings.anthropicKey);
  else if (settings.openaiKey) result = await callAI('openai', prompt, text, settings.openaiKey);
  else return text;

  if (!result) return text;

  const bad = ['i notice', "i'm ready", 'please provide', 'here is', 'here are', 'i can help', "i'd be happy", 'let me', 'it appears', 'to help you', "you've provided"];
  const lower = result.toLowerCase();
  if (bad.some(p => lower.includes(p)) || result.length > text.length * 2) return text;

  return result;
}

// ── AI: Build Prompt Context ──
function buildAIContext(requestType, documents) {
  const docs = (documents || []).map((d, i) => `[Doc ${i + 1}: ${d.name}]\n${d.content}`).join('\n\n');

  // Use last 15 entries for richer context
  const transcript = state.fullTranscript.slice(-15).map(e => `${e.speaker}: ${e.text}`).join('\n');

  const docNote = docs
    ? '\n\nREFERENCE DOCUMENTS are provided. Use them as ~30% of your knowledge — blend relevant facts naturally. Do NOT quote them directly.'
    : '';

  const COMMON_RULES = `
CRITICAL — Read the transcript VERY carefully:
- Read every word in the conversation EXACTLY as written. Do NOT guess, skip, abbreviate, or change any words.
- If someone says "AI agent", respond about "AI agent" — NOT "AI AG", "AGI", or anything else.
- The transcript comes from speech recognition and may contain minor errors, but respond to the EXACT words as closely as possible.
- Pay close attention to the LAST few sentences — that is what the other party is currently asking or talking about.

Tone and style:
- Be professional but warm and approachable — like a friendly, experienced colleague
- Be practical and useful — give answers people can actually use, not textbook definitions
- Sound natural — like a real person talking, not a chatbot or encyclopedia
- Keep it conversational — avoid stiff, formal, or overly academic language
- If they asked about your experience/skills, respond in first person ("I have...", "I've worked on...")`;

  const PROMPTS = {
    'question': `You are helping someone in a live meeting. Analyze the last few sentences the other party said and suggest 2-3 smart follow-up questions.

${COMMON_RULES}

Additional rules for questions:
- Questions must relate directly to what was JUST discussed (the most recent sentences)
- Make them sound natural, like a colleague would ask
- Show you've been paying attention to the specific words and topics mentioned
- Vary between clarifying questions and deeper exploration${docNote}`,

    'simple-answer': `You are helping someone respond in a live meeting. Analyze the last few sentences the other party said and generate a response.

${COMMON_RULES}

Additional rules for quick answers:
- Give a direct, concise answer (2-4 sentences)
- Answer the most recent thing the other party said or asked
- Be specific, not vague — use concrete details relevant to what they actually said
- Start with the answer immediately — no preamble like "Great question" or "Sure"
- Match the energy of the conversation (casual or formal)${docNote}`,

    'detailed-answer': `You are a knowledgeable professional helping someone respond in a live meeting. Analyze the last few sentences the other party said and generate a thorough response.

${COMMON_RULES}

Additional rules for detailed answers:
- Give a well-structured answer (use bullet points or numbered lists when helpful)
- Be specific with details, examples, and practical insights
- Answer the most recent thing the other party said or asked
- Start with the key answer, then elaborate with supporting points
- Don't be generic — tailor everything to the specific words and context of the conversation${docNote}`,
  };

  let userMsg;
  if (!transcript || transcript.trim().length === 0) {
    // No transcript yet — give a helpful response instead of confusing the AI
    userMsg = (docs ? `=== REFERENCE DOCUMENTS ===\n${docs}\n\n` : '')
      + 'NOTE: No conversation transcript has been captured yet. The meeting captions may not be enabled or no one has spoken yet.\n\n'
      + 'Please respond with: "Waiting for conversation... Please make sure Closed Captions (CC) are enabled in your meeting. Once someone speaks, press the shortcut again to get a response."';
  } else {
    userMsg = (docs ? `=== REFERENCE DOCUMENTS ===\n${docs}\n\n` : '')
      + `=== LIVE CONVERSATION (read every word carefully) ===\n${transcript}\n\n`
      + 'Focus on the LAST few sentences above. What is the other person asking or talking about? Respond to EXACTLY that — using their exact words and topics.';
  }

  return { systemPrompt: PROMPTS[requestType], userMessage: userMsg };
}

// ── AI Calls ──
async function callAI(provider, system, user, key) {
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `API ${r.status}`); }
    return (await r.json()).content[0].text;
  } else {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.4, max_tokens: 1024 }),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `API ${r.status}`); }
    return (await r.json()).choices[0].message.content;
  }
}

async function streamAIResponse(requestType, tabId) {
  const settings = await getSettings(['aiProvider', 'openaiKey', 'anthropicKey']);
  const documents = (await chrome.storage.local.get(['documents'])).documents;
  const key = settings.aiProvider === 'anthropic' ? settings.anthropicKey : settings.openaiKey;
  if (!key) throw new Error('No API key configured. Set your key in extension settings.');

  const { systemPrompt, userMessage } = buildAIContext(requestType, documents);

  if (settings.aiProvider === 'anthropic' && settings.anthropicKey) await streamSSE('anthropic', systemPrompt, userMessage, settings.anthropicKey, tabId);
  else await streamSSE('openai', systemPrompt, userMessage, settings.openaiKey, tabId);
}

async function streamSSE(provider, system, user, key, tabId) {
  const isAnthropic = provider === 'anthropic';

  const url = isAnthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions';
  const headers = isAnthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` };
  const body = isAnthropic
    ? { model: 'claude-sonnet-4-20250514', max_tokens: 1024, stream: true, system, messages: [{ role: 'user', content: user }] }
    : { model: 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.4, max_tokens: 1024, stream: true };

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `API ${r.status}`); }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const d = t.slice(6);
      if (d === '[DONE]') return;
      try {
        const p = JSON.parse(d);
        const token = isAnthropic
          ? (p.type === 'content_block_delta' ? p.delta?.text : null)
          : p.choices?.[0]?.delta?.content;
        if (token) safeSendTab(tabId, { type: 'streamChunk', token });
      } catch {}
    }
  }
}

// ── Utilities ──
function detectPlatform(url) {
  if (!url) return null;
  if (url.includes('meet.google.com')) return 'meet';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
  if (url.includes('zoom.us')) return 'zoom';
  return null;
}

function safeSendTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}
