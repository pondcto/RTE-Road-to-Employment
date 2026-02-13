// ============================================================
// RTE - File Parser Library
// Extracts text from PDF, DOCX, and DOC files.
// Pure vanilla JS — no external dependencies.
// ============================================================

const FileParser = (() => {
  'use strict';

  // ── Public API ──

  /**
   * Parse a File object and return its text content.
   * Supports: .pdf, .docx, .doc, .txt, .md, .json, .csv, .xml, .html, .log, .js, .py, .ts
   * @param {File} file
   * @returns {Promise<{name: string, content: string, type: string}>}
   */
  async function parseFile(file) {
    const ext = getExtension(file.name);
    const name = file.name;

    let content = '';
    let type = 'text';

    switch (ext) {
      case 'pdf':
        content = await parsePDF(file);
        type = 'pdf';
        break;
      case 'docx':
        content = await parseDOCX(file);
        type = 'docx';
        break;
      case 'doc':
        content = await parseDOC(file);
        type = 'doc';
        break;
      default:
        content = await readAsText(file);
        type = 'text';
        break;
    }

    // Clean up the extracted text
    content = cleanText(content);

    if (!content || content.trim().length === 0) {
      throw new Error(`Could not extract text from "${name}". The file may be empty, encrypted, or in an unsupported format.`);
    }

    return { name, content, type };
  }

  /**
   * Check if a file extension is supported.
   */
  function isSupported(filename) {
    const ext = getExtension(filename);
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  const SUPPORTED_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx',
    'txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'htm',
    'js', 'py', 'ts', 'jsx', 'tsx', 'css', 'yaml', 'yml', 'toml', 'ini', 'cfg',
    'rtf',
  ]);

  // ── Helpers ──

  function getExtension(filename) {
    return (filename || '').split('.').pop().toLowerCase();
  }

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file as text'));
      reader.readAsText(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  // ============================================================
  // PDF Parser
  // Minimal PDF text extractor — handles common unencrypted PDFs.
  // For production use, pdf.js is recommended.
  // ============================================================

  async function parsePDF(file) {
    const buffer = await readAsArrayBuffer(file);
    const bytes = new Uint8Array(buffer);

    // Verify PDF signature
    const header = String.fromCharCode(...bytes.slice(0, 5));
    if (!header.startsWith('%PDF')) {
      throw new Error('Not a valid PDF file');
    }

    const textParts = [];

    // Find and process all stream objects
    const streamPositions = findAllOccurrences(bytes, 'stream');

    for (const pos of streamPositions) {
      try {
        const streamData = extractStream(bytes, pos);
        if (!streamData || streamData.length === 0) continue;

        // Try to decompress (most PDF streams use FlateDecode)
        let decoded;
        try {
          decoded = await inflateData(streamData);
        } catch {
          decoded = streamData; // Already uncompressed or unknown encoding
        }

        // Extract text from the content stream
        const text = extractTextFromStream(decoded);
        if (text && text.trim().length > 0) {
          textParts.push(text);
        }
      } catch {
        // Skip unreadable streams
      }
    }

    if (textParts.length === 0) {
      // Fallback: try to find raw text strings in the PDF
      return extractRawPDFText(bytes);
    }

    return textParts.join('\n');
  }

  function findAllOccurrences(bytes, needle) {
    const positions = [];
    const needleBytes = new TextEncoder().encode(needle);
    const len = needleBytes.length;

    for (let i = 0; i < bytes.length - len; i++) {
      let match = true;
      for (let j = 0; j < len; j++) {
        if (bytes[i + j] !== needleBytes[j]) { match = false; break; }
      }
      if (match) positions.push(i);
    }
    return positions;
  }

  function extractStream(bytes, streamStart) {
    // Find the actual start of stream data (after "stream\r\n" or "stream\n")
    let dataStart = streamStart + 6; // length of "stream"
    if (bytes[dataStart] === 0x0D && bytes[dataStart + 1] === 0x0A) dataStart += 2;
    else if (bytes[dataStart] === 0x0A) dataStart += 1;
    else if (bytes[dataStart] === 0x0D) dataStart += 1;

    // Find "endstream"
    const endNeedle = new TextEncoder().encode('endstream');
    let dataEnd = -1;
    for (let i = dataStart; i < Math.min(bytes.length, dataStart + 1000000); i++) {
      let match = true;
      for (let j = 0; j < endNeedle.length; j++) {
        if (bytes[i + j] !== endNeedle[j]) { match = false; break; }
      }
      if (match) { dataEnd = i; break; }
    }

    if (dataEnd === -1 || dataEnd <= dataStart) return null;

    // Trim trailing whitespace before endstream
    while (dataEnd > dataStart && (bytes[dataEnd - 1] === 0x0A || bytes[dataEnd - 1] === 0x0D)) {
      dataEnd--;
    }

    return bytes.slice(dataStart, dataEnd);
  }

  async function inflateData(data) {
    // Use DecompressionStream API (available in Chrome 80+)
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(data);
    writer.close();

    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  function extractTextFromStream(data) {
    const text = new TextDecoder('latin1').decode(data);
    const parts = [];

    // Extract text from Tj operator: (text) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let m;
    while ((m = tjRegex.exec(text)) !== null) {
      const decoded = decodePDFString(m[1]);
      if (decoded) parts.push(decoded);
    }

    // Extract text from TJ operator: [(text) kern (text) kern ...] TJ
    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/gi;
    while ((m = tjArrayRegex.exec(text)) !== null) {
      const inner = m[1];
      const stringRegex = /\(([^)]*)\)/g;
      let sm;
      const lineParts = [];
      while ((sm = stringRegex.exec(inner)) !== null) {
        const decoded = decodePDFString(sm[1]);
        if (decoded) lineParts.push(decoded);
      }
      if (lineParts.length) parts.push(lineParts.join(''));
    }

    // Extract text from ' and " operators
    const quoteRegex = /\(([^)]*)\)\s*['"]/g;
    while ((m = quoteRegex.exec(text)) !== null) {
      const decoded = decodePDFString(m[1]);
      if (decoded) parts.push(decoded);
    }

    // Detect line breaks (Td, TD, T*, etc.)
    let result = '';
    let lineBuffer = '';

    for (const part of parts) {
      lineBuffer += part;
    }

    // Simple heuristic: split on double spaces or where sentence structure changes
    result = lineBuffer
      .replace(/\s{2,}/g, '\n')
      .replace(/([.!?])\s+([A-Z])/g, '$1\n$2');

    return result;
  }

  function decodePDFString(str) {
    // Handle PDF escape sequences
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\')
      .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  }

  function extractRawPDFText(bytes) {
    // Last resort: extract all printable ASCII text between parentheses
    const text = new TextDecoder('latin1').decode(bytes);
    const parts = [];
    const regex = /\(([^()]{3,500})\)/g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const s = decodePDFString(m[1]);
      // Filter out PDF metadata and binary-looking strings
      if (s && /^[\x20-\x7E\n\r\t]+$/.test(s) && !/^[A-Z][a-z]+[A-Z]/.test(s)) {
        const cleaned = s.trim();
        if (cleaned.length > 2 && !/^[\d.]+$/.test(cleaned)) {
          parts.push(cleaned);
        }
      }
    }
    return parts.join(' ');
  }

  // ============================================================
  // DOCX Parser
  // DOCX = ZIP archive containing XML.
  // Main text is in word/document.xml inside <w:t> elements.
  // ============================================================

  async function parseDOCX(file) {
    const buffer = await readAsArrayBuffer(file);
    const bytes = new Uint8Array(buffer);

    // Verify ZIP signature (PK\x03\x04)
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4B || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new Error('Not a valid DOCX file (not a ZIP archive)');
    }

    // Parse ZIP and find word/document.xml
    const entries = parseZIPEntries(bytes);
    const docEntry = entries.find(e =>
      e.name === 'word/document.xml' || e.name === 'word\\document.xml'
    );

    if (!docEntry) {
      throw new Error('Could not find document content in DOCX file');
    }

    // Extract and decompress the document.xml
    let xmlBytes;
    if (docEntry.compressionMethod === 8) {
      // Deflate compressed
      const compressed = bytes.slice(docEntry.dataOffset, docEntry.dataOffset + docEntry.compressedSize);
      xmlBytes = await inflateRawData(compressed);
    } else if (docEntry.compressionMethod === 0) {
      // Stored (uncompressed)
      xmlBytes = bytes.slice(docEntry.dataOffset, docEntry.dataOffset + docEntry.compressedSize);
    } else {
      throw new Error('Unsupported compression method in DOCX');
    }

    const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
    return extractTextFromDocumentXML(xmlText);
  }

  function parseZIPEntries(bytes) {
    const entries = [];
    let offset = 0;

    while (offset < bytes.length - 4) {
      // Look for local file header signature (PK\x03\x04)
      if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4B) break;
      if (bytes[offset + 2] === 0x03 && bytes[offset + 3] === 0x04) {
        const view = new DataView(bytes.buffer, offset);
        const compressionMethod = view.getUint16(8, true);
        const compressedSize = view.getUint32(18, true);
        const uncompressedSize = view.getUint32(22, true);
        const nameLength = view.getUint16(26, true);
        const extraLength = view.getUint16(28, true);
        const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
        const dataOffset = offset + 30 + nameLength + extraLength;

        entries.push({
          name,
          compressionMethod,
          compressedSize,
          uncompressedSize,
          dataOffset,
        });

        offset = dataOffset + compressedSize;

        // Skip data descriptor if present (bit 3 of general purpose flag)
        const flags = view.getUint16(6, true);
        if (flags & 0x08) {
          // Data descriptor: may have optional signature + CRC + sizes
          if (offset + 4 <= bytes.length &&
              bytes[offset] === 0x50 && bytes[offset + 1] === 0x4B &&
              bytes[offset + 2] === 0x07 && bytes[offset + 3] === 0x08) {
            offset += 16; // signature(4) + crc(4) + compSize(4) + uncompSize(4)
          } else {
            offset += 12; // crc(4) + compSize(4) + uncompSize(4)
          }
        }
      } else {
        break; // Central directory or end-of-archive
      }
    }

    return entries;
  }

  async function inflateRawData(data) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(data);
    writer.close();

    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const chunk of chunks) {
      result.set(chunk, off);
      off += chunk.length;
    }
    return result;
  }

  function extractTextFromDocumentXML(xml) {
    const paragraphs = [];
    let currentParagraph = [];

    // Split by paragraph tags <w:p ...> ... </w:p>
    const pRegex = /<w:p[\s>][^]*?<\/w:p>/g;
    let pm;

    while ((pm = pRegex.exec(xml)) !== null) {
      const pContent = pm[0];

      // Extract all text runs <w:t ...>text</w:t>
      const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
      let tm;
      currentParagraph = [];

      while ((tm = tRegex.exec(pContent)) !== null) {
        const text = decodeXMLEntities(tm[1]);
        if (text) currentParagraph.push(text);
      }

      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(''));
      } else {
        // Empty paragraph = line break
        if (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] !== '') {
          paragraphs.push('');
        }
      }
    }

    // If regex approach didn't find paragraphs, try simpler extraction
    if (paragraphs.length === 0) {
      const simpleRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
      let sm;
      while ((sm = simpleRegex.exec(xml)) !== null) {
        const text = decodeXMLEntities(sm[1]);
        if (text) paragraphs.push(text);
      }
    }

    return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function decodeXMLEntities(text) {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  // ============================================================
  // DOC Parser (Legacy .doc format)
  // Extracts readable text from OLE2 compound binary files.
  // This is a best-effort extraction — complex DOC files may
  // not parse perfectly. DOCX is recommended.
  // ============================================================

  async function parseDOC(file) {
    const buffer = await readAsArrayBuffer(file);
    const bytes = new Uint8Array(buffer);

    // Check for OLE2 signature (D0 CF 11 E0 A1 B1 1A E1)
    const oleSig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    const isOLE2 = oleSig.every((b, i) => bytes[i] === b);

    if (isOLE2) {
      return extractDOCText(bytes);
    }

    // Fallback: try reading as text (some .doc files are actually RTF or plain text)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.startsWith('{\\rtf')) {
      return parseRTF(text);
    }

    // Last resort: extract printable strings
    return extractPrintableStrings(bytes);
  }

  function extractDOCText(bytes) {
    // OLE2 Compound Binary File Format parsing
    const view = new DataView(bytes.buffer);

    try {
      const sectorSize = 1 << view.getUint16(30, true);
      const fatSectors = view.getInt32(44, true);
      const firstDirSector = view.getInt32(48, true);
      const firstMiniFATSector = view.getInt32(60, true);

      // Read the FAT (File Allocation Table)
      const fatEntries = [];
      for (let i = 0; i < 109 && i < fatSectors; i++) {
        const fatSectorNum = view.getInt32(76 + i * 4, true);
        if (fatSectorNum < 0) break;
        const fatOffset = (fatSectorNum + 1) * sectorSize;
        for (let j = 0; j < sectorSize / 4; j++) {
          if (fatOffset + j * 4 + 4 <= bytes.length) {
            fatEntries.push(view.getInt32(fatOffset + j * 4, true));
          }
        }
      }

      // Read directory entries
      const dirEntries = [];
      let dirSector = firstDirSector;
      const maxSectors = 1000;
      let count = 0;

      while (dirSector >= 0 && count < maxSectors) {
        const dirOffset = (dirSector + 1) * sectorSize;
        // Each directory entry is 128 bytes
        for (let i = 0; i < sectorSize / 128; i++) {
          const entryOffset = dirOffset + i * 128;
          if (entryOffset + 128 > bytes.length) break;

          const nameLen = view.getUint16(entryOffset + 64, true);
          if (nameLen === 0) continue;

          // Read name as UTF-16LE
          const nameBytes = bytes.slice(entryOffset, entryOffset + Math.min(nameLen, 64));
          let name = '';
          for (let j = 0; j < nameBytes.length - 1; j += 2) {
            const charCode = nameBytes[j] | (nameBytes[j + 1] << 8);
            if (charCode === 0) break;
            name += String.fromCharCode(charCode);
          }

          const entryType = bytes[entryOffset + 66];
          const startSector = view.getInt32(entryOffset + 116, true);
          const size = view.getUint32(entryOffset + 120, true);

          dirEntries.push({ name, entryType, startSector, size });
        }

        dirSector = (dirSector < fatEntries.length) ? fatEntries[dirSector] : -1;
        count++;
      }

      // Find the WordDocument stream
      const wordDocEntry = dirEntries.find(e =>
        e.name === 'WordDocument' || e.name === '1Table' || e.name === '0Table'
      );

      // Try to read the main document text
      // Word stores text as UTF-16LE in the WordDocument stream
      const wordDoc = dirEntries.find(e => e.name === 'WordDocument');
      if (wordDoc && wordDoc.startSector >= 0) {
        let textData = readStream(bytes, wordDoc.startSector, wordDoc.size, sectorSize, fatEntries);
        if (textData) {
          // The text in a Word document starts after the FIB (File Information Block)
          // Try to extract UTF-16LE text
          const extracted = extractUTF16Text(textData);
          if (extracted.length > 20) return extracted;
        }
      }

      // Fallback: try all streams for readable text
      for (const entry of dirEntries) {
        if (entry.startSector >= 0 && entry.size > 0 && entry.size < 10000000) {
          try {
            const data = readStream(bytes, entry.startSector, entry.size, sectorSize, fatEntries);
            if (data) {
              const text = extractUTF16Text(data);
              if (text.length > 50) return text;
            }
          } catch { /* skip */ }
        }
      }
    } catch {
      // OLE2 parsing failed
    }

    // Final fallback
    return extractPrintableStrings(bytes);
  }

  function readStream(bytes, startSector, size, sectorSize, fatEntries) {
    const data = new Uint8Array(size);
    let sector = startSector;
    let offset = 0;
    let maxIter = 10000;

    while (sector >= 0 && offset < size && maxIter-- > 0) {
      const sectorOffset = (sector + 1) * sectorSize;
      const copyLen = Math.min(sectorSize, size - offset);

      if (sectorOffset + copyLen > bytes.length) break;
      data.set(bytes.slice(sectorOffset, sectorOffset + copyLen), offset);
      offset += copyLen;

      sector = (sector < fatEntries.length) ? fatEntries[sector] : -1;
      if (sector === -2 || sector === -1) break; // End of chain
    }

    return data.slice(0, offset);
  }

  function extractUTF16Text(data) {
    const parts = [];
    let current = '';
    let consecutivePrintable = 0;

    for (let i = 0; i < data.length - 1; i += 2) {
      const charCode = data[i] | (data[i + 1] << 8);

      if ((charCode >= 32 && charCode < 127) || charCode === 10 || charCode === 13 || charCode === 9 ||
          (charCode >= 160 && charCode < 65534)) {
        current += String.fromCharCode(charCode);
        consecutivePrintable++;
      } else {
        if (consecutivePrintable >= 4 && current.trim().length > 2) {
          parts.push(current.trim());
        }
        current = '';
        consecutivePrintable = 0;
      }
    }

    if (consecutivePrintable >= 4 && current.trim().length > 2) {
      parts.push(current.trim());
    }

    return parts.join('\n');
  }

  function extractPrintableStrings(bytes) {
    const parts = [];
    let current = '';

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if ((b >= 32 && b < 127) || b === 10 || b === 13 || b === 9) {
        current += String.fromCharCode(b);
      } else {
        if (current.trim().length > 8) {
          // Filter out binary-looking strings
          const ratio = (current.match(/[a-zA-Z ]/g) || []).length / current.length;
          if (ratio > 0.6) parts.push(current.trim());
        }
        current = '';
      }
    }

    if (current.trim().length > 8) parts.push(current.trim());
    return parts.join('\n');
  }

  function parseRTF(rtfText) {
    // Basic RTF to text conversion
    let text = rtfText;

    // Remove RTF header
    text = text.replace(/^\{\\rtf[^}]*/, '');

    // Handle common RTF commands
    text = text.replace(/\\par\b/g, '\n');
    text = text.replace(/\\tab\b/g, '\t');
    text = text.replace(/\\line\b/g, '\n');
    text = text.replace(/\\\n/g, '\n');

    // Handle Unicode characters
    text = text.replace(/\\u(\d+)[?]/g, (_, code) => String.fromCharCode(parseInt(code)));
    text = text.replace(/\\u(-?\d+)[\\?]/g, (_, code) => {
      const c = parseInt(code);
      return String.fromCharCode(c < 0 ? c + 65536 : c);
    });

    // Remove RTF groups and commands
    text = text.replace(/\{[^{}]*\}/g, ''); // Remove nested groups
    text = text.replace(/\\[a-z]+\d*\s?/gi, ''); // Remove commands
    text = text.replace(/[{}]/g, ''); // Remove remaining braces

    // Handle escaped characters
    text = text.replace(/\\\\/g, '\\');
    text = text.replace(/\\{/g, '{');
    text = text.replace(/\\}/g, '}');

    return text.trim();
  }

  // ── Registry (Export/Import) ──

  /**
   * Export all settings and documents as a JSON registry file.
   * @returns {Promise<string>} JSON string of all data
   */
  async function exportRegistry() {
    const syncData = await new Promise(resolve => chrome.storage.sync.get(null, resolve));
    const localData = await new Promise(resolve => chrome.storage.local.get(null, resolve));

    const registry = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        aiProvider: syncData.aiProvider || localData.aiProvider,
        openaiKey: syncData.openaiKey || localData.openaiKey,
        anthropicKey: syncData.anthropicKey || localData.anthropicKey,
        spellingCorrection: syncData.spellingCorrection ?? localData.spellingCorrection ?? true,
        customShortcuts: syncData.customShortcuts || localData.customShortcuts,
        sentenceCount: syncData.sentenceCount || localData.sentenceCount || 5,
        sourceLang: localData.sourceLang,
        targetLang: localData.targetLang,
      },
      documents: localData.documents || [],
    };

    return JSON.stringify(registry, null, 2);
  }

  /**
   * Import settings and documents from a registry JSON file.
   * @param {string} jsonString
   * @returns {Promise<{settingsCount: number, documentsCount: number}>}
   */
  async function importRegistry(jsonString) {
    const registry = JSON.parse(jsonString);

    if (!registry || !registry.version) {
      throw new Error('Invalid registry file format');
    }

    const settings = registry.settings || {};
    const documents = registry.documents || [];

    // Save to sync storage (persists across reinstalls)
    const syncData = {};
    if (settings.aiProvider) syncData.aiProvider = settings.aiProvider;
    if (settings.openaiKey) syncData.openaiKey = settings.openaiKey;
    if (settings.anthropicKey) syncData.anthropicKey = settings.anthropicKey;
    if (settings.spellingCorrection !== undefined) syncData.spellingCorrection = settings.spellingCorrection;
    if (settings.customShortcuts) syncData.customShortcuts = settings.customShortcuts;
    if (settings.sentenceCount) syncData.sentenceCount = settings.sentenceCount;

    await new Promise(resolve => chrome.storage.sync.set(syncData, resolve));

    // Save to local storage
    const localData = { ...syncData };
    if (settings.sourceLang) localData.sourceLang = settings.sourceLang;
    if (settings.targetLang) localData.targetLang = settings.targetLang;
    if (documents.length > 0) localData.documents = documents;

    await new Promise(resolve => chrome.storage.local.set(localData, resolve));

    return {
      settingsCount: Object.keys(syncData).length,
      documentsCount: documents.length,
    };
  }

  // ── Public Interface ──
  return {
    parseFile,
    isSupported,
    exportRegistry,
    importRegistry,
    SUPPORTED_EXTENSIONS,
  };
})();
