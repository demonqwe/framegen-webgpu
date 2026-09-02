/**
 * Popup Controller: Manages settings, telemetry, localization, and GitHub updates.
 */

import { ExtensionSettings, DEFAULT_SETTINGS, OperationMode, Multiplier, MultiplierMode, ScalerAlgorithm, TargetResolution, getDomainFromUrl } from '../config/defaults';
import { getTranslation, Language } from '../i18n/translations';


document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('masterToggle') as HTMLInputElement;

  const siteDomainText = document.getElementById('siteDomainText') as HTMLElement;
  const makeDefaultBtn = document.getElementById('makeDefaultBtn') as HTMLButtonElement;

  const framegenEngineSelect = document.getElementById('framegenEngineSelect') as HTMLSelectElement;
  const neuralModelSelect = document.getElementById('neuralModelSelect') as HTMLSelectElement;
  const neuralModelRow = document.getElementById('neuralModelRow') as HTMLElement;
  const neuralResolutionSelect = document.getElementById('neuralResolutionSelect') as HTMLSelectElement;
  const neuralResolutionRow = document.getElementById('neuralResolutionRow') as HTMLElement;
  const presetAnimeBtn = document.getElementById('presetAnimeBtn') as HTMLButtonElement;
  const presetCinemaBtn = document.getElementById('presetCinemaBtn') as HTMLButtonElement;
  const presetEcoBtn = document.getElementById('presetEcoBtn') as HTMLButtonElement;
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
  const sharpnessRow = document.getElementById('sharpnessRow') as HTMLElement;
  const animeCadenceDetection = document.getElementById('animeCadenceDetection') as HTMLInputElement;
  const showSideControls = document.getElementById('showSideControls') as HTMLInputElement;
  const segButtons = document.querySelectorAll<HTMLButtonElement>('.seg-btn');

  const langRu = document.getElementById('langRu') as HTMLElement;
  const langEn = document.getElementById('langEn') as HTMLElement;

  let activeMode: OperationMode = 'hybrid';
  let currentLang: Language = 'ru';

  let currentDomain = 'global';
  let activeTabId: number | null = null;
  let siteProfilesMap: Record<string, ExtensionSettings> = {};
  let globalSettingsObj: ExtensionSettings = { ...DEFAULT_SETTINGS };

  // Determine current site domain from active tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && tabs[0].url) {
      activeTabId = tabs[0].id || null;
      currentDomain = getDomainFromUrl(tabs[0].url);
    }
  } catch {}

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
    el('t_modeTitle', t.modeTitle);
    el('t_modeHybrid', t.modeHybrid);
    el('t_modeGenOnly', t.modeGenOnly);
    el('t_modeUpscaleOnly', t.modeUpscaleOnly);
    el('t_framegenEngineLabel', (t as any).framegenEngineLabel);
    el('t_neuralModelLabel', (t as any).neuralModelLabel);
    el('t_engineNeural', (t as any).engineNeural);
    el('t_engineMotionFlow', (t as any).engineMotionFlow);
    el('t_modelV7s', (t as any).modelV7s);
    el('t_modelTfact2', (t as any).modelTfact2);
    el('t_neuralResLabel', (t as any).neuralResLabel);
    el('t_resNative', (t as any).resNative);
    el('t_res720p', (t as any).res720p);
    el('t_res540p', (t as any).res540p);
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

    if (siteDomainText) {
      if (currentDomain === 'global') {
        siteDomainText.textContent = `🌐 ${(t as any).globalProfile || 'Глобальный (По умолчанию)'}`;
      } else {
        siteDomainText.textContent = `🌐 ${currentDomain}`;
      }
    }
    if (makeDefaultBtn) {
      makeDefaultBtn.title = (t as any).makeDefaultBtn || 'Сделать по умолчанию для новых сайтов';
    }
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

  function updateEngineVisibility(engine: string) {
    const isNeural = engine === 'neural';
    if (neuralModelRow) neuralModelRow.style.display = isNeural ? 'flex' : 'none';
    if (neuralResolutionRow) neuralResolutionRow.style.display = isNeural ? 'flex' : 'none';
  }

  // Load Settings (Per-site profile with fallback to globalSettings)
  chrome.storage.local.get(['siteProfiles', 'globalSettings', 'frameGenSettings'], (result) => {
    siteProfilesMap = result.siteProfiles || {};
    globalSettingsObj = result.globalSettings || result.frameGenSettings || { ...DEFAULT_SETTINGS };

    const s: ExtensionSettings = (currentDomain !== 'global' && siteProfilesMap[currentDomain])
      ? { ...globalSettingsObj, ...siteProfilesMap[currentDomain] }
      : { ...globalSettingsObj };

    masterToggle.checked = s.isEnabled ?? false;
    currentLang = s.language ?? 'ru';
    applyLanguage(currentLang);

    framegenEngineSelect.value = s.framegenEngine ?? 'neural';
    neuralModelSelect.value = s.neuralModel ?? 'v7s';
    neuralResolutionSelect.value = s.neuralResolution ?? 'native';
    updateEngineVisibility(s.framegenEngine ?? 'neural');

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
    updateSharpnessVisibility(s.scalerAlgorithm ?? 'fsr');
    setMode(s.mode ?? 'hybrid');
  });

  function updateSharpnessVisibility(scaler: string) {
    if (sharpnessRow) {
      sharpnessRow.style.display = (scaler === 'fsr' || scaler === 'anime4k') ? 'flex' : 'none';
    }
  }

  // Language Switch Handlers
  langRu.addEventListener('click', () => {
    applyLanguage('ru');
    saveAndApplySettings();
  });

  langEn.addEventListener('click', () => {
    applyLanguage('en');
    saveAndApplySettings();
  });

  function getFormSettings(): ExtensionSettings {
    const sh = parseFloat(fsrSharpness.value);
    const bypassVal = parseInt(autoBypassFpsInput.value, 10);
    return {
      isEnabled: masterToggle.checked,
      language: currentLang,
      mode: activeMode,
      framegenEngine: (framegenEngineSelect.value as any) || 'neural',
      neuralModel: (neuralModelSelect.value as any) || 'v7s',
      neuralResolution: (neuralResolutionSelect.value as any) || 'native',
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
  }

  // Save Settings
  function saveAndApplySettings() {
    const updatedSettings = getFormSettings();

    if (currentDomain !== 'global') {
      siteProfilesMap[currentDomain] = updatedSettings;
      chrome.storage.local.set({
        siteProfiles: siteProfilesMap,
        frameGenSettings: updatedSettings
      });
    } else {
      globalSettingsObj = updatedSettings;
      chrome.storage.local.set({
        globalSettings: updatedSettings,
        frameGenSettings: updatedSettings
      });
    }

    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'SETTINGS_UPDATED',
        settings: updatedSettings,
        domain: currentDomain
      }).catch(() => {});
    }
  }

  // Set Default Template Button
  makeDefaultBtn?.addEventListener('click', () => {
    const current = getFormSettings();
    globalSettingsObj = current;
    chrome.storage.local.set({
      globalSettings: current,
      frameGenSettings: current
    });
    const orig = makeDefaultBtn.textContent;
    makeDefaultBtn.textContent = '✅ Сохранено!';
    setTimeout(() => {
      if (makeDefaultBtn) makeDefaultBtn.textContent = orig;
    }, 1500);
  });

  // Event Listeners
  masterToggle.addEventListener('change', saveAndApplySettings);
  framegenEngineSelect.addEventListener('change', () => {
    updateEngineVisibility(framegenEngineSelect.value);
    saveAndApplySettings();
  });
  neuralModelSelect.addEventListener('change', saveAndApplySettings);
  neuralResolutionSelect.addEventListener('change', saveAndApplySettings);

  // Quick Presets
  presetAnimeBtn?.addEventListener('click', () => {
    masterToggle.checked = true;
    setMode('hybrid');
    framegenEngineSelect.value = 'neural';
    neuralModelSelect.value = 'tfact2';
    neuralResolutionSelect.value = 'native';
    scalerSelect.value = 'anime4k';
    animeCadenceDetection.checked = true;
    updateEngineVisibility('neural');
    saveAndApplySettings();
  });

  presetCinemaBtn?.addEventListener('click', () => {
    masterToggle.checked = true;
    setMode('hybrid');
    framegenEngineSelect.value = 'neural';
    neuralModelSelect.value = 'v7s';
    neuralResolutionSelect.value = 'native';
    scalerSelect.value = 'fsr';
    animeCadenceDetection.checked = false;
    updateEngineVisibility('neural');
    saveAndApplySettings();
  });

  presetEcoBtn?.addEventListener('click', () => {
    masterToggle.checked = true;
    setMode('hybrid');
    framegenEngineSelect.value = 'neural';
    neuralModelSelect.value = 'v7s';
    neuralResolutionSelect.value = '720p';
    scalerSelect.value = 'fsr';
    animeCadenceDetection.checked = true;
    updateEngineVisibility('neural');
    saveAndApplySettings();
  });

  scalerSelect.addEventListener('change', () => {
    updateSharpnessVisibility(scalerSelect.value);
    saveAndApplySettings();
  });
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
