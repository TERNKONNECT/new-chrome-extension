// offscreen.js
// This page runs hidden in the background.
// It owns: microphone capture → Gemini WebSocket → audio playback.
// Tool calls from Gemini are forwarded to background.js for execution.
// Screenshot results are sent back to Gemini as inline images for vision analysis.

import { getTernkonnectAuth } from './config.js';

// ── Config ─────────────────────────────────────────────────────────────────────

// Every session — trial or paid — connects to the Intelligence backend, which
// holds the system prompt + tool declarations server-side and gates the
// connection on a Platform-issued JWT (see config.js / background.js). There
// is no client-side system prompt or anonymous proxy path anymore.
// The actual URL is owned by background.js (configurable via the popup's
// Advanced settings) — fetched fresh on each connect rather than hardcoded
// here, so changing deployments doesn't need a code edit.
async function getIntelligenceWsUrl() {
  try {
    const urls = await chrome.runtime.sendMessage({ type: 'get_backend_urls' });
    if (urls?.intelligenceWsUrl) return urls.intelligenceWsUrl;
  } catch (_) {}
  return 'ws://localhost:8000/ws';
}

// Forgiving match: STT often mis-hears "Tern" as "Turn", and may or may not
// split "Konnect" into two words.
const WAKE_PHRASE = /\bhey\s*(?:t[ue]rn|term|ten)?\s*-?\s*[ck]onnect\b/i;
// How long to stay connected after the conversation goes quiet before
// proactively disconnecting — well under the server's own idle timeout,
// specifically to avoid burning a capped session's minutes while idle.
const WAKE_REARM_IDLE_SECONDS = 90;

// ── State ──────────────────────────────────────────────────────────────────────

let ws = null;
let authDetails = null;
let isConnecting = false;
let suppressNextReconnect = false;
let micStream;
let audioContext;
let workletNode;
let hasWelcomed = false;

// Wake-word gating: the assistant starts dormant (just listening for the
// wake phrase via the browser's own speech recognizer) and only opens the
// — capped, costed — Gemini Live session once summoned.
let awake = false;
let recognizer = null;
let wakeIdleTimer = null;
let lastWakeIdleResetAt = 0;
let wakeWordAvailable = true; // false when SpeechRecognition API is missing

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
  stopWakeWordListener();
  awake = false;

  // Load session state to avoid repeating welcome message on unexpected browser reloads
  try {
    const sessionData = await chrome.runtime.sendMessage({ type: 'get_session_state' });
    hasWelcomed = !!sessionData.hasWelcomed;
  } catch (_) {}

  // Load Auth — every session (trial or paid) requires a linked email +
  // integrationCode now. There's no anonymous fallback.
  authDetails = await getTernkonnectAuth();

  if (!authDetails || !authDetails.email || !authDetails.integrationCode) {
    console.warn('[TernKonnect] No account linked yet. Open the extension popup and enter your email + integration code.');
    updateWsStatus('disconnected');
    return;
  }

  // Dormant by default — the costed, capped-duration Gemini Live session
  // only opens once the wake phrase is heard (see wakeUp()), so just having
  // the extension open and waiting doesn't burn a Starter/Enterprise
  // session's allotted minutes.
  startWakeWordListener();
}

// ── Wake word ────────────────────────────────────────────────────────────────

function startWakeWordListener() {
  updateWsStatus('dormant');
  if (recognizer) return; // already listening

  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionImpl) {
    console.warn('[TernKonnect] SpeechRecognition unavailable in this context — wake word disabled, waking immediately instead.');
    wakeWordAvailable = false;
    wakeUp();
    return;
  }

  recognizer = new SpeechRecognitionImpl();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = 'en-US';

  recognizer.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0]?.transcript || '';
      console.log('[TernKonnect] STT heard:', transcript);
      if (WAKE_PHRASE.test(transcript)) {
        console.log('[TernKonnect] Wake phrase detected:', transcript.trim());
        wakeUp();
        return;
      }
    }
  };

  recognizer.onerror = (event) => {
    // 'no-speech' fires routinely on silence; onend below restarts it regardless.
    console.warn('[TernKonnect] Wake word recognizer error:', event.error);
    if (event.error === 'not-allowed') {
      console.warn('[TernKonnect] Speech recognition blocked in this context. Waking immediately instead.');
      stopWakeWordListener();
      wakeWordAvailable = false;
      wakeUp();
    }
  };

  recognizer.onend = () => {
    // Chrome stops continuous recognition on its own periodically even
    // without an error — restart unless we've since woken up (Gemini owns
    // the mic at that point) or were stopped intentionally (recognizer is
    // nulled out by stopWakeWordListener() before calling .stop()).
    if (!awake && recognizer) {
      try { recognizer.start(); } catch (_) {}
    }
  };

  try {
    recognizer.start();
  } catch (err) {
    console.warn('[TernKonnect] Could not start wake word listener:', err.message);
  }
}

function stopWakeWordListener() {
  if (recognizer) {
    const r = recognizer;
    recognizer = null;
    r.onend = null;
    r.onerror = null;
    r.onresult = null;
    try { r.stop(); } catch (_) {}
  }
}

async function wakeUp() {
  if (awake) return;
  awake = true;
  stopWakeWordListener();
  playFeedbackSound('chime_up');
  resetWakeIdleTimer();
  await startMicrophone();
  connectToGemini();
}

// Proactively disconnects after a quiet period — well before the server's
// own idle timeout — so a paused conversation doesn't quietly eat through a
// capped session's minutes. Also the landing spot for any connection
// failure: going back to "listening for the wake phrase" is always a safe,
// non-error resting state.
function goToSleep() {
  awake = false;
  clearWakeIdleTimer();
  if (ws) {
    suppressNextReconnect = true;
    const oldWs = ws;
    ws = null;
    try { oldWs.close(); } catch (_) {}
  }
  stopMicrophone();
  startWakeWordListener();
}

function resetWakeIdleTimer() {
  lastWakeIdleResetAt = Date.now();
  clearWakeIdleTimer();
  // If there's no wake-word listener to fall back to, sleeping would just
  // trigger an immediate re-connect loop — so stay connected instead.
  if (!wakeWordAvailable) return;
  wakeIdleTimer = setTimeout(() => {
    console.log('[TernKonnect] Quiet for a while — going back to sleep to preserve session time.');
    goToSleep();
  }, WAKE_REARM_IDLE_SECONDS * 1000);
}

function clearWakeIdleTimer() {
  if (wakeIdleTimer) {
    clearTimeout(wakeIdleTimer);
    wakeIdleTimer = null;
  }
}

// Initial boot
boot();

// Listen for messages from popup or background service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'restart_offscreen') {
    console.log('[TernKonnect] Config reload requested — restarting connection...');
    hasWelcomed = false;
    try { chrome.runtime.sendMessage({ type: 'set_session_state', state: { hasWelcomed: false } }); } catch (_) {}
    // Wait for the old connection to actually finish closing before opening
    // a new one — otherwise the backend can briefly see two live sessions
    // for the same account and the new one gets needlessly rejected/evicted.
    return (async () => {
      if (ws) {
        suppressNextReconnect = true;
        const oldWs = ws;
        ws = null;
        await new Promise((resolve) => {
          if (oldWs.readyState === WebSocket.CLOSED) return resolve();
          oldWs.addEventListener('close', resolve, { once: true });
          oldWs.close();
          setTimeout(resolve, 1000); // safety timeout if the close event never fires
        });
      }
      isConnecting = false;
      await boot();
    })();
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

    // Diagnostic: log mic track info to help debug silent-audio issues
    const track = micStream.getAudioTracks()[0];
    console.log('[TernKonnect] Mic track:', track?.label, 'enabled:', track?.enabled, 'readyState:', track?.readyState, 'muted:', track?.muted);
    if (track) {
      track.onmute = () => console.warn('[TernKonnect] Mic track MUTED');
      track.onunmute = () => console.log('[TernKonnect] Mic track UNMUTED');
      track.onended = () => console.warn('[TernKonnect] Mic track ENDED');
    }

    audioContext = new AudioContext({ sampleRate: 16000 });
    const ctx = audioContext; // capture this specific instance, not the mutable outer binding
    console.log('[TernKonnect] AudioContext state on creation:', ctx.state);

    // Automatically resume if Chrome suspends it later. Bound to `ctx`
    // (not the outer `audioContext` variable) so a stale close event from a
    // previous context — fired after stopMicrophone() already nulled/
    // reassigned `audioContext` during a restart — can't throw or act on
    // the wrong context.
    ctx.onstatechange = () => {
      console.log('[TernKonnect] AudioContext state changed:', ctx.state);
      if (ctx.state === 'suspended') {
        ctx.resume().catch(e => console.error('[TernKonnect] Failed to resume AudioContext:', e));
      }
    };
    
    // Explicitly resume the context to guarantee that processing fires
    if (ctx.state === 'suspended') {
      await ctx.resume();
      console.log('[TernKonnect] AudioContext explicitly resumed. State:', ctx.state);
    }

    const source = ctx.createMediaStreamSource(micStream);

    // AudioWorkletNode: load audio-processor.js and handle chunks
    await ctx.audioWorklet.addModule('audio-processor.js');
    workletNode = new AudioWorkletNode(ctx, 'audio-processor');

    let diagFrameCount = 0;
    workletNode.port.onmessage = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Half-duplex: don't stream the mic into Gemini while TTS is playing.
      // Cheaper and safer than full acoustic echo cancellation — avoids the
      // assistant hearing (and reacting to) its own voice through a speaker.
      if (isPlaying) return;
      // Throttled — this handler fires far too often (per audio frame) to
      // reset a timer on every call.
      if (Date.now() - lastWakeIdleResetAt > 2000) resetWakeIdleTimer();
      const float32 = event.data;

      // Diagnostic: log max sample amplitude every ~2s to verify real audio
      diagFrameCount++;
      if (diagFrameCount % 62 === 0) {
        let maxVal = 0;
        for (let i = 0; i < float32.length; i++) maxVal = Math.max(maxVal, Math.abs(float32[i]));
        console.log('[TernKonnect] Mic audio check — max amplitude:', maxVal.toFixed(6), maxVal > 0.001 ? '(AUDIO OK)' : '(SILENCE)');
      }

      const int16 = float32ToInt16(float32);
      const b64 = bufferToBase64(int16.buffer);
      ws.send(JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: b64 }
        }
      }));
    };

    // Connect through a silent gain so we don't echo mic into speakers
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(workletNode);
    workletNode.connect(silent);
    silent.connect(ctx.destination);

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

async function connectToGemini() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  isConnecting = true;
  updateWsStatus('connecting');

  let sessionToken;
  try {
    const tokenResp = await chrome.runtime.sendMessage({ type: 'get_chrome_session_token' });
    if (tokenResp?.error) {
      const err = new Error(tokenResp.error);
      err.trialExhausted = !!tokenResp.trialExhausted;
      throw err;
    }
    sessionToken = tokenResp?.token;
    if (!sessionToken) throw new Error('No session token returned');
  } catch (err) {
    console.error('[TernKonnect] Could not obtain session token:', err.message);
    isConnecting = false;
    updateWsStatus('error');
    // Trial-exhausted is an expected, actionable state (upgrade), not a
    // connection failure — speak it plainly and surface it to the popup,
    // instead of "Could not connect" + endless silent retries.
    speakFallback(err.trialExhausted ? err.message : 'Could not connect: ' + err.message);
    if (err.trialExhausted) {
      try { chrome.runtime.sendMessage({ type: 'set_session_state', state: { trialExhausted: true } }); } catch (_) {}
    }
    // Either way, go back to listening for the wake phrase rather than
    // silently retrying on a timer — the user can just summon it again.
    goToSleep();
    return;
  }

  // A fresh token means the account is in good standing — clear any stale
  // trial-exhausted flag from a previous failed attempt.
  try { chrome.runtime.sendMessage({ type: 'set_session_state', state: { trialExhausted: false } }); } catch (_) {}

  ws = new WebSocket(await getIntelligenceWsUrl());

  ws.onopen = () => {
    isConnecting = false;
    updateWsStatus('connected');
    console.log('[TernKonnect] Connected to Intelligence backend');
    ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
    scheduleTokenRefresh();
  };

  ws.onmessage = handleWsMessage;
  ws.onclose = handleWsClose;
  ws.onerror = handleWsError;
}

async function handleWsMessage(event) {
  try {
    // WebSocket may deliver data as Blob or string depending on browser
    let raw = event.data;
    if (raw instanceof Blob || (raw && typeof raw === 'object' && typeof raw.text === 'function')) {
      raw = await raw.text();
    }
    const msg = JSON.parse(raw);
    if (msg.type) {
      handleControlMessage(msg);
    } else {
      await handleServerMessage(msg);
    }
  } catch (err) {
    console.error('[TernKonnect] Parse error:', err);
  }
}

function handleWsClose(event) {
  console.warn('[TernKonnect] WebSocket closed:', event.code, event.reason);
  isConnecting = false;
  ws = null;
  clearTokenRefreshTimer();
  if (suppressNextReconnect) {
    // Whoever closed us (goToSleep, restart_offscreen) is already handling
    // the transition — don't fight over status or double-start the wake
    // word listener.
    suppressNextReconnect = false;
    return;
  }
  updateWsStatus('disconnected');
  goToSleep();
}

function handleWsError(err) {
  console.error('[TernKonnect] WebSocket error:', err);
  isConnecting = false;
  updateWsStatus('error');
}

// ── New control messages (auth_failed, capacity_exceeded, feedback_sound, etc.) ──
// Distinguished from native Gemini Live messages by the presence of a "type" key.

function handleControlMessage(msg) {
  switch (msg.type) {
    case 'auth_failed':
      console.error('[TernKonnect] Auth failed:', msg.reason);
      speakFallback('Could not connect: ' + msg.reason + '. Please check your email and integration code in settings.');
      // Not suppressed — handleWsClose's goToSleep() puts us back to
      // listening for the wake phrase, which is a safe resting state even
      // though this particular attempt failed.
      if (ws) ws.close();
      break;
    case 'capacity_exceeded':
      speakFallback(msg.message || 'TernConnect is at capacity right now, please try again shortly.');
      break;
    case 'action_failed_final':
      console.warn('[TernKonnect] Action failed after retries:', msg.tool, msg.attempts);
      break;
    case 'thinking_filler':
      // Best-effort filler in case Gemini's own audio is slow to start.
      break;
    case 'feedback_sound':
      playFeedbackSound(msg.name, msg.loop);
      break;
    case 'idle_warning':
      console.log('[TernKonnect] Idle warning, seconds remaining:', msg.seconds_remaining);
      break;
    case 'service_error':
      // Backend accepted us but couldn't reach the upstream AI service
      // (bad/quota-limited Gemini key, network issue, etc.) — distinct from
      // auth_failed, and worth a normal retry rather than giving up.
      console.error('[TernKonnect] Service error:', msg.message);
      speakFallback(msg.message);
      break;
    case 'session_replaced':
      // A newer connection from this same account took over (e.g. the
      // extension reconnected elsewhere). Going back to wake-word listening
      // (via handleWsClose -> goToSleep()) rather than immediately
      // reconnecting avoids bouncing the two connections off each other.
      console.warn('[TernKonnect] Session replaced by a newer connection.');
      if (ws) ws.close();
      break;
    default:
      console.warn('[TernKonnect] Unknown control message type:', msg.type);
  }
}

// Synthesized tones (no bundled audio assets needed) — distinct frequency
// per cue so the user can learn to recognize them by ear.
const FEEDBACK_TONES = {
  tick: { freq: 880, duration: 0.06 },
  success: { freq: 1320, duration: 0.12 },
  error: { freq: 220, duration: 0.18 },
  whoosh: { freq: 440, duration: 0.15 },
  chime_up: { freq: 660, duration: 0.1 },
  chime_down: { freq: 330, duration: 0.1 },
  capacity_full: { freq: 180, duration: 0.3 }
};

function playFeedbackSound(name) {
  const tone = FEEDBACK_TONES[name];
  if (!tone) return;
  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = tone.freq;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + tone.duration);
    osc.onended = () => ctx.close();
  } catch (err) {
    console.warn('[TernKonnect] Feedback tone playback failed:', err.message);
  }
}

// ── Session token refresh ───────────────────────────────────────────────────────
// Refreshes a few minutes before the JWT expires and sends it over the live
// socket as `reauth`, so a long voice session never gets cut off mid-task.

let tokenRefreshTimer = null;

function scheduleTokenRefresh() {
  clearTokenRefreshTimer();
  // 30-minute tokens; refresh with 5 minutes of headroom.
  tokenRefreshTimer = setTimeout(async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'get_chrome_session_token', forceRefresh: true });
      if (resp?.token && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'reauth', token: resp.token }));
        scheduleTokenRefresh();
      }
    } catch (err) {
      console.warn('[TernKonnect] Token refresh failed:', err.message);
    }
  }, 25 * 60 * 1000);
}

function clearTokenRefreshTimer() {
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
}

// ── Handle server messages ─────────────────────────────────────────────────────

async function handleServerMessage(msg) {
  // Any real activity from Gemini means the conversation is still going —
  // push back the auto-sleep clock.
  resetWakeIdleTimer();

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
    if (playbackCtx.state === 'suspended') {
      await playbackCtx.resume();
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
