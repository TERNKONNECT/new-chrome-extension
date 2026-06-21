# TernKonnect AI Assistant — Chrome Extension

A voice-controlled browser assistant for blind users, powered by Google Gemini Live AI.  
The user speaks, Gemini understands, and the extension takes action — navigate, read, fill forms, click buttons, and more.

---

## Setup (2 steps)

### Step 1 — Load the Extension in Chrome
1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `new-chrome-extension/` folder
5. When prompted, allow **Microphone** access

### Step 2 — Link with the Platform
- The extension automatically starts in a 3-session **Trial Mode** (5 minutes per session).
- To unlock unlimited usage, generate an **Integration Code** on the platform dashboard under the **Tools** tab.
- Click the settings icon (⚙) in the extension popup (or the login button on trial expiry) and enter your sign-up email and integration code.

---

## How it Works

| What you say | What happens |
|---|---|
| "Go to Coursera" | Opens coursera.com immediately |
| "Sign me in" | Finds the login form, asks for email, then password, then submits |
| "Read this page" | Reads the main content aloud |
| "What's on this page?" | Describes the page title and headings |
| "Scroll down" | Scrolls the page down |
| "Click the Sign Up button" | Clicks the button with that text |
| "Go back" | Goes to the previous page |
| "Open YouTube in a new tab" | Opens youtube.com in a new tab |

---

## Architecture

```
Microphone
    │  (16kHz PCM audio)
    ▼
offscreen.js  ──── WebSocket ────▶  Gemini Live API
    │                                     │
    │          ◀── Audio response ────────┘
    │          ◀── Tool calls ────────────┘
    │
    ▼
background.js  (executes browser actions)
    │
    ├── chrome.tabs.update()        → navigate
    ├── chrome.scripting.executeScript() → click / fill / read / scroll
    └── chrome.tabs.goBack/Forward()    → history
```

- **offscreen.js** — Hidden page that owns the mic + Gemini WebSocket + audio playback
- **background.js** — Service worker that executes all browser control actions
- **popup.html** — Status indicator (shows connection state)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| No welcome message | Check that your API key is correct in `config.js` |
| "Microphone access denied" | Go to `chrome://settings/content/microphone` and allow for extensions |
| Extension won't load | Make sure all 4 icon PNG files are in the `icons/` folder |
| Gemini doesn't respond | Check the Chrome DevTools console on the background service worker |
| Commands not working on a page | Some pages (chrome://, PDFs) cannot be scripted — this is a browser limitation |

To open DevTools for the background worker:  
`chrome://extensions/` → Find TernKonnect → Click **"service worker"** link

---

## Privacy

- Audio is sent directly to Google Gemini via an encrypted WebSocket
- No audio is stored by this extension
- Passwords spoken by the user are sent to Gemini only for form-filling and are not logged locally
