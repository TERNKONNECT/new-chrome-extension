// Injected via chrome.scripting.executeScript (allFrames: true to reach
// videos inside iframes) — must stay fully self-contained.

export async function controlVideoScript(action, value, config) {
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

  // Helper to get absolute coordinates relative to the top-level viewport, even in iframes
  const getAbsoluteCenter = (el) => {
    return new Promise(resolve => {
      const observer = new IntersectionObserver(entries => {
        observer.disconnect();
        const rect = entries[0].intersectionRect;
        if (rect.width > 0 && rect.height > 0) {
          resolve({
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          });
        } else {
          // If not intersecting, fallback to getBoundingClientRect (might be wrong in iframes but better than nothing)
          const br = el.getBoundingClientRect();
          resolve({
            x: Math.round(br.left + br.width / 2),
            y: Math.round(br.top + br.height / 2)
          });
        }
      });
      observer.observe(el);
    });
  };

  let targetElement = video;

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
      targetElement = btn;
      break;
    }
  }

  if (!targetElement) return null; // Skip this frame

  const videoRect = await getAbsoluteCenter(targetElement);

  if (!video) return null; // Skip this frame

  try {
    switch (action) {
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
      case 'play':
      case 'pause':
      case 'toggle':
      case 'mute':
        // These can be solved with just a physical click on the target element
        return { success: false, rect: videoRect, reason: 'require_trusted_click' };
      case 'forward':
      case 'rewind':
      case 'speed':
        // These require focusing the element and sending keyboard events
        return { success: false, rect: videoRect, reason: 'require_trusted_key' };
      default:
        return { success: false, message: `Unknown video action: ${action}`, rect: videoRect };
    }
  } catch (err) {
    // If HTML5 API fails (e.g. cross-origin restriction or not allowed), return rect so debugger can take over
    return { success: false, message: err.message, rect: videoRect };
  }
}
