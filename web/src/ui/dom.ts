import { applyI18n, t } from '../i18n';
import { se } from '../audio/se';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Small element factory: el('div.cls', {onclick: fn, title: 'x'}, children...). Text is always set as text, never HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag as K);
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'text') node.textContent = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, ms = 2600): void {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), ms);
}

let modalResolve: ((v: boolean) => void) | null = null;

export function isModalOpen(): boolean {
  return !$('#modal').hidden;
}

/** Yes/No confirmation (ConfirmationDialog.cs). */
export function confirmDialog(message: string): Promise<boolean> {
  const modal = $('#modal');
  $('#modal-text').textContent = message;
  applyI18n(modal);
  modal.hidden = false;
  se('open');
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

export function closeModal(answer: boolean): void {
  const modal = $('#modal');
  if (modal.hidden) return;
  modal.hidden = true;
  se(answer ? 'confirm' : 'cancel');
  modalResolve?.(answer);
  modalResolve = null;
}

export function initModal(): void {
  $('#modal-yes').addEventListener('click', () => closeModal(true));
  $('#modal-no').addEventListener('click', () => closeModal(false));
  $('#modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal(false);
  });
}

export { t };
