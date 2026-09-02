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

    // FrameGen Engine & Neural Models
    framegenEngineLabel: 'Движок генерации',
    neuralModelLabel: 'Модель нейросети',
    engineNeural: 'EMA-VFI (WebGPU)',
    engineMotionFlow: 'Motion Flow (Шейдер)',
    modelV7s: 'v7 Small (2.9 МБ)',
    modelTfact2: 'v6 T-Fact2 (4.5 МБ)',
    neuralResLabel: 'Качество нейросети',
    resNative: 'Нативное (5060 Ti / Full)',
    res720p: '720p (Сбалансированное)',
    res540p: '540p (Слабый ПК/Ноутбук)',
    
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
    siteProfilePrefix: 'Сайт:',
    globalProfile: 'Глобальный (По умолчанию)',
    makeDefaultBtn: 'Сделать по умолчанию для новых сайтов',
    savedAsDefaultToast: 'Сохранено как шаблон по умолчанию!',
    
    // Updates & Footer
    footerHint: 'G: Вкл/Выкл • C: Сравнение • Shift+D: HUD',
    
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

    // FrameGen Engine & Neural Models
    framegenEngineLabel: 'FrameGen Engine',
    neuralModelLabel: 'Neural Model',
    engineNeural: 'EMA-VFI (WebGPU)',
    engineMotionFlow: 'Motion Flow (Shader)',
    modelV7s: 'v7 Small (2.9 MB)',
    modelTfact2: 'v6 T-Fact2 (4.5 MB)',
    neuralResLabel: 'Neural Quality',
    resNative: 'Native (5060 Ti / Full)',
    res720p: '720p (Balanced)',
    res540p: '540p (Eco / Low-End)',
    
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
    siteProfilePrefix: 'Site:',
    globalProfile: 'Global (Default)',
    makeDefaultBtn: 'Set as default for new sites',
    savedAsDefaultToast: 'Saved as default profile for new sites!',
    
    // Updates & Footer
    footerHint: 'G: On/Off • C: Compare • Shift+D: HUD',
    
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
