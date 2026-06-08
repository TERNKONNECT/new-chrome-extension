'use strict';

async function checkStatus() {
  const warn      = document.getElementById('apiWarning');
  const connBadge = document.getElementById('connBadge');
  const micBadge  = document.getElementById('micBadge');

  // Ping the background service worker
  let bgAlive = false;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    bgAlive = resp?.alive === true;
  } catch (_) {}

  if (bgAlive) {
    warn.style.display = 'none';
    setBadge(connBadge, '● Connected', 'green');
    setBadge(micBadge,  '● Active',    'green');
  } else {
    // Background not responding — likely API key missing or extension just installed
    warn.style.display = 'block';
    setBadge(connBadge, 'Starting…', 'yellow');
    setBadge(micBadge,  'Starting…', 'yellow');
  }
}

function setBadge(el, text, color) {
  el.textContent = text;
  el.className = `badge ${color}`;
}

checkStatus();
