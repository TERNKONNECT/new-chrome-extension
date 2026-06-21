// Udemy-specific selectors. outline/transcript/video selectors below were
// already relied on in production before this file existed. dashboard/search/quiz
// scraping was never implemented for Udemy — left undefined here so pageContext
// and quiz extraction fall back to the generic handling until verified against
// a real fixture (see tests/fixtures/udemy and the capture instructions handed
// off alongside this change).

export default {
  id: 'Udemy',
  matches: (url) => /udemy\.com/.test(url),

  outline: {
    itemSelectors: ['[data-purpose="curriculum-item-title"]']
  },

  transcript: {
    containerSelectors: ['[data-purpose="transcript-panel"]']
  },

  video: {
    playOverlaySelectors: ['[data-purpose="video-play-button"]']
  }

  // dashboard, search, quiz: unverified — see comment above.
};
