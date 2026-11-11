// SPDX-License-Identifier: Apache-2.0
// Renders an EmptyContent into a panel's #empty element with DOM APIs only (no markup strings).
import { EmptyContent } from './emptyState';

export function renderEmptyState(el: HTMLElement, content: EmptyContent | undefined, onClear: () => void): void {
  el.hidden = !content;
  el.style.display = content ? 'block' : 'none';
  // Panels re-render on every data push; rebuilding unchanged content would steal focus from the button.
  const sig = content ? JSON.stringify(content) : '';
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  if (!content) {
    el.replaceChildren();
    return;
  }
  const title = document.createElement('div');
  title.className = 'empty-title';
  title.textContent = content.title;
  const parts: HTMLElement[] = [title];
  if (content.hint) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = content.hint;
    if (content.code) {
      const code = document.createElement('code');
      code.textContent = content.code;
      hint.append(' ', code);
    }
    parts.push(hint);
  }
  if (content.clear) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary empty-clear';
    button.textContent = 'Clear filters';
    button.addEventListener('click', onClear);
    parts.push(button);
  }
  el.replaceChildren(...parts);
}
