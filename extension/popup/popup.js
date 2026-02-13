// ============================================================
// RTE - Popup Logic (with MsgCopyer Integration)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const sourceLangEl = document.getElementById('sourceLang');
  const targetLangEl = document.getElementById('targetLang');
  const activateBtn = document.getElementById('activateBtn');
  const btnIcon = document.getElementById('btnIcon');
  const btnText = document.getElementById('btnText');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const infoSection = document.getElementById('infoSection');
  const infoPlatform = document.getElementById('infoPlatform');
  const infoLines = document.getElementById('infoLines');
  const settingsLink = document.getElementById('settingsLink');
  const popupSentenceCount = document.getElementById('popupSentenceCount');

  let isActive = false;

  // ──────────── Load State ────────────
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError || !response) return;

      isActive = response.active;
      updateUI(response);
    });
  }

  function updateUI(status) {
    if (status.active) {
      activateBtn.classList.add('active');
      btnIcon.textContent = '■';
      btnText.textContent = 'Deactivate';
      statusDot.classList.add('active');
      statusText.textContent = 'Active — Capturing transcripts';
      infoSection.style.display = 'block';

      const platformNames = { meet: 'Google Meet', teams: 'Microsoft Teams', zoom: 'Zoom' };
      infoPlatform.textContent = platformNames[status.platform] || 'Waiting for meeting...';
      infoLines.textContent = status.transcriptCount || '0';
    } else {
      activateBtn.classList.remove('active');
      btnIcon.textContent = '▶';
      btnText.textContent = 'Activate';
      statusDot.classList.remove('active');
      statusText.textContent = 'Inactive';
      infoSection.style.display = 'none';
    }
  }

  // ──────────── Load Saved Languages ────────────
  chrome.storage.local.get(['sourceLang', 'targetLang'], (data) => {
    if (data.sourceLang) sourceLangEl.value = data.sourceLang;
    if (data.targetLang) targetLangEl.value = data.targetLang;
  });

  // ──────────── Load Sentence Count (from sync first) ────────────
  chrome.storage.sync.get({ sentenceCount: 5 }, (syncData) => {
    if (chrome.runtime.lastError) {
      chrome.storage.local.get({ sentenceCount: 5 }, (localData) => {
        popupSentenceCount.value = String(localData.sentenceCount);
      });
    } else {
      popupSentenceCount.value = String(syncData.sentenceCount);
    }
  });

  // ──────────── Save Sentence Count ────────────
  popupSentenceCount.addEventListener('change', () => {
    const raw = popupSentenceCount.value;
    const value = raw === 'all' ? 'all' : parseInt(raw, 10);

    // Save to both sync (persist) and local
    chrome.storage.sync.set({ sentenceCount: value }, () => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.set({ sentenceCount: value });
      }
    });
    chrome.storage.local.set({ sentenceCount: value });
  });

  // ──────────── Save Languages on Change ────────────
  sourceLangEl.addEventListener('change', () => {
    chrome.storage.local.set({ sourceLang: sourceLangEl.value });
  });

  targetLangEl.addEventListener('change', () => {
    chrome.storage.local.set({ targetLang: targetLangEl.value });
  });

  // ──────────── Activate / Deactivate ────────────
  activateBtn.addEventListener('click', () => {
    if (!isActive) {
      chrome.runtime.sendMessage({
        type: 'activate',
        sourceLang: sourceLangEl.value,
        targetLang: targetLangEl.value,
      }, (response) => {
        if (response?.ok) {
          isActive = true;
          refreshStatus();
        } else {
          alert('Failed to activate: ' + (response?.error || 'Unknown error'));
        }
      });
    } else {
      chrome.runtime.sendMessage({ type: 'deactivate' }, (response) => {
        if (response?.ok) {
          isActive = false;
          refreshStatus();
        }
      });
    }
  });

  // ──────────── Settings Link ────────────
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // ──────────── Load Custom Shortcuts into Popup ────────────
  const shortcutLabels = {
    'generate-question': 'Generate questions',
    'generate-simple-answer': 'Quick answer',
    'generate-detailed-answer': 'Detailed answer',
    'clear-translate': 'Clear history',
    'copy-captions': 'Copy captions',
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function loadPopupShortcuts() {
    const syncData = await new Promise(r => chrome.storage.sync.get(['customShortcuts'], r));
    const localData = await new Promise(r => chrome.storage.local.get(['customShortcuts'], r));
    const shortcuts = syncData.customShortcuts || localData.customShortcuts;
    if (!shortcuts) return; // keep defaults shown in HTML

    const container = document.getElementById('popupShortcutList');
    if (!container) return;

    container.innerHTML = Object.entries(shortcuts)
      .map(([cmd, combo]) => `
        <div class="shortcut-row${cmd === 'copy-captions' ? ' shortcut-row-highlight' : ''}">
          <kbd>${escapeHtml(combo)}</kbd>
          <span>${escapeHtml(shortcutLabels[cmd] || cmd)}</span>
        </div>
      `).join('');
  }

  loadPopupShortcuts();

  // ──────────── Auto-refresh ────────────
  refreshStatus();
  setInterval(refreshStatus, 3000);
});
