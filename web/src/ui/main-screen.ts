// Main system panel: Kurisu, dialogue box, input bar, touch gestures and the
// circular menu (MenuPanelController.cs / SystemPanelController.cs).

import { se } from '../audio/se';
import type { ChatController, ChatState, DialogueView } from '../chat/controller';
import { speechLocale, t } from '../i18n';
import type { Live2DStage } from '../live2d/stage';
import { setImmersive, startListening, stopListening, sttAvailable, vibrate } from '../native/bridge';
import { settings } from '../settings';
import { $, el, toast } from './dom';

export type MenuAction =
  | 'backlog' | 'config' | 'status' | 'fullscreen' | 'changelog' | 'logout' | 'help' | 'shutdown' | 'close';

// Circle centres measured on menu_circles.webp (x, y as fractions; r as a fraction of the width).
const NODES: { action: MenuAction; x: number; y: number; r: number; icon?: string; label: string }[] = [
  { action: 'backlog', x: 0.498, y: 0.135, r: 0.109, icon: 'backlog', label: 'BACKLOG' },
  { action: 'config', x: 0.498, y: 0.297, r: 0.109, icon: 'config', label: 'CONFIG' },
  { action: 'status', x: 0.498, y: 0.459, r: 0.109, icon: 'status', label: 'STATUS' },
  { action: 'fullscreen', x: 0.289, y: 0.54, r: 0.085, label: 'FULL\nSCREEN' },
  { action: 'changelog', x: 0.498, y: 0.621, r: 0.109, icon: 'changelog', label: 'CHANGE LOG' },
  { action: 'logout', x: 0.287, y: 0.702, r: 0.087, label: 'LOG\nOUT' },
  { action: 'help', x: 0.498, y: 0.782, r: 0.109, icon: 'help', label: 'HELP' },
  { action: 'shutdown', x: 0.287, y: 0.875, r: 0.087, label: 'SHUT\nDOWN' },
  { action: 'close', x: 0.707, y: 0.875, r: 0.085, label: 'CLOSE\nMENU' },
];
const MENU_ASPECT = 1080 / 1823;
// Screen area inside monitor.webp (1376x768).
const MONITOR = { x0: 0.2725, x1: 0.8815, y0: 0.181, y1: 0.7969, aspect: 1376 / 768 };

const LONG_PRESS_MS = 600;
const TAP_SLOP = 12;

export class MainScreen {
  private screen = $('#screen-main');
  private panel = $('#system-panel');
  private canvas = $<HTMLCanvasElement>('#live2d');
  private input = $<HTMLInputElement>('#chat-input');
  private dialogue = $('#dialogue');
  private menu = $('#menu');
  private mic = $('#mic-button');
  private gaze: { x: number; y: number } | null = null;
  private menuOpen = false;
  private listening = false;
  private stableHeight = 0;
  private stableOrientation = '';

  onMenuAction: (action: MenuAction) => void = () => undefined;

  readonly view: DialogueView;

  constructor(private stage: Live2DStage | null, private chatRef: () => ChatController) {
    const text = $('#dialogue-text');
    const waiting = $('#waiting');
    const advance = $('#advance');
    const cancel = $('#cancel-button');
    const hint = $('#cancel-hint');
    const autoInd = $('#auto-indicator');
    const autoBtn = $('#auto-button');
    const inputbar = $('#inputbar');

    this.view = {
      setState: (s: ChatState) => {
        this.dialogue.hidden = s === 'input';
        inputbar.hidden = s !== 'input';
        cancel.hidden = s !== 'waiting';
        hint.hidden = s !== 'waiting';
        this.input.disabled = s !== 'input';
        if (s !== 'input' && this.listening) this.stopMic();
      },
      setText: (s) => (text.textContent = s),
      setWaitingDots: (n) => {
        waiting.hidden = n === null;
        waiting.textContent = '.'.repeat(n ?? 0);
      },
      setAdvanceIndicator: (on) => (advance.hidden = !on),
      setPlaceholder: (p) => (this.input.placeholder = p),
      setAuto: (on) => {
        autoInd.hidden = !on;
        autoBtn.classList.toggle('on', on);
      },
    };

    this.bindInput();
    this.bindGestures();
    this.buildMenu();
    $('#auto-button').addEventListener('click', (e) => {
      e.stopPropagation();
      this.chat.toggleAuto();
    });
    $('#cancel-button').addEventListener('click', (e) => {
      e.stopPropagation();
      this.chat.cancel();
    });
    $('#menu-button').addEventListener('click', () => this.openMenu());
    window.addEventListener('resize', () => this.layout());
  }

  private get chat(): ChatController {
    return this.chatRef();
  }

  get isMenuOpen(): boolean {
    return this.menuOpen;
  }

  gazeTarget(): { x: number; y: number } | null {
    return settings.get().gazeTracking ? this.gaze : null;
  }

  show(): void {
    this.screen.hidden = false;
    this.applySettings();
    this.layout();
    this.view.setAuto(settings.get().autoMode);
    this.chat.updatePlaceholder();
  }

  hide(): void {
    this.closeMenu(true);
    this.screen.hidden = true;
    this.stage?.stop();
  }

  applySettings(): void {
    const s = settings.get();
    const textOnly = s.quality === 'text' || !this.stage;
    this.canvas.hidden = textOnly;
    $('.text-only-logo', this.screen).hidden = !textOnly;
    this.mic.hidden = !s.stt;
    if (this.stage) {
      this.stage.setOptions({ maxFps: s.lightweight ? 30 : 0, maxPixelRatio: s.lightweight ? 1 : s.quality === 'high' ? 2 : 1.25 });
      if (textOnly || this.screen.hidden) this.stage.stop();
      else this.stage.start();
    }
  }

  /** Model framing and a canvas that keeps its size when the keyboard opens. */
  layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const orientation = w > h ? 'landscape' : 'portrait';
    if (orientation !== this.stableOrientation || h > this.stableHeight || !document.activeElement?.matches('input')) {
      this.stableOrientation = orientation;
      this.stableHeight = h;
    }
    this.canvas.style.height = `${this.stableHeight}px`;
    this.canvas.style.bottom = 'auto';
    if (!this.stage) return;
    const aspect = w / this.stableHeight;
    // Head near the top of the screen, bust visible above the dialogue box.
    const height = aspect < 0.8 ? 3.5 : aspect < 1.3 ? 3.2 : 3.0;
    this.stage.framing = { height, centerX: 0, centerY: 0.93 - height / 2 };
    if (this.menuOpen) this.placeMenu();
  }

  // ─── Input bar & voice ───

  private bindInput(): void {
    $<HTMLFormElement>('#inputbar').addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.chat.submit(this.input.value)) {
        this.input.value = '';
        this.input.blur();
      }
    });
    // Immersive mode can hide the input behind the keyboard on older Android versions.
    this.input.addEventListener('focus', () => {
      this.chat.activity();
      if (settings.get().fullscreen) setImmersive(false);
    });
    this.input.addEventListener('blur', () => {
      if (settings.get().fullscreen) setImmersive(true);
    });
    this.input.addEventListener('input', () => this.chat.activity());
    this.mic.addEventListener('click', () => (this.listening ? this.stopMic() : this.startMic()));

    document.addEventListener('keydown', (e) => {
      if (this.screen.hidden || !$('#panel').hidden || !$('#modal').hidden) return;
      this.chat.activity();
      if (e.key === 'F3') {
        e.preventDefault();
        this.chat.toggleAuto();
      } else if (e.key === 'Escape') {
        if (this.menuOpen) this.closeMenu();
        else this.openMenu();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && this.chat.state === 'waiting') {
        this.chat.cancel();
      } else if (e.key === 'Enter' && document.activeElement !== this.input && !this.menuOpen) {
        this.chat.tap();
      }
    });
  }

  private startMic(): void {
    if (!sttAvailable()) {
      toast(t('mic_unavailable'));
      return;
    }
    this.chat.activity();
    this.listening = true;
    this.mic.classList.add('recording');
    const before = this.input.value;
    this.input.placeholder = t('mic_listening');
    startListening(speechLocale(), {
      onPartial: (text) => (this.input.value = before ? `${before} ${text}` : text),
      onResult: (text) => {
        const full = (before ? `${before} ${text}` : text).trim();
        this.input.value = '';
        if (full && this.chat.submit(full)) return;
        this.input.value = full;
      },
      onError: (code) => {
        if (code === 'unavailable' || code === 'permission' || code === 'not-allowed') toast(t('mic_unavailable'));
      },
      onEnd: () => this.micStopped(),
    });
  }

  private stopMic(): void {
    stopListening();
    this.micStopped();
  }

  private micStopped(): void {
    this.listening = false;
    this.mic.classList.remove('recording');
    this.chat.updatePlaceholder();
  }

  // ─── Gestures: tap to advance, long press for the menu, touch to be looked at ───

  private bindGestures(): void {
    let downX = 0;
    let downY = 0;
    let moved = false;
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let longPressed = false;

    const isControl = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest('button, input, form, .hud-menu');

    this.panel.addEventListener('pointerdown', (e) => {
      if (this.menuOpen) return;
      this.chat.activity();
      if (isControl(e.target)) return;
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      longPressed = false;
      this.updateGaze(e.clientX, e.clientY);
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (moved || !settings.get().longPressMenu) return;
        longPressed = true;
        if (settings.get().haptics) vibrate(25);
        this.openMenu();
      }, LONG_PRESS_MS);
    });

    this.panel.addEventListener('pointermove', (e) => {
      if (this.menuOpen || e.buttons === 0 && e.pointerType !== 'mouse') return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP) moved = true;
      if (e.pointerType === 'mouse' || e.buttons) this.updateGaze(e.clientX, e.clientY);
    });

    const release = (e: PointerEvent) => {
      clearTimeout(pressTimer);
      if (e.pointerType !== 'mouse') this.gaze = null;
      if (this.menuOpen || longPressed || isControl(e.target)) return;
      if (e.type === 'pointerup' && !moved) {
        if (document.activeElement === this.input) this.input.blur();
        else if (this.chat.state !== 'input') this.chat.tap();
      }
    };
    this.panel.addEventListener('pointerup', release);
    this.panel.addEventListener('pointercancel', release);
    this.panel.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.gaze = null;
    });
    this.panel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (settings.get().longPressMenu && !this.menuOpen) this.openMenu();
    });
  }

  private updateGaze(x: number, y: number): void {
    const w = window.innerWidth;
    const h = this.stableHeight || window.innerHeight;
    const headY = h * 0.3;
    const clamp = (v: number) => Math.max(-0.7, Math.min(0.7, v));
    this.gaze = { x: clamp(((x - w / 2) / (w / 2)) * 1.2), y: clamp((headY - y) / (h * 0.45)) };
  }

  // ─── Circular menu ───

  private buildMenu(): void {
    const circles = $('#menu-circles');
    for (const node of NODES) {
      const size = `${node.r * 2 * 100}%`;
      const button = el('button.menu-node', {
        style: `left:${node.x * 100}%;top:${node.y * 100}%;width:${size};aspect-ratio:1`,
        'aria-label': node.label.replace('\n', ' '),
        onclick: () => this.menuAction(node.action),
      });
      if (node.icon) {
        button.append(
          el('img.def', { src: `img/icon_${node.icon}.webp`, alt: '' }),
          el('img.sel', { src: `img/icon_${node.icon}_sel.webp`, alt: '' }),
        );
        circles.append(
          el('span.menu-label', { style: `left:${(node.x + node.r + 0.1) * 100}%;top:${node.y * 100}%`, text: node.label }),
        );
      } else {
        button.style.whiteSpace = 'pre-line';
        button.textContent = node.label;
      }
      circles.append(button);
    }
    const monitor = el('img.menu-monitor', { src: 'img/monitor.webp', alt: '' });
    this.menu.prepend(monitor);
    this.menu.addEventListener('click', (e) => {
      if (e.target === this.menu) this.closeMenu();
    });
  }

  private menuAction(action: MenuAction): void {
    se(action === 'close' ? 'close' : 'select');
    if (action === 'close') this.closeMenu();
    else if (action === 'fullscreen') {
      settings.update({ fullscreen: !settings.get().fullscreen });
      setImmersive(settings.get().fullscreen);
    } else this.onMenuAction(action);
  }

  openMenu(): void {
    if (this.menuOpen || this.screen.hidden) return;
    this.menuOpen = true;
    this.gaze = null;
    this.input.blur();
    if (this.listening) this.stopMic();
    se('open');
    this.menu.hidden = false;
    this.screen.classList.add('menu-open');
    $('.hud', this.panel).hidden = true;
    this.dialogue.style.visibility = 'hidden';
    $('#inputbar').style.visibility = 'hidden';
    requestAnimationFrame(() => this.placeMenu());
  }

  closeMenu(instant = false): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    if (!instant) se('close');
    this.menu.hidden = true;
    this.screen.classList.remove('menu-open');
    this.panel.style.transform = '';
    this.panel.style.clipPath = '';
    this.panel.onclick = null;
    $('.hud', this.panel).hidden = false;
    this.dialogue.style.visibility = '';
    $('#inputbar').style.visibility = '';
  }

  /** Shrinks the system panel into the lab monitor (SystemPanelController) and lays out the circles. */
  private placeMenu(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const portrait = vw <= vh;
    const monitor = $<HTMLImageElement>('.menu-monitor', this.menu);
    const circles = $('#menu-circles');
    const pad = 12;
    let mx: number, my: number, mw: number;
    let cx: number, cy: number, ch: number;
    if (portrait) {
      mw = Math.min(vw - pad * 2, 560);
      mx = (vw - mw) / 2;
      my = Math.max(pad, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || pad);
      const mh = mw / MONITOR.aspect;
      const top = my + mh + 4;
      ch = Math.min(vh - top - pad, (vw - pad) / MENU_ASPECT);
      cx = (vw - ch * MENU_ASPECT) / 2;
      cy = top + (vh - top - pad - ch) / 2;
    } else {
      ch = vh - pad * 2;
      cx = pad;
      cy = pad;
      const left = cx + ch * MENU_ASPECT + pad;
      mw = Math.min(vw - left - pad, (vh - pad * 2) * MONITOR.aspect);
      mx = left + (vw - left - pad - mw) / 2;
      my = (vh - mw / MONITOR.aspect) / 2;
    }
    const mh = mw / MONITOR.aspect;
    Object.assign(monitor.style, { left: `${mx}px`, top: `${my}px`, width: `${mw}px`, transform: 'none' });
    Object.assign(circles.style, { left: `${cx}px`, top: `${cy}px`, width: `${ch * MENU_ASPECT}px`, height: `${ch}px` });

    // Panel -> monitor screen: fit the width, keep the upper part (Kurisu's face).
    const sx = mx + mw * MONITOR.x0;
    const sy = my + mh * MONITOR.y0;
    const sw = mw * (MONITOR.x1 - MONITOR.x0);
    const sh = mh * (MONITOR.y1 - MONITOR.y0);
    const scale = sw / vw;
    const visible = sh / scale;
    const offsetY = portrait ? Math.max(0, vh * 0.12) : 0;
    const cut = Math.max(0, vh - visible - offsetY);
    this.panel.style.transform = `translate(${sx}px, ${sy - offsetY * scale}px) scale(${scale})`;
    this.panel.style.clipPath = `inset(${offsetY}px 0 ${cut}px 0)`;
    this.panel.onclick = () => this.closeMenu();
  }
}
