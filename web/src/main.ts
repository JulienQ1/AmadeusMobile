import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/mate-sc/400.css';
import '@fontsource/noto-serif/400.css';
import './styles/app.css';

import { Backlog } from './chat/backlog';
import { ChatController } from './chat/controller';
import { applyI18n, t } from './i18n';
import { KurisuAnimator } from './live2d/animator';
import { Live2DStage } from './live2d/stage';
import { MemoryManager } from './memory/memory';
import {
  exitApp,
  onAppState,
  onBackButton,
  requestNotificationPermission,
  setImmersive,
  setKeepScreenOn,
  stopListening,
  stopSpeaking,
} from './native/bridge';
import { settings, type Settings } from './settings';
import { runBoot } from './ui/boot';
import { $, closeModal, confirmDialog, initModal, isModalOpen } from './ui/dom';
import { showLogin } from './ui/login';
import { MainScreen, type MenuAction } from './ui/main-screen';
import { closePanel, initPanels, isPanelOpen, openPanel, type PanelHost } from './ui/panels';

function textureFor(quality: Settings['quality'], maxTexture: number): string {
  return quality === 'high' && !settings.get().lightweight && maxTexture >= 4096 ? 'texture_4096.png' : 'texture_2048.png';
}

function coreVersion(): string {
  try {
    const v = Live2DCubismCore.Version.csmGetVersion();
    return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${v & 0xffff}`;
  } catch {
    return '?';
  }
}

function main(): void {
  applyI18n();
  initModal();
  initPanels();

  const s0 = settings.get();
  setImmersive(s0.fullscreen);
  setKeepScreenOn(s0.keepScreenOn);

  const memory = new MemoryManager();
  const backlog = new Backlog();
  const latencies: number[] = [];
  let operator = '---';

  const maxTexture = Live2DStage.maxTextureSize();
  let stage: Live2DStage | null =
    maxTexture > 0 && typeof Live2DCubismCore !== 'undefined'
      ? new Live2DStage($<HTMLCanvasElement>('#live2d'), {
          modelDir: 'model/kurisu/',
          mocFile: 'kurisu.moc3',
          physicsFile: 'kurisu.physics3.json',
          textureFile: textureFor(s0.quality, maxTexture),
          maxPixelRatio: 2,
          maxFps: 0,
        })
      : null;

  let chat: ChatController | null = null;
  let screen: MainScreen | null = null;
  const animator = new KurisuAnimator({
    isMouthMoving: () => chat?.isMouthMoving() ?? false,
    mouthLevel: () => chat?.mouthLevel() ?? null,
    isIdleForSneeze: () => chat?.isIdleForSneeze() ?? false,
    gazeTarget: () => screen?.gazeTarget() ?? null,
    isSpeaking: () => chat?.isSpeaking() ?? false,
  });
  const mainScreen = new MainScreen(stage, () => chat!);
  screen = mainScreen;
  const isOverlayOpen = () => mainScreen.isMenuOpen || isPanelOpen() || isModalOpen();
  chat = new ChatController({
    animator,
    memory,
    backlog,
    view: mainScreen.view,
    isMenuOpen: isOverlayOpen,
    onLatency: (ms) => {
      latencies.push(ms);
      if (latencies.length > 20) latencies.shift();
    },
  });

  // Load Kurisu while the login screen is shown.
  const stageReady = stage
    ? stage.init().then(
        () => {
          stage!.onFrame = (dt, p) => animator.update(dt, p);
        },
        (e) => {
          console.error('Live2D init failed, text-only mode', e);
          stage = null;
        },
      )
    : Promise.resolve();
  // Chat clock (auto mode, falling asleep), independent of rendering so it also runs in text-only mode.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    chat!.tick(Math.min((now - last) / 1000, 1));
    last = now;
  }, 100);

  const host: PanelHost = {
    memory,
    backlog,
    chat,
    operator: () => operator,
    fps: () => stage?.fps ?? 0,
    latency: () => ({
      last: latencies.length ? latencies[latencies.length - 1] : null,
      avg: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    }),
    coreVersion,
    onSettingsApplied: (changed) => {
      const s = settings.get();
      if (changed.includes('fullscreen')) setImmersive(s.fullscreen);
      if (changed.includes('keepScreenOn')) setKeepScreenOn(s.keepScreenOn);
      if (changed.includes('quality') || changed.includes('lightweight')) {
        void stage?.setTexture(textureFor(s.quality, maxTexture));
      }
      if (changed.includes('language')) chat!.updatePlaceholder();
      mainScreen.applySettings();
      mainScreen.view.setAuto(s.autoMode);
    },
  };

  const enter = async (op: string) => {
    operator = op;
    await runBoot();
    await stageReady;
    if (!stage) {
      settings.get().quality !== 'text' && settings.update({ quality: 'text' });
    }
    mainScreen.show();
    if (settings.get().notifications && !localStorage.getItem('amadeus.notifAsked')) {
      localStorage.setItem('amadeus.notifAsked', '1');
      requestNotificationPermission();
    }
  };

  const logout = () => {
    stopListening();
    stopSpeaking();
    chat!.clearHistory();
    backlog.clear();
    operator = '---';
    mainScreen.hide();
    showLogin((op) => void enter(op));
  };

  mainScreen.onMenuAction = async (action: MenuAction) => {
    switch (action) {
      case 'backlog':
      case 'config':
      case 'status':
      case 'changelog':
      case 'help':
        openPanel(action, host);
        break;
      case 'logout':
        if (await confirmDialog(t('logout_confirm'))) logout();
        break;
      case 'shutdown':
        if (await confirmDialog(t('exit_confirm'))) exitApp();
        break;
    }
  };

  onBackButton(() => {
    if (isModalOpen()) {
      closeModal(false);
      return true;
    }
    if (closePanel()) return true;
    if (mainScreen.isMenuOpen) {
      mainScreen.closeMenu();
      return true;
    }
    if (!$('#screen-main').hidden) {
      if (chat!.state === 'waiting') {
        chat!.cancel();
        return true;
      }
      void confirmDialog(t('exit_confirm')).then((yes) => yes && exitApp());
      return true;
    }
    return false;
  });

  onAppState((state) => {
    if (state === 'resume') {
      setImmersive(settings.get().fullscreen);
      if (!$('#screen-main').hidden) mainScreen.applySettings();
    }
  });

  showLogin((op) => void enter(op));
}

main();
