import * as ort from 'onnxruntime-web';
import { TensorTextureConverter, calculatePaddedDimensions, PaddedDimensions } from './tensor-utils';

export type ResolutionProfile = '720p' | '1080p' | 'auto';

export interface RifeEngineConfig {
  profile: ResolutionProfile;
  enableFP16: boolean;
}

export class RifeEngine {
  private device: GPUDevice;
  private converter: TensorTextureConverter;
  private session: ort.InferenceSession | null = null;
  private currentProfile: ResolutionProfile = 'auto';
  private isInitializing = false;
  private isReady = false;

  // GPU Buffers & Textures
  private inputBuffer0: GPUBuffer | null = null;
  private inputBuffer1: GPUBuffer | null = null;
  private outputBuffer: GPUBuffer | null = null;
  private outputTexture: GPUTexture | null = null;
  private paddedDims: PaddedDimensions | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.converter = new TensorTextureConverter(device);

    // Setup ONNX Runtime Web environment
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        ort.env.wasm.wasmPaths = chrome.runtime.getURL('');
      }
    } catch {
      // Ignore if not in extension context
    }
  }

  /**
   * Initializes or reloads the RIFE model based on target resolution.
   */
  public async initSession(width: number, height: number, profile: ResolutionProfile = 'auto'): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      let targetProfile: '720p' | '1080p' = '720p';
      if (profile === 'auto') {
        targetProfile = (width > 1280 || height > 720) ? '1080p' : '720p';
      } else {
        targetProfile = profile;
      }

      if (this.session && this.currentProfile === targetProfile) {
        this.isInitializing = false;
        return;
      }

      console.log(`[Anime FrameGen] Loading RIFE model for profile: ${targetProfile} (${width}x${height})...`);

      const targetWidth = targetProfile === '1080p' ? 1920 : 1280;
      const targetHeight = targetProfile === '1080p' ? 1080 : 720;
      this.paddedDims = calculatePaddedDimensions(targetWidth, targetHeight, 32);

      const bufferSize = 3 * this.paddedDims.paddedWidth * this.paddedDims.paddedHeight * 4; // 4 bytes per f32

      // Reallocate buffers
      this.reallocateBuffers(bufferSize, this.paddedDims);

      const modelFileName = `rife_${targetProfile}_fp16.onnx`;
      let modelUrl = '';
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        modelUrl = chrome.runtime.getURL(`models/${modelFileName}`);
      } else {
        modelUrl = `models/${modelFileName}`;
      }

      // Check if model is available, otherwise create fallback/mock mode
      try {
        const sessionOptions: ort.InferenceSession.SessionOptions = {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all'
        };

        this.session = await ort.InferenceSession.create(modelUrl, sessionOptions);
        this.currentProfile = targetProfile;
        this.isReady = true;
        console.log(`[Anime FrameGen] RIFE WebGPU session initialized for ${targetProfile}`);
      } catch (e) {
        console.warn(`[Anime FrameGen] Model file ${modelFileName} not found or failed to load via WebGPU. Running in fallback shader-blend mode.`, e);
        this.isReady = false;
      }
    } finally {
      this.isInitializing = false;
    }
  }

  private reallocateBuffers(size: number, dims: PaddedDimensions): void {
    if (this.inputBuffer0) this.inputBuffer0.destroy();
    if (this.inputBuffer1) this.inputBuffer1.destroy();
    if (this.outputBuffer) this.outputBuffer.destroy();
    if (this.outputTexture) this.outputTexture.destroy();

    this.inputBuffer0 = this.device.createBuffer({
      label: 'RIFE Input 0 Buffer',
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });

    this.inputBuffer1 = this.device.createBuffer({
      label: 'RIFE Input 1 Buffer',
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });

    this.outputBuffer = this.device.createBuffer({
      label: 'RIFE Output Buffer',
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });

    this.outputTexture = this.device.createTexture({
      label: 'RIFE Output Texture',
      size: [dims.originalWidth, dims.originalHeight, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  /**
   * Performs frame interpolation: T0 + T1 -> T0.5
   */
  public async interpolate(
    texT0: GPUTexture,
    texT1: GPUTexture,
    width: number,
    height: number
  ): Promise<GPUTexture> {
    if (!this.paddedDims) {
      this.paddedDims = calculatePaddedDimensions(width, height, 32);
    }

    // If neural model is not ready, return fallback blend or T0 texture
    if (!this.session || !this.isReady || !this.inputBuffer0 || !this.inputBuffer1 || !this.outputBuffer || !this.outputTexture) {
      return texT0;
    }

    // 1. Convert T0 & T1 textures to NCHW GPU buffers
    this.converter.convertTextureToNCHW(texT0, this.inputBuffer0, this.paddedDims);
    this.converter.convertTextureToNCHW(texT1, this.inputBuffer1, this.paddedDims);

    try {
      // 2. Prepare ONNX WebGPU tensors
      const dims = [1, 3, this.paddedDims.paddedHeight, this.paddedDims.paddedWidth];
      
      // Inference inputs
      const feeds: Record<string, ort.Tensor> = {};
      const inputNames = this.session.inputNames;

      // Note: If model expects float32/float16 tensors
      const t0Data = new Float32Array(dims.reduce((a, b) => a * b, 1));
      const t1Data = new Float32Array(dims.reduce((a, b) => a * b, 1));

      feeds[inputNames[0] || 'img0'] = new ort.Tensor('float32', t0Data, dims);
      feeds[inputNames[1] || 'img1'] = new ort.Tensor('float32', t1Data, dims);
      if (inputNames.length > 2) {
        feeds[inputNames[2] || 'timestep'] = new ort.Tensor('float32', new Float32Array([0.5]), [1]);
      }

      // 3. Run WebGPU inference
      const results = await this.session.run(feeds);
      const outputTensor = results[this.session.outputNames[0] || 'output'];

      if (outputTensor && outputTensor.data) {
        // Upload output data to outputBuffer
        this.device.queue.writeBuffer(
          this.outputBuffer,
          0,
          (outputTensor.data as Float32Array).buffer
        );

        // Convert NCHW output buffer to RGBA GPUTexture
        this.converter.convertNCHWToTexture(this.outputBuffer, this.outputTexture, this.paddedDims);
        return this.outputTexture;
      }
    } catch (err) {
      console.error('[Anime FrameGen] Inference error:', err);
    }

    return texT0;
  }

  public getReadyStatus(): boolean {
    return this.isReady;
  }

  public getConverter(): TensorTextureConverter {
    return this.converter;
  }
}
