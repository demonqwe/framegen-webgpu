/**
 * Popup Controller: Manages settings, telemetry, and pipeline configuration.
 */

import { ExtensionSettings, DEFAULT_SETTINGS, OperationMode, Multiplier, ScalerAlgorithm } from '../config/defaults';

document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('masterToggle') as HTMLInputElement;
  const statusText = document.getElementById('statusText') as HTMLElement;
  const fpsCounter = document.getElementById('fpsCounter') as HTMLElement;
  const videoRes = document.getElementById('videoRes') as HTMLElement;

  const scalerSelect = document.getElementById('scalerSelect') as HTMLSelectElement;
  const multiplierSelect = document.getElementById('multiplierSelect') as HTMLSelectElement;
  const autoBypassSelect = document.getElementById('autoBypassSelect') as HTMLSelectElement;
  const fsrSharpness = document.getElementById('fsrSharpness') as HTMLInputElement;
  const sharpnessValue = document.getElementById('sharpnessValue') as HTMLElement;
  const animeCadenceDetection = document.getElementById('animeCadenceDetection') as HTMLInputElement;
  const showSideControls = document.getElementById('showSideControls') as HTMLInputElement;
  const segButtons = document.querySelectorAll<HTMLButtonElement>('.seg-btn');

  let activeMode: OperationMode = 'hybrid';

  function setMode(mode: OperationMode) {
    activeMode = mode;
    segButtons.forEach((btn) => {
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function applyStatus(status: any) {
    if (!status) {
      statusText.textContent = 'Поиск плеера...';
      fpsCounter.textContent = '-- FPS';
      videoRes.textContent = '--';
      return;
    }

    const isFresh = Date.now() - (status.timestamp || 0) < 5000;
    if (status.videoDimensions && status.videoDimensions.width) {
      videoRes.textContent = `${status.videoDimensions.width}x${status.videoDimensions.height}`;
    }

    if (status.active && isFresh) {
      statusText.textContent = status.vsrBypass ? 'Исходник (VSR)' : 'Воспроизведение';
      statusText.style.color = status.vsrBypass ? '#22c55e' : '#38bdf8';
      const srcFps = status.sourceFps || 24;
      fpsCounter.textContent = status.vsrBypass ? `${srcFps} FPS` : `${srcFps} → ${status.fps || 60} FPS`;
    } else if (status.hasVideo && isFresh) {
      statusText.textContent = 'Пауза';
      statusText.style.color = '#94a3b8';
      fpsCounter.textContent = '0 FPS';
    } else {
      statusText.textContent = status.settings?.isEnabled ? 'Поиск плеера...' : 'Отключено';
      statusText.style.color = '#64748b';
      fpsCounter.textContent = '-- FPS';
    }
  }

  // Load Settings (default isEnabled: false)
  chrome.storage.local.get(['frameGenSettings', 'activePlayerStatus'], (result) => {
    const s: ExtensionSettings = result.frameGenSettings ? { ...DEFAULT_SETTINGS, ...result.frameGenSettings } : { ...DEFAULT_SETTINGS };

    masterToggle.checked = s.isEnabled ?? false;
    scalerSelect.value = s.scalerAlgorithm ?? 'fsr';
    multiplierSelect.value = String(s.multiplier ?? 2);
    autoBypassSelect.value = String(s.autoBypassFps ?? 60);
    fsrSharpness.value = String(s.fsrSharpness ?? 0.8);
    sharpnessValue.textContent = `${Math.round((s.fsrSharpness ?? 0.8) * 100)}%`;
    animeCadenceDetection.checked = s.animeCadenceDetection ?? true;
    showSideControls.checked = s.showSideControls ?? true;

    setMode(s.mode ?? 'hybrid');

    if (result.activePlayerStatus) {
      applyStatus(result.activePlayerStatus);
    }
  });

  // Listen for telemetry updates
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.activePlayerStatus) {
      applyStatus(changes.activePlayerStatus.newValue);
    }
  });

  const pollInterval = window.setInterval(() => {
    chrome.storage.local.get(['activePlayerStatus'], (res) => {
      if (res.activePlayerStatus) {
        applyStatus(res.activePlayerStatus);
      }
    });
  }, 500);

  window.addEventListener('unload', () => clearInterval(pollInterval));

  // Save Settings
  function saveAndApplySettings() {
    const sh = parseFloat(fsrSharpness.value);
    const updatedSettings: ExtensionSettings = {
      isEnabled: masterToggle.checked,
      mode: activeMode,
      multiplier: parseInt(multiplierSelect.value, 10) as Multiplier,
      scalerAlgorithm: scalerSelect.value as ScalerAlgorithm,
      autoBypassFps: parseInt(autoBypassSelect.value, 10),
      animeCadenceDetection: animeCadenceDetection.checked,
      cadenceThreshold: 0.01,
      fsrSharpness: sh,
      showSideControls: showSideControls.checked,
      showDebug: false
    };

    chrome.storage.local.set({ frameGenSettings: updatedSettings });
  }

  // Event Listeners
  masterToggle.addEventListener('change', saveAndApplySettings);
  scalerSelect.addEventListener('change', saveAndApplySettings);
  multiplierSelect.addEventListener('change', saveAndApplySettings);
  autoBypassSelect.addEventListener('change', saveAndApplySettings);
  animeCadenceDetection.addEventListener('change', saveAndApplySettings);
  showSideControls.addEventListener('change', saveAndApplySettings);

  fsrSharpness.addEventListener('input', () => {
    const sh = parseFloat(fsrSharpness.value);
    sharpnessValue.textContent = `${Math.round(sh * 100)}%`;
    saveAndApplySettings();
  });

  segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn.dataset.mode || 'hybrid') as OperationMode;
      setMode(mode);
      saveAndApplySettings();
    });
  });
});
