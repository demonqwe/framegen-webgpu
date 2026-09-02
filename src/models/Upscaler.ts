import { ScalerAlgorithm } from '../config/defaults';
import { Anime4KPass } from '../webgpu/anime4k-pass';
import { NeuralSRPass } from '../webgpu/neural-sr-pass';

export class UpscalerManager {
  private device: GPUDevice;
  private currentMode: ScalerAlgorithm = 'fsr';
  private anime4kPass: Anime4KPass;
  private neuralSRPass: NeuralSRPass;

  // Output storage texture for neural compute passes
  private intermediateTexture: GPUTexture | null = null;
  private currentBufferWidth = 0;
  private currentBufferHeight = 0;

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat) {
    this.device = device;
    this.anime4kPass = new Anime4KPass(device, presentationFormat);
    this.neuralSRPass = new NeuralSRPass(device);
  }

  public setMode(mode: ScalerAlgorithm): void {
    this.currentMode = mode;
  }

  public isOnnxActive(): boolean {
    return false;
  }

  public async initSession(_mode: ScalerAlgorithm, _target4k = false): Promise<void> {
    // Native WebGPU compute and render pipelines are initialized immediately
  }

  private ensureIntermediateTexture(dstWidth: number, dstHeight: number): void {
    if (this.currentBufferWidth === dstWidth && this.currentBufferHeight === dstHeight && this.intermediateTexture) {
      return;
    }

    if (this.intermediateTexture) {
      this.intermediateTexture.destroy();
    }

    this.intermediateTexture = this.device.createTexture({
      size: [dstWidth, dstHeight],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING
    });

    this.currentBufferWidth = dstWidth;
    this.currentBufferHeight = dstHeight;
  }

  /**
   * Runs high-performance native WebGPU edge-adaptive / deblock compute pass.
   */
  public async renderWithOnnx(
    srcTexture: GPUTexture,
    outputTargetView: GPUTextureView,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number,
    sharpness = 0.8
  ): Promise<boolean> {
    const algo: 'span' | 'compact' = (this.currentMode as any) === 'span' ? 'span' : 'compact';

    try {
      this.ensureIntermediateTexture(targetWidth, targetHeight);
      if (!this.intermediateTexture) {
        this.render(srcTexture, outputTargetView, targetWidth, targetHeight, sharpness, srcWidth, srcHeight);
        return false;
      }

      // 1. Execute Neural SR Compute Pass on GPU (Zero-Copy)
      this.neuralSRPass.render(
        srcTexture,
        this.intermediateTexture,
        srcWidth,
        srcHeight,
        {
          algorithm: algo,
          strength: sharpness,
          targetWidth,
          targetHeight
        }
      );

      // 2. Output directly to the presentation canvas
      this.anime4kPass.render(
        this.intermediateTexture,
        outputTargetView,
        targetWidth,
        targetHeight,
        {
          strength: sharpness,
          thinningThreshold: 0.05,
          scalerMode: 'off'
        }
      );

      return true;
    } catch (e) {
      console.warn('[FrameGen] Neural SR pass fallback:', e);
      this.render(srcTexture, outputTargetView, targetWidth, targetHeight, sharpness, srcWidth, srcHeight);
      return false;
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
    sharpness = 0.8,
    srcWidth?: number,
    srcHeight?: number
  ): void {
    let passMode: 'anime4k' | 'fsr' | 'bicubic' | 'off' = 'fsr';

    switch (this.currentMode) {
      case 'anime4k':
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

    const inW = srcWidth || srcTexture.width || targetWidth;
    const inH = srcHeight || srcTexture.height || targetHeight;

    this.anime4kPass.render(
      srcTexture,
      outputTargetView,
      inW,
      inH,
      {
        strength: sharpness,
        thinningThreshold: 0.05,
        scalerMode: passMode
      }
    );
  }

  public destroy(): void {
    this.anime4kPass.destroy();
    this.neuralSRPass.destroy();
    if (this.intermediateTexture) {
      this.intermediateTexture.destroy();
      this.intermediateTexture = null;
    }
  }
}
