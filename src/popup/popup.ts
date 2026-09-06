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
  const presetUltraBtn = document.getElementById('presetUltraBtn') as HTMLButtonElement;
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

  const checkUpdateBtn = document.getElementById('checkUpdateBtn') as HTMLButtonElement | null;
  const checkUpdateIcon = document.getElementById('checkUpdateIcon') as HTMLElement | null;
  const checkUpdateText = document.getElementById('checkUpdateText') as HTMLElement | null;
  const currentVersionText = document.getElementById('currentVersionText') as HTMLElement | null;
  const updateBanner = document.getElementById('updateBanner') as HTMLElement | null;
  const updateBannerTitle = document.getElementById('updateBannerTitle') as HTMLElement | null;
  const updateBannerSub = document.getElementById('updateBannerSub') as HTMLElement | null;
  const updateDownloadLink = document.getElementById('updateDownloadLink') as HTMLAnchorElement | null;

  let activeMode: OperationMode = 'hybrid';
  let currentLang: Language = 'ru';

  const currentVersion = (chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '1.3.1') || '1.3.1';
  if (currentVersionText) {
    currentVersionText.textContent = `v${currentVersion}`;
  }

  let currentDomain = 'global';
  let activeTabId: number | null = null;
  let siteProfilesMap: Record<string, ExtensionSettings> = {};
  let globalSettingsObj: ExtensionSettings = { ...DEFAULT_SETTINGS };

  // Determine current site domain from active tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (tab) {
      activeTabId = tab.id || null;
      if (tab.url) {
        currentDomain = getDomainFromUrl(tab.url);
      }
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
    el('checkUpdateText', (t as any).checkUpdate || 'Обновления');
    el('t_downloadBtn', (t as any).downloadBtn || 'Скачать');

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
    const modelVal = (s.neuralModel === 'v6' || s.neuralModel === 'tfact2') ? 'tfact2' : 'v7s';
    neuralModelSelect.value = modelVal;
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
    const selectedModel = (neuralModelSelect.value === 'tfact2' || (neuralModelSelect.value as any) === 'v6') ? 'tfact2' : 'v7s';
    return {
      isEnabled: masterToggle.checked,
      language: currentLang,
      mode: activeMode,
      framegenEngine: (framegenEngineSelect.value as any) || 'neural',
      neuralModel: selectedModel,
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

    if (currentDomain && currentDomain !== 'global') {
      siteProfilesMap[currentDomain] = { ...updatedSettings };
      chrome.storage.local.set({
        siteProfiles: siteProfilesMap
      });
    } else {
      globalSettingsObj = { ...globalSettingsObj, ...updatedSettings };
      chrome.storage.local.set({
        globalSettings: globalSettingsObj
      });
    }

    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'SETTINGS_UPDATED',
        settings: updatedSettings
      }).catch(() => {});
    }
  }

  // Set Default Template Button
  makeDefaultBtn?.addEventListener('click', () => {
    const current = getFormSettings();
    globalSettingsObj = { ...current };
    chrome.storage.local.set({
      globalSettings: globalSettingsObj
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
    multiplierModeSelect.value = 'target_fps';
    targetFpsSelect.value = '60';
    updateMultiplierModeVisibility('target_fps');
    animeCadenceDetection.checked = true;
    updateEngineVisibility('neural');
    updateSharpnessVisibility('anime4k');
    saveAndApplySettings();
  });

  presetCinemaBtn?.addEventListener('click', () => {
    masterToggle.checked = true;
    setMode('hybrid');
    framegenEngineSelect.value = 'neural';
    neuralModelSelect.value = 'v7s';
    neuralResolutionSelect.value = '720p';
    scalerSelect.value = 'fsr';
    multiplierModeSelect.value = 'target_fps';
    targetFpsSelect.value = '60';
    updateMultiplierModeVisibility('target_fps');
    animeCadenceDetection.checked = false;
    updateEngineVisibility('neural');
    updateSharpnessVisibility('fsr');
    saveAndApplySettings();
  });

  presetUltraBtn?.addEventListener('click', () => {
    masterToggle.checked = true;
    setMode('hybrid');
    framegenEngineSelect.value = 'neural';
    neuralModelSelect.value = 'tfact2';
    neuralResolutionSelect.value = 'native';
    scalerSelect.value = 'anime4k';
    multiplierModeSelect.value = 'target_fps';
    targetFpsSelect.value = '165';
    updateMultiplierModeVisibility('target_fps');
    animeCadenceDetection.checked = true;
    updateEngineVisibility('neural');
    updateSharpnessVisibility('anime4k');
    saveAndApplySettings();
  });

  presetEcoBtn?.addEventListener('click', () => {
    masterToggle.checked = true;
    setMode('hybrid');
    framegenEngineSelect.value = 'neural';
    neuralModelSelect.value = 'v7s';
    neuralResolutionSelect.value = '720p';
    scalerSelect.value = 'fsr';
    multiplierModeSelect.value = 'target_fps';
    targetFpsSelect.value = '60';
    updateMultiplierModeVisibility('target_fps');
    animeCadenceDetection.checked = true;
    updateEngineVisibility('neural');
    updateSharpnessVisibility('fsr');
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
  targetFpsSelect.addEventListener('change', () => {
    multiplierModeSelect.value = 'target_fps';
    updateMultiplierModeVisibility('target_fps');
    saveAndApplySettings();
  });
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

  // Update Checker Logic
  function compareSemver(v1: string, v2: string): number {
    const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
    const p1 = parse(v1);
    const p2 = parse(v2);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }

  async function checkUpdates(manual = false) {
    if (!checkUpdateBtn || !checkUpdateText || !checkUpdateIcon) return;
    const t = getTranslation(currentLang);

    if (manual) {
      checkUpdateIcon.textContent = '⏳';
      checkUpdateText.textContent = (t as any).checkingUpdate || 'Поиск...';
    }

    try {
      let remoteVersion: string | null = null;
      let releasesUrl = 'https://github.com/demonqwe/framegen-webgpu/releases/latest';

      // 1. Fetch latest official GitHub Release (primary source of truth)
      try {
        const res = await fetch(`https://api.github.com/repos/demonqwe/framegen-webgpu/releases/latest?_t=${Date.now()}`, {
          headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        if (res.ok) {
          const rel = await res.json();
          remoteVersion = rel.tag_name ? rel.tag_name.replace(/^v/, '') : null;
          // Direct download link if asset exists
          const zipAsset = (rel.assets || []).find((a: any) => a.name?.endsWith('.zip'));
          if (zipAsset && zipAsset.browser_download_url) {
            releasesUrl = zipAsset.browser_download_url;
          } else if (rel.html_url) {
            releasesUrl = rel.html_url;
          }
        }
      } catch {}

      // 2. Fallback to raw package.json if API was rate-limited
      if (!remoteVersion) {
        try {
          const res = await fetch(`https://raw.githubusercontent.com/demonqwe/framegen-webgpu/main/package.json?_t=${Date.now()}`);
          if (res.ok) {
            const pkg = await res.json();
            remoteVersion = pkg.version;
          }
        } catch {}
      }

      if (remoteVersion) {
        const isNewer = compareSemver(remoteVersion, currentVersion) > 0;
        if (isNewer) {
          if (updateBanner) {
            updateBanner.style.display = 'flex';
          }
          if (updateBannerTitle) {
            updateBannerTitle.textContent = `${(t as any).updateBannerTitle || 'Доступно обновление'} v${remoteVersion}`;
          }
          if (updateBannerSub) {
            updateBannerSub.textContent = `GitHub (У вас: v${currentVersion})`;
          }
          if (updateDownloadLink) {
            updateDownloadLink.href = releasesUrl;
            updateDownloadLink.textContent = `Скачать v${remoteVersion}`;
          }
          checkUpdateBtn.classList.add('has-update');
          checkUpdateIcon.textContent = '🚀';
          checkUpdateText.textContent = `v${remoteVersion}`;

          chrome.storage.local.set({ latestKnownVersion: remoteVersion, lastUpdateCheck: Date.now() });
          return;
        } else {
          if (manual) {
            checkUpdateIcon.textContent = '✅';
            checkUpdateText.textContent = `${(t as any).upToDate || 'Актуально'} (v${currentVersion})`;
            setTimeout(() => {
              if (checkUpdateIcon && checkUpdateText) {
                checkUpdateIcon.textContent = '🔄';
                checkUpdateText.textContent = (t as any).checkUpdate || 'Обновления';
              }
            }, 3000);
          }
          chrome.storage.local.set({ latestKnownVersion: remoteVersion, lastUpdateCheck: Date.now() });
          return;
        }
      }

      throw new Error('No version data');
    } catch {
      if (manual) {
        checkUpdateIcon.textContent = '⚠️';
        checkUpdateText.textContent = (t as any).updateError || 'Ошибка';
        setTimeout(() => {
          if (checkUpdateIcon && checkUpdateText) {
            checkUpdateIcon.textContent = '🔄';
            checkUpdateText.textContent = (t as any).checkUpdate || 'Обновления';
          }
        }, 3000);
      }
    }
  }

  checkUpdateBtn?.addEventListener('click', () => checkUpdates(true));

  // Check cached update state or check periodically
  chrome.storage.local.get(['lastUpdateCheck', 'latestKnownVersion'], (data) => {
    const lastCheck = data?.lastUpdateCheck || 0;
    const cachedVer = data?.latestKnownVersion;
    if (cachedVer && compareSemver(cachedVer, currentVersion) > 0) {
      checkUpdates(false);
    } else if (Date.now() - lastCheck > 4 * 3600 * 1000) {
      checkUpdates(false);
    }
  });
});
