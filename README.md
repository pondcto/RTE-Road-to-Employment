# RTE - Real-Time Translation & Call Support

A Chrome extension that integrates with **Google Meet**, **Microsoft Teams**, and **Google Translate** to provide real-time call transcript translation and AI-powered call support.

---

## Features

### 1. Real-Time Transcript Translation
- Select input and output languages in the extension popup
- Click **Activate** to open Google Translate with your chosen language pair
- Join a Google Meet or Microsoft Teams call with captions enabled
- All call transcripts are captured and sent to Google Translate in real time
- AI-powered spelling correction ensures accurate transcript text (using OpenAI or Anthropic)

### 2. AI Call Support
- Upload support documents (text files, notes, reference material) via the Settings page
- During a call, press keyboard shortcuts to get AI-generated assistance:

| Shortcut | Function |
|---|---|
| `Ctrl + Shift + Q` | Generate relevant questions to ask the other party |
| `Ctrl + Shift + A` | Generate a concise, natural answer to the other party's question |
| `Ctrl + Shift + E` | Generate a detailed, professional response with expertise |

### 3. Configuration
- Choose between **OpenAI** (GPT-4o) or **Anthropic** (Claude) as your AI provider
- Toggle spelling correction on/off
- Upload and manage support documents
- All settings accessible from the extension's Settings page

---

## Installation

### Load as Unpacked Extension (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension` folder from this project
5. The RTE extension will appear in your toolbar

### Generate Icons (Optional)

1. Open `extension/icons/generate-icons.html` in your browser
2. Right-click each canvas icon and **Save Image As**:
   - Save the 16×16 as `icon16.png`
   - Save the 48×48 as `icon48.png`  
   - Save the 128×128 as `icon128.png`
3. Save them to the `extension/icons/` folder
4. Uncomment the icon references in `manifest.json` if you'd like custom icons

---

## Setup

### 1. Configure API Keys
1. Click the RTE extension icon → **Settings** (or right-click → Options)
2. Select your preferred AI provider (OpenAI or Anthropic)
3. Enter your API key
4. Click **Save API Configuration**

### 2. Upload Support Documents
1. Go to Settings → **Documents** tab
2. Drag & drop text files or paste content manually
3. These documents provide context for AI-generated responses during calls

### 3. Usage
1. Click the RTE extension icon
2. Select the **Source Language** (the language spoken in the meeting)
3. Select the **Target Language** (the language you want translations in)
4. Click **Activate** — a Google Translate tab opens automatically
5. Join your Google Meet or Microsoft Teams call
6. **Enable captions/subtitles** in the meeting (important!)
7. Transcripts will stream into Google Translate in real time

---

## How It Works

```
Google Meet / Teams ──► Content Script captures captions
                              │
                              ▼
                    Background Service Worker
                       │              │
                       ▼              ▼
               AI Spelling      Keyboard Shortcuts
               Correction       trigger AI responses
                       │              │
                       ▼              ▼
              Google Translate   Overlay Panel
              (via bridge)      on meeting page
```

### Architecture
- **Manifest V3** Chrome extension
- **Content Scripts**: Capture transcripts from Google Meet and Teams, bridge text to Google Translate, render AI response overlays
- **Background Service Worker**: Manages state, routes messages, calls AI APIs
- **Popup**: Quick controls for language selection and activation
- **Options Page**: Full settings UI for API keys, documents, and preferences

---

## Important Notes

- **Captions must be enabled** in Google Meet or Teams for transcript capture to work
- Google Meet and Teams may change their DOM structure over time — caption selectors may need updating
- API keys are stored locally in Chrome storage and never transmitted anywhere except to the respective AI provider
- Google Translate has a ~5000 character input limit — the extension keeps a rolling window of the most recent transcript

---

## Project Structure

```
extension/
├── manifest.json              # Extension manifest (MV3)
├── background/
│   └── service-worker.js      # Background logic, AI calls, state
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.css              # Popup styles
│   └── popup.js               # Popup logic
├── options/
│   ├── options.html           # Settings page
│   ├── options.css            # Settings styles
│   └── options.js             # Settings logic
├── content/
│   ├── meet-transcript.js     # Google Meet caption capture
│   ├── teams-transcript.js    # Microsoft Teams caption capture
│   ├── translate-bridge.js    # Google Translate text injection
│   └── overlay.js             # AI response overlay panel
├── styles/
│   └── overlay.css            # Overlay panel styles
└── icons/
    └── generate-icons.html    # Icon generator utility
```

---

## License

MIT
