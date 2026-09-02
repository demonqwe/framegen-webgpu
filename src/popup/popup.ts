/**
 * Popup Controller: Manages settings, telemetry, and pipeline configuration.
 */

import { ExtensionSettings, DEFAULT_SETTINGS, OperationMode, Multiplier, MultiplierMode, ScalerAlgorithm } from '../config/defaults';

document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('masterToggle') as HTMLInputElement;
  const statusText = document.getElementById('statusText') as HTMLElement;
  const fpsCounter = document.getElementById('fpsCounter') as HTMLElement;
  const videoRes = document.getElementById('videoRes') as HTMLElement;

  const scalerSelect = document.getElementById('scalerSelect') as HTMLSelectElement;
  const multiplierModeSelect = document.getElementById('multiplierModeSelect') as HTMLSelectElement;
  const multiplierSelect = document.getElementById('multiplierSelect') as HTMLSelectElement;
  const targetFpsSelect = document.getElementById('targetFpsSelect') as HTMLSelectElement;
  const fixedMultiplierRow = document.getElementById('fixedMultiplierRow') as HTMLElement;
  const targetFpsRow = document.getElementById('targetFpsRow') as HTMLElement;

  const autoBypassFpsInput = document.getElementById('autoBypassFpsInput') as HTMLInputElement;
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

  function updateMultiplierModeVisibility(mode: MultiplierMode) {
    if (mode === 'target_fps') {
      fixedMultiplierRow.style.display = 'none';
      targetFpsRow.style.display = 'flex';
    } else {
      fixedMultiplierRow.style.display = 'flex';
      targetFpsRow.style.display = 'none';
    }
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
    multiplierModeSelect.value = s.multiplierMode ?? 'fixed';
    multiplierSelect.value = String(s.multiplier ?? 2);
    targetFpsSelect.value = String(s.targetFps ?? 60);
    autoBypassFpsInput.value = String(s.autoBypassFps ?? 60);
    fsrSharpness.value = String(s.fsrSharpness ?? 0.8);
    sharpnessValue.textContent = `${Math.round((s.fsrSharpness ?? 0.8) * 100)}%`;
    animeCadenceDetection.checked = s.animeCadenceDetection ?? true;
    showSideControls.checked = s.showSideControls ?? true;

    updateMultiplierModeVisibility(s.multiplierMode ?? 'fixed');
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
    const bypassVal = parseInt(autoBypassFpsInput.value, 10);
    const updatedSettings: ExtensionSettings = {
      isEnabled: masterToggle.checked,
      mode: activeMode,
      multiplierMode: multiplierModeSelect.value as MultiplierMode,
      multiplier: parseInt(multiplierSelect.value, 10) as Multiplier,
      targetFps: parseInt(targetFpsSelect.value, 10),
      scalerAlgorithm: scalerSelect.value as ScalerAlgorithm,
      autoBypassFps: isNaN(bypassVal) ? 60 : Math.max(0, bypassVal),
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
  multiplierModeSelect.addEventListener('change', () => {
    updateMultiplierModeVisibility(multiplierModeSelect.value as MultiplierMode);
    saveAndApplySettings();
  });
  multiplierSelect.addEventListener('change', saveAndApplySettings);
  targetFpsSelect.addEventListener('change', saveAndApplySettings);
  autoBypassFpsInput.addEventListener('input', saveAndApplySettings);
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
