// Injected via chrome.scripting.executeScript — must stay fully self-contained.

export function extractTranscript(config) {
  let transcriptEl = null;
  for (const sel of config.containerSelectors || []) {
    transcriptEl = document.querySelector(sel);
    if (transcriptEl) break;
  }

  if (!transcriptEl) {
    const captionSelector = (config.captionSelectors || []).join(', ');
    const trackEls = captionSelector ? Array.from(document.querySelectorAll(captionSelector)) : [];
    if (trackEls.length > 0) {
      const text = trackEls.map((el) => el.textContent.trim()).filter(Boolean).join(' ');
      if (text.length > 10) {
        return { success: true, text: text.slice(0, 5000), note: 'Extracted from on-screen captions (may be incomplete).' };
      }
    }
    return { success: false, message: 'No transcript or closed captions found on the page. Try looking for a "Show Transcript" button.' };
  }

  const lines = Array.from(transcriptEl.querySelectorAll('p, span, li, div'))
    .map((el) => {
      let text = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue + ' ';
      }
      return text.trim();
    })
    .filter((text) => text.length > 5);

  const uniqueLines = [];
  for (const line of lines) {
    if (uniqueLines.length === 0 || uniqueLines[uniqueLines.length - 1] !== line) {
      uniqueLines.push(line);
    }
  }

  const fullText = uniqueLines.join(' ');
  if (!fullText || fullText.length < 10) {
    return { success: false, message: 'Transcript container found, but it is empty. It might be loading or hidden.' };
  }

  return { success: true, text: fullText.slice(0, 10000), length: fullText.length };
}
