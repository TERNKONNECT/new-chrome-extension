// offscreen.js
// This page runs hidden in the background.
// It owns: microphone capture → Gemini WebSocket → audio playback.
// Tool calls from Gemini are forwarded to background.js for execution.

import { GEMINI_API_KEY } from './config.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'models/gemini-2.0-flash-live-001';
const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const SYSTEM_PROMPT = `You are TernKonnect, an AI browser assistant built exclusively for blind users.
The user CANNOT see the screen at all — you are their eyes, hands, and navigator.

Your job is to take action immediately when the user speaks a command. Never just describe what to do; DO it.

TOOLS YOU HAVE:
- navigate_to_url: go to any website
- click_element: click buttons and links by their visible text
- fill_form_field: type into input fields (email, password, username, search, etc.)
- clear_field: clear a form field
- submit_form: submit the current form
- read_page_content: read what is on the current page
- get_page_elements: discover what buttons/links/forms are on the page
- get_current_page_info: get the current URL and page title
- scroll_page: scroll up, down, to top, or to bottom
- go_back: go to the previous page
- go_forward: go forward a page
- open_new_tab: open a URL in a new tab
- press_key: press a keyboard key (e.g. Enter, Tab, Escape)

RULES:
1. When a user says "go to X", call navigate_to_url immediately.
2. When a page loads, announce its title and briefly describe what it is.
3. For sign-in/sign-up: first call get_page_elements so you know what fields exist,
   then ask the user for each required field one at a time, fill it, then submit.
4. Never tell the user to "click" or "look" — do it for them.
5. After every action, speak a short confirmation and ask what they want to do next.
6. If a command is ambiguous, ask one clarifying question.
7. Be concise. One or two sentences per response is ideal.
8. If a page has a CAPTCHA or requires image recognition, tell the user honestly.
9. Never reveal passwords back to the user after they say them.

START: When this session begins, immediately greet the user with:
"Welcome to TernKonnect AI assistant. Tell me anything, and I will do it for you."`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'navigate_to_url',
        description: 'Navigate the browser to a URL or website.',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: { type: 'STRING', description: 'Full URL or domain, e.g. https://coursera.org or coursera.com' }
          },
          required: ['url']
        }
      },
      {
        name: 'click_element',
        description: 'Click a button, link, or interactive element by its visible text.',
        parameters: {
          type: 'OBJECT',
          properties: {
            element_text: { type: 'STRING', description: 'Visible text of the element to click' },
            element_type: {
              type: 'STRING',
              description: 'Type of element',
              enum: ['button', 'link', 'any']
            }
          },
          required: ['element_text']
        }
      },
      {
        name: 'fill_form_field',
        description: 'Type a value into a form field (email, password, username, search box, etc.).',
        parameters: {
          type: 'OBJECT',
          properties: {
            field_identifier: { type: 'STRING', description: 'Label, placeholder, or name of the field' },
            value: { type: 'STRING', description: 'Value to type into the field' }
          },
          required: ['field_identifier', 'value']
        }
      },
      {
        name: 'clear_field',
        description: 'Clear the contents of a form field.',
        parameters: {
          type: 'OBJECT',
          properties: {
            field_identifier: { type: 'STRING', description: 'Label, placeholder, or name of the field to clear' }
          },
          required: ['field_identifier']
        }
      },
      {
        name: 'read_page_content',
        description: 'Read the main text content of the current page.',
        parameters: {
          type: 'OBJECT',
          properties: {
            section: {
              type: 'STRING',
              description: 'What to read: "main" for all content, "headings" for just headings',
              enum: ['main', 'headings']
            }
          }
        }
      },
      {
        name: 'get_page_elements',
        description: 'Get all interactive elements on the page: buttons, links, form fields, headings.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_current_page_info',
        description: 'Get the URL, title, and headings of the current page.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'scroll_page',
        description: 'Scroll the current page.',
        parameters: {
          type: 'OBJECT',
          properties: {
            direction: {
              type: 'STRING',
              description: 'Direction to scroll',
              enum: ['up', 'down', 'top', 'bottom']
            },
            amount: { type: 'NUMBER', description: 'Pixels to scroll (optional, default 500)' }
          },
          required: ['direction']
        }
      },
      {
        name: 'submit_form',
        description: 'Submit the current form on the page.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'go_back',
        description: 'Go back to the previous page.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'go_forward',
        description: 'Go forward in browser history.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'open_new_tab',
        description: 'Open a URL in a new browser tab.',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: { type: 'STRING', description: 'URL to open in new tab' }
          },
          required: ['url']
        }
      },
      {
        name: 'press_key',
        description: 'Press a keyboard key on the currently focused element.',
        parameters: {
          type: 'OBJECT',
          properties: {
            key: { type: 'STRING', description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown' }
          },
          required: ['key']
        }
      }
    ]
  }
];

// ── State ──────────────────────────────────────────────────────────────────────

let ws = null;
let apiKey = null;
let isConnecting = false;
let reconnectTimer = null;
let micStream = null;
let audioContext = null;
let scriptProcessor = null;

// Audio playback queue (we queue chunks and play them sequentially)
let playbackQueue = [];
let isPlaying = false;
let playbackCtx = null;

// ── Boot ───────────────────────────────────────────────────────────────────────

(async function boot() {
  // API key comes directly from config.js via ES module import
  apiKey = GEMINI_API_KEY;

  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    console.error('[TernKonnect] No API key found. Open config.js and add your Gemini API key.');
    speakFallback('TernKonnect is not configured. Please add your Gemini API key to the config dot j s file, then reload the extension.');
    return;
  }

  await startMicrophone();
  connectToGemini();
})();

// ── Microphone capture ─────────────────────────────────────────────────────────

async function startMicrophone() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(micStream);

    // ScriptProcessorNode: buffer of 4096 samples @ 16kHz ≈ 256ms per chunk
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);
      const b64 = bufferToBase64(int16.buffer);
      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: b64 }]
        }
      }));
    };

    // Connect through a silent gain so we don't echo mic into speakers
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(scriptProcessor);
    scriptProcessor.connect(silent);
    silent.connect(audioContext.destination);

    console.log('[TernKonnect] Microphone ready');
  } catch (err) {
    console.error('[TernKonnect] Microphone error:', err);
    speakFallback('Microphone access was denied. Please allow microphone access for this extension in your browser settings.');
  }
}

// ── Gemini WebSocket ───────────────────────────────────────────────────────────

function connectToGemini() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  isConnecting = true;

  const url = `${GEMINI_WS_BASE}?key=${apiKey}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    isConnecting = false;
    console.log('[TernKonnect] Connected to Gemini');

    // Send setup
    ws.send(JSON.stringify({
      setup: {
        model: GEMINI_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Charon' }
            }
          }
        },
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        tools: TOOLS
      }
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      await handleServerMessage(msg);
    } catch (err) {
      console.error('[TernKonnect] Parse error:', err);
    }
  };

  ws.onclose = (event) => {
    console.warn('[TernKonnect] WebSocket closed:', event.code, event.reason);
    isConnecting = false;
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[TernKonnect] WebSocket error:', err);
    isConnecting = false;
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[TernKonnect] Reconnecting...');
    connectToGemini();
  }, 5000);
}

// ── Handle server messages ─────────────────────────────────────────────────────

async function handleServerMessage(msg) {
  // Setup complete → Gemini will say the welcome message per system prompt
  if (msg.setupComplete !== undefined) {
    console.log('[TernKonnect] Setup complete');
    // Nudge Gemini to say the welcome message
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'Begin.' }] }],
        turnComplete: true
      }
    }));
    return;
  }

  // Model turn: audio, text, or function calls
  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
        enqueueAudio(part.inlineData.data, part.inlineData.mimeType);
      }
      if (part.text) {
        console.log('[TernKonnect] Model text:', part.text);
      }
      if (part.functionCall) {
        await handleFunctionCall(part.functionCall);
      }
    }
  }

  // Tool call (alternative top-level format)
  if (msg.toolCall?.functionCalls) {
    for (const call of msg.toolCall.functionCalls) {
      await handleFunctionCall(call);
    }
  }
}

// ── Function call dispatch ─────────────────────────────────────────────────────

async function handleFunctionCall(call) {
  const { name, args, id } = call;
  console.log(`[TernKonnect] Tool call: ${name}`, args);

  // Ask background.js to execute the browser action
  const response = await chrome.runtime.sendMessage({
    type: 'execute_tool',
    name,
    args: args || {},
    callId: id
  });

  const result = response?.result ?? { error: 'No result from background' };
  console.log(`[TernKonnect] Tool result for ${name}:`, result);

  // Return result to Gemini
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ id, name, response: result }]
      }
    }));
  }
}

// ── Audio playback queue ───────────────────────────────────────────────────────

function enqueueAudio(base64Data, mimeType) {
  playbackQueue.push({ base64Data, mimeType });
  if (!isPlaying) drainQueue();
}

async function drainQueue() {
  if (isPlaying || playbackQueue.length === 0) return;
  isPlaying = true;

  while (playbackQueue.length > 0) {
    const { base64Data, mimeType } = playbackQueue.shift();
    await playPCMChunk(base64Data, mimeType);
  }

  isPlaying = false;
}

async function playPCMChunk(base64Data, mimeType) {
  try {
    const sampleRate = extractSampleRate(mimeType) || 24000;

    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    // Use a shared or new AudioContext for playback
    if (!playbackCtx || playbackCtx.state === 'closed') {
      playbackCtx = new AudioContext({ sampleRate });
    }

    const buffer = playbackCtx.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackCtx.destination);

    await new Promise(resolve => {
      source.onended = resolve;
      source.start();
    });
  } catch (err) {
    console.error('[TernKonnect] Playback error:', err);
  }
}

function extractSampleRate(mimeType) {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ── TTS fallback (for config errors before Gemini connects) ───────────────────

function speakFallback(text) {
  window.speechSynthesis?.speak(new SpeechSynthesisUtterance(text));
}

// ── Audio conversion utilities ─────────────────────────────────────────────────

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return int16;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
