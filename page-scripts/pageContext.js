// Injected via chrome.scripting.executeScript — must stay fully self-contained.
//
// config is assembled by background.js from adapters/index.js:
//   resolvedPlatformLabel: 'Coursera' | 'Udemy' | 'LinkedIn Learning' | 'LinkedIn' | null
//   hints: self-hosted Canvas/Moodle sniff rules (url substring OR'd with a DOM selector)
//   dashboard / search / enroll: merged per-category selector config (may be empty objects)
//   social: LinkedIn feed/profile path hints

export function analyzePageContextScript(config) {
  const url = window.location.href;
  const title = document.title;

  // "LinkedIn" (plain social) is not an LMS platform; "LinkedIn Learning" is.
  let lmsPlatform = config.resolvedPlatformLabel !== 'LinkedIn' ? config.resolvedPlatformLabel : null;
  const isLinkedIn = /linkedin\.com/.test(url);

  if (!lmsPlatform) {
    for (const hint of config.hints || []) {
      if (url.toLowerCase().includes(hint.urlSubstring) || document.querySelector(hint.selector)) {
        lmsPlatform = hint.platform;
        break;
      }
    }
  }

  if (!lmsPlatform && !isLinkedIn) {
    return { url, title, isLMS: false };
  }

  let pageType = 'unknown';
  const contextInfo = {};
  const path = window.location.pathname.toLowerCase();

  if (path.includes('login') || path.includes('signin') || path.includes('signup') || document.querySelector('input[type="password"]')) {
    pageType = 'login';
  } else if (path.includes('dashboard') || path.includes('home') || path === '/' || path === '/home' || path.includes('my-courses')) {
    pageType = 'dashboard';
    const courses = [];
    const d = config.dashboard;
    if (d && d.courseLinkSelector) {
      const links = document.querySelectorAll(d.courseLinkSelector);
      const seenSlugs = new Set();
      const slugRe = new RegExp(d.courseSlugPattern);
      const genericLabels = d.genericLinkLabels || [];
      links.forEach((link) => {
        const href = link.href;
        const match = href.match(slugRe);
        if (!match) return;
        const slug = match[1];
        if (seenSlugs.has(slug)) return;
        seenSlugs.add(slug);

        let titleText = link.textContent.trim().replace(/\s+/g, ' ');
        if (titleText.length < 5 || genericLabels.includes(titleText.toLowerCase())) {
          const parentCard = link.closest(d.cardSelector);
          if (parentCard) {
            const heading = parentCard.querySelector(d.cardTitleSelector);
            if (heading) titleText = heading.textContent.trim();
          }
        }
        if (titleText && titleText.length > 3 && !genericLabels.includes(titleText.toLowerCase())) {
          courses.push({ title: titleText, url: href });
        }
      });
    }
    contextInfo.enrolledCourses = courses;
  } else if (path.includes('search') || url.includes('query=')) {
    pageType = 'search_results';
    const results = [];
    const s = config.search;
    if (s && s.cardSelector) {
      const cards = document.querySelectorAll(s.cardSelector);
      if (cards.length > 0) {
        cards.forEach((card) => {
          const titleEl = card.querySelector(s.cardTitleSelector);
          const ratingEl = card.querySelector(s.cardRatingSelector);
          const descEl = card.querySelector(s.cardDescriptionSelector);
          if (titleEl) {
            results.push({
              title: titleEl.textContent.trim(),
              rating: ratingEl ? ratingEl.textContent.trim() : 'N/A',
              description: descEl ? descEl.textContent.trim() : ''
            });
          }
        });
      } else if (s.linkFallbackSelector) {
        const links = document.querySelectorAll(s.linkFallbackSelector);
        const seen = new Set();
        links.forEach((link) => {
          const href = link.href;
          const text = link.textContent.trim().replace(/\s+/g, ' ');
          if (text.length > 8 && !seen.has(href)) {
            seen.add(href);
            let rating = 'N/A';
            const parent = link.parentElement;
            if (parent && s.linkRatingSelector) {
              const ratingEl = parent.querySelector(s.linkRatingSelector);
              if (ratingEl) rating = ratingEl.textContent.trim();
            }
            results.push({ title: text, rating, url: href, description: '' });
          }
        });
      }
    }
    contextInfo.searchResults = results.slice(0, 5);
  } else if (path.includes('learn/') && (path.includes('lecture/') || path.includes('item/') || path.includes('supplement/') || path.includes('quiz') || path.includes('exam') || path.includes('assessment'))) {
    pageType = (path.includes('quiz') || path.includes('exam') || path.includes('assessment')) ? 'quiz' : 'lecture';
  } else if (path.includes('learn/') || path.includes('courses/') || path.includes('course/')) {
    pageType = 'course_home';
    const enrollSelector = ((config.enroll && config.enroll.buttonSelectors) || []).join(', ');
    const enrollBtn = enrollSelector ? document.querySelector(enrollSelector) : null;
    contextInfo.hasEnrollButton = !!enrollBtn;
  } else if (isLinkedIn && !lmsPlatform) {
    const social = config.social || {};
    if ((social.feedPathHints || []).some((hint) => path.includes(hint))) {
      pageType = 'linkedin_feed';
    } else if ((social.profilePathHints || []).some((hint) => path.includes(hint))) {
      pageType = 'linkedin_profile';
    } else {
      pageType = 'linkedin_other';
    }
  }

  return {
    url,
    title,
    isLMS: !!lmsPlatform,
    lmsPlatform,
    isLinkedIn,
    pageType,
    contextInfo
  };
}
