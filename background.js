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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only trigger when the active tab completes loading
  if (changeInfo.status === 'complete' && tab.active) {
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }
    
    try {
      await ensureOffscreenDocument();
      const analysis = await runInTab(analyzePageContext).catch((err) => {
        console.warn('[TernKonnect] analyzePageContext run error:', err);
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

  if (message.type === 'get_config') {
    chrome.storage.local.get('geminiApiKey').then(res => sendResponse({ apiKey: res.geminiApiKey })).catch(() => sendResponse({ apiKey: null }));
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

async function controlVideo(action, value) {
  return runInTab((act, val) => {
    const video = document.querySelector('video');
    if (!video) return { success: false, message: 'No video element found on this page.' };

    switch (act) {
      case 'play':
        video.play();
        return { success: true, action: 'play' };
      case 'pause':
        video.pause();
        return { success: true, action: 'pause' };
      case 'toggle':
        if (video.paused) { video.play(); return { success: true, action: 'resumed' }; }
        else { video.pause(); return { success: true, action: 'paused' }; }
      case 'forward':
        video.currentTime = Math.min(video.duration, video.currentTime + (val || 10));
        return { success: true, action: 'forward', seconds: val || 10 };
      case 'rewind':
        video.currentTime = Math.max(0, video.currentTime - (val || 10));
        return { success: true, action: 'rewind', seconds: val || 10 };
      case 'speed':
        video.playbackRate = val || 1;
        return { success: true, action: 'speed', rate: val || 1 };
      case 'mute':
        video.muted = !video.muted;
        return { success: true, action: video.muted ? 'muted' : 'unmuted' };
      case 'status': {
        const mins = Math.floor(video.currentTime / 60);
        const secs = Math.floor(video.currentTime % 60);
        const durMins = Math.floor(video.duration / 60);
        const durSecs = Math.floor(video.duration % 60);
        return {
          success: true,
          paused: video.paused,
          currentTime: `${mins}:${secs.toString().padStart(2, '0')}`,
          duration: `${durMins}:${durSecs.toString().padStart(2, '0')}`,
          playbackRate: video.playbackRate,
          muted: video.muted,
          volume: Math.round(video.volume * 100) + '%'
        };
      }
      default:
        return { success: false, message: `Unknown video action: ${act}` };
    }
  }, [action, value]);
}

// ── LMS: Course outline / syllabus ─────────────────────────────────────────────

async function getLmsOutline() {
  return runInTab(() => {
    const items = [];

    // ── Coursera-style selectors ──
    // Coursera uses various list/link structures; try several patterns
    const courseraSelectors = [
      // Week/module items
      '.rc-WeekItemName a',
      '.rc-ItemName a',
      '[data-track-component="syllabus_item"] a',
      // Sidebar navigation
      '.rc-SidebarItem a',
      'nav a[data-track-component]',
      // General lesson links
      '.lesson-name a',
      '.item-name a',
      // New Coursera UI
      '[class*="ItemName"] a',
      '[class*="syllabus"] a'
    ];

    // ── Generic LMS selectors (edX, Moodle, Canvas, Udemy, etc.) ──
    const genericSelectors = [
      // edX / Open edX
      '.outline-item a',
      '.sequence-list-wrapper a',
      '.chapter a',
      // Moodle
      '.activity-item a',
      '.section .activity a',
      '.course-content a.aalink',
      // Canvas
      '.context_module_item a.title',
      '#context_modules .ig-title a',
      // Udemy
      '[data-purpose="curriculum-item-title"]',
      // Generic patterns
      'nav[aria-label*="course"] a',
      'aside a[href*="lesson"]',
      'aside a[href*="module"]',
      '.sidebar a[href]'
    ];

    const allSelectors = [...courseraSelectors, ...genericSelectors];
    const seen = new Set();

    for (const sel of allSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 200 || seen.has(text)) continue;
          seen.add(text);

          const isComplete =
            el.closest('[class*="completed"]') !== null ||
            el.closest('[class*="done"]') !== null ||
            el.querySelector('[class*="check"], [class*="complete"]') !== null;

          items.push({
            index: items.length,
            title: text,
            url: el.href || null,
            completed: isComplete
          });
        }
      } catch (_) { /* selector not present */ }
    }

    // Fallback: if no items found, try to find any sidebar or nav links
    if (items.length === 0) {
      const fallbackEls = document.querySelectorAll('aside a[href], nav a[href], [role="navigation"] a[href]');
      for (const el of fallbackEls) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 200 || text.length < 3 || seen.has(text)) continue;
        seen.add(text);
        items.push({
          index: items.length,
          title: text,
          url: el.href || null,
          completed: false
        });
      }
    }

    return {
      success: true,
      pageTitle: document.title,
      itemCount: items.length,
      items: items.slice(0, 40) // cap at 40 to avoid huge payloads
    };
  });
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
  return runInTab(() => {
    function getQuizContainers() {
      const selectors = [
        '.rc-FormPartsQuestion',
        '[data-testid*="question"]',
        '[class*="QuestionBody"]',
        '.quiz-question',
        '.question',
        'fieldset',
        '[role="group"][aria-labelledby]',
        '.wrapper-problem-response',
        '.que',
        '.question_holder'
      ];
      return Array.from(document.querySelectorAll(selectors.join(', '))).filter(c => {
        let els = c.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
        if (els.length === 0) {
          els = c.querySelectorAll('.rc-Option, [class*="Option"], .answer, .option');
        }
        return els.length > 0;
      });
    }

    function getQuestionOptions(c) {
      let els = c.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
      if (els.length === 0) {
        els = c.querySelectorAll('.rc-Option, [class*="Option"], .answer, .option');
      }
      return Array.from(els);
    }

    const questions = [];
    const containers = getQuizContainers();

    let idx = 0;
    for (const container of containers) {
      // Extract question text
      const qTextEl = container.querySelector(
        'legend, .question-text, [class*="prompt"], ' +
        '[class*="QuestionText"], h3, h4, p:first-of-type, ' +
        '.qtext, .question_text'
      );
      const qText = qTextEl
        ? qTextEl.textContent.replace(/\s+/g, ' ').trim()
        : container.textContent.replace(/\s+/g, ' ').trim().slice(0, 300);

      if (!qText || qText.length < 5) continue;

      // Extract options
      const optionEls = getQuestionOptions(container);

      const options = [];
      let optIdx = 0;
      for (const opt of optionEls) {
        const label = opt.closest('label')?.textContent?.replace(/\s+/g, ' ').trim()
          || opt.getAttribute('aria-label')
          || (opt.id ? document.querySelector(`label[for="${opt.id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() : null)
          || opt.textContent?.replace(/\s+/g, ' ').trim()
          || `Option ${optIdx + 1}`;

        const isSelected =
          opt.checked ||
          opt.getAttribute('aria-checked') === 'true' ||
          opt.classList.contains('selected') ||
          (opt.tagName !== 'INPUT' && opt.querySelector('input')?.checked);

        options.push({
          index: optIdx,
          label: label.slice(0, 300),
          selected: !!isSelected
        });
        optIdx++;
      }

      questions.push({
        index: idx,
        question: qText.slice(0, 500),
        options,
        optionCount: options.length
      });
      idx++;
    }

    return {
      success: true,
      pageTitle: document.title,
      questionCount: questions.length,
      questions: questions.slice(0, 20)
    };
  });
}

// ── LMS: Answer a quiz question ────────────────────────────────────────────────

async function answerQuiz(questionIndex, optionIndex) {
  return runInTab((qIdx, oIdx) => {
    function getQuizContainers() {
      const selectors = [
        '.rc-FormPartsQuestion',
        '[data-testid*="question"]',
        '[class*="QuestionBody"]',
        '.quiz-question',
        '.question',
        'fieldset',
        '[role="group"][aria-labelledby]',
        '.wrapper-problem-response',
        '.que',
        '.question_holder'
      ];
      return Array.from(document.querySelectorAll(selectors.join(', '))).filter(c => {
        let els = c.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
        if (els.length === 0) {
          els = c.querySelectorAll('.rc-Option, [class*="Option"], .answer, .option');
        }
        return els.length > 0;
      });
    }

    function getQuestionOptions(c) {
      let els = c.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]');
      if (els.length === 0) {
        els = c.querySelectorAll('.rc-Option, [class*="Option"], .answer, .option');
      }
      return Array.from(els);
    }

    const containers = getQuizContainers();

    if (qIdx < 0 || qIdx >= containers.length) {
      return { success: false, message: `Question index ${qIdx} out of range (0–${containers.length - 1})` };
    }

    const container = containers[qIdx];
    const optionEls = getQuestionOptions(container);

    if (oIdx < 0 || oIdx >= optionEls.length) {
      return { success: false, message: `Option index ${oIdx} out of range (0–${optionEls.length - 1})` };
    }

    const target = optionEls[oIdx];

    // Click the input, option container, or its label
    const label = target.closest('label') || document.querySelector(`label[for="${target.id}"]`);
    if (label) {
      label.click();
    } else {
      target.click();
    }

    // Also set checked and fire events for React compatibility
    let inputEl = target.tagName === 'INPUT' ? target : target.querySelector('input');
    if (inputEl) {
      inputEl.checked = true;
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const chosenLabel = label?.textContent?.replace(/\s+/g, ' ').trim() || target.textContent?.replace(/\s+/g, ' ').trim() || `Option ${oIdx}`;
    return {
      success: true,
      questionIndex: qIdx,
      optionIndex: oIdx,
      selectedLabel: chosenLabel.slice(0, 200)
    };
  }, [questionIndex, optionIndex]);
}

// ── LMS Page Context Analysis ──────────────────────────────────────────────────

function analyzePageContext() {
  const url = window.location.href;
  const title = document.title;
  
  let lmsPlatform = null;
  if (url.includes('coursera.org')) lmsPlatform = 'Coursera';
  else if (url.includes('edx.org')) lmsPlatform = 'edX';
  else if (url.includes('udemy.com')) lmsPlatform = 'Udemy';
  else if (url.includes('canvas') || document.querySelector('.ic-app-header')) lmsPlatform = 'Canvas';
  else if (url.includes('moodle') || document.querySelector('.moodle-wrapper')) lmsPlatform = 'Moodle';
  
  let isLinkedIn = false;
  if (url.includes('linkedin.com')) {
    isLinkedIn = true;
  }
  
  if (!lmsPlatform && !isLinkedIn) {
    return { url, title, isLMS: false };
  }
  
  let pageType = 'unknown';
  let contextInfo = {};
  
  const path = window.location.pathname.toLowerCase();
  
  // Determine page type
  if (path.includes('login') || path.includes('signin') || path.includes('signup') || document.querySelector('input[type="password"]')) {
    pageType = 'login';
  } else if (path.includes('dashboard') || path.includes('home') || path === '/' || path === '/home' || path.includes('my-courses')) {
    pageType = 'dashboard';
    
    // Find enrolled courses if visible
    const courses = [];
    if (lmsPlatform === 'Coursera') {
      const links = document.querySelectorAll('a[href*="/learn/"]');
      const seenSlugs = new Set();
      links.forEach(link => {
        const href = link.href;
        const match = href.match(/\/learn\/([^/]+)/);
        if (match) {
          const slug = match[1];
          if (!seenSlugs.has(slug)) {
            seenSlugs.add(slug);
            let titleText = link.textContent.trim().replace(/\s+/g, ' ');
            if (titleText.length < 5 || ['continue', 'go to course', 'resume', 'learn'].includes(titleText.toLowerCase())) {
              const parentCard = link.closest('.rc-MobileCourseCard, .rc-CourseCard, div[class*="card"], div[class*="Card"]');
              if (parentCard) {
                const heading = parentCard.querySelector('h1, h2, h3, h4, [class*="title"], [class*="Name"]');
                if (heading) titleText = heading.textContent.trim();
              }
            }
            if (titleText && titleText.length > 3 && !['continue', 'go to course', 'resume', 'learn'].includes(titleText.toLowerCase())) {
              courses.push({ title: titleText, url: href });
            }
          }
        }
      });
    }
    contextInfo.enrolledCourses = courses;
  } else if (path.includes('search') || url.includes('query=')) {
    pageType = 'search_results';
    const results = [];
    if (lmsPlatform === 'Coursera') {
      const cards = document.querySelectorAll('[data-testid="product-card"], .rc-ProductCard, [class*="productCard"]');
      if (cards.length > 0) {
        cards.forEach(card => {
          const titleEl = card.querySelector('h3, h4, a, [class*="title"]');
          const ratingEl = card.querySelector('.ratings-text, .rating-number, [class*="rating"]');
          const descEl = card.querySelector('.card-description, [class*="description"], [class*="difficulty"]');
          if (titleEl) {
            results.push({
              title: titleEl.textContent.trim(),
              rating: ratingEl ? ratingEl.textContent.trim() : 'N/A',
              description: descEl ? descEl.textContent.trim() : ''
            });
          }
        });
      } else {
        const links = document.querySelectorAll('a[href*="/courses/"], a[href*="/specializations/"], a[href*="/professional-certificates/"]');
        const seen = new Set();
        links.forEach(link => {
          const href = link.href;
          const text = link.textContent.trim().replace(/\s+/g, ' ');
          if (text.length > 8 && !seen.has(href)) {
            seen.add(href);
            const parent = link.parentElement;
            let rating = 'N/A';
            if (parent) {
              const ratingEl = parent.querySelector('[class*="rating"], [class*="Rating"]');
              if (ratingEl) rating = ratingEl.textContent.trim();
            }
            results.push({ title: text, rating, url: href, description: '' });
          }
        });
      }
    }
    contextInfo.searchResults = results.slice(0, 5);
  } else if (path.includes('learn/') && (path.includes('lecture/') || path.includes('item/') || path.includes('supplement/') || path.includes('quiz') || path.includes('exam') || path.includes('assessment'))) {
    if (path.includes('quiz') || path.includes('exam') || path.includes('assessment')) {
      pageType = 'quiz';
    } else {
      pageType = 'lecture';
    }
  } else if (path.includes('learn/') || path.includes('courses/') || path.includes('course/')) {
    pageType = 'course_home';
    const enrollBtn = document.querySelector('button[class*="enroll"], a[href*="enroll"], .enroll-button, [data-testid="enroll-button"], [data-click-key*="enroll"]');
    contextInfo.hasEnrollButton = !!enrollBtn;
  } else if (isLinkedIn) {
    if (path.includes('/feed')) {
      pageType = 'linkedin_feed';
    } else if (path.includes('/in/')) {
      pageType = 'linkedin_profile';
    } else {
      pageType = 'linkedin_other';
    }
  }
  
  return {
    url,
    title,
    isLMS: !!lmsPlatform,
    lmsPlatform,
    isLinkedIn,
    pageType,
    contextInfo
  };
}
