import { ScalerAlgorithm } from '../config/defaults';
import { Anime4KPass } from '../webgpu/anime4k-pass';

export class UpscalerManager {
  private currentMode: ScalerAlgorithm = 'fsr';
  private anime4kPass: Anime4KPass;

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat) {
    this.anime4kPass = new Anime4KPass(device, presentationFormat);
  }

  public setMode(mode: ScalerAlgorithm): void {
    this.currentMode = mode;
  }

  public isOnnxActive(): boolean {
    return false;
  }

  public async initSession(_mode: ScalerAlgorithm, _target4k = false): Promise<void> {
    // Native WebGPU render pipelines are initialized immediately
  }

  /**
   * Universal upscaler / filter dispatch (Anime4K / FSR / Bicubic / Direct).
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
    const inW = srcWidth || srcTexture.width || targetWidth;
    const inH = srcHeight || srcTexture.height || targetHeight;

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
  }
}
