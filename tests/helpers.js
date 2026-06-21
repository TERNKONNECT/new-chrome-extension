import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

// page-scripts/* reference bare `document`/`window`/`Node` globals, since
// that's how they run when injected into a real page. Shimming those
// globals from a jsdom fixture lets us call the same functions in Node
// without needing a real browser or extension context.
export function loadFixture(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.com/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  return dom;
}
