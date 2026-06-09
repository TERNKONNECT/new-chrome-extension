'use strict';

// ── DOM refs ──────────────────────────────────────────────────

const warn        = document.getElementById('apiWarning');
const connBadge   = document.getElementById('connBadge');
const micBadge    = document.getElementById('micBadge');
const radarCore   = document.getElementById('radarCore');
const radarLabel  = document.getElementById('radarLabel');

const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel  = document.getElementById('settingsPanel');
const apiKeyInput    = document.getElementById('apiKeyInput');
const saveKeyBtn     = document.getElementById('saveKeyBtn');
const clearKeyBtn    = document.getElementById('clearKeyBtn');
const settingsMsg    = document.getElementById('settingsMsg');

// ── Settings panel toggle ─────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  settingsToggle.classList.toggle('active', isOpen);

  // When opening, load the current saved key (masked)
  if (isOpen) loadSavedKey();
});

async function loadSavedKey() {
  try {
    const result = await chrome.storage.local.get('geminiApiKey');
    if (result.geminiApiKey) {
      // Show masked version
      const key = result.geminiApiKey;
      apiKeyInput.value = key.slice(0, 6) + '•'.repeat(Math.max(0, key.length - 10)) + key.slice(-4);
      apiKeyInput.dataset.hasKey = 'true';
    } else {
      apiKeyInput.value = '';
      apiKeyInput.dataset.hasKey = 'false';
    }
  } catch (_) {}
}

// When user focuses the input, clear the masked display so they can type a new key
apiKeyInput.addEventListener('focus', () => {
  if (apiKeyInput.dataset.hasKey === 'true') {
    apiKeyInput.value = '';
    apiKeyInput.type = 'text';
    apiKeyInput.dataset.hasKey = 'false';
  }
});

apiKeyInput.addEventListener('blur', () => {
  apiKeyInput.type = 'password';
});

// ── Save key ──────────────────────────────────────────────────

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();

  if (!key || key.includes('•')) {
    showMsg('Enter a new API key first.', true);
    return;
  }

  if (!key.startsWith('AIza')) {
    showMsg('Key should start with "AIza…". Double-check it.', true);
    return;
  }

  try {
    await chrome.storage.local.set({ geminiApiKey: key });
    showMsg('✓ Key saved! Reload extension to apply.', false);
    apiKeyInput.dataset.hasKey = 'true';
    apiKeyInput.type = 'password';
    apiKeyInput.value = key.slice(0, 6) + '•'.repeat(Math.max(0, key.length - 10)) + key.slice(-4);

    // Attempt to tell the background to reload
    try { chrome.runtime.sendMessage({ type: 'reload_config' }); } catch (_) {}

    // Recheck status after short delay
    setTimeout(checkStatus, 2000);
  } catch (err) {
    showMsg('Failed to save: ' + err.message, true);
  }
});

// ── Clear key ─────────────────────────────────────────────────

clearKeyBtn.addEventListener('click', async () => {
  try {
    await chrome.storage.local.remove('geminiApiKey');
    apiKeyInput.value = '';
    apiKeyInput.dataset.hasKey = 'false';
    showMsg('Key cleared.', false);
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
  // First check if API key exists
  let hasKey = false;
  try {
    const result = await chrome.storage.local.get('geminiApiKey');
    hasKey = !!result.geminiApiKey;
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
  } else if (!hasKey) {
    // No key saved — show warning
    warn.style.display = 'flex';
    setBadge(connBadge, 'No Key', 'red');
    
    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }
    
    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'API Key Required';
    radarLabel.className = 'radar-label error';
  } else {
    // Key exists but background not responding yet
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
