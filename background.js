// background.js - Service Worker
// Responsible for: creating the offscreen document, and executing all
// browser tool calls that Gemini requests (navigation, clicking, forms, etc.)

// offscreen.js imports config.js directly — no key passing needed here

import { getPlatformLabel, getSelectors, generic, linkedin } from './adapters/index.js';
import { extractOutline } from './page-scripts/outline.js';
import { quizPageScript } from './page-scripts/quiz.js';
import { extractTranscript } from './page-scripts/transcript.js';
import { controlVideoScript } from './page-scripts/video.js';
import { analyzePageContextScript } from './page-scripts/pageContext.js';

// ── Offscreen document lifecycle ──────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Microphone capture and audio playback for voice assistant'
  });
}

// Called after credentials change (save/clear) so the live connection picks
// up the new email/integrationCode immediately, instead of only on the next
// full browser restart (the offscreen document otherwise only calls boot()
// once, when it's first created).
async function restartOffscreenDocument() {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({ type: 'restart_offscreen' });
}

async function getChromeIdentityEmail() {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (userInfo) => {
        resolve(userInfo?.email || '');
      });
    } catch (_) {
      resolve('');
    }
  });
}

async function ensureProfileId() {
  const result = await chrome.storage.local.get(['chromeProfileId', 'chromeProfileName', 'chromeProfileEmail']);
  let profileId = result.chromeProfileId;
  let profileName = result.chromeProfileName;
  let profileEmail = result.chromeProfileEmail;

  // Always fetch current Chrome identity email
  const currentEmail = await getChromeIdentityEmail();

  if (!profileId) {
    profileId = 'profile_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    if (currentEmail) {
      profileEmail = currentEmail;
      const namePrefix = currentEmail.split('@')[0];
      profileName = namePrefix.charAt(0).toUpperCase() + namePrefix.slice(1) + ` (${currentEmail})`;
    } else {
      profileEmail = '';
      profileName = 'Profile-' + Math.floor(1000 + Math.random() * 9000);
    }

    await chrome.storage.local.set({ 
      chromeProfileId: profileId, 
      chromeProfileName: profileName,
      chromeProfileEmail: profileEmail
    });
  } else if (currentEmail && currentEmail !== profileEmail) {
    // Update profile details if identity changed
    profileEmail = currentEmail;
    const namePrefix = currentEmail.split('@')[0];
    profileName = namePrefix.charAt(0).toUpperCase() + namePrefix.slice(1) + ` (${currentEmail})`;
    await chrome.storage.local.set({
      chromeProfileName: profileName,
      chromeProfileEmail: profileEmail
    });
  }

  return { profileId, profileName, profileEmail };
}

// ── Backend URLs ──────────────────────────────────────────────────────────────
// Single source of truth for where the two backends live, baked in from
// .env at build time (run `npm run build:config` after changing .env, then
// reload the extension) — not editable from the extension UI. Browser JS
// has no filesystem access, so this generated file is the closest honest
// equivalent of "read it from .env".

import { PLATFORM_BASE_URL, INTELLIGENCE_WS_URL, DASHBOARD_URL, ENV } from './config.generated.js';

if (ENV === 'local') {
  chrome.storage.local.set({
    ternkonnectEmail: 'local@dev',
    ternkonnectCode: 'local'
  });
}

async function getBackendUrls() {
  return {
    platformBaseUrl: PLATFORM_BASE_URL,
    intelligenceWsUrl: INTELLIGENCE_WS_URL,
    dashboardUrl: DASHBOARD_URL
  };
}

// ── Intelligence backend session token ──────────────────────────────────────
// digital-accessibility-intelligence gates its WebSocket on a short-lived JWT
// minted by the Platform's /api/auth/session (reusing the same email +
// integrationCode the user already entered for /chrome/integrate). Cached in
// memory only — re-fetched from the Platform whenever it's near expiry.

let cachedSessionToken = null;
let cachedSessionExpiresAt = 0;

async function getChromeSessionToken({ forceRefresh = false } = {}) {
  if (ENV === 'local') {
    return 'local-mock-token';
  }
  const now = Date.now();
  if (!forceRefresh && cachedSessionToken && now < cachedSessionExpiresAt - 60000) {
    return cachedSessionToken;
  }

  const storage = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin']);
  const email = storage.ternkonnectEmail;
  const integrationCode = storage.ternkonnectCode || storage.ternkonnectPin;
  if (!email || !integrationCode) {
    throw new Error('No TernConnect account linked yet. Open settings and enter your email and integration code.');
  }

  const { platformBaseUrl } = await getBackendUrls();
  const response = await fetch(`${platformBaseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, integrationCode })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || 'Failed to obtain a session token from the platform.');
    err.trialExhausted = !!data.trialExhausted;
    throw err;
  }

  cachedSessionToken = data.token;
  cachedSessionExpiresAt = now + (data.expiresIn || 1800) * 1000;
  return cachedSessionToken;
}

async function trackCheckIn(eventType = 'checkin') {
  if (ENV === 'local') return;
  try {
    const storage = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin', 'chromeProfileId', 'chromeProfileName', 'chromeProfileEmail']);
    const code = storage.ternkonnectCode || storage.ternkonnectPin;
    const profileId = storage.chromeProfileId;
    const profileName = storage.chromeProfileName;
    const chromeEmail = storage.chromeProfileEmail;

    if (code && profileId) {
      const { platformBaseUrl } = await getBackendUrls();
      await fetch(`${platformBaseUrl}/api/platform/chrome/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationCode: code,
          profileId,
          profileName,
          chromeEmail,
          browserVersion: navigator.userAgent,
          eventType
        })
      });
    }
  } catch (err) {
    console.warn('[TernKonnect] Track check-in failed:', err.message);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (ENV === 'local') {
    await chrome.storage.local.set({
      ternkonnectEmail: 'local@dev',
      ternkonnectCode: 'local'
    });
  }
  await ensureOffscreenDocument();
  await ensureProfileId();
  await trackCheckIn('login');

  if (details && details.reason === 'install') {
    if (ENV !== 'local') {
      chrome.tabs.create({ url: 'setup.html' });
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenDocument();
  await ensureProfileId();
  await trackCheckIn('login');
});

// Re-create the offscreen document if the service worker wakes up and it's gone
async function keepAlive() {
  try {
    await ensureOffscreenDocument();
  } catch (_) {}
}

// Builds the config object passed into analyzePageContextScript: resolves the
// platform via adapters/index.js (URL-only, no DOM needed for the three named
// adapters), plus the merged dashboard/search/enroll selectors and the
// generic self-hosted-LMS sniff hints used when no named adapter matches.
function buildPageContextConfig(url) {
  return {
    resolvedPlatformLabel: getPlatformLabel(url),
    hints: generic.pageType.hints,
    dashboard: getSelectors(url, 'dashboard'),
    search: getSelectors(url, 'search'),
    enroll: getSelectors(url, 'enroll'),
    social: linkedin.social
  };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only trigger when the active tab completes loading
  if (changeInfo.status === 'complete' && tab.active) {
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    try {
      await ensureOffscreenDocument();
      const pageContextConfig = buildPageContextConfig(tab.url);
      const analysis = await runInTab(analyzePageContextScript, [pageContextConfig]).catch((err) => {
        console.warn('[TernKonnect] analyzePageContextScript run error:', err);
        return { url: tab.url, title: tab.title, isLMS: false };
      });

      // Send message to offscreen
      chrome.runtime.sendMessage({
        type: 'page_loaded',
        analysis
      }).catch(() => {
        // Offscreen might not be listening yet or WebSocket is not open, ignore
      });
    } catch (err) {
      console.error('[TernKonnect] Page load handler error:', err);
    }
  }
});

// ── Message router ─────────────────────────────────────────────────────────────
// The offscreen doc sends { type: 'execute_tool', name, args, callId }
// We execute and reply { type: 'tool_result', callId, result }

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'execute_tool') {
    keepAlive();
    executeTool(message.name, message.args)
      .then(result => sendResponse({ type: 'tool_result', callId: message.callId, result }))
      .catch(err => sendResponse({ type: 'tool_result', callId: message.callId, result: { error: err.message } }));
    return true; // keep channel open for async response
  }

  if (message.type === 'get_status') {
    sendResponse({ alive: true });
    return true;
  }

  if (message.type === 'reload_config') {
    restartOffscreenDocument()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'get_config') {
    // No anonymous mode anymore — every session (trial or paid) requires a
    // linked email + integrationCode. "Trial" is just the Starter plan's
    // capped limits, enforced server-side by the Platform's /api/auth/session.
    Promise.all([
      chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin', 'chromeProfileId', 'chromeProfileName']),
      chrome.storage.session.get(['wsStatus', 'trialExhausted'])
    ]).then(([storage, session]) => {
      const email = storage.ternkonnectEmail;
      const code = storage.ternkonnectCode || storage.ternkonnectPin;
      const profileId = storage.chromeProfileId;
      const profileName = storage.chromeProfileName;
      const wsStatus = session?.wsStatus || 'disconnected';

      sendResponse({
        email: email || null,
        integrationCode: code || null,
        linked: !!(email && code),
        trialExhausted: !!session?.trialExhausted,
        profileId,
        profileName,
        wsStatus
      });
    }).catch(() => sendResponse({ email: null, integrationCode: null, linked: false, trialExhausted: false, wsStatus: 'disconnected' }));
    return true;
  }

  if (message.type === 'integrate_profile') {
    const { email, integrationCode } = message;
    if (ENV === 'local') {
      chrome.storage.local.set({
        ternkonnectEmail: email,
        ternkonnectCode: integrationCode
      }).then(() => {
        sendResponse({ success: true, message: 'Local mode bypass.' });
      });
      return true;
    }
    ensureProfileId().then(async ({ profileId, profileName, profileEmail }) => {
      try {
        const { platformBaseUrl } = await getBackendUrls();
        const response = await fetch(`${platformBaseUrl}/api/platform/chrome/integrate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            integrationCode,
            profileId,
            profileName,
            chromeEmail: profileEmail,
            browserVersion: navigator.userAgent
          })
        });
        const data = await response.json();
        if (response.ok) {
          await chrome.storage.local.set({
            ternkonnectEmail: email,
            ternkonnectCode: integrationCode
          });
          // Check in immediately after integration
          await trackCheckIn('login');
          sendResponse({ success: true, message: data.message });
        } else {
          sendResponse({ success: false, error: data.error || 'Failed to integrate' });
        }
      } catch (err) {
        sendResponse({ success: false, error: 'Cannot connect to platform' });
      }
    });
    return true;
  }

  if (message.type === 'log_profile_activity') {
    if (ENV === 'local') {
      sendResponse({ success: true });
      return true;
    }
    const { actionType, description, metadata } = message;
    chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin', 'chromeProfileId']).then(async (storage) => {
      const code = storage.ternkonnectCode || storage.ternkonnectPin || 'inactive';
      const profileId = storage.chromeProfileId;
      const { platformBaseUrl } = await getBackendUrls();

      fetch(`${platformBaseUrl}/api/platform/chrome/log-activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationCode: code,
          profileId,
          actionType,
          description,
          metadata
        })
      }).then(r => r.json())
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
    }).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'get_chrome_session_token') {
    getChromeSessionToken({ forceRefresh: !!message.forceRefresh })
      .then(token => sendResponse({ token }))
      .catch(err => sendResponse({ error: err.message, trialExhausted: !!err.trialExhausted }));
    return true;
  }

  if (message.type === 'get_backend_urls') {
    getBackendUrls().then(sendResponse).catch(() => sendResponse({
      platformBaseUrl: PLATFORM_BASE_URL,
      intelligenceWsUrl: INTELLIGENCE_WS_URL,
      dashboardUrl: DASHBOARD_URL
    }));
    return true;
  }

  if (message.type === 'get_session_state') {
    chrome.storage.session.get('hasWelcomed').then(res => sendResponse({ hasWelcomed: !!res.hasWelcomed })).catch(() => sendResponse({ hasWelcomed: false }));
    return true;
  }

  if (message.type === 'set_session_state') {
    chrome.storage.session.set(message.state).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
});

// ── Tool implementations ───────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'navigate_to_url':      return navigateToUrl(args.url);
    case 'click_element':        return clickElement(args.element_text, args.element_type || 'any');
    case 'fill_form_field':      return fillFormField(args.field_identifier, args.value);
    case 'clear_field':          return clearField(args.field_identifier);
    case 'read_page_content':    return readPageContent(args.section || 'main');
    case 'get_page_elements':    return getPageElements();
    case 'scroll_page':          return scrollPage(args.direction, args.amount || 500);
    case 'submit_form':          return submitForm();
    case 'go_back':              return goBack();
    case 'go_forward':           return goForward();
    case 'get_current_page_info': return getCurrentPageInfo();
    case 'open_new_tab':         return openNewTab(args.url);
    case 'press_key':            return pressKey(args.key);
    // ── LMS & Computer-Vision tools ──
    case 'take_screenshot':      return takeScreenshot();
    case 'control_video':        return controlVideo(args.action, args.value);
    case 'get_video_transcript': return getVideoTranscript();
    case 'get_lms_outline':      return getLmsOutline();
    case 'click_lms_item':       return clickLmsItem(args.index);
    case 'get_quiz_details':     return getQuizDetails();
    case 'answer_quiz':          return answerQuiz(args.question_index, args.option_index);
    case 'get_quiz_timer':       return getQuizTimer();
    case 'submit_quiz':          return submitQuiz();
    // ── v3 additions ──
    case 'get_orientation':      return getOrientation();
    case 'dismiss_overlay':      return dismissOverlay();
    case 'keyboard_navigate':    return keyboardNavigate(args.keys || []);
    case 'select_option':        return selectOption(args.field_identifier, args.value);
    case 'type_rich_text':       return typeRichText(args.text, args.format || 'plain');
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runInTab(fn, args = []) {
  const tab = await getActiveTab();
  if (!tab) throw new Error('No active tab found');

  // chrome:// pages can't be scripted
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    throw new Error('Cannot interact with browser internal pages');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fn,
    args
  });
  return results[0].result;
}

async function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 12000); // max 12s wait
  });
}

// ── Navigation ─────────────────────────────────────────────────────────────────

async function navigateToUrl(url) {
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url;
  const tab = await getActiveTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
  const updatedTab = await chrome.tabs.get(tab.id);
  return { success: true, url: updatedTab.url, title: updatedTab.title };
}

async function openNewTab(url) {
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url;
  const tab = await chrome.tabs.create({ url });
  await waitForTabLoad(tab.id);
  return { success: true, url, tabId: tab.id };
}

async function goBack() {
  const tab = await getActiveTab();
  await chrome.tabs.goBack(tab.id);
  return { success: true };
}

async function goForward() {
  const tab = await getActiveTab();
  await chrome.tabs.goForward(tab.id);
  return { success: true };
}

// ── DOM: Click ─────────────────────────────────────────────────────────────────

async function clickElement(elementText, elementType) {
  return runInTab(async (text, type) => {
    const lower = text.toLowerCase().trim();

    const selectors = {
      button: 'button, input[type="button"], input[type="submit"], [role="button"]',
      link:   'a[href], [role="link"]',
      any:    'button, input[type="button"], input[type="submit"], [role="button"], a[href], [role="link"], [tabindex="0"]'
    };

    // Pierces shadow roots — custom-element-heavy LMS widgets (e.g. some
    // Coursera/Udemy components) render real interactive elements inside one.
    function deepQueryAll(root, selector) {
      const found = Array.from(root.querySelectorAll(selector));
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) found.push(...deepQueryAll(el.shadowRoot, selector));
      }
      return found;
    }

    function findCandidates() {
      const candidates = deepQueryAll(document, selectors[type] || selectors.any);
      if (type !== 'any') {
        candidates.push(...deepQueryAll(document, selectors.any));
      }
      const extraCandidates = deepQueryAll(document, 'div, span, li, img, summary, article, section').filter(el => {
        if (el.hasAttribute('onclick')) return true;
        try {
          return window.getComputedStyle(el).cursor === 'pointer';
        } catch(e) { return false; }
      });
      candidates.push(...extraCandidates);
      return Array.from(new Set(candidates));
    }

    function score(el) {
      const txt = (
        el.textContent + ' ' +
        (el.value || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' +
        (el.title || '') + ' ' +
        (el.getAttribute('placeholder') || '')
      ).toLowerCase().trim();
      
      if (txt === lower) return 5;
      if (txt.startsWith(lower)) return 4;
      if (txt.includes(lower)) return 3;
      
      const ignore = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'course', 'video', 'button', 'link', 'click', 'open', 'play']);
      const words = lower.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !ignore.has(w));
      
      if (words.length > 0) {
        const matched = words.filter(w => txt.includes(w));
        if (matched.length === words.length) return 2;
        if (matched.length > 0) return matched.length / words.length; // 0.1 to 0.9
      }
      return 0;
    }

    // Short retry loop: elements that render asynchronously after a click or
    // navigation (React/Vue re-renders, lazy-loaded widgets) often aren't in
    // the DOM yet on the first pass.
    let sorted = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      sorted = findCandidates()
        .map(el => ({ el, s: score(el) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s);
      if (sorted.length > 0) break;
      await new Promise((r) => setTimeout(r, 350));
    }

    if (sorted.length === 0) {
      return { success: false, message: `No element found matching: "${text}"` };
    }

    const target = sorted[0].el;
    target.focus();
    
    // Simulate real mouse events for SPAs that listen to mousedown/mouseup instead of click
    ['mousedown', 'mouseup', 'click'].forEach(evt => {
      target.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
    });
    try { target.click(); } catch(e) {}
    return {
      success: true,
      clicked: (target.textContent || target.value || target.getAttribute('aria-label') || '').trim()
    };
  }, [elementText, elementType]);
}

// ── DOM: Form filling ──────────────────────────────────────────────────────────

async function fillFormField(fieldIdentifier, value) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, message: 'No active tab' };
  const postConfig = getSelectors(tab.url, 'post') || {};

  return runInTab(async (identifier, val, pConfig) => {
    const lower = identifier.toLowerCase().trim();
    const isPostTarget = lower.includes('post') || lower.includes('content') || lower.includes('draft');

    function labelOf(el) {
      const byId = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      if (byId) return byId.textContent;
      const wrap = el.closest('label');
      if (wrap) return wrap.textContent;
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') return prev.textContent;
      const aria = el.getAttribute('aria-labelledby');
      if (aria) {
        const el2 = document.getElementById(aria);
        if (el2) return el2.textContent;
      }
      return '';
    }

    function deepQueryAll(root, selector) {
      const found = Array.from(root.querySelectorAll(selector));
      const allEls = root.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) found.push(...deepQueryAll(el.shadowRoot, selector));
      }
      return found;
    }

    function score(el) {
      let s = 0;
      const combined = [
        labelOf(el),
        el.placeholder || '',
        el.name || '',
        el.id || '',
        el.getAttribute('aria-label') || '',
        el.type || ''
      ].join(' ').toLowerCase();

      if (combined === lower) s = 4;
      else if (combined.startsWith(lower)) s = 3;
      else if (combined.includes(lower)) s = 2;
      
      if (lower === 'password' && el.type === 'password') s = Math.max(s, 4);
      if (lower === 'email' && el.type === 'email') s = Math.max(s, 3);

      if (isPostTarget && pConfig.editorSelectors) {
        for (const sel of pConfig.editorSelectors) {
          if (el.matches(sel)) {
            s = Math.max(s, 5); // Highest priority for explicitly matched platform editors
            break;
          }
        }
      }

      return s;
    }

    let ranked = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const inputs = deepQueryAll(
        document,
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"]'
      );
      // Explicitly add elements that match editor selectors if they aren't caught
      if (isPostTarget && pConfig.editorSelectors) {
         for (const sel of pConfig.editorSelectors) {
            inputs.push(...deepQueryAll(document, sel));
         }
      }
      
      // Deduplicate
      const uniqueInputs = Array.from(new Set(inputs));

      ranked = uniqueInputs
        .map(el => ({ el, s: score(el) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s);
      if (ranked.length > 0) break;
      await new Promise((r) => setTimeout(r, 350));
    }

    if (ranked.length === 0) {
      return { success: false, message: `Field not found: "${identifier}"` };
    }

    const target = ranked[0].el;
    target.focus();

    // React-compatible value setting
    const proto = target.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
      
    if (target.getAttribute('contenteditable') === 'true' || target.contentEditable === 'true') {
      // For rich text editors (like Quill on LinkedIn), innerText breaks internal state.
      // Use document.execCommand to simulate real typing.
      if (val === '') {
        target.innerHTML = '';
      } else {
        target.innerHTML = '';
        document.execCommand('insertText', false, val);
        if (target.innerText.trim() !== val.trim() && target.innerHTML === '') {
           target.innerText = val; // fallback
        }
      }
      target.dispatchEvent(new Event('input',  { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, field: identifier };
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(target, val);
    } else {
      target.value = val;
    }

    target.dispatchEvent(new Event('input',  { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));

    return { success: true, field: identifier };
  }, [fieldIdentifier, value, postConfig]);
}

async function clearField(fieldIdentifier) {
  return fillFormField(fieldIdentifier, '');
}

// ── DOM: Reading ───────────────────────────────────────────────────────────────

async function readPageContent(section) {
  return runInTab(sec => {
    const clean = txt => txt.replace(/\s+/g, ' ').trim();

    if (sec === 'headings') {
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
        .map(h => clean(h.textContent))
        .filter(t => t.length > 0);
      return { title: document.title, content: headings.join('. ') };
    }

    const root = document.querySelector('main, [role="main"], article') || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (['script', 'style', 'noscript', 'nav', 'footer', 'header'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        return clean(node.textContent).length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      }
    });

    const chunks = [];
    let node;
    while ((node = walker.nextNode()) && chunks.join(' ').length < 3000) {
      const t = clean(node.textContent);
      if (t) chunks.push(t);
    }

    return { title: document.title, url: location.href, content: chunks.join(' ') };
  }, [section]);
}

async function getCurrentPageInfo() {
  const tab = await getActiveTab();
  const headings = await readPageContent('headings').catch(() => ({ content: '' }));
  return { url: tab.url, title: tab.title, headings: headings.content };
}

// ── DOM: Elements inventory ────────────────────────────────────────────────────

async function getPageElements() {
  return runInTab(() => {
    const uniq = arr => [...new Set(arr.filter(Boolean))];
    const txt  = el => (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();

    return {
      buttons: uniq(
        Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]'))
          .map(txt)
      ).slice(0, 15),
      links: uniq(
        Array.from(document.querySelectorAll('a[href]'))
          .map(txt)
          .filter(t => t.length < 80)
      ).slice(0, 20),
      inputs: uniq(
        Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea,select'))
          .map(el => el.getAttribute('aria-label') || el.placeholder || el.name || el.id || el.type)
      ).slice(0, 10),
      headings: uniq(
        Array.from(document.querySelectorAll('h1,h2,h3')).map(txt)
      ).slice(0, 6)
    };
  });
}

// ── DOM: Scroll ────────────────────────────────────────────────────────────────

async function scrollPage(direction, amount) {
  return runInTab((dir, amt) => {
    const map = {
      down:   () => window.scrollBy(0,  amt),
      up:     () => window.scrollBy(0, -amt),
      top:    () => window.scrollTo(0, 0),
      bottom: () => window.scrollTo(0, document.body.scrollHeight)
    };
    (map[dir] || map.down)();
    return { success: true };
  }, [direction, amount]);
}

// ── DOM: Form submit ───────────────────────────────────────────────────────────

async function submitForm() {
  return runInTab(() => {
    const btn = document.querySelector(
      'form button[type="submit"], form input[type="submit"], form button:not([type])'
    );
    if (btn) { btn.click(); return { success: true, via: 'submit button' }; }
    const form = document.querySelector('form');
    if (form) { form.submit(); return { success: true, via: 'form.submit()' }; }
    return { success: false, message: 'No form found on page' };
  });
}

// ── DOM: Keyboard ──────────────────────────────────────────────────────────────

async function pressKey(key) {
  return runInTab(k => {
    const active = document.activeElement || document.body;
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      active.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
    });
    return { success: true, key: k };
  }, [key]);
}

// ══════════════════════════════════════════════════════════════════════════════
//  LMS & COMPUTER-VISION TOOLS
// ══════════════════════════════════════════════════════════════════════════════

// ── Screenshot ─────────────────────────────────────────────────────────────────

async function takeScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'jpeg',
      quality: 70
    });
    // Strip the data:image/jpeg;base64, prefix to get raw base64
    const base64 = dataUrl.split(',')[1];
    return { success: true, imageBase64: base64, mimeType: 'image/jpeg' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Video control ──────────────────────────────────────────────────────────────
// Runs in all frames (not just the top one) to reach videos inside iframes.

async function controlVideo(action, value) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, message: 'No active tab' };

  const config = getSelectors(tab.url, 'video');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: controlVideoScript,
    args: [action, value, config]
  });

  let firstError = null;
  let videoRect = null;
  
  for (const res of results) {
    if (res.result && res.result.success) {
        // If the script explicitly says it succeeded via HTML5 API, great.
        // But if it just tried a DOM click, we might want to still do CDP.
        // For now, let's assume if it returns success, we accept it.
        // We will modify video.js to return {success: false, rect: ...} for DOM clicks
        // so we can fallback to CDP.
        if (res.result.action) {
            return res.result;
        }
    }
    if (res.result && res.result.rect) {
        videoRect = res.result.rect; // Capture coordinates for CDP
    }
    if (res.result && !res.result.success && !firstError) firstError = res.result;
  }

  // If HTML5 API didn't work (or we specifically need to dispatch a trusted click/key)
  // we fallback to chrome.debugger.
  if (videoRect || action === 'play' || action === 'pause' || action === 'toggle' || action === 'forward' || action === 'rewind') {
      try {
          const target = { tabId: tab.id };
          await chrome.debugger.attach(target, "1.3");
          
          try {
              let executed = false;
              let resReason = null;
              
              // We need the reason from the result that matched
              for (const r of results) {
                  if (r.result && r.result.rect) resReason = r.result.reason;
              }

              if (videoRect) {
                  // Always click the exact absolute coordinates returned by video.js
                  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
                      type: "mousePressed", x: videoRect.x, y: videoRect.y, button: "left", clickCount: 1
                  });
                  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
                      type: "mouseReleased", x: videoRect.x, y: videoRect.y, button: "left", clickCount: 1
                  });
                  executed = true;
              }

              if (resReason === 'require_trusted_key') {
                  let key = "";
                  if (action === 'forward') key = "ArrowRight";
                  if (action === 'rewind') key = "ArrowLeft";

                  if (key) {
                      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
                          type: "keyDown", key: key, text: "", windowsVirtualKeyCode: (key === "ArrowRight" ? 39 : (key === "ArrowLeft" ? 37 : 77))
                      });
                      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
                          type: "keyUp", key: key
                      });
                      executed = true;
                  }
              }

              if (executed) {
                  return { success: true, action: action, note: "Executed via debugger trusted event" };
              }
          } finally {
              // Always detach immediately (Transient Attach)
              await chrome.debugger.detach(target);
          }
      } catch (err) {
          console.warn("[TernKonnect] Debugger fallback failed:", err);
          return { success: false, message: `Video control failed: ${err.message}` };
      }
  }

  return firstError || { success: false, message: 'No video element found on this page or inside iframes.' };
}

// ── LMS: Video Transcript ──────────────────────────────────────────────────────

async function getVideoTranscript() {
  const tab = await getActiveTab();
  const config = getSelectors(tab.url, 'transcript');
  return runInTab(extractTranscript, [config]);
}

// ── LMS: Course outline / syllabus ─────────────────────────────────────────────

async function getLmsOutline() {
  const tab = await getActiveTab();
  const config = getSelectors(tab.url, 'outline');
  return runInTab(extractOutline, [config]);
}

// ── LMS: Click a specific outline item by index ────────────────────────────────

async function clickLmsItem(index) {
  // First get the outline, then navigate to that item's URL
  const outline = await getLmsOutline();
  if (!outline.success || outline.itemCount === 0) {
    return { success: false, message: 'No course outline items found on this page.' };
  }
  if (index < 0 || index >= outline.items.length) {
    return { success: false, message: `Invalid index ${index}. Valid range: 0–${outline.items.length - 1}` };
  }
  const item = outline.items[index];
  if (item.url) {
    const tab = await getActiveTab();
    await chrome.tabs.update(tab.id, { url: item.url });
    await waitForTabLoad(tab.id);
    return { success: true, navigatedTo: item.title, url: item.url };
  }
  // If no URL, try clicking the element directly
  return clickElement(item.title, 'link');
}

// ── LMS: Quiz extraction ──────────────────────────────────────────────────────

async function getQuizDetails() {
  const tab = await getActiveTab();
  const config = getSelectors(tab.url, 'quiz');
  return runInTab(quizPageScript, [config, 'extract']);
}

// ── LMS: Answer a quiz question ────────────────────────────────────────────────

async function answerQuiz(questionIndex, optionIndex) {
  const tab = await getActiveTab();
  const config = getSelectors(tab.url, 'quiz');
  return runInTab(quizPageScript, [config, 'select', questionIndex, optionIndex]);
}

async function getQuizTimer() {
  const tab = await getActiveTab();
  const config = getSelectors(tab.url, 'quiz');
  return runInTab(quizPageScript, [config, 'timer']);
}

async function submitQuiz() {
  const tab = await getActiveTab();
  const config = getSelectors(tab.url, 'quiz');
  return runInTab(quizPageScript, [config, 'submit']);
}

// ══════════════════════════════════════════════════════════════════════════════
//  V3 ADDITIONS: orientation, overlays, keyboard fallback, dropdowns, rich text
// ══════════════════════════════════════════════════════════════════════════════

// ── Orientation: combines page info + LMS outline into one spoken-ready summary ──

async function getOrientation() {
  const tab = await getActiveTab();
  if (!tab) return { success: false, message: 'No active tab' };

  const pageInfo = await getCurrentPageInfo().catch(() => null);
  const outline = await getLmsOutline().catch(() => null);

  const nextItems = (outline?.success && outline.itemCount > 0)
    ? outline.items.filter(i => !i.completed).slice(0, 3).map(i => i.title)
    : [];

  return {
    success: true,
    url: pageInfo?.url,
    title: pageInfo?.title,
    headings: pageInfo?.headings,
    courseItemCount: outline?.itemCount || 0,
    suggestedNextItems: nextItems
  };
}

// ── Overlay dismissal: cookie banners, modals, popups ──────────────────────────

async function dismissOverlay() {
  return runInTab(() => {
    const clickIfFound = (selector) => {
      const el = document.querySelector(selector);
      if (el) { el.click(); return el; }
      return null;
    };

    let target =
      clickIfFound('[aria-label*="close" i]') ||
      clickIfFound('[aria-label*="dismiss" i]') ||
      clickIfFound('.modal-close, .banner-close, .cookie-close');

    if (!target) {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const textMatch = candidates.find((el) =>
        /^(accept|reject all|close|got it|no thanks|dismiss|i agree)$/i.test((el.textContent || '').trim())
      );
      if (textMatch) { textMatch.click(); target = textMatch; }
    }

    if (!target) {
      const dialog = document.querySelector('[role="dialog"], .modal, [class*="overlay" i]');
      const xButton = dialog?.querySelector('button, [role="button"]');
      if (xButton && /×|close|x/i.test((xButton.textContent || xButton.getAttribute('aria-label') || '').trim())) {
        xButton.click();
        target = xButton;
      }
    }

    if (!target) {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { success: true, via: 'Escape key (best effort — no explicit close control found)' };
    }

    return { success: true, via: 'matched close/accept/dismiss control' };
  });
}

// ── Keyboard fallback: sequential key presses for cross-origin iframes, custom widgets ──

async function keyboardNavigate(keys) {
  return runInTab((keySequence) => {
    function parseKey(raw) {
      const parts = raw.split('+');
      const key = parts.pop();
      return {
        key,
        shiftKey: parts.includes('Shift'),
        ctrlKey: parts.includes('Ctrl') || parts.includes('Control'),
        altKey: parts.includes('Alt'),
        metaKey: parts.includes('Meta')
      };
    }

    for (const raw of keySequence) {
      const opts = { ...parseKey(raw), bubbles: true, cancelable: true };
      const active = document.activeElement || document.body;
      active.dispatchEvent(new KeyboardEvent('keydown', opts));
      active.dispatchEvent(new KeyboardEvent('keypress', opts));
      // Character keys also need a real input event for controlled React/Vue fields.
      if (opts.key.length === 1 && active && 'value' in active) {
        active.value = (active.value || '') + opts.key;
        active.dispatchEvent(new Event('input', { bubbles: true }));
      }
      active.dispatchEvent(new KeyboardEvent('keyup', opts));
    }

    return { success: true, keysPressed: keySequence.length };
  }, [keys]);
}

// ── Dropdown / <select> ─────────────────────────────────────────────────────────

async function selectOption(fieldIdentifier, value) {
  return runInTab((identifier, val) => {
    const lower = (identifier || '').toLowerCase().trim();

    function labelOf(el) {
      const byId = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      if (byId) return byId.textContent;
      const aria = el.getAttribute('aria-label');
      return aria || '';
    }

    const selects = Array.from(document.querySelectorAll('select'));
    function score(el) {
      const combined = [labelOf(el), el.name || '', el.id || ''].join(' ').toLowerCase();
      if (combined === lower) return 3;
      if (combined.includes(lower)) return 2;
      return lower ? 0 : 1;
    }

    const ranked = selects.map(el => ({ el, s: score(el) })).filter(({ s }) => s > 0).sort((a, b) => b.s - a.s);
    if (ranked.length === 0) {
      return { success: false, message: `Dropdown not found: "${identifier}"` };
    }

    const target = ranked[0].el;
    const options = Array.from(target.options);
    const match = options.find(o => o.value === val) ||
      options.find(o => o.textContent.trim().toLowerCase() === val.toLowerCase()) ||
      options.find(o => o.textContent.trim().toLowerCase().includes(val.toLowerCase()));

    if (!match) {
      return { success: false, message: `Option "${val}" not found in dropdown "${identifier}"` };
    }

    target.value = match.value;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, selected: match.textContent.trim() };
  }, [fieldIdentifier, value]);
}

// ── Rich text editors: TinyMCE, CKEditor, Quill, contenteditable ────────────────

async function typeRichText(text, format) {
  return runInTab((val, fmt) => {
    const editor = document.querySelector(
      '[contenteditable="true"], .ql-editor, .mce-content-body, .cke_editable'
    );
    if (!editor) {
      return { success: false, message: 'No rich text editor found on this page.' };
    }

    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, val);

    if (fmt && fmt !== 'plain') {
      const formatCommand = { bold: 'bold', italic: 'italic', heading: 'formatBlock' }[fmt];
      if (formatCommand) {
        document.execCommand('selectAll', false, null);
        document.execCommand(formatCommand, false, formatCommand === 'formatBlock' ? 'H2' : null);
      }
    }

    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return { success: true };
  }, [text, format]);
}
