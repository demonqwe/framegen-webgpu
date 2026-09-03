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

  // Triple-buffered frame textures for stable motion interpolation
  private texPrev: GPUTexture | null = null;
  private texCurr: GPUTexture | null = null;
  private texCapture: GPUTexture | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  private hasCapturedAnyT0 = false;

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
    if (this.currentWidth === width && this.currentHeight === height && this.texPrev && this.texCurr && this.texCapture) {
      return;
    }

    if (this.texPrev) this.texPrev.destroy();
    if (this.texCurr) this.texCurr.destroy();
    if (this.texCapture) this.texCapture.destroy();

    const desc: GPUTextureDescriptor = {
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    };

    this.texPrev = this.device.createTexture({ ...desc, label: 'FrameScheduler_Prev' });
    this.texCurr = this.device.createTexture({ ...desc, label: 'FrameScheduler_Curr' });
    this.texCapture = this.device.createTexture({ ...desc, label: 'FrameScheduler_Capture' });

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

    // PLL-smoothed arrival clock (from cadence.js algorithms)
    const arrival = now || performance.now();
    const dt = arrival - this.lastArrival;
    if (dt > 0.5 && dt < 500) {
      this.intervalMs = this.intervalMs * 0.9 + dt * 0.1;
    }
    this.lastArrival = arrival;

    const expected = this.schedT + this.intervalMs;
    this.schedT = (!this.schedT || Math.abs(arrival - expected) > 80)
      ? arrival
      : expected + 0.08 * (arrival - expected);

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

    if (!this.texCapture) {
      this.scheduleNextVideoFrame();
      return;
    }

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

    if (deltaT > 0.005 && deltaT < 0.2) {
      const detectedFps = Math.round(1 / deltaT);
      if (detectedFps >= 10 && detectedFps <= 240) {
        this.sourceFps = detectedFps;
      }
    } else {
      this.sourceFps = Math.round(1000 / this.intervalMs);
    }

    // 3. Anime duplicate frame check
    const cadenceResult = await this.pipelineManager.evaluateCadence(this.texCapture, currentMediaTime, now);

    // CRITICAL MUTEX: Await in-flight subframe rendering before rotating textures.
    // Prevents writing to texCapture while interpolation reads from oldPrev/texPrev!
    if (this.activeRenderPromise) {
      try {
        await this.activeRenderPromise;
      } catch {}
    }

    // 4. Rotate textures in triple buffer
    const oldPrev = this.texPrev;
    this.texPrev = this.texCurr;
    this.texCurr = this.texCapture;
    this.texCapture = oldPrev || this.device.createTexture({
      size: [videoWidth, videoHeight],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    // 5. Render base frame -> Canvas (ALWAYS render to maintain source video cadence, never drop to 12 FPS!)
    if (this.hasCapturedAnyT0) {
      await this.renderFrame(this.texPrev || this.texCurr, videoWidth, videoHeight);
    } else {
      await this.renderFrame(this.texCurr, videoWidth, videoHeight);
    }

    // 6. Schedule real motion-interpolated sub-frames if enabled
    const isHighFpsSource = this.sourceFps >= this.settings.autoBypassFps;
    const shouldInterpolate = !this.isCompareMode && this.settings.mode !== 'upscale_only' && !isHighFpsSource && this.hasCapturedAnyT0 && !!this.texPrev && !!this.texCurr;

    if (shouldInterpolate) {
      // Use PLL-smoothed intervalMs clamped to [16ms .. 100ms] to eliminate sudden drops to 24 FPS
      const durationMs = (deltaT > 0.015 && deltaT < 0.1) ? deltaT * 1000 : this.intervalMs;
      this.scheduleSubframes(durationMs, videoWidth, videoHeight, this.texPrev!, this.texCurr!, cadenceResult.isDuplicate);
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
    isDuplicate = false
  ): void {
    this.clearTimers();
    const steps = this.pipelineManager.getInterpolationSteps(this.sourceFps);
    const stableDuration = Math.min(100, Math.max(16, frameDurationMs));

    for (const step of steps) {
      const delay = Math.max(4, Math.round(stableDuration * step));
      const timer = window.setTimeout(() => {
        if (!this.isRunning || this.video.paused) return;
        if (this.isGpuRendering) return; // Drop subframe if GPU is busy to avoid queue buildup
        this.renderInterpolated(t0Texture, t1Texture, step, width, height, isDuplicate);
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
    isDuplicate = false
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

        if (isDuplicate && this.settings.animeCadenceDetection) {
          // Smart Anime Cadence: frames are identical drawings.
          // Skip heavy neural motion estimation to eliminate line warping / artifacts,
          // while maintaining rock-solid 60 FPS output cadence!
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

  public destroy(): void {
    this.stop();
    this.removeEventListeners();
    if (this.texPrev) this.texPrev.destroy();
    if (this.texCurr) this.texCurr.destroy();
    if (this.texCapture) this.texCapture.destroy();
    this.texPrev = null;
    this.texCurr = null;
    this.texCapture = null;
  }
}
