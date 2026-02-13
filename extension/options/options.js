// ============================================================
// RTE - Options Page Logic
// Settings stored in chrome.storage.sync (persist across reinstall)
// + chrome.storage.local (for documents and runtime data).
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // ──────────── Auth Check ────────────
  chrome.runtime.sendMessage({ type: 'checkAuth' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.authenticated) {
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#94a3b8;font-family:Segoe UI,sans-serif;background:#0a0a14;"><div style="text-align:center;"><h2 style="color:#e2e8f0;margin-bottom:8px;">Locked</h2><p>Please unlock RTE from the popup first.</p></div></div>';
      return;
    }
    initOptions();
  });
});

function initOptions() {
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

      // Refresh sync status when navigating to backup section
      if (sectionId === 'backup') refreshSyncStatus();
    });
  });

  // ──────────── Elements ────────────
  const openaiKeyEl = document.getElementById('openaiKey');
  const anthropicKeyEl = document.getElementById('anthropicKey');
  const toggleOpenaiBtn = document.getElementById('toggleOpenai');
  const toggleAnthropicBtn = document.getElementById('toggleAnthropic');
  const saveApiBtn = document.getElementById('saveApiKeys');
  const spellingEl = document.getElementById('spellingCorrection');
  const sentenceCountEl = document.getElementById('sentenceCount');
  const uploadAreaEl = document.getElementById('uploadArea');
  const fileInputEl = document.getElementById('fileInput');
  const uploadProgressEl = document.getElementById('uploadProgress');
  const progressFillEl = document.getElementById('progressFill');
  const progressTextEl = document.getElementById('progressText');
  const docNameEl = document.getElementById('docName');
  const docContentEl = document.getElementById('docContent');
  const addManualDocBtn = document.getElementById('addManualDoc');
  const documentListEl = document.getElementById('documentList');
  const clearAllBtn = document.getElementById('clearAllData');
  const toastEl = document.getElementById('toast');
  const toastTextEl = document.getElementById('toastText');
  const exportRegistryBtn = document.getElementById('exportRegistry');
  const registryUploadAreaEl = document.getElementById('registryUploadArea');
  const registryFileInputEl = document.getElementById('registryFileInput');

  // ──────────── Toast ────────────
  let toastTimer;
  function showToast(message, isError = false) {
    toastTextEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 3000);
  }

  // ──────────── Load Settings (from sync first, then local) ────────────
  async function loadAllSettings() {
    const settingsKeys = ['aiProvider', 'openaiKey', 'anthropicKey', 'spellingCorrection', 'customShortcuts', 'sentenceCount'];
    const syncData = await new Promise(r => chrome.storage.sync.get(settingsKeys, r));
    const localData = await new Promise(r => chrome.storage.local.get([...settingsKeys, 'documents'], r));

    // Merge: sync overrides local for settings keys
    const data = { ...localData, ...syncData };

    if (data.openaiKey) openaiKeyEl.value = data.openaiKey;
    if (data.anthropicKey) anthropicKeyEl.value = data.anthropicKey;

    if (data.aiProvider) {
      const radio = document.querySelector(`input[name="aiProvider"][value="${data.aiProvider}"]`);
      if (radio) radio.checked = true;
    }

    spellingEl.checked = data.spellingCorrection !== false;

    if (data.sentenceCount !== undefined) {
      sentenceCountEl.value = String(data.sentenceCount);
    }

    renderDocuments(localData.documents || []);
  }

  loadAllSettings();

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

  // ──────────── Save API Keys (to sync + local) ────────────
  saveApiBtn.addEventListener('click', async () => {
    const aiProvider = document.querySelector('input[name="aiProvider"]:checked').value;
    const openaiKey = openaiKeyEl.value.trim();
    const anthropicKey = anthropicKeyEl.value.trim();

    const data = { aiProvider, openaiKey, anthropicKey };

    // Save to both sync and local
    try {
      await new Promise(r => chrome.storage.sync.set(data, r));
    } catch { /* sync not available */ }
    await new Promise(r => chrome.storage.local.set(data, r));

    showToast('API configuration saved and synced!');
  });

  // ──────────── Spelling Correction Toggle ────────────
  spellingEl.addEventListener('change', async () => {
    const val = spellingEl.checked;
    try { await new Promise(r => chrome.storage.sync.set({ spellingCorrection: val }, r)); } catch {}
    await new Promise(r => chrome.storage.local.set({ spellingCorrection: val }, r));
    showToast(val ? 'Spelling correction enabled' : 'Spelling correction disabled');
  });

  // ──────────── Sentence Count ────────────
  sentenceCountEl.addEventListener('change', async () => {
    const raw = sentenceCountEl.value;
    const value = raw === 'all' ? 'all' : parseInt(raw, 10);
    try { await new Promise(r => chrome.storage.sync.set({ sentenceCount: value }, r)); } catch {}
    await new Promise(r => chrome.storage.local.set({ sentenceCount: value }, r));
    showToast('Sentence count updated');
  });

  // ──────────── File Upload (Multi-file with PDF/DOCX support) ────────────
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

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    // Show progress
    uploadProgressEl.style.display = 'block';
    progressFillEl.style.width = '0%';
    progressTextEl.textContent = `Processing 0 of ${files.length} files...`;

    let processed = 0;
    let succeeded = 0;
    const errors = [];

    for (const file of files) {
      try {
        progressTextEl.textContent = `Processing ${processed + 1} of ${files.length}: ${file.name}`;

        // Check if file type is supported
        const ext = file.name.split('.').pop().toLowerCase();
        if (typeof FileParser !== 'undefined' && FileParser.isSupported(file.name)) {
          const result = await FileParser.parseFile(file);
          await addDocument(result.name, result.content, result.type);
          succeeded++;
        } else {
          // Fallback: try reading as text
          const content = await readFileAsText(file);
          if (content && content.trim()) {
            await addDocument(file.name, content, 'text');
            succeeded++;
          } else {
            errors.push(`${file.name}: Unsupported format or empty file`);
          }
        }
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }

      processed++;
      progressFillEl.style.width = ((processed / files.length) * 100) + '%';
    }

    // Hide progress after a brief delay
    setTimeout(() => { uploadProgressEl.style.display = 'none'; }, 1000);

    // Show results
    if (succeeded > 0 && errors.length === 0) {
      showToast(`${succeeded} document${succeeded > 1 ? 's' : ''} uploaded successfully!`);
    } else if (succeeded > 0 && errors.length > 0) {
      showToast(`${succeeded} uploaded, ${errors.length} failed. Check console for details.`, true);
      console.warn('[RTE Upload Errors]', errors);
    } else if (errors.length > 0) {
      showToast(errors[0], true);
    }
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
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

    addDocument(name, content, 'text');
    docNameEl.value = '';
    docContentEl.value = '';
  });

  // ──────────── Document Storage ────────────
  async function addDocument(name, content, type = 'text') {
    return new Promise((resolve) => {
      chrome.storage.local.get(['documents'], (data) => {
        const documents = data.documents || [];
        documents.push({
          id: Date.now().toString() + '_' + Math.random().toString(36).substring(2, 7),
          name,
          content,
          type: type || 'text',
          size: content.length,
          addedAt: new Date().toISOString(),
        });
        chrome.storage.local.set({ documents }, () => {
          renderDocuments(documents);
          // Sync documents to chrome.storage.sync (chunked)
          syncDocumentsToBackground(documents);
          resolve();
        });
      });
    });
  }

  function removeDocument(id) {
    chrome.storage.local.get(['documents'], (data) => {
      const documents = (data.documents || []).filter(d => d.id !== id);
      chrome.storage.local.set({ documents }, () => {
        renderDocuments(documents);
        syncDocumentsToBackground(documents);
        showToast('Document removed.');
      });
    });
  }

  function syncDocumentsToBackground(documents) {
    chrome.runtime.sendMessage({ type: 'syncDocuments', documents }).catch(() => {});
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
        const typeIcon = getTypeIcon(doc.type || doc.name);

        return `
          <div class="doc-item" data-id="${doc.id}">
            <div class="doc-info">
              <span class="doc-name">${typeIcon} ${escapeHtml(doc.name)}</span>
              <span class="doc-meta">${sizeStr} · ${doc.type ? doc.type.toUpperCase() : 'TEXT'} · Added ${dateStr}</span>
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

  function getTypeIcon(typeOrName) {
    const type = typeof typeOrName === 'string' ? typeOrName.toLowerCase() : '';
    if (type === 'pdf' || type.endsWith('.pdf')) return '📕';
    if (type === 'docx' || type === 'doc' || type.endsWith('.docx') || type.endsWith('.doc')) return '📘';
    if (type.endsWith('.json')) return '📋';
    if (type.endsWith('.csv')) return '📊';
    return '📄';
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
    'copy-captions': 'Ctrl+Shift+C',
  };

  const shortcutInputs = document.querySelectorAll('.shortcut-input');
  const saveShortcutsBtn = document.getElementById('saveShortcuts');
  const resetShortcutsBtn = document.getElementById('resetShortcuts');

  // Load saved shortcuts (from sync first, then local)
  async function loadShortcuts() {
    const syncData = await new Promise(r => chrome.storage.sync.get(['customShortcuts'], r));
    const localData = await new Promise(r => chrome.storage.local.get(['customShortcuts'], r));
    const shortcuts = syncData.customShortcuts || localData.customShortcuts || DEFAULT_SHORTCUTS;
    shortcutInputs.forEach((input) => {
      const cmd = input.dataset.command;
      if (shortcuts[cmd]) {
        input.value = shortcuts[cmd];
      }
    });
    return shortcuts;
  }
  loadShortcuts();

  // Shortcut recorder
  shortcutInputs.forEach((input) => {
    input.addEventListener('focus', () => {
      input.classList.add('recording');
      input.value = 'Press keys...';
    });

    input.addEventListener('blur', () => {
      input.classList.remove('recording');
      if (input.value === 'Press keys...') {
        loadShortcuts().then((shortcuts) => {
          input.value = shortcuts[input.dataset.command] || '';
        });
      }
    });

    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');

      if (parts.length === 0) {
        input.value = 'Need modifier key';
        setTimeout(() => { input.value = 'Press keys...'; }, 1000);
        return;
      }

      let keyName = e.key;
      if (keyName === ' ') keyName = 'Space';
      else if (keyName.length === 1) keyName = keyName.toUpperCase();
      else if (keyName.startsWith('Arrow')) keyName = keyName;
      const keyMap = {
        'Escape': 'Esc', 'Backspace': 'Backspace', 'Delete': 'Delete',
        'Enter': 'Enter', 'Tab': 'Tab',
      };
      if (keyMap[keyName]) keyName = keyMap[keyName];

      parts.push(keyName);
      const combo = parts.join('+');

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
    'clear-translate': 'Clear history',
    'copy-captions': 'Copy captions',
  };

  function checkAndShowSyncNotice(shortcuts) {
    const hasChanges = Object.keys(DEFAULT_SHORTCUTS).some(
      (key) => shortcuts[key] !== DEFAULT_SHORTCUTS[key]
    );

    if (hasChanges) {
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
  loadShortcuts().then(checkAndShowSyncNotice);

  openChromeShortcutsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Save shortcuts (to sync + local)
  saveShortcutsBtn.addEventListener('click', async () => {
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

    try { await new Promise(r => chrome.storage.sync.set({ customShortcuts }, r)); } catch {}
    await new Promise(r => chrome.storage.local.set({ customShortcuts }, r));
    showToast('Keyboard shortcuts saved and synced!');
    checkAndShowSyncNotice(customShortcuts);
  });

  // Reset shortcuts
  resetShortcutsBtn.addEventListener('click', async () => {
    try { await new Promise(r => chrome.storage.sync.set({ customShortcuts: DEFAULT_SHORTCUTS }, r)); } catch {}
    await new Promise(r => chrome.storage.local.set({ customShortcuts: DEFAULT_SHORTCUTS }, r));
    shortcutInputs.forEach((input) => {
      input.value = DEFAULT_SHORTCUTS[input.dataset.command] || '';
    });
    chromeSyncNotice.style.display = 'none';
    showToast('Shortcuts reset to defaults.');
  });

  // ──────────── Export Registry ────────────
  exportRegistryBtn.addEventListener('click', async () => {
    try {
      const jsonStr = await FileParser.exportRegistry();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rte-registry-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Registry exported successfully!');
    } catch (err) {
      showToast('Export failed: ' + err.message, true);
    }
  });

  // ──────────── Import Registry ────────────
  registryUploadAreaEl.addEventListener('click', () => registryFileInputEl.click());

  registryUploadAreaEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    registryUploadAreaEl.classList.add('drag-over');
  });

  registryUploadAreaEl.addEventListener('dragleave', () => {
    registryUploadAreaEl.classList.remove('drag-over');
  });

  registryUploadAreaEl.addEventListener('drop', (e) => {
    e.preventDefault();
    registryUploadAreaEl.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleRegistryImport(e.dataTransfer.files[0]);
    }
  });

  registryFileInputEl.addEventListener('change', () => {
    if (registryFileInputEl.files.length > 0) {
      handleRegistryImport(registryFileInputEl.files[0]);
    }
    registryFileInputEl.value = '';
  });

  async function handleRegistryImport(file) {
    if (!file.name.endsWith('.json')) {
      showToast('Please select a .json registry file.', true);
      return;
    }

    try {
      const text = await readFileAsText(file);
      const result = await FileParser.importRegistry(text);
      showToast(`Registry imported: ${result.settingsCount} settings, ${result.documentsCount} documents restored!`);

      // Reload the page to reflect changes
      setTimeout(() => loadAllSettings(), 500);
    } catch (err) {
      showToast('Import failed: ' + err.message, true);
    }
  }

  // ──────────── Sync Status ────────────
  async function refreshSyncStatus() {
    try {
      const syncData = await new Promise(r => chrome.storage.sync.get(null, r));
      const localData = await new Promise(r => chrome.storage.local.get(['documents'], r));

      document.getElementById('syncApiKeys').textContent =
        (syncData.openaiKey || syncData.anthropicKey) ? '✓ Synced' : '✗ Not set';
      document.getElementById('syncApiKeys').className =
        'sync-value ' + ((syncData.openaiKey || syncData.anthropicKey) ? 'sync-ok' : 'sync-warn');

      document.getElementById('syncProvider').textContent =
        syncData.aiProvider ? `✓ ${syncData.aiProvider}` : '✗ Not set';
      document.getElementById('syncProvider').className =
        'sync-value ' + (syncData.aiProvider ? 'sync-ok' : 'sync-warn');

      const docCount = (localData.documents || []).length;
      const hasSyncDocs = syncData._doc_meta && syncData._doc_meta.chunkCount > 0;
      document.getElementById('syncDocuments').textContent =
        `${docCount} local` + (hasSyncDocs ? ' · Synced' : ' · Not synced');
      document.getElementById('syncDocuments').className =
        'sync-value ' + (hasSyncDocs ? 'sync-ok' : 'sync-warn');

      document.getElementById('syncShortcuts').textContent =
        syncData.customShortcuts ? '✓ Synced' : 'Default';
      document.getElementById('syncShortcuts').className =
        'sync-value ' + (syncData.customShortcuts ? 'sync-ok' : 'sync-neutral');
    } catch {
      document.getElementById('syncApiKeys').textContent = 'Error checking sync';
    }
  }

  // ──────────── Clear All Data ────────────
  clearAllBtn.addEventListener('click', () => {
    if (!confirm('Are you sure you want to clear all local data? Synced settings (API keys, shortcuts) will be preserved in Chrome sync.')) return;

    chrome.storage.local.clear(() => {
      openaiKeyEl.value = '';
      anthropicKeyEl.value = '';
      spellingEl.checked = true;
      sentenceCountEl.value = '5';
      renderDocuments([]);
      shortcutInputs.forEach((input) => {
        input.value = DEFAULT_SHORTCUTS[input.dataset.command] || '';
      });
      showToast('Local data cleared. Synced settings preserved.');
    });
  });
}
