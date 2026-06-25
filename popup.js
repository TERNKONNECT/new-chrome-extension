'use strict';

// ── DOM refs ──────────────────────────────────────────────────

const warn        = document.getElementById('apiWarning');
const connBadge   = document.getElementById('connBadge');
const micBadge    = document.getElementById('micBadge');
const radarCore   = document.getElementById('radarCore');
const radarLabel  = document.getElementById('radarLabel');
const wakePhraseTip = document.getElementById('wakePhraseTip');

const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel  = document.getElementById('settingsPanel');
const emailInput     = document.getElementById('emailInput');
const pinInput       = document.getElementById('pinInput');
const saveKeyBtn     = document.getElementById('saveKeyBtn');
const clearKeyBtn    = document.getElementById('clearKeyBtn');
const settingsMsg    = document.getElementById('settingsMsg');

const integratedView    = document.getElementById('integratedView');
const linkedEmailDisplay = document.getElementById('linkedEmailDisplay');
const changeAccountBtn  = document.getElementById('changeAccountBtn');
const credentialsForm   = document.getElementById('credentialsForm');

// Once linked, the settings panel shows a confirmation instead of the raw
// form. "Change Account" forces the form back open until the next save.
let forceShowCredentialsForm = false;

// Free-sessions-exhausted panel (Starter plan's 3-session cap)
const trialExpiredView  = document.getElementById('trialExpiredView');
const upgradeBtn        = document.getElementById('upgradeBtn');
const retryAfterUpgradeBtn = document.getElementById('retryAfterUpgradeBtn');
const retryMsg          = document.getElementById('retryMsg');

// Backend URLs are baked in from .env at build time (background.js's
// get_backend_urls reads config.generated.js) — not editable from this UI.
// Run `npm run build:config` after changing .env, then reload the extension.
async function getBackendUrls() {
  try {
    const urls = await chrome.runtime.sendMessage({ type: 'get_backend_urls' });
    if (urls) return urls;
  } catch (_) {}
  return {
    platformBaseUrl: 'http://localhost:9001',
    intelligenceWsUrl: 'ws://localhost:8000/ws',
    dashboardUrl: 'http://localhost:3000/dashboard/billing'
  };
}

let autoOpenedSetup = false;

// ── Settings panel toggle ─────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  settingsToggle.classList.toggle('active', isOpen);

  // Re-opening always defaults back to the confirmation view (if linked)
  // rather than whatever edit state was left over from last time.
  if (isOpen) {
    forceShowCredentialsForm = false;
    loadSavedAuth();
  }
});

changeAccountBtn.addEventListener('click', () => {
  forceShowCredentialsForm = true;
  loadSavedAuth();
});

async function loadSavedAuth() {
  try {
    const result = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin']);
    const code = result.ternkonnectCode || result.ternkonnectPin;
    const linked = !!(result.ternkonnectEmail && code);

    if (linked) {
      emailInput.value = result.ternkonnectEmail;
      pinInput.value = code;
    } else {
      emailInput.value = '';
      pinInput.value = '';
    }

    renderSettingsPanel(linked, result.ternkonnectEmail);
  } catch (_) {
    renderSettingsPanel(false);
  }
}

function renderSettingsPanel(linked, email) {
  const showForm = !linked || forceShowCredentialsForm;
  credentialsForm.style.display = showForm ? 'block' : 'none';
  integratedView.style.display = !showForm ? 'block' : 'none';
  if (!showForm) linkedEmailDisplay.textContent = email || '';
}

// ── Save auth ──────────────────────────────────────────────────

saveKeyBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  const code = pinInput.value.trim();

  if (!email || !code) {
    showMsg('Enter both Email and Integration Code.', true);
    return;
  }

  if (!email.includes('@')) {
    showMsg('Please enter a valid email address.', true);
    return;
  }

  try {
    // Attempt integration validation using background
    showMsg('Connecting to platform...', false);
    const response = await chrome.runtime.sendMessage({
      type: 'integrate_profile',
      email,
      integrationCode: code
    });

    if (response && response.success) {
      showMsg('✓ Integrated successfully!', false);
      forceShowCredentialsForm = false;
      renderSettingsPanel(true, email);
      try { chrome.runtime.sendMessage({ type: 'reload_config' }); } catch (_) {}
      setTimeout(checkStatus, 2000);
    } else {
      showMsg(response?.error || 'Integration failed.', true);
    }
  } catch (err) {
    showMsg('Failed to save: ' + err.message, true);
  }
});

// ── Clear auth ─────────────────────────────────────────────────

clearKeyBtn.addEventListener('click', async () => {
  try {
    await chrome.storage.local.remove(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin']);
    emailInput.value = '';
    pinInput.value = '';
    forceShowCredentialsForm = false;
    renderSettingsPanel(false);
    showMsg('Credentials cleared.', false);
    try { chrome.runtime.sendMessage({ type: 'reload_config' }); } catch (_) {}
    setTimeout(checkStatus, 1000);
  } catch (err) {
    showMsg('Failed to clear: ' + err.message, true);
  }
});

// ── Upgrade (shown once the Starter plan's 3 free sessions are used up) ──
// The session cap lives on the Subscription record itself, so re-entering
// the same email + integration code can't lift it — only an actual plan
// upgrade on the web dashboard does.

upgradeBtn.addEventListener('click', async () => {
  const { dashboardUrl } = await getBackendUrls();
  chrome.tabs.create({ url: dashboardUrl });
});

// After upgrading on the dashboard, nothing automatically tells the
// extension to try again — the offscreen document only attempts a fresh
// /api/auth/session call when explicitly restarted. This re-triggers that,
// the same restart path used after saving new credentials.
retryAfterUpgradeBtn.addEventListener('click', async () => {
  retryAfterUpgradeBtn.disabled = true;
  retryMsg.textContent = 'Checking your plan...';
  retryMsg.className = 'settings-msg';

  try {
    await chrome.runtime.sendMessage({ type: 'reload_config' });
  } catch (_) {}

  setTimeout(() => {
    retryAfterUpgradeBtn.disabled = false;
    retryMsg.textContent = '';
    checkStatus();
  }, 2500);
});

function showMsg(text, isError) {
  settingsMsg.textContent = text;
  settingsMsg.className = 'settings-msg' + (isError ? ' error' : '');
  setTimeout(() => {
    if (settingsMsg.textContent === text) settingsMsg.textContent = '';
  }, 5000);
}

// ── Status check ──────────────────────────────────────────────

async function checkStatus() {
  let config = null;
  try {
    config = await chrome.runtime.sendMessage({ type: 'get_config' });
  } catch (_) {}

  // Ping the background service worker
  let bgAlive = false;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    bgAlive = resp?.alive === true;
  } catch (_) {}

  // Query microphone permission state
  let micState = 'prompt';
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    micState = perm.state;
  } catch (_) {}

  // Automatically open setup.html if permission is prompt (not yet asked)
  if (micState === 'prompt' && !autoOpenedSetup) {
    autoOpenedSetup = true;
    chrome.tabs.create({ url: 'setup.html' });
  }

  // Only relevant while actually dormant — the 'dormant' branch below turns
  // it back on.
  wakePhraseTip.style.display = 'none';

  if (!config) {
    warn.style.display = 'flex';
    trialExpiredView.style.display = 'none';
    setBadge(connBadge, 'Offline', 'red');
    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Service Error';
    radarLabel.className = 'radar-label error';
    return;
  }

  // Used up the Starter plan's 3 free sessions — only an actual upgrade
  // (not re-entering the same code) lifts this, since the cap lives on the
  // Subscription record server-side.
  if (config.trialExhausted) {
    warn.style.display = 'none';
    trialExpiredView.style.display = 'block';
    setBadge(connBadge, 'Upgrade Required', 'red');

    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }

    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Sessions Used Up';
    radarLabel.className = 'radar-label error';
    return;
  }
  trialExpiredView.style.display = 'none';

  // Every session — free Starter-plan or paid — now requires a linked
  // email + integration code. There's no anonymous fallback.
  if (!config.linked) {
    warn.style.display = 'flex';
    setBadge(connBadge, 'Not Linked', 'red');
    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Enter Email + Code';
    radarLabel.className = 'radar-label error';

    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
    return;
  }

  // Resting state: not connected to Gemini, but actively listening for the
  // wake phrase — this is normal and expected, not an error, so it gets its
  // own calm styling rather than "Disconnected".
  if (bgAlive && config.wsStatus === 'dormant') {
    warn.style.display = 'none';
    wakePhraseTip.style.display = 'block';
    setBadge(connBadge, 'Ready', 'green');
    radarCore.className = 'radar-core';
    radarLabel.textContent = "Say \"Hey TernKonnect\"";
    radarLabel.className = 'radar-label';

    if (micState === 'granted') {
      setBadge(micBadge, 'Listening', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
    return;
  }

  if (bgAlive && config.wsStatus === 'connected') {
    warn.style.display = 'none';
    setBadge(connBadge, 'Connected', 'green');

    if (micState === 'granted') {
      setBadge(micBadge, 'Active', 'green');
      radarCore.className = 'radar-core listening';
      radarLabel.textContent = 'Listening…';
      radarLabel.className = 'radar-label active';
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
      radarCore.className = 'radar-core error';
      radarLabel.textContent = 'Mic Blocked';
      radarLabel.className = 'radar-label error';
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
      radarCore.className = 'radar-core';
      radarLabel.textContent = 'Mic Setup Needed';
      radarLabel.className = 'radar-label';
    }
  } else if (bgAlive && config.wsStatus === 'connecting') {
    warn.style.display = 'none';
    setBadge(connBadge, 'Connecting…', 'yellow');
    radarCore.className = 'radar-core';
    radarLabel.textContent = 'Connecting…';
    radarLabel.className = 'radar-label';

    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
  } else {
    // No credentials-related warning here — `!config.linked` already
    // returned earlier with that message. This branch only means the
    // already-linked account's connection is down (backend restarting,
    // network blip, etc.), which is a different problem.
    warn.style.display = 'none';
    setBadge(connBadge, 'Disconnected', 'red');
    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Offline';
    radarLabel.className = 'radar-label error';

    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
  }
}

function setBadge(el, text, color) {
  el.innerHTML = `<span class="dot"></span>${text}`;
  el.className = `badge ${color}`;
}

async function requestMicPermission() {
  // Opening setup.html in a tab prevents Chrome from dismissing the permission prompt
  // when the extension popup loses focus.
  chrome.tabs.create({ url: 'setup.html' });
}

// ── Init ──────────────────────────────────────────────────────

checkStatus();

// Add click listeners to trigger mic permission request
micBadge.addEventListener('click', requestMicPermission);
radarCore.addEventListener('click', requestMicPermission);

// Re-check periodically in case the service worker or permissions update
setInterval(checkStatus, 4000);
