/**
 * Popup Controller: Manages settings, telemetry, localization, and GitHub updates.
 */

import { ExtensionSettings, DEFAULT_SETTINGS, OperationMode, Multiplier, MultiplierMode, ScalerAlgorithm, TargetResolution } from '../config/defaults';
import { getTranslation, Language } from '../i18n/translations';

const CURRENT_VERSION = 'v1.0.6';

document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('masterToggle') as HTMLInputElement;
  const statusText = document.getElementById('statusText') as HTMLElement;
  const fpsCounter = document.getElementById('fpsCounter') as HTMLElement;
  const videoRes = document.getElementById('videoRes') as HTMLElement;

  const scalerSelect = document.getElementById('scalerSelect') as HTMLSelectElement;
  const targetResSelect = document.getElementById('targetResSelect') as HTMLSelectElement;
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

  const langRu = document.getElementById('langRu') as HTMLElement;
  const langEn = document.getElementById('langEn') as HTMLElement;
  const checkUpdatesBtn = document.getElementById('checkUpdatesBtn') as HTMLButtonElement;
  const updateStatusText = document.getElementById('updateStatusText') as HTMLElement;

  let activeMode: OperationMode = 'hybrid';
  let currentLang: Language = 'ru';

  function applyLanguage(lang: Language) {
    currentLang = lang;
    const t = getTranslation(lang);

    if (lang === 'ru') {
      langRu.style.fontWeight = '700';
      langRu.style.color = '#38bdf8';
      langEn.style.fontWeight = '400';
      langEn.style.color = '#94a3b8';
    } else {
      langEn.style.fontWeight = '700';
      langEn.style.color = '#38bdf8';
      langRu.style.fontWeight = '400';
      langRu.style.color = '#94a3b8';
    }

    // Update Text Elements
    const el = (id: string, text: string) => {
      const target = document.getElementById(id);
      if (target) target.textContent = text;
    };

    el('t_brandTitle', t.brandTitle);
    el('t_brandSub', t.brandSub);
    el('t_fpsCounterLabel', t.fpsCounterLabel);
    el('t_resolutionLabel', t.resolutionLabel);
    el('t_playerStatusLabel', t.playerStatusLabel);
    el('t_modeTitle', t.modeTitle);
    el('t_modeHybrid', t.modeHybrid);
    el('t_modeGenOnly', t.modeGenOnly);
    el('t_modeUpscaleOnly', t.modeUpscaleOnly);
    el('t_scalerLabel', t.scalerLabel);
    el('t_targetResLabel', t.targetResLabel);
    el('t_frequencyTypeLabel', t.frequencyTypeLabel);
    el('t_fixedMultiplier', t.fixedMultiplier);
    el('t_floatingMultiplier', t.floatingMultiplier);
    el('t_multiplierLabel', t.multiplierLabel);
    el('t_targetFpsLabel', t.targetFpsLabel);
    el('t_autoBypassLabel', t.autoBypassLabel);
    el('t_autoBypassHint', t.autoBypassHint);
    el('t_sharpnessLabel', t.sharpnessLabel);
    el('t_animeCadenceLabel', t.animeCadenceLabel);
    el('t_sideControlsLabel', t.sideControlsLabel);
    el('t_footerHint', t.footerHint);
    checkUpdatesBtn.textContent = t.checkUpdates;
  }

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
    const t = getTranslation(currentLang);
    if (!status) {
      statusText.textContent = t.searchingPlayer;
      fpsCounter.textContent = '-- FPS';
      videoRes.textContent = '--';
      return;
    }

    const isFresh = Date.now() - (status.timestamp || 0) < 5000;
    if (status.videoDimensions && status.videoDimensions.width) {
      videoRes.textContent = `${status.videoDimensions.width}x${status.videoDimensions.height}`;
    }

    if (status.active && isFresh) {
      statusText.textContent = status.vsrBypass ? t.nativeVsr : t.playing;
      statusText.style.color = status.vsrBypass ? '#22c55e' : '#38bdf8';
      const srcFps = status.sourceFps || 24;
      fpsCounter.textContent = status.vsrBypass ? `${srcFps} FPS` : `${srcFps} → ${status.fps || 60} FPS`;
    } else if (status.hasVideo && isFresh) {
      statusText.textContent = t.paused;
      statusText.style.color = '#94a3b8';
      fpsCounter.textContent = '0 FPS';
    } else {
      statusText.textContent = status.settings?.isEnabled ? t.searchingPlayer : t.disabled;
      statusText.style.color = '#64748b';
      fpsCounter.textContent = '-- FPS';
    }
  }

  // Load Settings (default isEnabled: false)
  chrome.storage.local.get(['frameGenSettings', 'activePlayerStatus'], (result) => {
    const s: ExtensionSettings = result.frameGenSettings ? { ...DEFAULT_SETTINGS, ...result.frameGenSettings } : { ...DEFAULT_SETTINGS };

    masterToggle.checked = s.isEnabled ?? false;
    currentLang = s.language ?? 'ru';
    applyLanguage(currentLang);

    scalerSelect.value = s.scalerAlgorithm ?? 'fsr';
    targetResSelect.value = s.targetResolution ?? '1440p';
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

  function parseVersion(v: string): number[] {
    return v.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  }

  function isNewerVersion(latest: string, current: string): boolean {
    const l = parseVersion(latest);
    const c = parseVersion(current);
    for (let i = 0; i < Math.max(l.length, c.length); i++) {
      const lNum = l[i] || 0;
      const cNum = c[i] || 0;
      if (lNum > cNum) return true;
      if (lNum < cNum) return false;
    }
    return false;
  }

  // Check Updates from GitHub Releases
  async function checkForUpdates() {
    const t = getTranslation(currentLang);
    checkUpdatesBtn.disabled = true;
    checkUpdatesBtn.textContent = t.checking;

    try {
      const res = await fetch('https://api.github.com/repos/demonqwe/framegen-webgpu/releases/latest');
      if (res.ok) {
        const release = await res.json();
        const latestTag = release.tag_name || '';

        if (latestTag && isNewerVersion(latestTag, CURRENT_VERSION)) {
          updateStatusText.innerHTML = `<span style="color:#22c55e;">${t.updateAvailable} ${latestTag}!</span>`;
          checkUpdatesBtn.textContent = t.downloadUpdate;
          checkUpdatesBtn.onclick = () => {
            window.open(release.html_url || 'https://github.com/demonqwe/framegen-webgpu/releases', '_blank');
          };
          checkUpdatesBtn.disabled = false;
          return;
        }
      }
      updateStatusText.textContent = `${CURRENT_VERSION} (${t.latestVersion})`;
      checkUpdatesBtn.textContent = t.checkUpdates;
    } catch {
      updateStatusText.textContent = `${CURRENT_VERSION}`;
      checkUpdatesBtn.textContent = t.checkUpdates;
    } finally {
      checkUpdatesBtn.disabled = false;
    }
  }

  checkUpdatesBtn.addEventListener('click', checkForUpdates);

  // Language Switch Handlers
  langRu.addEventListener('click', () => {
    applyLanguage('ru');
    saveAndApplySettings();
  });

  langEn.addEventListener('click', () => {
    applyLanguage('en');
    saveAndApplySettings();
  });

  // Telemetry updates listener
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
      language: currentLang,
      mode: activeMode,
      multiplierMode: multiplierModeSelect.value as MultiplierMode,
      multiplier: parseInt(multiplierSelect.value, 10) as Multiplier,
      targetFps: parseInt(targetFpsSelect.value, 10),
      targetResolution: targetResSelect.value as TargetResolution,
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
  targetResSelect.addEventListener('change', saveAndApplySettings);
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
