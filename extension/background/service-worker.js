// ============================================================
// RTE - Background Service Worker (Optimized)
// State persistence, AI calls, message routing, tab management.
// MV3 service workers are ephemeral — state is persisted to
// chrome.storage.session with keep-alive alarm.
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
  pendingText: '',
  spellingCorrection: true,
};

let stateLoaded = false;
let debounceTimer = null;
let lastCommandTime = 0;
let lastCommandName = '';
let lastTranslateSpeaker = '';
let hasFlushedToTranslate = false;

const DEBOUNCE_MS = 1500;
const COMMAND_DEBOUNCE_MS = 500;
const KEEP_ALIVE_ALARM = 'rte-keep-alive';
const KEEP_ALIVE_MIN = 0.4;

const DEFAULT_SHORTCUTS = {
  'generate-question': 'Ctrl+Shift+Q',
  'generate-simple-answer': 'Ctrl+Shift+A',
  'generate-detailed-answer': 'Ctrl+Shift+E',
  'clear-translate': 'Ctrl+Shift+Z',
};

const PERSIST_KEYS = ['active', 'sourceLang', 'targetLang', 'translateTabId', 'meetingTabId', 'platform', 'spellingCorrection'];

// ── Storage helpers ──
async function storageSet(data) {
  try { await chrome.storage.session.set(data); } catch { await chrome.storage.local.set(data); }
}
async function storageGet(keys) {
  try { return await chrome.storage.session.get(keys); } catch { return await chrome.storage.local.get(keys); }
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
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ aiProvider: 'openai', openaiKey: '', anthropicKey: '', spellingCorrection: true, documents: [] });
});
chrome.runtime.onStartup.addListener(() => loadState());

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
    case 'transcript': handleTranscript(msg, sender); respond({ ok: true }); break;
    case 'translateReady': respond({ ok: true }); break;
    case 'customCommand': handleCustomCommand(msg.command, sender); respond({ ok: true }); break;
    default: respond({ error: 'Unknown message type' });
  }
}

// ── Commands ──
async function handleCustomCommand(cmd, sender) { await dispatchCommand(cmd, sender?.tab?.id); }

async function dispatchCommand(cmd, senderTabId) {
  const now = Date.now();
  if (cmd === lastCommandName && (now - lastCommandTime) < COMMAND_DEBOUNCE_MS) return;
  lastCommandName = cmd; lastCommandTime = now;

  if (cmd === 'clear-translate') { await clearGoogleTranslate(); return; }

  const tab = state.meetingTabId || senderTabId;
  if (!state.active || !tab) return;

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
  const { customShortcuts } = await chrome.storage.local.get(['customShortcuts']);
  if (customShortcuts && Object.keys(DEFAULT_SHORTCUTS).some(k => customShortcuts[k] !== DEFAULT_SHORTCUTS[k])) return;
  await dispatchCommand(cmd, null);
});

// ── Clear Google Translate ──
async function clearGoogleTranslate() {
  state.pendingText = '';
  clearTimeout(debounceTimer);
  const tabId = state.translateTabId;
  if (!tabId) return;

  try { await chrome.tabs.get(tabId); } catch { state.translateTabId = null; saveState(); return; }

  try { await chrome.tabs.sendMessage(tabId, { type: 'clearTranslation' }); return; } catch {}

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

// ── Tab lifecycle ──
chrome.tabs.onRemoved.addListener((id) => {
  if (id === state.translateTabId) { state.translateTabId = null; saveState(); }
  if (id === state.meetingTabId) { state.meetingTabId = null; state.platform = null; saveState(); }
});

// ── Activate / Deactivate ──
async function handleActivate({ sourceLang, targetLang }) {
  state.sourceLang = sourceLang; state.targetLang = targetLang;
  state.fullTranscript = []; state.pendingText = '';
  lastTranslateSpeaker = ''; hasFlushedToTranslate = false;

  const s = await chrome.storage.local.get(['spellingCorrection']);
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
  state.active = false; state.platform = null; state.meetingTabId = null;
  state.fullTranscript = []; state.pendingText = '';
  lastTranslateSpeaker = ''; hasFlushedToTranslate = false;
  if (state.translateTabId) { try { await chrome.tabs.remove(state.translateTabId); } catch {} state.translateTabId = null; }
  await saveState(); stopKeepAlive();
  return { ok: true };
}

// ── Transcript Handling ──
function handleTranscript(msg, sender) {
  if (!state.active) return;
  if (sender.tab) { state.meetingTabId = sender.tab.id; state.platform = msg.platform || detectPlatform(sender.tab.url); }

  const speaker = msg.speaker || 'Unknown';
  const text = msg.text || '';
  const isNew = msg.isNewTurn !== false;
  const speakerChanged = speaker !== lastTranslateSpeaker;

  // Store transcript
  const last = state.fullTranscript[state.fullTranscript.length - 1];
  if (isNew || speakerChanged || !last || last.speaker !== speaker) {
    state.fullTranscript.push({ speaker, text, timestamp: Date.now() });
  } else {
    last.text += ' ' + text;
  }

  // Build pending text for translate
  if (isNew || speakerChanged) {
    const line = `${speaker}: ${text}`;
    if (state.pendingText) state.pendingText += '\n\n' + line;
    else if (hasFlushedToTranslate) state.pendingText = '\n\n' + line;
    else state.pendingText = line;
    lastTranslateSpeaker = speaker;
  } else {
    state.pendingText += ' ' + text;
  }

  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushToTranslate, DEBOUNCE_MS);
  if (state.fullTranscript.length % 10 === 0) saveState();
}

async function flushToTranslate() {
  if (!state.translateTabId || !state.pendingText) return;
  let text = state.pendingText;
  state.pendingText = '';
  hasFlushedToTranslate = true;

  if (state.spellingCorrection) {
    try { text = await correctSpelling(text); } catch {}
  }

  safeSendTab(state.translateTabId, { type: 'updateTranslation', text });
}

// ── Spelling Correction ──
async function correctSpelling(text) {
  if (!text || text.trim().length < 8) return text;

  const { aiProvider, openaiKey, anthropicKey } = await chrome.storage.local.get(['aiProvider', 'openaiKey', 'anthropicKey']);

  const prompt = 'Fix spelling/grammar in the transcript below. Output ONLY the corrected text, nothing else. Keep the same format. If already correct, return unchanged. NEVER add explanations or commentary.';

  let result;
  if (aiProvider === 'anthropic' && anthropicKey) result = await callAI('anthropic', prompt, text, anthropicKey);
  else if (openaiKey) result = await callAI('openai', prompt, text, openaiKey);
  else return text;

  if (!result) return text;

  // Reject conversational AI responses
  const bad = ['i notice', "i'm ready", 'please provide', 'here is', 'here are', 'i can help', "i'd be happy", 'let me', 'it appears', 'to help you', "you've provided"];
  const lower = result.toLowerCase();
  if (bad.some(p => lower.includes(p)) || result.length > text.length * 2) return text;

  return result;
}

// ── AI: Build Prompt Context ──
function buildAIContext(requestType, documents) {
  const docs = (documents || []).map((d, i) => `[Doc ${i + 1}: ${d.name}]\n${d.content}`).join('\n\n');

  // Use last 8 entries for richer context
  const transcript = state.fullTranscript.slice(-8).map(e => `${e.speaker}: ${e.text}`).join('\n');

  const docNote = docs
    ? '\n\nREFERENCE DOCUMENTS are provided. Use them as ~30% of your knowledge — blend relevant facts naturally. Do NOT quote them directly.'
    : '';

  const PROMPTS = {
    'question': `You are helping someone in a live meeting. Based on the conversation, suggest 2-3 smart follow-up questions they could ask right now.

Rules:
- Questions must relate directly to what was just discussed
- Make them sound natural, like a colleague would ask
- Show you've been paying attention to specifics mentioned
- Vary between clarifying questions and deeper exploration${docNote}`,

    'simple-answer': `You are helping someone respond in a live meeting. Read the conversation and determine what the other person wants — it could be a question, a request ("tell me about..."), or just an expectation for your input.

Rules:
- Give a direct, concise answer (2-4 sentences)
- Sound natural — like a confident professional speaking in conversation
- Answer the most recent thing the other party is waiting to hear
- Be specific, not vague. Use concrete details
- Start with the answer immediately — no preamble
- If they asked about your experience/skills, respond in first person ("I have...", "I've worked on...")
- Match the tone of the conversation (casual or formal)${docNote}`,

    'detailed-answer': `You are a subject-matter expert helping someone respond in a live meeting. Read the conversation and determine what the other person wants — it could be a question, a request, or an implied need for your detailed input.

Rules:
- Give a thorough, well-structured answer (use bullet points or numbered lists for clarity)
- Sound like a senior professional with deep expertise
- Be specific with details, numbers, examples, and practical insights
- Answer the most recent thing the other party is waiting to hear
- Start with the key answer, then elaborate
- If they asked about experience/skills, use first person and give specifics
- Don't be generic — tailor everything to what was actually discussed${docNote}`,
  };

  const userMsg = (docs ? `=== REFERENCE DOCUMENTS ===\n${docs}\n\n` : '')
    + `=== LIVE CONVERSATION ===\n${transcript}\n\n`
    + 'What does the other person want to hear right now? Respond accordingly.';

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
  const { aiProvider, openaiKey, anthropicKey, documents } = await chrome.storage.local.get(['aiProvider', 'openaiKey', 'anthropicKey', 'documents']);
  const key = aiProvider === 'anthropic' ? anthropicKey : openaiKey;
  if (!key) throw new Error('No API key configured. Set your key in extension settings.');

  const { systemPrompt, userMessage } = buildAIContext(requestType, documents);

  if (aiProvider === 'anthropic' && anthropicKey) await streamSSE('anthropic', systemPrompt, userMessage, anthropicKey, tabId);
  else await streamSSE('openai', systemPrompt, userMessage, openaiKey, tabId);
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
  return null;
}

function safeSendTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}
