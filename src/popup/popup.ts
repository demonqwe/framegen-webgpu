/**
 * Popup Controller: Sleek, non-hyped settings management and telemetry.
 */

type ScalerMode = 'anime4k' | 'fsr' | 'bicubic' | 'off';

document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('masterToggle') as HTMLInputElement;
  const statusText = document.getElementById('statusText') as HTMLElement;
  const fpsCounter = document.getElementById('fpsCounter') as HTMLElement;
  const videoRes = document.getElementById('videoRes') as HTMLElement;
  const fpsMode = document.getElementById('fpsMode') as HTMLSelectElement;
  const anime4kStrength = document.getElementById('anime4kStrength') as HTMLInputElement;
  const strengthValue = document.getElementById('strengthValue') as HTMLElement;
  const autoDisableNative = document.getElementById('autoDisableWhenNativeOrHigher') as HTMLInputElement;
  const showSideControls = document.getElementById('showSideControls') as HTMLInputElement;
  const segButtons = document.querySelectorAll<HTMLButtonElement>('.seg-btn');

  let activeScalerMode: ScalerMode = 'anime4k';

  function setScalerMode(mode: ScalerMode) {
    activeScalerMode = mode;
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
      statusText.textContent = status.settings?.enabled ? 'Поиск плеера...' : 'Отключено';
      statusText.style.color = '#64748b';
      fpsCounter.textContent = '-- FPS';
    }
  }

  // Load Settings
  chrome.storage.local.get(['frameGenSettings', 'activePlayerStatus'], (result) => {
    if (result.frameGenSettings) {
      const s = result.frameGenSettings;
      masterToggle.checked = s.enabled ?? true;
      fpsMode.value = (s.targetFpsMode === '2x' || !s.targetFpsMode) ? '60fps' : s.targetFpsMode;
      if (s.anime4kParams) {
        const str = Number(s.anime4kParams.strength ?? 0.8);
        anime4kStrength.value = String(str);
        strengthValue.textContent = `${Math.round(str * 100)}%`;
        if (s.anime4kParams.scalerMode) {
          setScalerMode(s.anime4kParams.scalerMode);
        }
      }
      if (autoDisableNative) {
        autoDisableNative.checked = s.autoDisableWhenNativeOrHigher ?? true;
      }
      if (showSideControls) {
        showSideControls.checked = s.showSideControls ?? true;
      }
    }

    if (result.activePlayerStatus) {
      applyStatus(result.activePlayerStatus);
    }
  });

  // Listen for telemetry
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
    const str = parseFloat(anime4kStrength.value);
    const updatedSettings = {
      enabled: masterToggle.checked,
      targetFpsMode: fpsMode.value,
      resolutionProfile: 'auto',
      anime4kParams: {
        strength: str,
        thinningThreshold: 0.05,
        scalerMode: activeScalerMode
      },
      autoDisableWhenNativeOrHigher: autoDisableNative ? autoDisableNative.checked : true,
      showSideControls: showSideControls ? showSideControls.checked : true
    };

    chrome.storage.local.set({ frameGenSettings: updatedSettings });
  }

  // Events
  masterToggle.addEventListener('change', saveAndApplySettings);
  fpsMode.addEventListener('change', saveAndApplySettings);
  if (autoDisableNative) autoDisableNative.addEventListener('change', saveAndApplySettings);
  if (showSideControls) showSideControls.addEventListener('change', saveAndApplySettings);

  anime4kStrength.addEventListener('input', () => {
    const str = parseFloat(anime4kStrength.value);
    strengthValue.textContent = `${Math.round(str * 100)}%`;
    saveAndApplySettings();
  });

  segButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn.dataset.mode || 'anime4k') as ScalerMode;
      setScalerMode(mode);
      saveAndApplySettings();
    });
  });
});
