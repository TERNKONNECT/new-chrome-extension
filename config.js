// ============================================================
//  TernKonnect AI Assistant - Configuration
//  The API key is managed via the extension popup settings panel.
//  It is stored in chrome.storage.local for persistence.
//  A hardcoded fallback can be placed below for development.
// ============================================================

export async function getTernkonnectAuth() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get_config' });
    if (result) {
      return result;
    }
  } catch (_) {
    // storage unavailable — fall through
  }
  return null;
}
