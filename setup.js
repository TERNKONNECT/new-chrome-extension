'use strict';

const startBtn    = document.getElementById('startBtn');
const statusBadge = document.getElementById('status');
const instruction = document.getElementById('instruction');

async function checkPermissionOnLoad() {
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    if (perm.state === 'granted') {
      statusBadge.textContent = 'Microphone already enabled. Closing...';
      statusBadge.className = 'status-badge green';
      setTimeout(() => window.close(), 1000);
    }
  } catch (_) {}
}

async function requestPermission() {
  statusBadge.textContent = 'Requesting permission...';
  statusBadge.className = 'status-badge yellow';
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop tracks to turn off recording light
    stream.getTracks().forEach(track => track.stop());
    
    statusBadge.textContent = '✓ Microphone Authorized! Closing...';
    statusBadge.className = 'status-badge green';
    instruction.textContent = 'TernKonnect now has microphone access. You can close this tab and open the extension popup.';

    // Notify background/offscreen to reload configuration and connect
    try {
      chrome.runtime.sendMessage({ type: 'reload_config' });
    } catch (_) {}

    // Close the tab after a brief delay
    setTimeout(() => {
      window.close();
    }, 1500);
  } catch (err) {
    console.error('Permission request failed:', err);
    statusBadge.textContent = 'Permission Denied';
    statusBadge.className = 'status-badge red';
    instruction.innerHTML = '<strong>Access Blocked:</strong> TernKonnect was denied access to your microphone.<br><br>To fix this, please click the <strong>microphone icon</strong> in your browser address bar, select "Always allow," and click the Setup button again or reload this page.';
  }
}

startBtn.addEventListener('click', requestPermission);

// Check if already authorized when the page opens
checkPermissionOnLoad();
