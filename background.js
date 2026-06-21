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

async function trackCheckIn(eventType = 'checkin') {
  try {
    const storage = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin', 'chromeProfileId', 'chromeProfileName', 'chromeProfileEmail']);
    const code = storage.ternkonnectCode || storage.ternkonnectPin;
    const profileId = storage.chromeProfileId;
    const profileName = storage.chromeProfileName;
    const chromeEmail = storage.chromeProfileEmail;

    if (code && profileId) {
      await fetch('http://localhost:9001/api/platform/chrome/track', {
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
  await ensureOffscreenDocument();
  await ensureProfileId();
  await trackCheckIn('login');

  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: 'setup.html' });
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
    Promise.all([
      chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin', 'chromeProfileId', 'chromeProfileName']),
      chrome.storage.session.get('wsStatus'),
      checkOrStartTrial()
    ]).then(([storage, session, trialInfo]) => {
      const email = storage.ternkonnectEmail;
      const code = storage.ternkonnectCode || storage.ternkonnectPin;
      const profileId = storage.chromeProfileId;
      const profileName = storage.chromeProfileName;
      const wsStatus = session?.wsStatus || 'disconnected';

      if (email && code) {
        sendResponse({
          email,
          integrationCode: code,
          trial: false,
          profileId,
          profileName,
          wsStatus
        });
      } else {
        sendResponse({
          email: trialInfo.trialExpired ? null : `trial-${profileId}`,
          integrationCode: trialInfo.trialExpired ? null : 'TRIAL',
          trial: !trialInfo.trialExpired,
          trialExpired: trialInfo.trialExpired,
          trialsCount: trialInfo.trialsCount,
          trialActive: trialInfo.trialActive,
          trialStartTimestamp: trialInfo.trialStartTimestamp,
          remainingTime: trialInfo.trialActive ? Math.max(0, 5 * 60 * 1000 - (Date.now() - trialInfo.trialStartTimestamp)) : 0,
          profileId,
          profileName,
          wsStatus
        });
      }
    }).catch(() => sendResponse({ email: null, integrationCode: null, wsStatus: 'disconnected' }));
    return true;
  }

  if (message.type === 'integrate_profile') {
    const { email, integrationCode } = message;
    ensureProfileId().then(async ({ profileId, profileName, profileEmail }) => {
      try {
        const response = await fetch('http://localhost:9001/api/platform/chrome/integrate', {
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
    const { actionType, description, metadata } = message;
    chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin', 'chromeProfileId', 'trialActive']).then((storage) => {
      const code = storage.ternkonnectCode || storage.ternkonnectPin || (storage.trialActive ? 'TRIAL' : 'inactive');
      const profileId = storage.chromeProfileId;

      fetch('http://localhost:9001/api/platform/chrome/log-activity', {
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

  if (message.type === 'get_session_state') {
    chrome.storage.session.get('hasWelcomed').then(res => sendResponse({ hasWelcomed: !!res.hasWelcomed })).catch(() => sendResponse({ hasWelcomed: false }));
    return true;
  }

  if (message.type === 'set_session_state') {
    chrome.storage.session.set(message.state).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
});

async function checkOrStartTrial() {
  const data = await chrome.storage.local.get(['trialsCount', 'trialActive', 'trialStartTimestamp']);
  let trialsCount = data.trialsCount || 0;
  let trialActive = data.trialActive || false;
  let trialStartTimestamp = data.trialStartTimestamp || 0;

  const now = Date.now();
  const trialDuration = 5 * 60 * 1000; // 5 minutes

  if (trialActive) {
    const elapsed = now - trialStartTimestamp;
    if (elapsed >= trialDuration) {
      trialActive = false;
      await chrome.storage.local.set({ trialActive });
    }
  }

  // If not active, can we start a new one?
  if (!trialActive && trialsCount < 3) {
    trialsCount += 1;
    trialActive = true;
    trialStartTimestamp = now;
    await chrome.storage.local.set({ trialsCount, trialActive, trialStartTimestamp });
  }

  return {
    trialsCount,
    trialActive,
    trialStartTimestamp,
    trialExpired: trialsCount >= 3 && !trialActive
  };
}

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
  return runInTab((text, type) => {
    const lower = text.toLowerCase().trim();

    const selectors = {
      button: 'button, input[type="button"], input[type="submit"], [role="button"]',
      link:   'a[href], [role="link"]',
      any:    'button, input[type="button"], input[type="submit"], [role="button"], a[href], [role="link"], [tabindex="0"]'
    };

    const candidates = Array.from(document.querySelectorAll(selectors[type] || selectors.any));

    if (type === 'any') {
      const extraCandidates = Array.from(document.querySelectorAll('div, span, li, img, summary')).filter(el => {
        if (el.hasAttribute('onclick')) return true;
        const style = window.getComputedStyle(el);
        return style.cursor === 'pointer';
      });
      candidates.push(...extraCandidates);
    }

    function score(el) {
      const txt = (
        el.textContent + ' ' +
        (el.value || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' +
        (el.title || '') + ' ' +
        (el.getAttribute('placeholder') || '')
      ).toLowerCase().trim();
      if (txt === lower) return 3;
      if (txt.startsWith(lower)) return 2;
      if (txt.includes(lower)) return 1;
      return 0;
    }

    const sorted = candidates
      .map(el => ({ el, s: score(el) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s);

    if (sorted.length === 0) {
      return { success: false, message: `No element found matching: "${text}"` };
    }

    const target = sorted[0].el;
    target.focus();
    target.click();
    return {
      success: true,
      clicked: (target.textContent || target.value || target.getAttribute('aria-label') || '').trim()
    };
  }, [elementText, elementType]);
}

// ── DOM: Form filling ──────────────────────────────────────────────────────────

async function fillFormField(fieldIdentifier, value) {
  return runInTab((identifier, val) => {
    const lower = identifier.toLowerCase().trim();

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

    const inputs = Array.from(
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"]')
    );

    function score(el) {
      const combined = [
        labelOf(el),
        el.placeholder || '',
        el.name || '',
        el.id || '',
        el.getAttribute('aria-label') || '',
        el.type || ''
      ].join(' ').toLowerCase();

      if (combined === lower) return 4;
      if (combined.startsWith(lower)) return 3;
      if (combined.includes(lower)) return 2;
      // special: "password" matches type="password"
      if (lower === 'password' && el.type === 'password') return 4;
      if (lower === 'email' && el.type === 'email') return 3;
      return 0;
    }

    const ranked = inputs
      .map(el => ({ el, s: score(el) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s);

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
      target.innerText = val;
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
  }, [fieldIdentifier, value]);
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

  // Find the first frame that successfully found a video (or clicked a button)
  for (const res of results) {
    if (res.result) return res.result;
  }

  return { success: false, message: 'No video element found on this page or inside iframes.' };
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
