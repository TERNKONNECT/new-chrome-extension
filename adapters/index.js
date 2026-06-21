// Adapter registry: resolves which platform-specific data applies to a URL
// and merges it with the generic fallback (adapters/generic.js) so unlisted
// LMS-style sites still get reasonable behavior.
//
// Shared data shape (adapters omit categories they don't need):
//   { id, matches(url), outline, transcript, quiz, video, dashboard, search, enroll }
// Each category is a flat object whose values are either arrays of CSS
// selectors or plain config values (strings/arrays) — see generic.js and
// coursera.js for the concrete shape per category.

import coursera from './coursera.js';
import udemy from './udemy.js';
import linkedin from './linkedin.js';
import generic from './generic.js';

const PLATFORM_ADAPTERS = [coursera, udemy, linkedin];

export function detectAdapter(url) {
  return PLATFORM_ADAPTERS.find((adapter) => adapter.matches(url)) || null;
}

// Resolves a human-readable platform label, splitting LinkedIn's social
// surface from LinkedIn Learning since they need very different handling.
export function getPlatformLabel(url) {
  const adapter = detectAdapter(url);
  if (!adapter) return null;
  if (adapter.id === 'LinkedIn') {
    return adapter.isLearningPath(url) ? 'LinkedIn Learning' : 'LinkedIn';
  }
  return adapter.id;
}

export function isLmsAdapter(url) {
  const adapter = detectAdapter(url);
  if (!adapter) return false;
  if (adapter.id === 'LinkedIn') return adapter.isLearningPath(url);
  return true;
}

// Merges a category (e.g. "outline", "quiz") across the matched platform
// adapter and the generic fallback. Array fields are concatenated
// (platform selectors tried first); scalar fields prefer the platform's
// value, falling back to generic's.
export function getSelectors(url, category) {
  const adapter = detectAdapter(url);
  const platformConfig = (adapter && adapter[category]) || {};
  const genericConfig = generic[category] || {};

  const merged = {};
  for (const key of new Set([...Object.keys(platformConfig), ...Object.keys(genericConfig)])) {
    const a = platformConfig[key];
    const b = genericConfig[key];
    merged[key] = Array.isArray(a) || Array.isArray(b) ? [...(a || []), ...(b || [])] : a ?? b;
  }
  return merged;
}

export { coursera, udemy, linkedin, generic };
