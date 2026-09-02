export type Language = 'ru' | 'en';

export const TRANSLATIONS = {
  ru: {
    // Header & Brand
    brandTitle: 'FrameGen WebGPU',
    brandSub: '60-240 FPS & 1440p/4K Scaler',
    
    // Status Panel
    fpsCounterLabel: 'Частота кадров',
    resolutionLabel: 'Разрешение',
    playerStatusLabel: 'Статус плеера',
    searchingPlayer: 'Поиск плеера...',
    playing: 'Воспроизведение',
    paused: 'Пауза',
    disabled: 'Отключено',
    nativeVsr: 'Исходник (VSR)',
    nativeFps: 'Нативный',
    
    // Mode
    modeTitle: 'Режим работы',
    modeHybrid: 'Гибридный',
    modeGenOnly: 'Кадры',
    modeUpscaleOnly: 'Апскейл',
    
    // Scaler & Target Res
    scalerLabel: 'Алгоритм апскейла',
    targetResLabel: 'Целевое разрешение',
    res1440p: '1440p (2560×1440)',
    res4k: '4K UHD (3840×2160)',
    resAuto: 'Авто (Размер экрана)',
    
    // Multiplier & Frequency
    frequencyTypeLabel: 'Тип частоты',
    fixedMultiplier: 'Фиксированный множитель',
    floatingMultiplier: 'Плавающий (Целевой FPS)',
    multiplierLabel: 'Множитель',
    targetFpsLabel: 'Целевой FPS',
    
    // Auto Bypass & Sharpness
    autoBypassLabel: 'Авто-пропуск от (FPS)',
    autoBypassHint: 'FPS (0=Выкл)',
    sharpnessLabel: 'Резкость и шарпенинг',
    animeCadenceLabel: 'Умный каденс аниме (пропуск дубликатов)',
    sideControlsLabel: 'Отображать переключатель слева',
    
    // Updates & Footer
    checkUpdates: 'Проверить обновления',
    checking: 'Проверка...',
    latestVersion: 'У вас последняя версия',
    updateAvailable: 'Доступно обновление',
    downloadUpdate: 'Скачать',
    footerHint: 'Нажмите Shift+D во время видео для мониторинга',
    
    // Side Pill & HUD
    sideOn: 'ON',
    sideOff: 'OFF [VSR Натив]',
    hudTitle: 'Мониторинг WebGPU',
    hudLatency: 'Задержка рендера',
    hudMode: 'Режим',
    hudUpscaler: 'Апскейлер',
    hudEngineNeural: 'Нейросеть WebGPU',
    hudEngineShader: 'Шейдер WebGPU',
    hudEngineOnnx: 'Нейросеть WebGPU',
    hudEngineWgsl: 'Шейдер WebGPU',
    hudVideoSource: 'Видеопоток',
    hudScreenOutput: 'Вывод экрана',
    hudHideHint: 'Shift+D — скрыть'
  },
  en: {
    // Header & Brand
    brandTitle: 'FrameGen WebGPU',
    brandSub: '60-240 FPS & 1440p/4K Scaler',
    
    // Status Panel
    fpsCounterLabel: 'Frame Rate',
    resolutionLabel: 'Resolution',
    playerStatusLabel: 'Player Status',
    searchingPlayer: 'Searching player...',
    playing: 'Playing',
    paused: 'Paused',
    disabled: 'Disabled',
    nativeVsr: 'Source (VSR)',
    nativeFps: 'Native',
    
    // Mode
    modeTitle: 'Operation Mode',
    modeHybrid: 'Hybrid',
    modeGenOnly: 'FrameGen',
    modeUpscaleOnly: 'Upscale',
    
    // Scaler & Target Res
    scalerLabel: 'Upscaling Algorithm',
    targetResLabel: 'Target Resolution',
    res1440p: '1440p (2560×1440)',
    res4k: '4K UHD (3840×2160)',
    resAuto: 'Auto (Screen Size)',
    
    // Multiplier & Frequency
    frequencyTypeLabel: 'Frequency Mode',
    fixedMultiplier: 'Fixed Multiplier',
    floatingMultiplier: 'Floating (Target FPS)',
    multiplierLabel: 'Multiplier',
    targetFpsLabel: 'Target FPS',
    
    // Auto Bypass & Sharpness
    autoBypassLabel: 'Auto-bypass from (FPS)',
    autoBypassHint: 'FPS (0=Off)',
    sharpnessLabel: 'Sharpness & RCAS',
    animeCadenceLabel: 'Anime Smart Cadence (Skip Duplicates)',
    sideControlsLabel: 'Show Quick Switch on Left Edge',
    
    // Updates & Footer
    checkUpdates: 'Check for Updates',
    checking: 'Checking...',
    latestVersion: 'Latest version installed',
    updateAvailable: 'Update available',
    downloadUpdate: 'Download',
    footerHint: 'Press Shift+D during video for Diagnostics HUD',
    
    // Side Pill & HUD
    sideOn: 'ON',
    sideOff: 'OFF [VSR Native]',
    hudTitle: 'WebGPU Diagnostics',
    hudLatency: 'Render Latency',
    hudMode: 'Mode',
    hudUpscaler: 'Upscaler',
    hudEngineNeural: 'Neural WebGPU',
    hudEngineShader: 'Shader WebGPU',
    hudEngineOnnx: 'Neural WebGPU',
    hudEngineWgsl: 'Shader WebGPU',
    hudVideoSource: 'Video Source',
    hudScreenOutput: 'Screen Output',
    hudHideHint: 'Shift+D to hide'
  }
};

export function getTranslation(lang: Language = 'ru') {
  return TRANSLATIONS[lang] || TRANSLATIONS.ru;
}
