// ============================================================
//  TernKonnect AI Assistant - Configuration
//  The API key is managed via the extension popup settings panel.
//  It is stored in chrome.storage.local for persistence.
//  A hardcoded fallback can be placed below for development.
// ============================================================

// Hardcoded fallback key (used if chrome.storage.local has no key saved).
// Replace with your own key, or save one via the popup settings.
const GEMINI_API_KEY_FALLBACK = '';

/**
 * Retrieve the Gemini API key.
 * Priority: chrome.storage.local → hardcoded fallback.
 * @returns {Promise<string|null>}
 */
export async function getGeminiApiKey() {
  try {
    const result = await chrome.storage.local.get('geminiApiKey');
    if (result.geminiApiKey) return result.geminiApiKey;
  } catch (_) {
    // storage unavailable — fall through
  }
  return GEMINI_API_KEY_FALLBACK || null;
}

/**
 * Save a new API key to chrome.storage.local.
 * @param {string} key
 */
export async function saveGeminiApiKey(key) {
  await chrome.storage.local.set({ geminiApiKey: key });
}

/**
 * Clear the saved API key from chrome.storage.local.
 */
export async function clearGeminiApiKey() {
  await chrome.storage.local.remove('geminiApiKey');
}
