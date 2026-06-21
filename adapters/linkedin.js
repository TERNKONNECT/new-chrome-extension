// LinkedIn has two very different surfaces the assistant deals with:
//   1. The social product (feed, profile, posting) — already supported in
//      production today via generic click/fill tools, unchanged here.
//   2. LinkedIn Learning (linkedin.com/learning/*), the actual course
//      platform — NOT supported in production before this file existed.
//      The outline/transcript/quiz/video selectors below are a best-effort
//      first pass (LinkedIn Learning's player is Video.js-based, and its
//      curriculum sidebar uses a "classroom" naming convention), but they
//      are UNVERIFIED against a real account. Replace/extend once real
//      fixtures are captured — see tests/fixtures/linkedin-learning.

export default {
  id: 'LinkedIn',
  matches: (url) => /linkedin\.com/.test(url),
  isLearningPath: (url) => /linkedin\.com\/learning\//.test(url),

  outline: {
    itemSelectors: [
      '[data-test-curriculum-item] a',
      '.classroom-toc-item a',
      '.classroom-toc__item a'
    ]
  },

  transcript: {
    containerSelectors: ['[data-test-id="transcript-cue-list"]', '.classroom-transcript']
  },

  quiz: {
    // LinkedIn Learning quizzes are uncommon and markup is unverified;
    // rely entirely on the generic fallback until a real fixture exists.
  },

  video: {
    playOverlaySelectors: ['.vjs-big-play-button']
  },

  social: {
    feedPathHints: ['/feed'],
    profilePathHints: ['/in/']
  }
};
