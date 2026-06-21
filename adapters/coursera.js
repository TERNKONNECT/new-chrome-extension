// Coursera-specific selectors. Verified against the selectors the extension
// already relied on in production before this file existed.

export default {
  id: 'Coursera',
  matches: (url) => /coursera\.org/.test(url),

  outline: {
    itemSelectors: [
      '.rc-WeekItemName a',
      '.rc-ItemName a',
      '[data-track-component="syllabus_item"] a',
      '.rc-SidebarItem a',
      'nav a[data-track-component]',
      '.lesson-name a',
      '.item-name a',
      '[class*="ItemName"] a',
      '[class*="syllabus"] a'
    ]
  },

  transcript: {
    containerSelectors: ['.rc-Transcript']
  },

  quiz: {
    containerSelectors: ['.rc-FormPartsQuestion', '[class*="QuestionBody"]'],
    questionTextSelectors: ['[class*="prompt"]', '[class*="QuestionText"]']
  },

  // Dashboard: scrape enrolled courses from "/learn/<slug>" links, skipping
  // generic CTA text ("Continue", "Resume"...) in favor of the course card's
  // own heading when the link text itself isn't a real title.
  dashboard: {
    courseLinkSelector: 'a[href*="/learn/"]',
    courseSlugPattern: '/learn/([^/]+)',
    genericLinkLabels: ['continue', 'go to course', 'resume', 'learn'],
    cardSelector: '.rc-MobileCourseCard, .rc-CourseCard, div[class*="card"], div[class*="Card"]',
    cardTitleSelector: 'h1, h2, h3, h4, [class*="title"], [class*="Name"]'
  },

  // Search results: prefer the structured product-card markup; fall back to
  // raw course/specialization/professional-certificate links if cards aren't found.
  search: {
    cardSelector: '[data-testid="product-card"], .rc-ProductCard, [class*="productCard"]',
    cardTitleSelector: 'h3, h4, a, [class*="title"]',
    cardRatingSelector: '.ratings-text, .rating-number, [class*="rating"]',
    cardDescriptionSelector: '.card-description, [class*="description"], [class*="difficulty"]',
    linkFallbackSelector: 'a[href*="/courses/"], a[href*="/specializations/"], a[href*="/professional-certificates/"]',
    linkRatingSelector: '[class*="rating"], [class*="Rating"]'
  },

  enroll: {
    buttonSelectors: ['button[class*="enroll"]', 'a[href*="enroll"]', '.enroll-button', '[data-testid="enroll-button"]', '[data-click-key*="enroll"]']
  }
};
