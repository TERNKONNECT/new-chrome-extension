'use strict';

// ── DOM refs ──────────────────────────────────────────────────

const warn        = document.getElementById('apiWarning');
const connBadge   = document.getElementById('connBadge');
const micBadge    = document.getElementById('micBadge');
const radarCore   = document.getElementById('radarCore');
const radarLabel  = document.getElementById('radarLabel');

const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel  = document.getElementById('settingsPanel');
const emailInput     = document.getElementById('emailInput');
const pinInput       = document.getElementById('pinInput');
const saveKeyBtn     = document.getElementById('saveKeyBtn');
const clearKeyBtn    = document.getElementById('clearKeyBtn');
const settingsMsg    = document.getElementById('settingsMsg');

// ── Settings panel toggle ─────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  settingsToggle.classList.toggle('active', isOpen);

  // When opening, load the current saved auth
  if (isOpen) loadSavedAuth();
});

async function loadSavedAuth() {
  try {
    const result = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectPin']);
    if (result.ternkonnectEmail && result.ternkonnectPin) {
      emailInput.value = result.ternkonnectEmail;
      pinInput.value = result.ternkonnectPin;
    } else {
      emailInput.value = '';
      pinInput.value = '';
    }
  } catch (_) {}
}

// ── Save auth ──────────────────────────────────────────────────

saveKeyBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  const pin = pinInput.value.trim();

  if (!email || !pin) {
    showMsg('Enter both Email and PIN.', true);
    return;
  }

  // Basic email validation
  if (!email.includes('@')) {
    showMsg('Please enter a valid email address.', true);
    return;
  }

  try {
    // Optionally call the backend here to verify the PIN before saving
    // For now, we save it and the background worker will use it to authenticate
    await chrome.storage.local.set({ 
      ternkonnectEmail: email,
      ternkonnectPin: pin
    });
    showMsg('✓ Credentials saved!', false);

    // Attempt to tell the background to reload configs/re-authenticate
    try { chrome.runtime.sendMessage({ type: 'reload_config' }); } catch (_) {}

    // Recheck status after short delay
    setTimeout(checkStatus, 2000);
  } catch (err) {
    showMsg('Failed to save: ' + err.message, true);
  }
});

// ── Clear auth ─────────────────────────────────────────────────

clearKeyBtn.addEventListener('click', async () => {
  try {
    await chrome.storage.local.remove(['ternkonnectEmail', 'ternkonnectPin']);
    emailInput.value = '';
    pinInput.value = '';
    showMsg('Credentials cleared.', false);
    setTimeout(checkStatus, 1000);
  } catch (err) {
    showMsg('Failed to clear: ' + err.message, true);
  }
});

function showMsg(text, isError) {
  settingsMsg.textContent = text;
  settingsMsg.className = 'settings-msg' + (isError ? ' error' : '');
  // Auto-clear after 5s
  setTimeout(() => {
    if (settingsMsg.textContent === text) settingsMsg.textContent = '';
  }, 5000);
}

// ── Status check ──────────────────────────────────────────────

async function checkStatus() {
  // First check if Auth exists
  let hasAuth = false;
  try {
    const result = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectPin']);
    hasAuth = !!(result.ternkonnectEmail && result.ternkonnectPin);
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

  if (bgAlive) {
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
  } else if (!hasAuth) {
    // No auth saved — show warning
    warn.style.display = 'flex';
    setBadge(connBadge, 'Not Authenticated', 'red');
    
    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
    
    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Auth Required';
    radarLabel.className = 'radar-label error';
  } else {
    // Auth exists but background not responding yet
    warn.style.display = 'none';
    setBadge(connBadge, 'Starting…', 'yellow');
    
    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
    
    radarCore.className = 'radar-core';
    radarLabel.textContent = 'Connecting…';
    radarLabel.className = 'radar-label';
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
