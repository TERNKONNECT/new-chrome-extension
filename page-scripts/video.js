// Injected via chrome.scripting.executeScript (allFrames: true to reach
// videos inside iframes) — must stay fully self-contained.

export function controlVideoScript(action, value, config) {
  config = config || {};
  function deepQueryVideo(root) {
    const found = Array.from(root.querySelectorAll('video'));
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) found.push(...deepQueryVideo(el.shadowRoot));
    }
    return found;
  }
  const videos = deepQueryVideo(document);
  let video = null;
  let maxArea = -1;
  for (const v of videos) {
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > maxArea) {
      maxArea = area;
      video = v;
    }
  }
  if (!video && videos.length > 0) video = videos[0];

  if (video) {
    if (action === 'play' && !video.paused) return { success: true, action: 'play' };
    if (action === 'pause' && video.paused) return { success: true, action: 'pause' };
  }

  let videoRect = null;
  if (video) {
      const rect = video.getBoundingClientRect();
      videoRect = {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
      };
  }

  // Try UI buttons first for SPA compatibility (Udemy, Coursera)
  // We no longer call .click() on these because it fails as an untrusted event on modern LMS.
  // Instead, if we find a specific button, we can return its coordinates for the debugger.
  const actionToSelectors = {
    'play': config.playOverlaySelectors || [],
    'pause': config.pauseOverlaySelectors || config.playOverlaySelectors || [],
    'toggle': (config.playOverlaySelectors || []).concat(config.pauseOverlaySelectors || []),
    'forward': config.forwardOverlaySelectors || [],
    'rewind': config.rewindOverlaySelectors || [],
    'mute': config.muteOverlaySelectors || [],
    'speed': config.speedOverlaySelectors || []
  };

  const selectors = actionToSelectors[action] || [];
  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      videoRect = {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
      };
      break; // Found the button, we'll let the debugger click/focus it
    }
  }

  if (!video) return null; // Skip this frame

  try {
    switch (action) {
      case 'play':
        video.play();
        return { success: true, action: 'play' };
      case 'pause':
        video.pause();
        return { success: true, action: 'pause' };
      case 'toggle':
        if (video.paused) { video.play(); return { success: true, action: 'resumed' }; }
        video.pause();
        return { success: true, action: 'paused' };
      case 'forward':
        video.currentTime = Math.min(video.duration, video.currentTime + (value || 10));
        return { success: true, action: 'forward', seconds: value || 10 };
      case 'rewind':
        video.currentTime = Math.max(0, video.currentTime - (value || 10));
        return { success: true, action: 'rewind', seconds: value || 10 };
      case 'speed':
        video.playbackRate = value || 1;
        return { success: true, action: 'speed', rate: value || 1 };
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
        return { success: false, message: `Unknown video action: ${action}`, rect: videoRect };
    }
  } catch (err) {
    // If HTML5 API fails (e.g. cross-origin restriction or not allowed), return rect so debugger can take over
    return { success: false, message: err.message, rect: videoRect };
  }
}
