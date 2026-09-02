import * as ort from 'onnxruntime-web';
import { ScalerAlgorithm } from '../config/defaults';
import { Anime4KPass } from '../webgpu/anime4k-pass';

export class UpscalerManager {
  private currentMode: ScalerAlgorithm = 'fsr';
  private anime4kPass: Anime4KPass;

  // ONNX Inference Sessions
  private spanSession: ort.InferenceSession | null = null;
  private compactSession: ort.InferenceSession | null = null;
  private isInitializing = false;

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat) {
    this.anime4kPass = new Anime4KPass(device, presentationFormat);
  }

  public setMode(mode: ScalerAlgorithm): void {
    this.currentMode = mode;
  }

  public async initSession(mode: ScalerAlgorithm): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      if (mode === 'span' && !this.spanSession) {
        const modelUrl = chrome?.runtime?.getURL ? chrome.runtime.getURL('models/span_720p_to_1440p_fp16.onnx') : 'models/span_720p_to_1440p_fp16.onnx';
        try {
          this.spanSession = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all'
          });
          console.log('[FrameGen] SPAN x2 ONNX session initialized.');
        } catch (e) {
          console.warn('[FrameGen] SPAN x2 model not loaded, will fallback to Anime4K WGSL.', e);
        }
      } else if (mode === 'compact' && !this.compactSession) {
        const modelUrl = chrome?.runtime?.getURL ? chrome.runtime.getURL('models/realesr_compact_animevideov3_x2_fp16.onnx') : 'models/realesr_compact_animevideov3_x2_fp16.onnx';
        try {
          this.compactSession = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all'
          });
          console.log('[FrameGen] Real-ESRGAN Compact x2 ONNX session initialized.');
        } catch (e) {
          console.warn('[FrameGen] Real-ESRGAN Compact x2 model not loaded, will fallback to Anime4K WGSL.', e);
        }
      }
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Universal upscaler / filter dispatch.
   */
  public render(
    srcTexture: GPUTexture,
    outputTargetView: GPUTextureView,
    targetWidth: number,
    targetHeight: number,
    sharpness = 0.8
  ): void {
    let passMode: 'anime4k' | 'fsr' | 'bicubic' | 'off' = 'fsr';

    switch (this.currentMode) {
      case 'anime4k':
      case 'span':
      case 'compact':
        passMode = 'anime4k';
        break;
      case 'bicubic':
        passMode = 'bicubic';
        break;
      case 'off':
        passMode = 'off';
        break;
      case 'fsr':
      default:
        passMode = 'fsr';
        break;
    }

    this.anime4kPass.render(
      srcTexture,
      outputTargetView,
      targetWidth,
      targetHeight,
      {
        strength: sharpness,
        thinningThreshold: 0.05,
        scalerMode: passMode
      }
    );
  }

  public destroy(): void {
    this.spanSession = null;
    this.compactSession = null;
    this.anime4kPass.destroy();
  }
}
