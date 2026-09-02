import { ExtensionSettings, DEFAULT_SETTINGS } from '../config/defaults';
import { PipelineManager } from '../core/PipelineManager';

export class FrameScheduler {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private gpuContext: GPUCanvasContext;
  private device: GPUDevice;
  private pipelineManager: PipelineManager;

  private isRunning = false;
  private vfcHandle: number | null = null;
  private intermediateTimers: number[] = [];

  // Frame Textures for T0, T1
  private texT0: GPUTexture | null = null;
  private texT1: GPUTexture | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  private hasCapturedAnyT0 = false;

  // Timing metadata
  private lastPresentedTime = 0;
  private frameCount = 0;
  private lastFpsUpdate = performance.now();
  private currentFps = 0;
  private sourceFps = 24;

  private settings: ExtensionSettings = { ...DEFAULT_SETTINGS };

  constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    gpuContext: GPUCanvasContext,
    device: GPUDevice,
    pipelineManager: PipelineManager,
    settings?: Partial<ExtensionSettings>
  ) {
    this.video = video;
    this.canvas = canvas;
    this.gpuContext = gpuContext;
    this.device = device;
    this.pipelineManager = pipelineManager;

    if (settings) {
      this.settings = { ...this.settings, ...settings };
    }

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.video.addEventListener('seeked', this.onSeeked);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('playing', this.onPlay);
    this.video.addEventListener('ended', this.onEnded);
    this.video.addEventListener('loadstart', this.onSeeked);
    this.video.addEventListener('emptied', this.onSeeked);
  }

  private removeEventListeners(): void {
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('playing', this.onPlay);
    this.video.removeEventListener('ended', this.onEnded);
    this.video.removeEventListener('loadstart', this.onSeeked);
    this.video.removeEventListener('emptied', this.onSeeked);
  }

  private onSeeked = () => {
    this.resetFrameBuffers();
  };

  private onPause = () => {
    this.clearTimers();
    this.currentFps = 0;
    this.frameCount = 0;
  };

  private onPlay = () => {
    if (!this.isRunning && this.settings.isEnabled) {
      this.start();
    }
  };

  private onEnded = () => {
    this.stop();
  };

  private clearTimers(): void {
    for (const timer of this.intermediateTimers) {
      clearTimeout(timer);
    }
    this.intermediateTimers = [];
  }

  private resetFrameBuffers(): void {
    this.lastPresentedTime = 0;
    this.hasCapturedAnyT0 = false;
    this.currentFps = 0;
    this.clearTimers();
  }

  public updateSettings(newSettings: Partial<ExtensionSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.pipelineManager.updateSettings(this.settings);
  }

  private ensureTextures(width: number, height: number): void {
    if (this.currentWidth === width && this.currentHeight === height && this.texT0 && this.texT1) {
      return;
    }

    if (this.texT0) this.texT0.destroy();
    if (this.texT1) this.texT1.destroy();

    const desc: GPUTextureDescriptor = {
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    };

    this.texT0 = this.device.createTexture({ ...desc, label: 'FrameScheduler_T0' });
    this.texT1 = this.device.createTexture({ ...desc, label: 'FrameScheduler_T1' });

    this.currentWidth = width;
    this.currentHeight = height;
    this.hasCapturedAnyT0 = false;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFpsUpdate = performance.now();
    this.frameCount = 0;
    this.scheduleNextVideoFrame();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.vfcHandle !== null && 'cancelVideoFrameCallback' in this.video) {
      (this.video as any).cancelVideoFrameCallback(this.vfcHandle);
      this.vfcHandle = null;
    }
    this.clearTimers();
    this.resetFrameBuffers();
  }

  private scheduleNextVideoFrame(): void {
    if (!this.isRunning) return;

    if ('requestVideoFrameCallback' in this.video) {
      this.vfcHandle = (this.video as any).requestVideoFrameCallback(this.onVideoFrame);
    } else {
      // Fallback requestAnimationFrame
      requestAnimationFrame((now) => {
        this.onVideoFrame(now, { mediaTime: this.video.currentTime, presentedFrames: 0 });
      });
    }
  }

  private onVideoFrame = async (now: DOMHighResTimeStamp, metadata: any) => {
    if (!this.isRunning) return;

    if (this.video.paused || this.video.ended) {
      this.currentFps = 0;
      this.scheduleNextVideoFrame();
      return;
    }

    const videoWidth = this.video.videoWidth || (this.video.clientWidth ? Math.round(this.video.clientWidth) : 1280);
    const videoHeight = this.video.videoHeight || (this.video.clientHeight ? Math.round(this.video.clientHeight) : 720);

    if (videoWidth < 16 || videoHeight < 16) {
      this.scheduleNextVideoFrame();
      return;
    }

    this.ensureTextures(videoWidth, videoHeight);

    if (!this.texT0 || !this.texT1) {
      this.scheduleNextVideoFrame();
      return;
    }

    // 1. Capture incoming video frame into T1 texture
    const captured = await this.captureVideoFrame(videoWidth, videoHeight);
    if (!captured) {
      this.scheduleNextVideoFrame();
      return;
    }

    // 2. Measure source framerate cadence from mediaTime
    const currentMediaTime = metadata.mediaTime || this.video.currentTime;
    const deltaT = currentMediaTime - this.lastPresentedTime;
    this.lastPresentedTime = currentMediaTime;

    if (deltaT > 0.005 && deltaT < 0.2) {
      const detectedFps = Math.round(1 / deltaT);
      if (detectedFps >= 10 && detectedFps <= 240) {
        this.sourceFps = detectedFps;
      }
    }

    // 3. Anime duplicate frame check
    const cadenceResult = await this.pipelineManager.evaluateCadence(this.texT1, currentMediaTime, now);

    // 4. Render base frame T0 -> Canvas
    if (this.hasCapturedAnyT0 && !cadenceResult.isDuplicate) {
      await this.renderFrame(this.texT0, videoWidth, videoHeight);
    }

    // 5. Schedule sub-frame interpolation if enabled
    const isHighFpsSource = this.sourceFps >= this.settings.autoBypassFps;
    const shouldInterpolate = this.settings.mode !== 'upscale_only' && !isHighFpsSource && !cadenceResult.isDuplicate && this.hasCapturedAnyT0;

    if (shouldInterpolate) {
      this.scheduleSubframes(deltaT > 0 ? deltaT * 1000 : 41.6, videoWidth, videoHeight);
    }

    // 6. Swap T0 and T1 textures
    const temp = this.texT0;
    this.texT0 = this.texT1;
    this.texT1 = temp;
    this.hasCapturedAnyT0 = true;

    this.scheduleNextVideoFrame();
  };

  private async captureVideoFrame(width: number, height: number): Promise<boolean> {
    if (!this.texT1) return false;

    try {
      const bitmap = await createImageBitmap(this.video);
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.texT1 },
        [width, height]
      );
      bitmap.close();
      return true;
    } catch {
      return false;
    }
  }

  private scheduleSubframes(frameDurationMs: number, width: number, height: number): void {
    this.clearTimers();
    const steps = this.pipelineManager.getInterpolationSteps(this.sourceFps);

    for (const step of steps) {
      const delay = Math.max(4, Math.round(frameDurationMs * step));
      const timer = window.setTimeout(async () => {
        if (!this.isRunning || this.video.paused || !this.texT0) return;
        await this.renderFrame(this.texT0, width, height);
      }, delay);
      this.intermediateTimers.push(timer);
    }
  }

  private renderLatencyMs = 0;

  private async renderFrame(texture: GPUTexture, srcWidth: number, srcHeight: number): Promise<void> {
    const t0 = performance.now();
    try {
      const currentTarget = this.gpuContext.getCurrentTexture();
      const targetView = currentTarget.createView();
      const targetWidth = this.canvas.width || srcWidth;
      const targetHeight = this.canvas.height || srcHeight;

      const commandEncoder = this.device.createCommandEncoder({ label: 'FrameScheduler Render' });

      // Run pipeline upscaling / warping
      await this.pipelineManager.upscaleFrame(
        commandEncoder,
        texture,
        targetView,
        srcWidth,
        srcHeight,
        targetWidth,
        targetHeight
      );

      this.device.queue.submit([commandEncoder.finish()]);

      const t1 = performance.now();
      const frameCost = t1 - t0;
      this.renderLatencyMs = Math.round((this.renderLatencyMs * 0.8 + frameCost * 0.2) * 10) / 10;

      this.frameCount++;
      const now = performance.now();
      const elapsed = now - this.lastFpsUpdate;
      if (elapsed >= 500) {
        this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
        this.frameCount = 0;
        this.lastFpsUpdate = now;
      }
    } catch (e) {
      console.warn('[FrameGen] Render error:', e);
    }
  }

  public getFps(): number {
    return this.video.paused ? 0 : this.currentFps;
  }

  public getSourceFps(): number {
    return this.sourceFps;
  }

  public getLatencyMs(): number {
    return this.video.paused ? 0 : this.renderLatencyMs;
  }

  public destroy(): void {
    this.stop();
    this.removeEventListeners();
    if (this.texT0) this.texT0.destroy();
    if (this.texT1) this.texT1.destroy();
    this.texT0 = null;
    this.texT1 = null;
  }
}
