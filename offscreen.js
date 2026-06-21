// offscreen.js
// This page runs hidden in the background.
// It owns: microphone capture → Gemini WebSocket → audio playback.
// Tool calls from Gemini are forwarded to background.js for execution.
// Screenshot results are sent back to Gemini as inline images for vision analysis.

import { getTernkonnectAuth } from './config.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'models/gemini-2.0-flash-exp';
const GEMINI_WS_BASE = 'ws://localhost:9001/api/tools/proxy';

const SYSTEM_PROMPT = `You are TernKonnect, an AI browser assistant built exclusively for blind students.
The user is completely blind and CANNOT see the screen at all — you are their eyes, hands, and navigator.
Your goal is to make accessing LMS platforms (like Coursera) and browsing the web entirely seamless, conversational, and stress-free.

CORE BEHAVIOR RULES FOR BLIND NAVIGATION:
1. NEVER tell the user where things are located on the screen (e.g., "at the top right", "the blue button"). They cannot see them. Instead, describe the actions you are performing on their behalf (e.g., "I am logging in now" or "I am opening your Python course outline").
2. NEVER ask the user to click, look at, or locate elements. Use your browser tools to DO it for them immediately.
3. Speak in a guiding, patient, and reassuring tone. Let the user know when a page is loading, when an action is complete, or if you are scanning the page content behind the scenes.
4. Keep spoken responses concise, comforting, and focused. Blind users rely heavily on screen readers/text-to-speech, so avoid reading out long blocks of text. Summarize the 2 or 3 most relevant options and ask how they want to proceed.
5. If an action fails (e.g., a button isn't found), try another method, scroll, or take a screenshot to locate it. Do not throw technical errors; silently retry, and only explain the situation in simple terms if you are completely stuck.
6. For logins and forms, ask the user for information one field at a time (e.g., "What is your email address?") and fill it immediately, rather than asking for everything at once. Never speak passwords back to the user.

TOOLS YOU HAVE:

NAVIGATION & PAGE INTERACTION:
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

VISION (COMPUTER USE):
- take_screenshot: capture the visible screen as an image. Use this when you need to SEE the page visually — for example to understand a layout, read content that DOM tools missed, identify visual elements, or when the user asks "what's on the screen?" or "describe the page". After receiving the screenshot, you WILL be able to see the image and must describe what you see to the user.

VIDEO CONTROL:
- control_video: control the HTML5 video on the current page. Actions: play, pause, toggle, forward (skip ahead), rewind (go back), speed (change playback speed), mute, status (get current video info like time, duration, speed).
- get_video_transcript: extract and read the text transcript or closed captions for the video lecture currently on the screen. Use this when the user asks to read the transcript.

LMS / COURSE NAVIGATION:
- get_lms_outline: get the list of lessons, modules, quizzes, and items in the current course syllabus/outline. Works with Coursera, edX, Moodle, Canvas, Udemy, and similar platforms.
- click_lms_item: navigate to a specific course item by its index number from the outline.

QUIZ INTERACTION:
- get_quiz_details: extract all quiz questions and their answer options from the current page.
- answer_quiz: select an answer option for a specific quiz question by question index and option index.

RULES:
1. When a user says "go to X", call navigate_to_url immediately.
2. When a page loads, announce its title and state (e.g. if it is the login page, dashboard, search results, or a lesson page) and guide them on what to do next.
3. For sign-in/sign-up: tell the user they are on the login page and offer to guide them. Ask for each field one at a time, fill it, and submit.
4. Never tell the user to "click" or "look" — do it for them.
5. After every action, speak a short confirmation and ask what they want to do next.
6. If a command is ambiguous, ask one clarifying question.
7. Be concise. One or two sentences per response is ideal.
8. If a page has a CAPTCHA or requires image recognition, tell the user honestly.
9. Never reveal passwords back to the user after they say them.
10. For video lectures: when the user says "play", "pause", "fast forward", "rewind", "speed up", "slow down", or asks about the video, use control_video.
11. For course navigation: when the user says "what lessons are there?", "show me the outline", "go to lesson 3", use get_lms_outline and click_lms_item.
12. For quizzes: when the user reaches a quiz, automatically call get_quiz_details, read each question and its options aloud, ask the user which option they want, and use answer_quiz to select it. Then submit when all questions are answered.
13. Use take_screenshot when standard DOM tools fail to find or read content. If a page seems confusing or the user asks what the screen looks like, take a screenshot to visually analyze the page.
14. GUIDED LMS ONBOARDING & DASHBOARD:
    - If on the dashboard/homepage, read out the list of enrolled courses. Ask if they want to continue one or search for a new one.
    - If they want a new course, ask for their preferred topic, then search for it (navigate to search URL).
    - If on search results page: analyze the course options returned. Recommend the top course(s) and explain WHY (e.g. based on rating/difficulty/fit). Guide them on how to select it.
    - If on a course page: check if they need to enroll. If so, guide them and click the Enroll button to get them enrolled.
    - Once in a course: guide them step-by-step through the outline and syllabus.

15. LINKEDIN POSTS:
    - If the user asks to write a LinkedIn post, guide them. Navigate to linkedin.com, use click_element to click "Start a post", use fill_form_field to write the draft in the text editor, and then use click_element to click "Post" to publish it.
    - If you are having trouble finding the buttons, use take_screenshot to see the screen and find the right elements.

START: When this session begins, immediately greet the user with:
"Welcome to TernKonnect AI assistant. I can help you navigate courses, play videos, take quizzes, and browse the web. Just tell me what you need."`;

// NOTE: Gemini Live API uses lowercase JSON Schema types (object/string/number)
// NOT the uppercase variants used by the REST API (OBJECT/STRING/NUMBER)
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'navigate_to_url',
        description: 'Navigate the browser to a URL or website.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL or domain, e.g. https://coursera.org or coursera.com' }
          },
          required: ['url']
        }
      },
      {
        name: 'click_element',
        description: 'Click a button, link, or interactive element by its visible text.',
        parameters: {
          type: 'object',
          properties: {
            element_text: { type: 'string', description: 'Visible text of the element to click' },
            element_type: {
              type: 'string',
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
          type: 'object',
          properties: {
            field_identifier: { type: 'string', description: 'Label, placeholder, or name of the field' },
            value: { type: 'string', description: 'Value to type into the field' }
          },
          required: ['field_identifier', 'value']
        }
      },
      {
        name: 'clear_field',
        description: 'Clear the contents of a form field.',
        parameters: {
          type: 'object',
          properties: {
            field_identifier: { type: 'string', description: 'Label, placeholder, or name of the field to clear' }
          },
          required: ['field_identifier']
        }
      },
      {
        name: 'read_page_content',
        description: 'Read the main text content of the current page.',
        parameters: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'What to read: "main" for all content, "headings" for just headings',
              enum: ['main', 'headings']
            }
          }
        }
      },
      {
        name: 'get_page_elements',
        description: 'Get all interactive elements on the page: buttons, links, form fields, headings.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'get_current_page_info',
        description: 'Get the URL, title, and headings of the current page.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'scroll_page',
        description: 'Scroll the current page.',
        parameters: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              description: 'Direction to scroll',
              enum: ['up', 'down', 'top', 'bottom']
            },
            amount: { type: 'number', description: 'Pixels to scroll (optional, default 500)' }
          },
          required: ['direction']
        }
      },
      {
        name: 'submit_form',
        description: 'Submit the current form on the page.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'go_back',
        description: 'Go back to the previous page.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'go_forward',
        description: 'Go forward in browser history.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'open_new_tab',
        description: 'Open a URL in a new browser tab.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open in new tab' }
          },
          required: ['url']
        }
      },
      {
        name: 'press_key',
        description: 'Press a keyboard key on the currently focused element.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown' }
          },
          required: ['key']
        }
      },
      // ── Computer-Vision tool ──
      {
        name: 'take_screenshot',
        description: 'Capture a screenshot of the current visible browser tab. Returns an image that you can analyze to understand the visual layout, read text, identify elements, and describe the screen to the user. Use this when DOM-based tools fail, or when the user asks what the screen looks like.',
        parameters: { type: 'object', properties: {} }
      },
      // ── Video control tool ──
      {
        name: 'control_video',
        description: 'Control the HTML5 video player on the current page. Use for playing, pausing, skipping, rewinding, changing speed, muting, or getting status of a video lecture.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'What to do with the video',
              enum: ['play', 'pause', 'toggle', 'forward', 'rewind', 'speed', 'mute', 'status']
            },
            value: {
              type: 'number',
              description: 'Optional value: seconds to skip for forward/rewind, or playback rate for speed (e.g. 1.5, 2.0)'
            }
          },
          required: ['action']
        }
      },
      {
        name: 'get_video_transcript',
        description: 'Extract and return the text transcript or closed captions for the video lecture currently on the screen. Use this when the user asks to read the transcript.',
        parameters: { type: 'object', properties: {} }
      },
      // ── LMS navigation tools ──
      {
        name: 'get_lms_outline',
        description: 'Get the list of course items (lessons, videos, quizzes, readings) from the current LMS page sidebar or syllabus. Works with Coursera, edX, Moodle, Canvas, Udemy.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'click_lms_item',
        description: 'Navigate to a specific course item from the outline by its index number.',
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: 'The index number of the item to navigate to (from get_lms_outline results)' }
          },
          required: ['index']
        }
      },
      // ── Quiz tools ──
      {
        name: 'get_quiz_details',
        description: 'Extract all quiz questions, answer options, and current selections from the page. Use this on quiz/assessment pages.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'answer_quiz',
        description: 'Select an answer option for a specific quiz question.',
        parameters: {
          type: 'object',
          properties: {
            question_index: { type: 'number', description: 'The index of the question (from get_quiz_details)' },
            option_index: { type: 'number', description: 'The index of the option to select for that question' }
          },
          required: ['question_index', 'option_index']
        }
      }
    ]
  }
];

// ── State ──────────────────────────────────────────────────────────────────────

let ws = null;
let authDetails = null;
let isConnecting = false;
let reconnectTimer = null;
let micStream;
let audioContext;
let workletNode;
let hasWelcomed = false;
let trialTimeout = null;

// Audio playback queue (we queue chunks and play them sequentially)
let playbackQueue = [];
let isPlaying = false;
let playbackCtx = null;

// ── Boot ───────────────────────────────────────────────────────────────────────

function stopMicrophone() {
  console.log('[TernKonnect] Stopping microphone capture and cleaning up...');
  if (workletNode) {
    try { workletNode.disconnect(); } catch (_) {}
    workletNode = null;
  }
  if (audioContext) {
    try { audioContext.close(); } catch (_) {}
    audioContext = null;
  }
  if (micStream) {
    try {
      micStream.getTracks().forEach(track => track.stop());
    } catch (_) {}
    micStream = null;
  }
}

async function boot() {
  // Always clean up any existing capture resources first
  stopMicrophone();
  if (trialTimeout) {
    clearTimeout(trialTimeout);
    trialTimeout = null;
  }

  // Load session state to avoid repeating welcome message on unexpected browser reloads
  try {
    const sessionData = await chrome.runtime.sendMessage({ type: 'get_session_state' });
    hasWelcomed = !!sessionData.hasWelcomed;
  } catch (_) {}

  // Load Auth
  authDetails = await getTernkonnectAuth();

  if (!authDetails) {
    console.warn('[TernKonnect] No configuration loaded.');
    return;
  }

  if (authDetails.trialExpired) {
    console.warn('[TernKonnect] Trial expired. Login required.');
    speakFallback("Your trial period has expired. Please log in and subscribe to continue.");
    return;
  }

  if (!authDetails.trial && (!authDetails.email || !authDetails.integrationCode)) {
    console.warn('[TernKonnect] No auth configured. Please log in to continue.');
    return;
  }

  // If in active trial, set up expiration timer
  if (authDetails.trial) {
    console.log(`[TernKonnect] Running in trial mode. Remaining time: ${authDetails.remainingTime}ms`);
    trialTimeout = setTimeout(() => {
      console.warn('[TernKonnect] Trial expired during use.');
      stopMicrophone();
      if (ws) {
        ws.close();
        ws = null;
      }
      speakFallback("Your five minute trial session has ended. Please log in and subscribe to continue.");
      try { chrome.runtime.sendMessage({ type: 'trial_expired' }); } catch (_) {}
    }, authDetails.remainingTime);

    // Speak trial start announcement if it's a new trial segment
    if (authDetails.remainingTime > 290000) {
      speakFallback(`Starting trial session ${authDetails.trialsCount} of 3. This trial will last for 5 minutes.`);
    }
  }

  await startMicrophone();
  connectToGemini();
}

// Initial boot
boot();

// Listen for messages from popup or background service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'reload_config') {
    console.log('[TernKonnect] Config reload requested — restarting connection...');
    hasWelcomed = false;
    if (trialTimeout) {
      clearTimeout(trialTimeout);
      trialTimeout = null;
    }
    try { chrome.runtime.sendMessage({ type: 'set_session_state', state: { hasWelcomed: false } }); } catch (_) {}
    if (ws) { ws.close(); ws = null; }
    boot();
  } else if (message.type === 'page_loaded') {
    handlePageLoadedNotification(message.analysis);
  }
});

function handlePageLoadedNotification(analysis) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  console.log('[TernKonnect] Page load context received:', analysis);
  
  let promptText = `CONTEXT UPDATE: The active tab loaded a page.\nURL: ${analysis.url}\nTitle: "${analysis.title}"\n`;
  if (analysis.isLMS) {
    promptText += `LMS Platform: ${analysis.lmsPlatform}\nPage Type: ${analysis.pageType}\n`;
    
    if (analysis.pageType === 'login') {
      promptText += `Instruction: The user is on the Login page. Inform them they need to log in, and ask if they want you to guide them through filling out their email and password.`;
    } else if (analysis.pageType === 'dashboard') {
      promptText += `Instruction: The user is on the LMS dashboard. `;
      if (analysis.contextInfo?.enrolledCourses && analysis.contextInfo.enrolledCourses.length > 0) {
        promptText += `Visible Enrolled Courses:\n` + analysis.contextInfo.enrolledCourses.map((c, i) => `- [Index ${i}] "${c.title}" (Link: ${c.url})`).join('\n') + `\n`;
        promptText += `List these courses and ask the user if they want to continue one of them (specifying which index or name) or search for a new course to take.`;
      } else {
        promptText += `Ask the user if they would like to search for a new course.`;
      }
    } else if (analysis.pageType === 'search_results') {
      promptText += `Instruction: The user is looking at course search results. `;
      if (analysis.contextInfo?.searchResults && analysis.contextInfo.searchResults.length > 0) {
        promptText += `Found Courses:\n` + analysis.contextInfo.searchResults.map((c, i) => `Course ${i + 1}: "${c.title}" (Rating: ${c.rating}). Description: ${c.description}`).join('\n') + `\n`;
        promptText += `Analyze these results. Proactively recommend the top course(s) and explain WHY they are the best fit. Guide the user on how they can select a course (e.g. "To select course 1, say 'select course one'").`;
      } else {
        promptText += `No course results found on screen. Ask the user what other topic they would like to search for.`;
      }
    } else if (analysis.pageType === 'course_home') {
      promptText += `Instruction: The user is on the course details page. `;
      if (analysis.contextInfo?.hasEnrollButton) {
        promptText += `There is an "Enroll" button visible on the page. Describe the course and ask the user if they want to enroll in it.`;
      } else {
        promptText += `This course is already enrolled. Ask the user if they want to open the course outline/syllabus to start learning.`;
      }
    } else if (analysis.pageType === 'quiz') {
      promptText += `Instruction: The user is on a quiz. Proactively offer to read the quiz questions and help them answer.`;
    } else {
      promptText += `Instruction: The user is on a lesson/lecture page. Announce the title of the lesson/item, and ask if they want to play the video, view the syllabus outline, or continue.`;
    }
  } else if (analysis.isLinkedIn) {
    promptText += `Platform: LinkedIn\nPage Type: ${analysis.pageType}\n`;
    if (analysis.pageType === 'linkedin_feed') {
      promptText += `Instruction: The user is on the LinkedIn feed. Ask them if they would like you to help them draft and publish a new post, or if they want to scroll through their feed.`;
    } else if (analysis.pageType === 'linkedin_profile') {
      promptText += `Instruction: The user is viewing a LinkedIn profile. Ask if they want you to read the profile summary or connect with them.`;
    } else {
      promptText += `Instruction: The user is on LinkedIn. Ask them what they would like to do (e.g. draft a post, search for connections).`;
    }
  } else {
    promptText += `Instruction: The user is browsing a regular page. Briefly announce the title and ask what they would like to do next.`;
  }
  
  // Send the context to Gemini so it acts on it and speaks to the user
  ws.send(JSON.stringify({
    clientContent: {
      turns: [{
        role: 'user',
        parts: [{ text: promptText }]
      }],
      turnComplete: true
    }
  }));
}

// ── Microphone capture ─────────────────────────────────────────────────────────

async function startMicrophone() {
  try {
    // Check permission state first to avoid throwing NotAllowedError automatically
    try {
      const perm = await navigator.permissions.query({ name: 'microphone' });
      if (perm.state !== 'granted') {
        console.warn('[TernKonnect] Microphone permission state is:', perm.state, '- skipping getUserMedia request to avoid NotAllowedError.');
        speakFallback('Microphone access is not set up yet. Please open the extension popup and complete the microphone setup.');
        return;
      }
    } catch (e) {
      console.warn('[TernKonnect] navigator.permissions.query failed or not supported:', e);
    }

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
    console.log('[TernKonnect] AudioContext state on creation:', audioContext.state);
    
    // Automatically resume if Chrome suspends it later
    audioContext.onstatechange = () => {
      console.log('[TernKonnect] AudioContext state changed:', audioContext.state);
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(e => console.error('[TernKonnect] Failed to resume AudioContext:', e));
      }
    };
    
    // Explicitly resume the context to guarantee that processing fires
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
      console.log('[TernKonnect] AudioContext explicitly resumed. State:', audioContext.state);
    }

    const source = audioContext.createMediaStreamSource(micStream);

    // AudioWorkletNode: load audio-processor.js and handle chunks
    await audioContext.audioWorklet.addModule('audio-processor.js');
    workletNode = new AudioWorkletNode(audioContext, 'audio-processor');

    workletNode.port.onmessage = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = event.data;
      const int16 = float32ToInt16(float32);
      const b64 = bufferToBase64(int16.buffer);
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: b64 }
        }
      }));
    };

    // Connect through a silent gain so we don't echo mic into speakers
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    source.connect(workletNode);
    workletNode.connect(silent);
    silent.connect(audioContext.destination);

    console.log('[TernKonnect] Microphone capture active and connected to Web Audio pipeline.');
  } catch (err) {
    console.error('[TernKonnect] Microphone error:', err.name, err.message, err);
    // Don't block — Gemini can still work for text/tool interactions
    // Common causes: NotAllowedError (permission denied), NotFoundError (no mic)
    if (err.name === 'NotAllowedError') {
      speakFallback('Microphone access was denied. Please allow microphone access for this extension, then reload.');
    } else if (err.name === 'NotFoundError') {
      speakFallback('No microphone found. Please connect a microphone and reload the extension.');
    } else {
      speakFallback('Microphone error: ' + (err.message || err.name) + '. The assistant will still work but cannot hear you.');
    }
  }
}

// ── Gemini WebSocket ───────────────────────────────────────────────────────────

async function updateWsStatus(status) {
  try {
    await chrome.runtime.sendMessage({ type: 'set_session_state', state: { wsStatus: status } });
  } catch (_) {}
}

function connectToGemini() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  isConnecting = true;
  updateWsStatus('connecting');

  let url;
  if (authDetails.trial) {
    url = `${GEMINI_WS_BASE}?trial=true&profileId=${encodeURIComponent(authDetails.profileId)}`;
  } else {
    url = `${GEMINI_WS_BASE}?email=${encodeURIComponent(authDetails.email)}&integrationCode=${encodeURIComponent(authDetails.integrationCode)}&profileId=${encodeURIComponent(authDetails.profileId)}`;
  }
  ws = new WebSocket(url);

  ws.onopen = () => {
    isConnecting = false;
    updateWsStatus('connected');
    console.log('[TernKonnect] Connected to Gemini');

    // Send setup — all three fields are valid at the top level of setup.
    // Tools use lowercase JSON Schema types (object/string/number) as required by the Live API.
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
      // WebSocket may deliver data as Blob or string depending on browser
      let raw = event.data;
      if (raw instanceof Blob || (raw && typeof raw === 'object' && typeof raw.text === 'function')) {
        raw = await raw.text();
      }
      const msg = JSON.parse(raw);
      await handleServerMessage(msg);
    } catch (err) {
      console.error('[TernKonnect] Parse error:', err);
    }
  };

  ws.onclose = (event) => {
    console.warn('[TernKonnect] WebSocket closed:', event.code, event.reason);
    isConnecting = false;
    ws = null;
    updateWsStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[TernKonnect] WebSocket error:', err);
    isConnecting = false;
    updateWsStatus('error');
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
    if (!hasWelcomed) {
      hasWelcomed = true;
      try { chrome.runtime.sendMessage({ type: 'set_session_state', state: { hasWelcomed: true } }); } catch (_) {}
      
      // Nudge Gemini to say the welcome message
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'Begin.' }] }],
          turnComplete: true
        }
      }));
    } else {
      console.log('[TernKonnect] Silent reconnect: Skipping welcome message.');
    }
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

  // Log the activity to the platform
  try {
    chrome.runtime.sendMessage({
      type: 'log_profile_activity',
      actionType: name,
      description: `Executed tool "${name}"`,
      metadata: { args, result }
    });
  } catch (err) {
    console.warn('[TernKonnect] Failed to send activity log message:', err.message);
  }

  // Return result to Gemini
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ id, name, response: result }]
      }
    }));

    // ── Special handling: send screenshot as visual context ──
    // When take_screenshot succeeds, also send the image as a user turn
    // so Gemini can actually SEE and analyze the screenshot.
    if (name === 'take_screenshot' && result.success && result.imageBase64) {
      console.log('[TernKonnect] Sending screenshot image to Gemini for visual analysis...');
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: result.mimeType || 'image/jpeg',
                  data: result.imageBase64
                }
              },
              {
                text: 'I just took this screenshot of the current browser tab. Please analyze it and describe what you see to the user. Focus on: page layout, main content, any navigation elements, interactive buttons, forms, video players, or course content visible. Be concise but thorough.'
              }
            ]
          }],
          turnComplete: true
        }
      }));
    }
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
