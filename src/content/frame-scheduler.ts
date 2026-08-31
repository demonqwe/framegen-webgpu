import { Anime4KPass, Anime4KParams } from '../webgpu/anime4k-pass';

export type ResolutionProfile = 'auto' | '1080p' | '720p';

export interface SchedulerOptions {
  enabled: boolean;
  targetFpsMode: '60fps' | '120fps' | '2x' | 'native';
  resolutionProfile: ResolutionProfile;
  anime4kParams: Anime4KParams;
  autoDisableWhenNativeOrHigher: boolean;
}

export class FrameScheduler {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private gpuContext: GPUCanvasContext;
  private device: GPUDevice;
  private anime4kPass: Anime4KPass;

  private isRunning = false;
  private vfcHandle: number | null = null;
  private intermediateTimerHandle: number | null = null;

  // Frame Textures for T0, T1
  private texT0: GPUTexture | null = null;
  private texT1: GPUTexture | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  private hasCapturedAnyT0 = false;

  // Timing metadata
  private lastPresentedTime = 0;
  private lastRenderTimestamp = 0;
  private frameCount = 0;
  private lastFpsUpdate = performance.now();
  private currentFps = 0;
  private sourceFps = 24;

  private options: SchedulerOptions = {
    enabled: true,
    targetFpsMode: '60fps',
    resolutionProfile: 'auto',
    anime4kParams: { strength: 0.8, thinningThreshold: 0.05 },
    autoDisableWhenNativeOrHigher: true
  };

  constructor(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    gpuContext: GPUCanvasContext,
    device: GPUDevice,
    anime4kPass: Anime4KPass,
    options?: Partial<SchedulerOptions>
  ) {
    this.video = video;
    this.canvas = canvas;
    this.gpuContext = gpuContext;
    this.device = device;
    this.anime4kPass = anime4kPass;

    if (options) {
      this.options = { ...this.options, ...options };
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
    if (this.intermediateTimerHandle !== null) {
      clearTimeout(this.intermediateTimerHandle);
      this.intermediateTimerHandle = null;
    }
    this.currentFps = 0;
    this.frameCount = 0;
  };

  private onPlay = () => {
    if (!this.isRunning && this.options.enabled) {
      this.start();
    }
  };

  private onEnded = () => {
    this.stop();
  };

  private resetFrameBuffers(): void {
    this.lastPresentedTime = 0;
    this.lastRenderTimestamp = 0;
    this.hasCapturedAnyT0 = false;
    this.currentFps = 0;
  }

  public updateOptions(newOptions: Partial<SchedulerOptions>): void {
    this.options = { ...this.options, ...newOptions };
  }

  private ensureTextures(width: number, height: number): void {
    const safeW = Math.max(640, width || 1280);
    const safeH = Math.max(360, height || 720);

    if (this.currentWidth === safeW && this.currentHeight === safeH && this.texT0 && this.texT1) {
      return;
    }

    if (this.texT0) this.texT0.destroy();
    if (this.texT1) this.texT1.destroy();

    this.currentWidth = safeW;
    this.currentHeight = safeH;
    this.hasCapturedAnyT0 = false;

    // Both textures have COPY_SRC and COPY_DST for queue transfers
    const textureDesc: GPUTextureDescriptor = {
      size: [safeW, safeH, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.STORAGE_BINDING
    };

    this.texT0 = this.device.createTexture({ ...textureDesc, label: 'Frame T0 Texture' });
    this.texT1 = this.device.createTexture({ ...textureDesc, label: 'Frame T1 Texture' });
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Anime FrameGen] Frame scheduler started.');

    if ('requestVideoFrameCallback' in this.video) {
      this.scheduleNextVideoFrame();
    } else {
      this.startRafFallback();
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.vfcHandle !== null && 'cancelVideoFrameCallback' in this.video) {
      (this.video as any).cancelVideoFrameCallback(this.vfcHandle);
      this.vfcHandle = null;
    }
    if (this.intermediateTimerHandle !== null) {
      clearTimeout(this.intermediateTimerHandle);
      this.intermediateTimerHandle = null;
    }
    this.resetFrameBuffers();
  }

  public destroy(): void {
    this.stop();
    this.removeEventListeners();
    if (this.texT0) this.texT0.destroy();
    if (this.texT1) this.texT1.destroy();
  }

  private scheduleNextVideoFrame(): void {
    if (!this.isRunning) return;

    this.vfcHandle = (this.video as any).requestVideoFrameCallback(this.onVideoFrame);
  }

  private async captureVideoFrame(videoWidth: number, videoHeight: number): Promise<boolean> {
    if (!this.texT1) return false;

    // 1. Primary: createImageBitmap
    try {
      const bmp = await createImageBitmap(this.video);
      const bW = bmp.width || videoWidth;
      const bH = bmp.height || videoHeight;
      this.device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: this.texT1 },
        [bW, bH]
      );
      bmp.close();
      return true;
    } catch {}

    // 2. Direct HTMLVideoElement fallback
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.video },
        { texture: this.texT1 },
        [videoWidth, videoHeight]
      );
      return true;
    } catch {}

    // 3. WebCodecs VideoFrame fallback
    if (typeof VideoFrame !== 'undefined') {
      try {
        const frame = new VideoFrame(this.video);
        this.device.queue.copyExternalImageToTexture(
          { source: frame },
          { texture: this.texT1 },
          [videoWidth, videoHeight]
        );
        frame.close();
        return true;
      } catch (err) {
        console.warn('[Anime FrameGen] Capture error:', err);
      }
    }

    return false;
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

    // 1. Capture new incoming frame into T1 texture via ImageBitmap
    const captured = await this.captureVideoFrame(videoWidth, videoHeight);
    if (!captured) {
      this.scheduleNextVideoFrame();
      return;
    }

    const presentedTime = metadata?.presentedTime ?? now;
    const deltaT = this.lastPresentedTime > 0 ? (presentedTime - this.lastPresentedTime) : 41.6;
    this.lastPresentedTime = presentedTime;

    if (deltaT > 6 && deltaT < 100) {
      const instantFps = Math.round(1000 / deltaT);
      if (instantFps >= 15 && instantFps <= 240) {
        this.sourceFps = Math.round(this.sourceFps * 0.85 + instantFps * 0.15);
      }
    }

    const isDiscontinuous = deltaT <= 0 || deltaT > 120;

    // 2. Render current original frame (T1) immediately on canvas via Scaler Pass
    this.renderToCanvas(this.texT1, videoWidth, videoHeight, null, 0.0);
    this.recordFrameRendered();

    // 3. Smart Frame Generation:
    // If source is already 50/60 FPS (deltaT <= 22ms), do not double to 120 FPS unless mode is '120fps'
    const isSourceAlready60Fps = deltaT <= 22;
    const isNativeMode = this.options.targetFpsMode === 'native';
    const is120Mode = this.options.targetFpsMode === '120fps';
    
    // Only interpolate intermediate frame when needed (e.g. 24/30 FPS -> 60 FPS, or 60 FPS -> 120 FPS in 120 mode)
    const shouldInterpolate = !isNativeMode && (is120Mode || !isSourceAlready60Fps);

    if (shouldInterpolate && !isDiscontinuous && this.hasCapturedAnyT0 && this.lastRenderTimestamp > 0) {
      const halfDelta = Math.max(8, Math.min(deltaT / 2, 35));

      // Dual-texture hardware GPU interpolation (0.1ms latency)
      this.intermediateTimerHandle = window.setTimeout(() => {
        if (!this.isRunning || !this.texT0 || !this.texT1 || this.video.paused) return;
        this.renderToCanvas(this.texT0, videoWidth, videoHeight, this.texT1, 0.5);
        this.recordFrameRendered();
      }, halfDelta);
    }

    // 4. Shift queue: copy T1 to T0
    try {
      const copyEncoder = this.device.createCommandEncoder({ label: 'T1->T0 Shift Encoder' });
      copyEncoder.copyTextureToTexture(
        { texture: this.texT1 },
        { texture: this.texT0 },
        [videoWidth, videoHeight, 1]
      );
      this.device.queue.submit([copyEncoder.finish()]);
      this.hasCapturedAnyT0 = true;
    } catch (e) {
      console.warn('[Anime FrameGen] Texture shift error:', e);
    }

    this.lastRenderTimestamp = now;

    // Schedule next callback
    this.scheduleNextVideoFrame();
  };

  private renderToCanvas(
    tex0: GPUTexture,
    width: number,
    height: number,
    tex1: GPUTexture | null = null,
    mixFactor = 0.0
  ): void {
    try {
      const currentTexture = this.gpuContext.getCurrentTexture();
      const targetView = currentTexture.createView();

      // Only auto-bypass if the source video ALREADY matches or exceeds the display resolution (e.g. 1440p / 4K on 1440p monitor)
      const targetW = this.canvas.width || 1920;
      const targetH = this.canvas.height || 1080;
      const isAlreadyNativeOrHigher = (height >= targetH && width >= targetW);

      let effectiveParams = this.options.anime4kParams;
      if (this.options.autoDisableWhenNativeOrHigher && isAlreadyNativeOrHigher) {
        effectiveParams = { ...this.options.anime4kParams, strength: 0.0 };
      }

      this.anime4kPass.render(
        tex0,
        targetView,
        width,
        height,
        effectiveParams,
        tex1,
        mixFactor
      );
    } catch (e) {
      console.warn('[Anime FrameGen] Render pass error:', e);
    }
  }

  private recordFrameRendered(): void {
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.currentFps = Math.round((this.frameCount * 1000) / (now - this.lastFpsUpdate));
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }
  }

  public getFps(): number {
    return this.video.paused ? 0 : this.currentFps;
  }

  public getSourceFps(): number {
    return this.sourceFps || 24;
  }

  private startRafFallback(): void {
    const loop = () => {
      if (!this.isRunning) return;
      if (!this.video.paused && !this.video.ended) {
        this.onVideoFrame(performance.now(), { presentedTime: performance.now() });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
