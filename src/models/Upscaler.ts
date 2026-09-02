import * as ort from 'onnxruntime-web';
import { ScalerAlgorithm } from '../config/defaults';
import { Anime4KPass } from '../webgpu/anime4k-pass';
import { TensorTextureConverter, calculatePaddedDimensions } from '../webgpu/tensor-utils';

export class UpscalerManager {
  private device: GPUDevice;
  private currentMode: ScalerAlgorithm = 'fsr';
  private anime4kPass: Anime4KPass;
  private converter: TensorTextureConverter;

  // ONNX Inference Sessions
  private spanSession: ort.InferenceSession | null = null;
  private compactSession: ort.InferenceSession | null = null;
  private compact4kSession: ort.InferenceSession | null = null;
  private isInitializing = false;

  // Intermediate GPU Buffers for ONNX NCHW execution
  private inputBuffer: GPUBuffer | null = null;
  private outputBuffer: GPUBuffer | null = null;
  private outputTexture: GPUTexture | null = null;
  private currentBufferWidth = 0;
  private currentBufferHeight = 0;

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat) {
    this.device = device;
    this.anime4kPass = new Anime4KPass(device, presentationFormat);
    this.converter = new TensorTextureConverter(device);
  }

  public setMode(mode: ScalerAlgorithm): void {
    this.currentMode = mode;
  }

  public isOnnxActive(): boolean {
    if (this.currentMode === 'span' && this.spanSession) return true;
    if (this.currentMode === 'compact' && (this.compactSession || this.compact4kSession)) return true;
    return false;
  }

  public async initSession(mode: ScalerAlgorithm, target4k = false): Promise<void> {
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
          console.log('[FrameGen] SPAN x2 ONNX session initialized on WebGPU.');
        } catch (e) {
          console.warn('[FrameGen] SPAN x2 model not loaded, will run in WGSL mode.', e);
        }
      } else if (mode === 'compact') {
        const modelFileName = target4k ? 'compact_anime_4k_fp16.onnx' : 'realesr_compact_animevideov3_x2_fp16.onnx';
        const modelUrl = chrome?.runtime?.getURL ? chrome.runtime.getURL(`models/${modelFileName}`) : `models/${modelFileName}`;
        try {
          const session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all'
          });
          if (target4k) {
            this.compact4kSession = session;
          } else {
            this.compactSession = session;
          }
          console.log(`[FrameGen] Real-ESRGAN Compact (${target4k ? '4K' : '2x'}) ONNX session initialized on WebGPU.`);
        } catch (e) {
          console.warn('[FrameGen] Real-ESRGAN Compact model not loaded, will run in WGSL mode.', e);
        }
      }
    } finally {
      this.isInitializing = false;
    }
  }

  private ensureBuffers(srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): void {
    if (this.currentBufferWidth === srcWidth && this.currentBufferHeight === srcHeight && this.inputBuffer && this.outputBuffer && this.outputTexture) {
      return;
    }

    if (this.inputBuffer) this.inputBuffer.destroy();
    if (this.outputBuffer) this.outputBuffer.destroy();
    if (this.outputTexture) this.outputTexture.destroy();

    const inSize = 3 * srcWidth * srcHeight * 4; // f32
    const outSize = 3 * dstWidth * dstHeight * 4; // f32

    this.inputBuffer = this.device.createBuffer({
      size: inSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    this.outputBuffer = this.device.createBuffer({
      size: outSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    this.outputTexture = this.device.createTexture({
      size: [dstWidth, dstHeight],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING
    });

    this.currentBufferWidth = srcWidth;
    this.currentBufferHeight = srcHeight;
  }

  /**
   * Runs actual ONNX model inference on WebGPU if loaded, otherwise falls back to Anime4K WGSL pass.
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
    const activeSession = (this.currentMode === 'span' ? this.spanSession : (targetWidth > 2560 ? this.compact4kSession : this.compactSession));
    if (!activeSession) {
      // Fallback to WGSL
      this.render(srcTexture, outputTargetView, targetWidth, targetHeight, sharpness);
      return false;
    }

    try {
      const paddedIn = calculatePaddedDimensions(srcWidth, srcHeight, 16);
      const paddedOut = calculatePaddedDimensions(targetWidth, targetHeight, 16);
      const dstW = targetWidth;
      const dstH = targetHeight;
      this.ensureBuffers(paddedIn.paddedWidth, paddedIn.paddedHeight, paddedOut.paddedWidth, paddedOut.paddedHeight);

      if (!this.inputBuffer || !this.outputBuffer || !this.outputTexture) {
        this.render(srcTexture, outputTargetView, targetWidth, targetHeight, sharpness);
        return false;
      }

      // 1. Texture -> NCHW GPU Buffer
      this.converter.convertTextureToNCHW(srcTexture, this.inputBuffer, paddedIn);

      // 2. Wrap buffer as ONNX Tensor with WebGPU location
      const inputTensor = (ort.Tensor as any).fromGpuBuffer
        ? (ort.Tensor as any).fromGpuBuffer(this.inputBuffer, {
            dataType: 'float32',
            dims: [1, 3, paddedIn.paddedHeight, paddedIn.paddedWidth]
          })
        : null;

      if (inputTensor) {
        const feeds: Record<string, ort.Tensor> = {};
        feeds[activeSession.inputNames[0]] = inputTensor;
        const results = await activeSession.run(feeds);
        const outputTensor = results[activeSession.outputNames[0]];

        // 3. NCHW GPU Buffer -> Output Texture
        if (outputTensor) {
          this.converter.convertNCHWToTexture(this.outputBuffer, this.outputTexture, paddedOut);
          this.anime4kPass.render(this.outputTexture, outputTargetView, dstW, dstH, {
            strength: sharpness,
            thinningThreshold: 0.05,
            scalerMode: 'off'
          });
          return true;
        }
      }
    } catch (e) {
      console.warn('[FrameGen] ONNX inference execution fallback:', e);
    }

    // Fallback pass
    this.render(srcTexture, outputTargetView, targetWidth, targetHeight, sharpness);
    return false;
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
    this.compact4kSession = null;
    this.anime4kPass.destroy();
    if (this.inputBuffer) this.inputBuffer.destroy();
    if (this.outputBuffer) this.outputBuffer.destroy();
    if (this.outputTexture) this.outputTexture.destroy();
  }
}
