// Universal fallback selectors — the floor every platform adapter sits on top of.
// Covers edX/Open edX, Moodle, Canvas, and truly generic patterns that show up
// across most LMS-style sites. Named-platform-specific selectors (Coursera,
// Udemy, LinkedIn Learning) live in their own adapter files instead of here.

export default {
  id: 'generic',

  outline: {
    itemSelectors: [
      // edX / Open edX
      '.outline-item a',
      '.sequence-list-wrapper a',
      '.chapter a',
      // Moodle
      '.activity-item a',
      '.section .activity a',
      '.course-content a.aalink',
      // Canvas
      '.context_module_item a.title',
      '#context_modules .ig-title a',
      // Generic patterns
      'nav[aria-label*="course"] a',
      'aside a[href*="lesson"]',
      'aside a[href*="module"]',
      '.sidebar a[href]'
    ],
    fallbackSelectors: ['aside a[href]', 'nav a[href]', '[role="navigation"] a[href]'],
    completedSelectors: ['[class*="completed"]', '[class*="done"]'],
    completedChildSelectors: ['[class*="check"]', '[class*="complete"]']
  },

  transcript: {
    containerSelectors: [
      '.transcript-text',
      '.video-transcript',
      '.wrapper-transcripts', // edX
      '#transcript',
      '[aria-label="Transcript"]'
    ],
    captionSelectors: ['.vjs-text-track-display', '.captions-text', '[class*="caption"]', '[class*="subtitle"]']
  },

  quiz: {
    containerSelectors: [
      'fieldset',
      '[role="group"][aria-labelledby]',
      '.wrapper-problem-response', // edX
      '.que',                      // Moodle
      '.question_holder',          // Canvas
      '.quiz-question',
      '.question',
      '[data-testid*="question"]'
    ],
    optionSelectors: ['input[type="radio"]', 'input[type="checkbox"]', '[role="radio"]', '[role="checkbox"]'],
    optionFallbackSelectors: ['.answer', '.option'],
    questionTextSelectors: ['legend', '.question-text', 'h3', 'h4', 'p:first-of-type', '.qtext', '.question_text']
  },

  video: {
    playOverlaySelectors: ['.vjs-big-play-button', 'button[aria-label="Play"]', '.play-button']
  },

  // Best-effort detection of self-hosted LMS instances (e.g. a school's own
  // Canvas/Moodle install) where neither URL nor DOM alone reliably reveals
  // the platform — checked together, same as production did before this
  // file existed.
  pageType: {
    hints: [
      { platform: 'Canvas', urlSubstring: 'canvas', selector: '.ic-app-header' },
      { platform: 'Moodle', urlSubstring: 'moodle', selector: '.moodle-wrapper' }
    ]
  }
};
