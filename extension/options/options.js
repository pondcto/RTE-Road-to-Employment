// ============================================================
// RTE - Options Page Logic
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // ──────────── Sidebar Navigation ────────────
  const sidebarItems = document.querySelectorAll('.sidebar-item');
  const sections = document.querySelectorAll('.content-section');

  sidebarItems.forEach((item) => {
    item.addEventListener('click', () => {
      const sectionId = item.dataset.section;

      sidebarItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      sections.forEach(s => s.classList.remove('active'));
      document.getElementById('section-' + sectionId).classList.add('active');
    });
  });

  // ──────────── Elements ────────────
  const openaiKeyEl = document.getElementById('openaiKey');
  const anthropicKeyEl = document.getElementById('anthropicKey');
  const toggleOpenaiBtn = document.getElementById('toggleOpenai');
  const toggleAnthropicBtn = document.getElementById('toggleAnthropic');
  const saveApiBtn = document.getElementById('saveApiKeys');
  const spellingEl = document.getElementById('spellingCorrection');
  const uploadAreaEl = document.getElementById('uploadArea');
  const fileInputEl = document.getElementById('fileInput');
  const docNameEl = document.getElementById('docName');
  const docContentEl = document.getElementById('docContent');
  const addManualDocBtn = document.getElementById('addManualDoc');
  const documentListEl = document.getElementById('documentList');
  const clearAllBtn = document.getElementById('clearAllData');
  const toastEl = document.getElementById('toast');
  const toastTextEl = document.getElementById('toastText');

  // ──────────── Toast ────────────
  let toastTimer;
  function showToast(message, isError = false) {
    toastTextEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 3000);
  }

  // ──────────── Load Settings ────────────
  chrome.storage.local.get(
    ['aiProvider', 'openaiKey', 'anthropicKey', 'spellingCorrection', 'documents'],
    (data) => {
      if (data.openaiKey) openaiKeyEl.value = data.openaiKey;
      if (data.anthropicKey) anthropicKeyEl.value = data.anthropicKey;

      if (data.aiProvider) {
        const radio = document.querySelector(`input[name="aiProvider"][value="${data.aiProvider}"]`);
        if (radio) radio.checked = true;
      }

      spellingEl.checked = data.spellingCorrection !== false;

      renderDocuments(data.documents || []);
    }
  );

  // ──────────── Toggle Password Visibility ────────────
  function makeToggle(btn, input) {
    btn.addEventListener('click', () => {
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.textContent = isPassword ? '🔒' : '👁️';
    });
  }
  makeToggle(toggleOpenaiBtn, openaiKeyEl);
  makeToggle(toggleAnthropicBtn, anthropicKeyEl);

  // ──────────── Save API Keys ────────────
  saveApiBtn.addEventListener('click', () => {
    const aiProvider = document.querySelector('input[name="aiProvider"]:checked').value;
    const openaiKey = openaiKeyEl.value.trim();
    const anthropicKey = anthropicKeyEl.value.trim();

    chrome.storage.local.set({ aiProvider, openaiKey, anthropicKey }, () => {
      showToast('API configuration saved successfully!');
    });
  });

  // ──────────── Spelling Correction Toggle ────────────
  spellingEl.addEventListener('change', () => {
    chrome.storage.local.set({ spellingCorrection: spellingEl.checked }, () => {
      showToast(spellingEl.checked ? 'Spelling correction enabled' : 'Spelling correction disabled');
    });
  });

  // ──────────── File Upload ────────────
  uploadAreaEl.addEventListener('click', () => fileInputEl.click());

  uploadAreaEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadAreaEl.classList.add('drag-over');
  });

  uploadAreaEl.addEventListener('dragleave', () => {
    uploadAreaEl.classList.remove('drag-over');
  });

  uploadAreaEl.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadAreaEl.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  fileInputEl.addEventListener('change', () => {
    handleFiles(fileInputEl.files);
    fileInputEl.value = '';
  });

  function handleFiles(files) {
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        addDocument(file.name, e.target.result);
      };
      reader.readAsText(file);
    });
  }

  // ──────────── Manual Document ────────────
  addManualDocBtn.addEventListener('click', () => {
    const name = docNameEl.value.trim();
    const content = docContentEl.value.trim();

    if (!name) {
      showToast('Please enter a document name.', true);
      return;
    }
    if (!content) {
      showToast('Please enter document content.', true);
      return;
    }

    addDocument(name, content);
    docNameEl.value = '';
    docContentEl.value = '';
  });

  // ──────────── Document Storage ────────────
  function addDocument(name, content) {
    chrome.storage.local.get(['documents'], (data) => {
      const documents = data.documents || [];
      documents.push({
        id: Date.now().toString(),
        name,
        content,
        size: content.length,
        addedAt: new Date().toISOString(),
      });
      chrome.storage.local.set({ documents }, () => {
        renderDocuments(documents);
        showToast(`Document "${name}" added.`);
      });
    });
  }

  function removeDocument(id) {
    chrome.storage.local.get(['documents'], (data) => {
      const documents = (data.documents || []).filter(d => d.id !== id);
      chrome.storage.local.set({ documents }, () => {
        renderDocuments(documents);
        showToast('Document removed.');
      });
    });
  }

  function renderDocuments(documents) {
    if (!documents.length) {
      documentListEl.innerHTML = '<p class="empty-state">No documents uploaded yet.</p>';
      return;
    }

    documentListEl.innerHTML = documents
      .map((doc) => {
        const sizeStr = doc.size > 1024
          ? `${(doc.size / 1024).toFixed(1)} KB`
          : `${doc.size} chars`;
        const dateStr = new Date(doc.addedAt).toLocaleDateString();

        return `
          <div class="doc-item" data-id="${doc.id}">
            <div class="doc-info">
              <span class="doc-name">${escapeHtml(doc.name)}</span>
              <span class="doc-meta">${sizeStr} · Added ${dateStr}</span>
            </div>
            <button class="doc-remove" data-id="${doc.id}" title="Remove">✕</button>
          </div>
        `;
      })
      .join('');

    // Attach remove handlers
    documentListEl.querySelectorAll('.doc-remove').forEach((btn) => {
      btn.addEventListener('click', () => removeDocument(btn.dataset.id));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ──────────── Keyboard Shortcut Editor ────────────
  const DEFAULT_SHORTCUTS = {
    'generate-question': 'Ctrl+Shift+Q',
    'generate-simple-answer': 'Ctrl+Shift+A',
    'generate-detailed-answer': 'Ctrl+Shift+E',
    'clear-translate': 'Ctrl+Shift+Z',
  };

  const shortcutInputs = document.querySelectorAll('.shortcut-input');
  const saveShortcutsBtn = document.getElementById('saveShortcuts');
  const resetShortcutsBtn = document.getElementById('resetShortcuts');

  // Load saved shortcuts
  chrome.storage.local.get(['customShortcuts'], (data) => {
    const shortcuts = data.customShortcuts || DEFAULT_SHORTCUTS;
    shortcutInputs.forEach((input) => {
      const cmd = input.dataset.command;
      if (shortcuts[cmd]) {
        input.value = shortcuts[cmd];
      }
    });
  });

  // Shortcut recorder
  shortcutInputs.forEach((input) => {
    input.addEventListener('focus', () => {
      input.classList.add('recording');
      input.value = 'Press keys...';
    });

    input.addEventListener('blur', () => {
      input.classList.remove('recording');
      // Restore previous value if nothing was recorded
      if (input.value === 'Press keys...') {
        chrome.storage.local.get(['customShortcuts'], (data) => {
          const shortcuts = data.customShortcuts || DEFAULT_SHORTCUTS;
          input.value = shortcuts[input.dataset.command] || '';
        });
      }
    });

    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore lone modifier keys
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');

      // Must have at least one modifier
      if (parts.length === 0) {
        input.value = 'Need modifier key';
        setTimeout(() => { input.value = 'Press keys...'; }, 1000);
        return;
      }

      // Get the key name
      let keyName = e.key;
      if (keyName === ' ') keyName = 'Space';
      else if (keyName.length === 1) keyName = keyName.toUpperCase();
      else if (keyName.startsWith('Arrow')) keyName = keyName;
      // Map special keys
      const keyMap = {
        'Escape': 'Esc', 'Backspace': 'Backspace', 'Delete': 'Delete',
        'Enter': 'Enter', 'Tab': 'Tab',
      };
      if (keyMap[keyName]) keyName = keyMap[keyName];

      parts.push(keyName);
      const combo = parts.join('+');

      // Check for duplicates
      let duplicate = false;
      shortcutInputs.forEach((other) => {
        if (other !== input && other.value === combo) {
          duplicate = true;
        }
      });

      if (duplicate) {
        input.value = 'Already in use!';
        setTimeout(() => { input.value = 'Press keys...'; }, 1200);
        return;
      }

      input.value = combo;
      input.classList.remove('recording');
      input.blur();
    });
  });

  const chromeSyncNotice = document.getElementById('chromeSyncNotice');
  const noticeSyncList = document.getElementById('noticeSyncList');
  const openChromeShortcutsBtn = document.getElementById('openChromeShortcuts');

  const COMMAND_LABELS = {
    'generate-question': 'Generate questions',
    'generate-simple-answer': 'Quick answer',
    'generate-detailed-answer': 'Detailed answer',
    'clear-translate': 'Clear Translate',
  };

  // Check if shortcuts differ from defaults and show/hide notice
  function checkAndShowSyncNotice(shortcuts) {
    const hasChanges = Object.keys(DEFAULT_SHORTCUTS).some(
      (key) => shortcuts[key] !== DEFAULT_SHORTCUTS[key]
    );

    if (hasChanges) {
      // Build the shortcut reference list
      noticeSyncList.innerHTML = Object.entries(shortcuts)
        .map(([cmd, combo]) => `
          <div class="notice-shortcut-row">
            <span class="notice-cmd">${COMMAND_LABELS[cmd] || cmd}</span>
            <span class="notice-combo">${combo}</span>
          </div>
        `).join('');
      chromeSyncNotice.style.display = 'flex';
    } else {
      chromeSyncNotice.style.display = 'none';
    }
  }

  // Show notice on load if shortcuts are already customised
  chrome.storage.local.get(['customShortcuts'], (data) => {
    if (data.customShortcuts) {
      checkAndShowSyncNotice(data.customShortcuts);
    }
  });

  // Open Chrome extension shortcuts page
  openChromeShortcutsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Save shortcuts
  saveShortcutsBtn.addEventListener('click', () => {
    const customShortcuts = {};
    let valid = true;
    shortcutInputs.forEach((input) => {
      const val = input.value.trim();
      if (!val || val === 'Press keys...' || val === 'Already in use!' || val === 'Need modifier key') {
        valid = false;
        return;
      }
      customShortcuts[input.dataset.command] = val;
    });

    if (!valid) {
      showToast('Please set all shortcuts before saving.', true);
      return;
    }

    chrome.storage.local.set({ customShortcuts }, () => {
      showToast('Keyboard shortcuts saved!');
      checkAndShowSyncNotice(customShortcuts);
    });
  });

  // Reset shortcuts
  resetShortcutsBtn.addEventListener('click', () => {
    chrome.storage.local.set({ customShortcuts: DEFAULT_SHORTCUTS }, () => {
      shortcutInputs.forEach((input) => {
        input.value = DEFAULT_SHORTCUTS[input.dataset.command] || '';
      });
      chromeSyncNotice.style.display = 'none';
      showToast('Shortcuts reset to defaults.');
    });
  });

  // ──────────── Clear All Data ────────────
  clearAllBtn.addEventListener('click', () => {
    if (!confirm('Are you sure you want to clear all data? This cannot be undone.')) return;

    chrome.storage.local.clear(() => {
      openaiKeyEl.value = '';
      anthropicKeyEl.value = '';
      spellingEl.checked = true;
      renderDocuments([]);
      shortcutInputs.forEach((input) => {
        input.value = DEFAULT_SHORTCUTS[input.dataset.command] || '';
      });
      showToast('All data cleared.');
    });
  });
});
