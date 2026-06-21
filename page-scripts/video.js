// Injected via chrome.scripting.executeScript (allFrames: true to reach
// videos inside iframes) — must stay fully self-contained.

export function controlVideoScript(action, value, config) {
  const video = document.querySelector('video');

  if (!video && action === 'play') {
    const selector = (config.playOverlaySelectors || []).join(', ');
    const btn = selector ? document.querySelector(selector) : null;
    if (btn) {
      btn.click();
      return { success: true, action: 'play', note: 'Clicked play button overlay' };
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
