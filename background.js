// background.js - Service Worker
// Responsible for: creating the offscreen document, and executing all
// browser tool calls that Gemini requests (navigation, clicking, forms, etc.)

// offscreen.js imports config.js directly — no key passing needed here

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

chrome.runtime.onInstalled.addListener(async () => {
  await ensureOffscreenDocument();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenDocument();
});

// Re-create the offscreen document if the service worker wakes up and it's gone
async function keepAlive() {
  try {
    await ensureOffscreenDocument();
  } catch (_) {}
}

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
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select')
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
        return clean(node.textContent).length > 5
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
