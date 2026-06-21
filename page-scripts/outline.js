// Injected via chrome.scripting.executeScript — must stay fully
// self-contained (no references outside its own body/args; Chrome
// serializes just this function for injection into the page).

export function extractOutline(config) {
  const items = [];
  const seen = new Set();

  for (const sel of config.itemSelectors || []) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 200 || seen.has(text)) continue;
        seen.add(text);

        const isComplete =
          (config.completedSelectors || []).some((s) => el.closest(s) !== null) ||
          (config.completedChildSelectors || []).some((s) => el.querySelector(s) !== null);

        items.push({ index: items.length, title: text, url: el.href || null, completed: isComplete });
      }
    } catch (_) { /* selector not supported in this context */ }
  }

  if (items.length === 0) {
    for (const sel of config.fallbackSelectors || []) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 200 || text.length < 3 || seen.has(text)) continue;
          seen.add(text);
          items.push({ index: items.length, title: text, url: el.href || null, completed: false });
        }
      } catch (_) { /* selector not supported in this context */ }
    }
  }

  return {
    success: true,
    pageTitle: document.title,
    itemCount: items.length,
    items: items.slice(0, 40)
  };
}
