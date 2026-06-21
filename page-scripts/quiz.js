// Injected via chrome.scripting.executeScript — must stay fully
// self-contained. Extraction and answering share one container/option
// lookup (previously duplicated verbatim across two separate functions)
// by living in a single injected function with an action flag.

export function quizPageScript(config, action, questionIndex, optionIndex) {
  function getOptionEls(container) {
    const primary = (config.optionSelectors || []).join(', ');
    let els = primary ? container.querySelectorAll(primary) : [];
    if (els.length === 0) {
      const fallback = (config.optionFallbackSelectors || []).join(', ');
      els = fallback ? container.querySelectorAll(fallback) : [];
    }
    return Array.from(els);
  }

  function getContainers() {
    const selector = (config.containerSelectors || []).join(', ');
    if (!selector) return [];
    return Array.from(document.querySelectorAll(selector)).filter((c) => getOptionEls(c).length > 0);
  }

  if (action === 'extract') {
    const questions = [];
    const containers = getContainers();
    const qTextSelector = (config.questionTextSelectors || []).join(', ');

    let idx = 0;
    for (const container of containers) {
      const qTextEl = qTextSelector ? container.querySelector(qTextSelector) : null;
      const qText = qTextEl
        ? qTextEl.textContent.replace(/\s+/g, ' ').trim()
        : container.textContent.replace(/\s+/g, ' ').trim().slice(0, 300);

      if (!qText || qText.length < 5) continue;

      const optionEls = getOptionEls(container);
      const options = [];
      let optIdx = 0;
      for (const opt of optionEls) {
        const label = opt.closest('label')?.textContent?.replace(/\s+/g, ' ').trim()
          || opt.getAttribute('aria-label')
          || (opt.id ? document.querySelector(`label[for="${opt.id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() : null)
          || opt.textContent?.replace(/\s+/g, ' ').trim()
          || `Option ${optIdx + 1}`;

        const isSelected =
          opt.checked ||
          opt.getAttribute('aria-checked') === 'true' ||
          opt.classList.contains('selected') ||
          (opt.tagName !== 'INPUT' && opt.querySelector('input')?.checked);

        options.push({ index: optIdx, label: label.slice(0, 300), selected: !!isSelected });
        optIdx++;
      }

      questions.push({ index: idx, question: qText.slice(0, 500), options, optionCount: options.length });
      idx++;
    }

    return { success: true, pageTitle: document.title, questionCount: questions.length, questions: questions.slice(0, 20) };
  }

  if (action === 'select') {
    const containers = getContainers();
    if (questionIndex < 0 || questionIndex >= containers.length) {
      return { success: false, message: `Question index ${questionIndex} out of range (0–${containers.length - 1})` };
    }

    const optionEls = getOptionEls(containers[questionIndex]);
    if (optionIndex < 0 || optionIndex >= optionEls.length) {
      return { success: false, message: `Option index ${optionIndex} out of range (0–${optionEls.length - 1})` };
    }

    const target = optionEls[optionIndex];
    const label = target.closest('label') || document.querySelector(`label[for="${target.id}"]`);
    if (label) {
      label.click();
    } else {
      target.click();
    }

    const inputEl = target.tagName === 'INPUT' ? target : target.querySelector('input');
    if (inputEl) {
      inputEl.checked = true;
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const chosenLabel = label?.textContent?.replace(/\s+/g, ' ').trim() || target.textContent?.replace(/\s+/g, ' ').trim() || `Option ${optionIndex}`;
    return { success: true, questionIndex, optionIndex, selectedLabel: chosenLabel.slice(0, 200) };
  }

  return { success: false, message: `Unknown quiz action: ${action}` };
}
