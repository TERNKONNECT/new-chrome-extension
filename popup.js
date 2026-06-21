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

// Trial expired panel
const trialExpiredView = document.getElementById('trialExpiredView');
const loginEmail       = document.getElementById('loginEmail');
const loginCode        = document.getElementById('loginCode');
const loginSubmitBtn   = document.getElementById('loginSubmitBtn');
const loginMsg          = document.getElementById('loginMsg');

// Trial status card row
const trialRow   = document.getElementById('trialRow');
const trialBadge = document.getElementById('trialBadge');

let autoOpenedSetup = false;

// ── Settings panel toggle ─────────────────────────────────────

settingsToggle.addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  settingsToggle.classList.toggle('active', isOpen);

  // When opening, load the current saved auth
  if (isOpen) loadSavedAuth();
});

async function loadSavedAuth() {
  try {
    const result = await chrome.storage.local.get(['ternkonnectEmail', 'ternkonnectCode', 'ternkonnectPin']);
    const code = result.ternkonnectCode || result.ternkonnectPin;
    if (result.ternkonnectEmail && code) {
      emailInput.value = result.ternkonnectEmail;
      pinInput.value = code;
    } else {
      emailInput.value = '';
      pinInput.value = '';
    }
  } catch (_) {}
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
    showMsg('Credentials cleared.', false);
    try { chrome.runtime.sendMessage({ type: 'reload_config' }); } catch (_) {}
    setTimeout(checkStatus, 1000);
  } catch (err) {
    showMsg('Failed to clear: ' + err.message, true);
  }
});

// ── Login Submit (Trial expired view) ──────────────────────────

loginSubmitBtn.addEventListener('click', async () => {
  const email = loginEmail.value.trim();
  const code = loginCode.value.trim();

  if (!email || !code) {
    showLoginMsg('Enter both Email and Integration Code.', true);
    return;
  }

  if (!email.includes('@')) {
    showLoginMsg('Please enter a valid email address.', true);
    return;
  }

  loginSubmitBtn.disabled = true;
  showLoginMsg('Connecting to platform...', false);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'integrate_profile',
      email,
      integrationCode: code
    });

    if (response && response.success) {
      showLoginMsg('✓ Integrated successfully!', false);
      try { chrome.runtime.sendMessage({ type: 'reload_config' }); } catch (_) {}
      setTimeout(() => {
        trialExpiredView.style.display = 'none';
        loginSubmitBtn.disabled = false;
        checkStatus();
      }, 1500);
    } else {
      showLoginMsg(response?.error || 'Integration failed.', true);
      loginSubmitBtn.disabled = false;
    }
  } catch (err) {
    showLoginMsg('Cannot reach background helper.', true);
    loginSubmitBtn.disabled = false;
  }
});

function showMsg(text, isError) {
  settingsMsg.textContent = text;
  settingsMsg.className = 'settings-msg' + (isError ? ' error' : '');
  setTimeout(() => {
    if (settingsMsg.textContent === text) settingsMsg.textContent = '';
  }, 5000);
}

function showLoginMsg(text, isError) {
  loginMsg.textContent = text;
  loginMsg.className = 'settings-msg' + (isError ? ' error' : '');
  setTimeout(() => {
    if (loginMsg.textContent === text) loginMsg.textContent = '';
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

  if (!config) {
    warn.style.display = 'flex';
    trialExpiredView.style.display = 'none';
    trialRow.style.display = 'none';
    setBadge(connBadge, 'Offline', 'red');
    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Service Error';
    radarLabel.className = 'radar-label error';
    return;
  }

  // Handle Trial Expired state
  if (config.trialExpired) {
    warn.style.display = 'none';
    trialExpiredView.style.display = 'block';
    trialRow.style.display = 'flex';
    setBadge(trialBadge, 'Expired', 'red');
    setBadge(connBadge, 'Subscribe to Continue', 'red');

    if (micState === 'granted') {
      setBadge(micBadge, 'Ready', 'green');
    } else if (micState === 'denied') {
      setBadge(micBadge, 'Blocked (Click)', 'red');
    } else {
      setBadge(micBadge, 'Setup (Click)', 'yellow');
    }

    radarCore.className = 'radar-core error';
    radarLabel.textContent = 'Trial Expired';
    radarLabel.className = 'radar-label error';
    return;
  }

  // If we get here, trial is not expired. Hide the trial expired view.
  trialExpiredView.style.display = 'none';

  if (config.trial) {
    // Active trial
    warn.style.display = 'none';
    trialRow.style.display = 'flex';

    // Format remaining time (minutes and seconds)
    const mins = Math.floor(config.remainingTime / 60000);
    const secs = Math.floor((config.remainingTime % 60000) / 1000);
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    setBadge(trialBadge, `Session ${config.trialsCount}/3 (${timeStr})`, 'yellow');

    if (bgAlive && config.wsStatus === 'connected') {
      setBadge(connBadge, 'Connected (Trial)', 'green');

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
  } else {
    // Authenticated
    trialRow.style.display = 'none';

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
      warn.style.display = 'flex';
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
