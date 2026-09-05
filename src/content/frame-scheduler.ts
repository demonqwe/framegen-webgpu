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

  // 12-texture ring pool (matching upstream MIN_FRAME_TEXTURES = 12) to completely eliminate GPU race conditions
  private texturePool: GPUTexture[] = [];
  private poolIndex = 0;
  private readonly POOL_SIZE = 12;
  private texPrev: GPUTexture | null = null;
  private texCurr: GPUTexture | null = null;
  private texCapture: GPUTexture | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  private hasCapturedAnyT0 = false;
  private duplicateSkips = 0;

  // Timing metadata & PLL clock
  private lastPresentedTime = 0;
  private frameCount = 0;
  private lastFpsUpdate = performance.now();
  private currentFps = 0;
  private sourceFps = 24;

  // PLL frame pacing
  private lastArrival = performance.now();
  private intervalMs = 1000 / 24;
  private schedT = 0;

  // GPU Saver: visibility & intersection
  private isTabVisible = typeof document !== 'undefined' ? !document.hidden : true;
  private isVideoIntersecting = true;
  private intersectionObserver: IntersectionObserver | null = null;

  // GPU concurrency mutex: prevents overlapping command submissions and texture race conditions
  private isGpuRendering = false;
  private activeRenderPromise: Promise<void> | null = null;

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
    this.video.addEventListener('seeking', this.onSeeking);
    this.video.addEventListener('waiting', this.onWaiting);
    this.video.addEventListener('stalled', this.onWaiting);
    this.video.addEventListener('canplay', this.onCanPlay);
    this.video.addEventListener('pause', this.onPause);
    this.video.addEventListener('playing', this.onPlay);
    this.video.addEventListener('ended', this.onEnded);
    this.video.addEventListener('loadstart', this.onSeeked);
    this.video.addEventListener('emptied', this.onSeeked);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    if (typeof IntersectionObserver !== 'undefined') {
      try {
        this.intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            this.isVideoIntersecting = entry.isIntersecting;
            if (!this.isVideoIntersecting) {
              this.clearTimers();
            }
          }
        }, { threshold: 0.05 });
        this.intersectionObserver.observe(this.video);
      } catch {}
    }
  }

  private removeEventListeners(): void {
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('seeking', this.onSeeking);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('stalled', this.onWaiting);
    this.video.removeEventListener('canplay', this.onCanPlay);
    this.video.removeEventListener('pause', this.onPause);
    this.video.removeEventListener('playing', this.onPlay);
    this.video.removeEventListener('ended', this.onEnded);
    this.video.removeEventListener('loadstart', this.onSeeked);
    this.video.removeEventListener('emptied', this.onSeeked);

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
  }

  private onVisibilityChange = () => {
    this.isTabVisible = typeof document !== 'undefined' ? !document.hidden : true;
    if (!this.isTabVisible) {
      this.clearTimers();
      this.currentFps = 0;
    } else {
      this.lastArrival = performance.now();
      this.schedT = performance.now();
    }
  };

  private onWaiting = () => {
    // Network buffer starvation: cancel all scheduled subframe timers immediately
    this.clearTimers();
    this.hasCapturedAnyT0 = false;
    this.currentFps = 0;
  };

  private onSeeking = () => {
    this.clearTimers();
    this.resetFrameBuffers();
  };

  private onCanPlay = () => {
    this.lastArrival = performance.now();
    this.schedT = performance.now();
    this.lastPresentedTime = this.video.currentTime;
  };

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
    this.isGpuRendering = false;
    this.activeRenderPromise = null;
    this.clearTimers();
  }

  public updateSettings(newSettings: Partial<ExtensionSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.pipelineManager.updateSettings(this.settings);
  }

  private isCompareMode = false;

  public setCompareMode(active: boolean): void {
    this.isCompareMode = active;
    if (active) {
      this.clearTimers();
    }
  }

  public getCompareMode(): boolean {
    return this.isCompareMode;
  }

  private ensureTextures(width: number, height: number): void {
    if (this.currentWidth === width && this.currentHeight === height && this.texturePool.length === this.POOL_SIZE) {
      return;
    }

    this.texturePool.forEach(t => { try { t.destroy(); } catch {} });
    this.texturePool = [];

    const desc: GPUTextureDescriptor = {
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    };

    for (let i = 0; i < this.POOL_SIZE; i++) {
      this.texturePool.push(this.device.createTexture({ ...desc, label: `FrameScheduler_Pool_${i}` }));
    }

    this.poolIndex = 0;
    this.texCapture = this.texturePool[0];
    this.texCurr = null;
    this.texPrev = null;

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

    if (!this.isTabVisible || !this.isVideoIntersecting) {
      // GPU Saver: Video is hidden or off-screen, skip compute to save 100% GPU
      this.scheduleNextVideoFrame();
      return;
    }

    if (this.video.paused || this.video.ended) {
      this.currentFps = 0;
      this.scheduleNextVideoFrame();
      return;
    }

    // Buffer starvation check: if readyState < 3, playback is stalled waiting for network chunks
    if (this.video.readyState < 3 || this.video.seeking) {
      this.clearTimers();
      this.hasCapturedAnyT0 = false;
      this.currentFps = 0;
    }

    // PLL-smoothed arrival clock (from cadence.js algorithms)
    const arrival = now || performance.now();
    const dt = arrival - this.lastArrival;
    this.lastArrival = arrival;

    // Discontinuity / Network stall: if arrival interval was > 150ms, frame drop or buffering occurred.
    // Reset scheduling and do NOT interpolate across this network gap!
    if (dt > 150) {
      this.schedT = arrival;
      this.hasCapturedAnyT0 = false;
      this.clearTimers();
    } else if (dt > 0.5 && dt <= 150) {
      this.intervalMs = this.intervalMs * 0.9 + dt * 0.1;
      const expected = this.schedT + this.intervalMs;
      this.schedT = (!this.schedT || Math.abs(arrival - expected) > 80)
        ? arrival
        : expected + 0.08 * (arrival - expected);
    }

    const rawW = this.video.videoWidth || (this.video.clientWidth ? Math.round(this.video.clientWidth) : 1280);
    const rawH = this.video.videoHeight || (this.video.clientHeight ? Math.round(this.video.clientHeight) : 720);

    // Video dimensions must be aligned to 16 for WebGPU compute tiles and EMA-VFI
    const videoWidth = Math.max(64, Math.floor(rawW / 16) * 16);
    const videoHeight = Math.max(64, Math.floor(rawH / 16) * 16);

    if (videoWidth < 16 || videoHeight < 16) {
      this.scheduleNextVideoFrame();
      return;
    }

    this.ensureTextures(videoWidth, videoHeight);

    // Get next dedicated texture from the pool (idle for >= 5 frames, zero overwrite collision)
    this.texCapture = this.texturePool[this.poolIndex];
    this.poolIndex = (this.poolIndex + 1) % this.POOL_SIZE;

    // 1. Capture incoming video frame into texCapture
    const captured = await this.captureVideoFrame(videoWidth, videoHeight);
    if (!captured) {
      this.scheduleNextVideoFrame();
      return;
    }

    // 2. Measure source framerate cadence from mediaTime
    const currentMediaTime = metadata.mediaTime || this.video.currentTime;
    const deltaT = currentMediaTime - this.lastPresentedTime;
    this.lastPresentedTime = currentMediaTime;

    // If mediaTime stalled (buffering) or jumped (stall recovery > 100ms), do not interpolate across it!
    if (deltaT <= 0.002 || deltaT > 0.1) {
      this.hasCapturedAnyT0 = false;
      this.clearTimers();
    }

    if (deltaT > 0.005 && deltaT < 0.1) {
      const detectedFps = Math.round(1 / deltaT);
      if (detectedFps >= 10 && detectedFps <= 240) {
        this.sourceFps = detectedFps;
      }
    } else {
      this.sourceFps = Math.round(1000 / this.intervalMs);
    }

    // 3. Anime duplicate frame check
    const cadenceResult = await this.pipelineManager.evaluateCadence(this.texCapture, currentMediaTime, now);

    // 4. Update frame references
    this.texPrev = this.texCurr;
    this.texCurr = this.texCapture;

    // 5. Evaluate whether interpolation will run
    const isHighFpsSource = this.settings.multiplierMode === 'target_fps'
      ? this.sourceFps >= this.settings.targetFps
      : this.sourceFps >= this.settings.autoBypassFps;
    const shouldInterpolate = !this.isCompareMode && this.settings.mode !== 'upscale_only' && !isHighFpsSource && this.hasCapturedAnyT0 && !!this.texPrev && !!this.texCurr;

    // 6. Render base frame -> Canvas
    // CHRONOLOGICAL ORDER:
    // When interpolating, canvas displays texPrev at t=0, then subframes at t=0.5, and then next frame at t=1.0.
    // Displaying texCurr here would show t=1.0 BEFORE the t=0.5 subframe, which was jumping back and forth in time and causing severe ghosting!
    if (this.hasCapturedAnyT0 && shouldInterpolate && this.texPrev) {
      await this.renderFrame(this.texPrev, videoWidth, videoHeight);
    } else {
      await this.renderFrame(this.texCurr, videoWidth, videoHeight);
    }

    // 7. Schedule real motion-interpolated sub-frames if enabled
    if (shouldInterpolate) {
      // Use PLL-smoothed intervalMs clamped to [16ms .. 100ms] to eliminate sudden drops to 24 FPS
      const durationMs = (deltaT > 0.015 && deltaT < 0.1) ? deltaT * 1000 : this.intervalMs;
      this.scheduleSubframes(durationMs, videoWidth, videoHeight, this.texPrev!, this.texCurr!, cadenceResult.isDuplicate, cadenceResult.isSceneCut);
    }

    this.hasCapturedAnyT0 = true;
    this.scheduleNextVideoFrame();
  };

  private async captureVideoFrame(width: number, height: number): Promise<boolean> {
    if (!this.texCapture) return false;

    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.video },
        { texture: this.texCapture },
        [width, height]
      );
      return true;
    } catch {
      try {
        const bitmap = await createImageBitmap(this.video);
        this.device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture: this.texCapture },
          [width, height]
        );
        bitmap.close();
        return true;
      } catch {
        return false;
      }
    }
  }

  private scheduleSubframes(
    frameDurationMs: number,
    width: number,
    height: number,
    t0Texture: GPUTexture,
    t1Texture: GPUTexture,
    isDuplicate = false,
    isSceneCut = false
  ): void {
    this.clearTimers();
    const steps = this.pipelineManager.getInterpolationSteps(this.sourceFps);
    const stableDuration = Math.min(100, Math.max(8, frameDurationMs));

    for (const step of steps) {
      const delay = Math.max(1, Math.round(stableDuration * step));
      const timer = window.setTimeout(() => {
        if (!this.isRunning || this.video.paused) return;
        if (this.isGpuRendering) return; // Drop subframe if GPU is busy to avoid queue buildup
        this.renderInterpolated(t0Texture, t1Texture, step, width, height, isDuplicate, isSceneCut);
      }, delay);
      this.intermediateTimers.push(timer);
    }
  }

  private renderLatencyMs = 0;

  private renderInterpolated(
    t0Texture: GPUTexture,
    t1Texture: GPUTexture,
    stepT: number,
    srcWidth: number,
    srcHeight: number,
    isDuplicate = false,
    isSceneCut = false
  ): void {
    if (this.isGpuRendering || !this.isRunning || this.video.paused) return;
    this.isGpuRendering = true;

    this.activeRenderPromise = (async () => {
      const t0 = performance.now();
      try {
        const currentTarget = this.gpuContext.getCurrentTexture();
        if (!currentTarget) return;
        const targetView = currentTarget.createView();
        const targetWidth = this.canvas.width || srcWidth;
        const targetHeight = this.canvas.height || srcHeight;

        const commandEncoder = this.device.createCommandEncoder({ label: 'FrameScheduler Interpolate' });

        if (isSceneCut) {
          // Hard cut on scene change: display T0 before t=0.5, and T1 at or after t=0.5.
          // Completely eliminates ghostly morphing / blend artifacts on scene transitions!
          const cutTexture = stepT < 0.5 ? t0Texture : t1Texture;
          await this.pipelineManager.upscaleFrame(
            commandEncoder,
            cutTexture,
            targetView,
            srcWidth,
            srcHeight,
            targetWidth,
            targetHeight
          );
        } else if (isDuplicate && this.settings.animeCadenceDetection) {
          this.duplicateSkips++;
          // Smart Anime Cadence: frames are identical drawings.
          // Skip heavy neural motion estimation to eliminate line warping / artifacts,
          // while maintaining rock-solid output cadence!
          await this.pipelineManager.upscaleFrame(
            commandEncoder,
            t1Texture,
            targetView,
            srcWidth,
            srcHeight,
            targetWidth,
            targetHeight
          );
        } else {
          // Run real motion estimation + bidirectional warp + upscaling
          await this.pipelineManager.generateInterpolatedFrame(
            commandEncoder,
            t0Texture,
            t1Texture,
            stepT,
            targetView,
            srcWidth,
            srcHeight,
            targetWidth,
            targetHeight
          );
        }

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
        console.warn('[FrameGen] Interpolation error:', e);
      } finally {
        this.isGpuRendering = false;
        this.activeRenderPromise = null;
      }
    })();
  }

  private async renderFrame(texture: GPUTexture, srcWidth: number, srcHeight: number): Promise<void> {
    if (this.isGpuRendering && this.activeRenderPromise) {
      try {
        await this.activeRenderPromise;
      } catch {}
    }

    this.isGpuRendering = true;
    this.activeRenderPromise = (async () => {
      const t0 = performance.now();
      try {
        const currentTarget = this.gpuContext.getCurrentTexture();
        if (!currentTarget) return;
        const targetView = currentTarget.createView();
        const targetWidth = this.canvas.width || srcWidth;
        const targetHeight = this.canvas.height || srcHeight;

        const commandEncoder = this.device.createCommandEncoder({ label: 'FrameScheduler Render' });

        // Run pipeline upscaling
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
      } finally {
        this.isGpuRendering = false;
        this.activeRenderPromise = null;
      }
    })();

    await this.activeRenderPromise;
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

  public getDuplicateSkips(): number {
    return this.duplicateSkips;
  }

  public destroy(): void {
    this.stop();
    this.removeEventListeners();
    this.texturePool.forEach(t => { try { t.destroy(); } catch {} });
    this.texturePool = [];
    this.texPrev = null;
    this.texCurr = null;
    this.texCapture = null;
  }
}
