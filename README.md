# 🎙️ TernKonnect Chrome Extension

> Voice-controlled AI browser assistant for blind and visually impaired users.  
> Powered by Google Gemini Live — gives full hands-free control over web browsing, LMS platforms, and online learning.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Supported Platforms](#supported-platforms)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Extension Components](#extension-components)
- [Tool Capabilities](#tool-capabilities)
- [LMS Platform Adapters](#lms-platform-adapters)
- [Audio Pipeline](#audio-pipeline)
- [Wake Word System](#wake-word-system)
- [Authentication & Account Linking](#authentication--account-linking)
- [Session Management](#session-management)
- [Popup UI](#popup-ui)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

The **TernKonnect Chrome Extension** is a Manifest V3 Chrome extension that turns any web browser into a voice-controlled interface for blind and visually impaired users. The user speaks natural language commands, and the AI assistant:

- **Navigates** websites, clicks buttons, fills forms, and scrolls pages
- **Reads** page content aloud using natural speech
- **Interacts** with LMS platforms (Coursera, Udemy, edX, Moodle, Canvas, etc.)
- **Controls** video players — play, pause, seek, speed, transcripts
- **Assists** with quizzes — reads questions, selects answers, manages timers
- **Sees** pages via screenshots when DOM-based tools fail
- **Dismisses** overlays, cookie banners, and modals automatically

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     Chrome Extension                          │
│                                                               │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────────┐ │
│  │ popup.js │    │ background.js│    │   offscreen.js      │ │
│  │ popup.html│   │ (Service     │    │   (Hidden page)     │ │
│  │          │    │  Worker)     │    │                     │ │
│  │ Status   │    │              │    │ • Mic capture       │ │
│  │ display  │───▶│ • Tool exec  │◀──▶│ • Audio playback    │ │
│  │ Settings │    │ • Tab control│    │ • Wake word detect  │ │
│  │          │    │ • Auth flow  │    │ • WebSocket client  │ │
│  └──────────┘    │ • Page       │    │ • Gemini relay      │ │
│                  │   analysis   │    │                     │ │
│                  └──────────────┘    └─────────┬───────────┘ │
│                                                │             │
│  ┌──────────────────────┐  ┌──────────────┐    │             │
│  │ adapters/            │  │ page-scripts/│    │             │
│  │  coursera.js         │  │  outline.js  │    │             │
│  │  udemy.js            │  │  quiz.js     │    │             │
│  │  linkedin.js         │  │  video.js    │    │             │
│  │  generic.js          │  │  transcript. │    │             │
│  └──────────────────────┘  │  pageContext │    │             │
│                            └──────────────┘    │             │
└────────────────────────────────────────────────┼─────────────┘
                                                 │
                         WebSocket               │
                    ┌────────────────────────────▶│
                    │                             ▼
        ┌───────────────────────────┐    ┌───────────────┐
        │ Digital Accessibility     │    │ Platform      │
        │ Intelligence (Python)    │    │ Backend       │
        │                          │    │ (Node.js)     │
        │ • Auth verification      │    │               │
        │ • Gemini Live relay      │    │ • User mgmt   │
        │ • System prompt + tools  │    │ • Sessions    │
        │ • Usage tracking         │    │ • Billing     │
        └───────────────────────────┘   └───────────────┘
```

---

## Key Features

| Feature | Description |
|---|---|
| **Natural Voice Commands** | Speak freely — the AI understands context, intent, and multi-step instructions |
| **Wake Word Activation** | Say **"Hey TernKonnect"** to start — no Gemini session runs (and no cost accrues) until you summon it |
| **Auto-Sleep** | After 90 seconds of silence, the session closes automatically to preserve capped minutes |
| **LMS Expertise** | Deep understanding of Coursera, Udemy, edX, Moodle, Canvas, LinkedIn Learning patterns |
| **Quiz Assistance** | Reads questions and options, tracks selections, announces timer, confirms before submit |
| **Video Control** | Play/pause/seek/speed, plus full transcript extraction and narration |
| **Screenshot Vision** | Takes screenshots and sends them to Gemini for visual analysis when DOM tools fail |
| **Page Orientation** | After every navigation, announces where you are, what's on the page, and what you can do |
| **Smart Context Injection** | Auto-detects LMS page type (login, dashboard, search, quiz, lesson) and feeds structured context to the AI |
| **Audio Feedback Tones** | Distinct synthesized tones for wake-up, tool success, tool failure — learn them by ear |
| **Subscription-Aware** | Starter (3 free sessions), Pro, and Enterprise tiers with appropriate limits |
| **Shadow DOM Piercing** | Clicks and form fills work inside Web Components and shadow roots |

---

## Supported Platforms

### LMS Platforms (with dedicated adapters)
- **Coursera** — course outlines, video transcripts, quiz interaction
- **Udemy** — video control, course navigation
- **edX / Moodle / Canvas** — generic LMS adapter auto-detects page types
- **Khan Academy / Blackboard / LinkedIn Learning** — supported via generic adapter

### Social Platforms
- **LinkedIn** — feed reading, post drafting, profile viewing

### General Web
- Works on any website — full DOM interaction, navigation, form filling, page reading

---

## Project Structure

```
new-chrome-extension/
├── manifest.json              # Chrome Manifest V3 configuration
├── package.json               # Node.js test dependencies
│
├── background.js              # Service Worker — tool execution, tab control, auth
├── offscreen.html             # Hidden document for mic capture + audio playback
├── offscreen.js               # WebSocket client, Gemini relay, wake word, audio pipeline
├── config.js                  # Auth config loader from chrome.storage
├── audio-processor.js         # AudioWorklet — PCM16 chunk processing
│
├── popup.html                 # Extension popup — status display, settings panel
├── popup.js                   # Popup logic — status polling, credential management
├── setup.html                 # Full-page mic permission request
├── setup.js                   # Mic permission grant flow
│
├── adapters/                  # Platform-specific DOM selectors and page type detection
│   ├── index.js               # Adapter router — URL → platform → selectors
│   ├── coursera.js            # Coursera-specific selectors
│   ├── udemy.js               # Udemy-specific selectors
│   ├── linkedin.js            # LinkedIn-specific selectors
│   └── generic.js             # Generic LMS/website fallback
│
├── page-scripts/              # Content scripts injected into tabs for DOM operations
│   ├── pageContext.js         # Page type analysis (login, dashboard, quiz, etc.)
│   ├── outline.js             # Course outline/syllabus extraction
│   ├── quiz.js                # Quiz question, option, timer extraction
│   ├── video.js               # HTML5 video player control
│   └── transcript.js          # Video transcript/caption extraction
│
├── icons/                     # Extension icons (16, 32, 48, 128px)
├── generate_icons.html        # Icon generation utility
│
└── tests/                     # Unit tests
    └── *.test.js
```

---

## Prerequisites

- **Google Chrome** (version 116+ recommended for Manifest V3 support)
- **A running Platform backend** at `http://localhost:9001` — for account linking and session tokens
- **A running Intelligence backend** at `http://localhost:8000` — for the Gemini Live voice session
- **A TernConnect account** with a valid email and integration code

---

## Installation

### Loading as an Unpacked Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `new-chrome-extension/` directory
5. The extension icon appears in your toolbar

### First-Time Setup

1. **Click the extension icon** — the popup opens
2. **Microphone setup** — the extension automatically opens `setup.html` if mic permission hasn't been granted
3. **Link your account** — click ⚙ Settings, enter your Email and Integration Code, then click Save
4. **Say "Hey TernKonnect"** — the wake word activates the voice assistant

---

## Configuration

### Account Linking

The extension requires an email + integration code from the Platform backend. These are stored in `chrome.storage.local`:

| Key | Description |
|---|---|
| `ternkonnectEmail` | User's registered email |
| `ternkonnectCode` | Integration code from the Platform dashboard |

### Backend URLs (hardcoded)

| Constant | Value | Used For |
|---|---|---|
| `PLATFORM_BASE_URL` | `http://localhost:9001` | Auth, integration, activity logging |
| `INTELLIGENCE_WS_URL` | `ws://localhost:8000/ws` | Voice session WebSocket |

> **Note:** For production, update these URLs in `background.js` and `offscreen.js`.

---

## How It Works

### Voice Command Flow

```
1. User says "Hey TernKonnect"
   └─▶ Wake word detected by SpeechRecognition API (offscreen.js)

2. Wake up sequence
   └─▶ Play chime tone
   └─▶ Start microphone capture (AudioWorklet @ 16kHz PCM16)
   └─▶ Open WebSocket to Intelligence backend
   └─▶ Send auth message with Platform JWT

3. User speaks a command (e.g., "Go to Coursera and find Python courses")
   └─▶ Mic audio streamed as base64 PCM via WebSocket
   └─▶ Intelligence backend relays to Gemini Live
   └─▶ Gemini processes speech, decides on tool calls

4. Gemini requests tool execution (e.g., navigate_to_url, click_element)
   └─▶ offscreen.js receives toolCall message
   └─▶ Forwards to background.js via chrome.runtime.sendMessage
   └─▶ background.js executes via chrome.scripting.executeScript
   └─▶ Result sent back through the chain to Gemini

5. Gemini speaks the response
   └─▶ PCM audio chunks arrive via WebSocket
   └─▶ offscreen.js queues and plays them via Web Audio API
   └─▶ Mic input is muted during playback (half-duplex)

6. After 90s of silence → auto-sleep back to wake word listening
```

---

## Extension Components

### `background.js` — Service Worker

The brain of the extension. Responsibilities:
- **Tool execution** — implements all 27 browser tools (click, navigate, fill, scroll, screenshot, etc.)
- **Tab management** — `chrome.tabs` and `chrome.scripting` APIs
- **Auth flow** — `getChromeSessionToken()` fetches/caches JWTs from the Platform
- **Profile management** — Chrome identity detection, profile ID generation
- **Page context** — auto-analyzes each page load and notifies the offscreen doc
- **Message router** — handles `execute_tool`, `get_config`, `integrate_profile`, `reload_config`, etc.

### `offscreen.js` — Hidden Document

Runs in a persistent hidden page (Manifest V3 offscreen document). Responsibilities:
- **Microphone capture** — `getUserMedia` → AudioWorklet → PCM16 chunks
- **Wake word detection** — `SpeechRecognition` API (continuous, interim results)
- **WebSocket client** — connects to Intelligence backend, handles auth/reconnect
- **Audio playback** — queued PCM chunk playback via Web Audio API
- **Half-duplex** — mic is muted during TTS playback to prevent echo loops
- **Gemini message relay** — forwards tool calls to background, tool results back to Gemini
- **Token refresh** — auto-refreshes JWT 5 minutes before expiry

### `popup.html` / `popup.js` — Extension Popup

User-facing settings and status dashboard:
- **Radar visualizer** — animated radar ring showing connection state
- **Status badges** — AI Connection, Microphone, Voice Mode
- **Settings panel** — email + integration code entry
- **Account management** — link/change/clear account
- **Upgrade prompt** — shown when Starter plan sessions are exhausted
- **LMS capabilities** — feature list (video, quiz, outline, vision, navigation)

### `setup.html` / `setup.js` — Microphone Permission

Full-page permission request flow. Auto-opens on first install or when mic permission is `prompt`. Closes automatically once granted.

---

## Tool Capabilities

### Page Understanding
| Tool | Description |
|---|---|
| `get_current_page_info` | URL, title, and headings |
| `get_orientation` | Full context: where am I, what's here, what can I do |
| `read_page_content` | Main text or headings-only extraction |
| `get_page_elements` | Inventory of all buttons, links, inputs, headings |
| `take_screenshot` | Captures visible tab as JPEG → sent to Gemini for vision analysis |

### Navigation
| Tool | Description |
|---|---|
| `navigate_to_url` | Navigate to any URL (auto-prepends https://) |
| `go_back` / `go_forward` | Browser history navigation |
| `open_new_tab` | Open URL in a new tab |
| `scroll_page` | Scroll up/down/top/bottom by configurable pixels |

### DOM Interaction
| Tool | Description |
|---|---|
| `click_element` | Click by visible text — fuzzy matching with retry loop |
| `fill_form_field` | Type into form fields — React-compatible via native setter |
| `clear_field` | Clear a form field |
| `select_option` | Select from dropdown/`<select>` elements |
| `type_rich_text` | Type into rich text editors (TinyMCE, CKEditor, Quill) |
| `submit_form` | Submit the active form |
| `press_key` | Send keyboard events (Enter, Tab, Escape, etc.) |
| `dismiss_overlay` | Auto-close cookie banners, modals, popups |
| `keyboard_navigate` | Sequential key presses for cross-origin iframes, custom widgets |

### LMS & Video
| Tool | Description |
|---|---|
| `control_video` | Play, pause, toggle, forward, rewind, speed, mute, status |
| `get_video_transcript` | Extract transcript/captions from video players |
| `get_lms_outline` | Course outline/syllabus from sidebar |
| `click_lms_item` | Navigate to a specific course item by index |
| `get_quiz_details` | Extract quiz questions, options, current selections |
| `answer_quiz` | Select an answer for a specific question |
| `get_quiz_timer` | Check remaining time on timed quizzes |
| `submit_quiz` | Submit the quiz (always requires user confirmation) |

---

## LMS Platform Adapters

The `adapters/` directory provides platform-specific CSS selectors and page type detection rules:

| Adapter | Platform | Capabilities |
|---|---|---|
| `coursera.js` | Coursera | Dashboard, search, enrollment, video, transcript, outline, quiz selectors |
| `udemy.js` | Udemy | Video control, course navigation selectors |
| `linkedin.js` | LinkedIn | Feed, profile, post composition selectors |
| `generic.js` | Any LMS | Heuristic-based page type detection using common LMS patterns |

The `index.js` adapter router matches URLs to the appropriate adapter and returns merged selectors for each tool category (video, transcript, outline, quiz, dashboard, search, enroll).

---

## Audio Pipeline

```
Microphone → getUserMedia (16kHz mono)
    │
    ▼
AudioWorklet (audio-processor.js)
    │ Float32 PCM chunks
    ▼
offscreen.js workletNode.port.onmessage
    │ Float32 → Int16 → Base64
    ▼
WebSocket → Intelligence Backend → Gemini Live
    │
    ▼ (response audio)
Gemini Live → Intelligence Backend → WebSocket
    │ Base64 PCM @ 24kHz
    ▼
offscreen.js enqueueAudio()
    │ Base64 → Int16 → Float32
    ▼
AudioContext.createBufferSource → Speakers
```

**Half-duplex:** Mic streaming is paused while TTS audio is playing to prevent echo feedback loops.

---

## Wake Word System

The extension uses the **Web Speech API** (`SpeechRecognition`) for always-on wake word detection:

- **Wake phrase:** `"Hey TernKonnect"` (also matches "Hey Turn Connect" — common STT mishearing)
- **Dormant state:** Only the speech recognizer runs — no Gemini session, no cost
- **Wakeup:** Plays a rising chime, starts mic capture, opens the Gemini WebSocket
- **Auto-sleep:** After 90 seconds of conversation silence, disconnects and returns to wake word listening
- **Fallback:** If SpeechRecognition is unavailable, wakes up immediately (always-on mode)

---

## Authentication & Account Linking

### Integration Flow

```
User clicks "Save" in popup settings
    │
    ▼
popup.js → background.js (integrate_profile message)
    │
    ▼
background.js → POST /api/platform/chrome/integrate
    │ (email, integrationCode, profileId, browserVersion)
    ▼
Platform validates → 200 OK
    │
    ▼
Credentials saved to chrome.storage.local
    │
    ▼
offscreen.js reboots → starts wake word listener
```

### Session Token Flow

When the wake word is heard and the Gemini session needs to open:

1. `offscreen.js` asks `background.js` for a session token
2. `background.js` calls `POST /api/auth/session` on the Platform
3. Platform validates email + integrationCode + active subscription
4. Returns a 30-minute JWT (5-minute for Starter plan)
5. Token is cached in memory; auto-refreshed 5 minutes before expiry

---

## Session Management

| Behavior | Detail |
|---|---|
| **Wake idle timeout** | 90 seconds of silence → auto-sleep |
| **Server idle timeout** | 600 seconds (from Intelligence backend) |
| **Max session duration** | 5 min (Starter) / 30 min (Pro/Enterprise) |
| **Token refresh** | Every 25 minutes, a `reauth` message is sent with a fresh JWT |
| **Session replacement** | If a new connection opens from the same account, the old one is evicted |
| **Trial cap** | Starter plan: 30 lifetime sessions, then upgrade prompt shown |

---

## Popup UI

The popup features a dark, glassmorphic design with:

- **Radar visualizer** — animated concentric rings with pulsing core indicating state
- **Status badges** — color-coded (green/yellow/red) for AI Connection, Microphone, Voice Mode
- **Settings panel** — collapsible with email/code inputs, save/clear buttons
- **Integrated view** — shows linked account with "Change Account" option
- **Trial expired view** — upgrade prompt with "I've Upgraded — Retry" button
- **LMS capabilities grid** — 6 feature badges (Video Control, Course Outline, Quiz Assist, Screen Vision, Page Reading, Auto-Navigate)

### UI States

| State | Radar | AI Badge | Description |
|---|---|---|---|
| Dormant | Slow pulse (indigo) | Ready (green) | Listening for wake word |
| Connecting | Slow pulse (indigo) | Connecting (yellow) | Opening WebSocket |
| Connected + Listening | Active pulse (green) | Connected (green) | Session active, mic streaming |
| Not Linked | Error pulse (red) | Not Linked (red) | No credentials entered |
| Trial Exhausted | Error pulse (red) | Upgrade Required (red) | Free sessions used up |
| Offline | Error pulse (red) | Disconnected (red) | Backend unreachable |

---

## Development

### Local Development Setup

1. Start the **Platform backend** on port 9001
2. Start the **Intelligence backend** on port 8000
3. Load the extension as unpacked in Chrome
4. Open `chrome://extensions/` and click the service worker link to see `background.js` console
5. Open the offscreen document console via `chrome://extensions/` → Details → Inspect views

### Modifying Tools

Tool declarations live server-side in `digital-accessibility-intelligence/core/tools.py`. Tool **implementations** are in this extension's `background.js` → `executeTool()` switch.

To add a new tool:
1. Add the declaration in `tools.py` (Intelligence backend)
2. Add the `case` in `executeTool()` (this extension's `background.js`)
3. Implement the function using `runInTab()` for DOM operations or Chrome APIs directly

---

## Testing

```bash
npm test
# Runs: node --test tests/*.test.js
```

Tests use Node.js's built-in test runner with `jsdom` for DOM simulation.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| **"Account Required" warning** | Open Settings (⚙), enter email + integration code, click Save |
| **Mic stays "Setup (Click)"** | Click the mic badge → completes permission flow in setup.html |
| **"Mic Blocked"** | Click address bar mic icon → Allow → reload extension |
| **AI stays "Disconnected"** | Ensure Platform (`:9001`) and Intelligence (`:8000`) backends are running |
| **Wake word not detected** | Speak clearly: "Hey TernKonnect". Check mic permission in Chrome settings |
| **No audio playback** | Check system volume. Ensure no other tab is blocking audio context |
| **"Sessions Used Up"** | Starter plan exhausted — click "Upgrade Plan" to go to billing dashboard |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

This project is proprietary software owned by TernConnect. All rights reserved.
