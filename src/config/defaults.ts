/**
 * Global Configuration & Default Settings for FrameGen WebGPU
 */

import { Language } from '../i18n/translations';

export type OperationMode = 'hybrid' | 'generator_only' | 'upscale_only';
export type Multiplier = 2 | 3 | 4;
export type MultiplierMode = 'fixed' | 'target_fps';
export type TargetResolution = '1440p' | '4k' | 'auto';
export type ScalerAlgorithm = 'fsr' | 'anime4k' | 'span' | 'compact' | 'bicubic' | 'off';

export interface ExtensionSettings {
  isEnabled: boolean;                   // Global master toggle (default: false)
  language: Language;                   // Localization language (default: 'ru')
  mode: OperationMode;                  // Execution mode (default: 'hybrid')
  multiplierMode: MultiplierMode;       // 'fixed' (x2, x3, x4) | 'target_fps' (adaptive floating multiplier)
  multiplier: Multiplier;               // Fixed multiplier: 2, 3, 4 (default: 2)
  targetFps: number;                    // Target FPS for floating multiplier (e.g. 60, 75, 120, 144, 240, default: 60)
  targetResolution: TargetResolution;   // Target canvas resolution: '1440p', '4k', 'auto' (default: '1440p')
  scalerAlgorithm: ScalerAlgorithm;     // Universal scaler algorithm for all resolutions (default: 'fsr')
  autoBypassFps: number;                // Automatically bypass framegen if source FPS >= threshold (number, default: 60, 0 = disabled)
  animeCadenceDetection: boolean;       // Smart anime duplicate frame skip & phase detection (default: true)
  cadenceThreshold: number;             // L1 difference threshold for duplicate detection (default: 0.01)
  fsrSharpness: number;                 // FSR RCAS / CAS sharpness (0.0 to 1.0, default: 0.8)
  showSideControls: boolean;            // Show left-edge quick access micro-switch (default: true)
  showDebug: boolean;                   // Show Shift+D HUD overlay (default: false)
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  isEnabled: false,
  language: 'ru',
  mode: 'hybrid',
  multiplierMode: 'fixed',
  multiplier: 2,
  targetFps: 60,
  targetResolution: '1440p',
  scalerAlgorithm: 'fsr',
  autoBypassFps: 60,
  animeCadenceDetection: true,
  cadenceThreshold: 0.01,
  fsrSharpness: 0.8,
  showSideControls: true,
  showDebug: false
};
