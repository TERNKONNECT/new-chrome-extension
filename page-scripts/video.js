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

  // Try UI buttons first for SPA compatibility (Udemy, Coursera)
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
      btn.click();
      return { success: true, action, note: 'Clicked UI button' };
    }
  }

  // Fallback: Click the center of the video screen (only for play/pause/toggle)
  if (video && (action === 'play' || action === 'pause' || action === 'toggle')) {
    try {
      const rect = video.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(x, y);
      
      if (topEl) {
        topEl.click();
      } else {
        video.click();
      }
      return { success: true, action, note: 'Clicked video screen center' };
    } catch (err) {
      console.warn('Failed to click video center', err);
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
        return { success: false, message: `Unknown video action: ${action}` };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
