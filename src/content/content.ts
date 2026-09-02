import { initWebGPU, configureCanvas, GPUContextBundle } from '../webgpu/gpu-context';
import { OverlayManager } from './overlay-manager';
import { FrameScheduler } from './frame-scheduler';
import { PipelineManager } from '../core/PipelineManager';
import { ExtensionSettings, DEFAULT_SETTINGS } from '../config/defaults';
import { getTranslation } from '../i18n/translations';

function isExtensionValid(): boolean {
  try {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function safeStorageSet(data: Record<string, any>): void {
  if (!isExtensionValid()) return;
  try {
    chrome.storage.local.set(data);
  } catch {}
}

function safeStorageGet(keys: string[], cb: (res: any) => void): void {
  if (!isExtensionValid()) return;
  try {
    chrome.storage.local.get(keys, cb);
  } catch {}
}

class ContentController {
  private overlayManager: OverlayManager;
  private gpuBundle: GPUContextBundle | null = null;
  private pipelineManager: PipelineManager | null = null;
  private scheduler: FrameScheduler | null = null;
  private currentVideo: HTMLVideoElement | null = null;

  private sidePillElement: HTMLElement | null = null;
  private debugHudElement: HTMLElement | null = null;
  private showDebugHud = false;
  private vsrBypass = false;
  private isAttaching = false;
  private isTransitioning = false;
  private pillFadeTimeout: number | null = null;

  private settings: ExtensionSettings = { ...DEFAULT_SETTINGS };

  constructor() {
    this.overlayManager = new OverlayManager();
    this.init();
  }

  private getHostName(): string {
    try {
      return window.location.hostname.replace(/^www\./, '') || 'default';
    } catch {
      return 'default';
    }
  }

  private async init(): Promise<void> {
    console.log(`[FrameGen WebGPU] Active in frame: ${window.location.href}`);

    // 1. Load settings with default isEnabled: false
    safeStorageGet(['frameGenSettings', 'showDebug', 'siteVsrOverrides'], (result) => {
      if (result && result.frameGenSettings) {
        this.settings = { ...this.settings, ...result.frameGenSettings };
      }
      if (result && result.showDebug !== undefined) {
        this.showDebugHud = !!result.showDebug;
      }
      if (result && result.siteVsrOverrides) {
        const host = this.getHostName();
        if (result.siteVsrOverrides[host] !== undefined) {
          this.vsrBypass = !!result.siteVsrOverrides[host];
        }
      }
      this.startVideoObservation();
    });

    // 2. Listen for settings changes across frames
    if (isExtensionValid() && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'local') {
            if (changes.frameGenSettings) {
              this.settings = { ...this.settings, ...changes.frameGenSettings.newValue };
              if (this.pipelineManager) {
                this.pipelineManager.updateSettings(this.settings);
              }
              if (this.scheduler) {
                this.scheduler.updateSettings(this.settings);
              }
              if (!this.settings.isEnabled) {
                this.disableFrameGen();
              } else if (this.currentVideo) {
                if (!this.scheduler) {
                  this.attachToVideo(this.currentVideo);
                } else {
                  this.enableFrameGen();
                }
              }
              this.updateSidePill();
            }

            if (changes.showDebug !== undefined) {
              this.showDebugHud = !!changes.showDebug.newValue;
              this.updateDebugHud();
            }

            if (changes.siteVsrOverrides) {
              const overrides = changes.siteVsrOverrides.newValue || {};
              const host = this.getHostName();
              if (overrides[host] !== undefined && overrides[host] !== this.vsrBypass) {
                this.vsrBypass = overrides[host];
                this.applyVsrBypassState();
                this.updateSidePill();
                this.updateDebugHud();
              }
            }
          }
        });
      } catch {}
    }

    // 3. Global video event listeners
    const handleGlobalVideoEvent = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) {
        const v = e.target;
        const src = v.currentSrc || v.src || '';
        if (src.includes('blank.mp4')) return;

        const rect = v.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 140) return;

        if (v !== this.currentVideo || !this.scheduler) {
          this.attachToVideo(v);
        }
      }
    };

    window.addEventListener('play', handleGlobalVideoEvent, true);
    window.addEventListener('playing', handleGlobalVideoEvent, true);
    window.addEventListener('canplay', handleGlobalVideoEvent, true);
    window.addEventListener('loadeddata', handleGlobalVideoEvent, true);
    window.addEventListener('loadedmetadata', handleGlobalVideoEvent, true);
    window.addEventListener('timeupdate', handleGlobalVideoEvent, true);

    // Keyboard shortcut Shift + D for Diagnostic HUD
    window.addEventListener('keydown', (e) => {
      if (e.shiftKey && (e.key === 'D' || e.key === 'd' || e.code === 'KeyD')) {
        const targetTag = (e.target as HTMLElement)?.tagName;
        if (!['INPUT', 'TEXTAREA'].includes(targetTag)) {
          e.preventDefault();
          this.toggleDebugHud();
        }
      }
    }, true);

    // Message fallback
    if (isExtensionValid() && chrome.runtime && chrome.runtime.onMessage) {
      try {
        chrome.runtime.onMessage.addListener(this.handleMessage);
      } catch {}
    }

    // Tab visibility handler
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.scheduler) this.scheduler.stop();
      } else {
        if (this.scheduler && this.currentVideo && !this.currentVideo.paused && this.settings.isEnabled && !this.vsrBypass) {
          this.scheduler.start();
        }
      }
    });

    this.startTelemetryLoop();
  }

  private toggleDebugHud(): void {
    this.showDebugHud = !this.showDebugHud;
    safeStorageSet({ showDebug: this.showDebugHud });
    this.updateDebugHud();
  }

  private async toggleVsrBypass(): Promise<void> {
    if (this.isTransitioning) return;
    this.isTransitioning = true;

    if (this.sidePillElement) {
      this.sidePillElement.style.pointerEvents = 'none';
    }

    try {
      this.vsrBypass = !this.vsrBypass;
      const host = this.getHostName();

      safeStorageGet(['siteVsrOverrides'], (res) => {
        const overrides = res?.siteVsrOverrides || {};
        overrides[host] = this.vsrBypass;
        safeStorageSet({ siteVsrOverrides: overrides });
      });

      this.applyVsrBypassState();
      this.updateSidePill();
      this.updateDebugHud();
    } finally {
      setTimeout(() => {
        this.isTransitioning = false;
        if (this.sidePillElement) {
          this.sidePillElement.style.pointerEvents = 'auto';
        }
      }, 200);
    }
  }

  private applyVsrBypassState(): void {
    const overlay = this.overlayManager.getActiveState();
    if (this.vsrBypass) {
      if (overlay && overlay.canvas) {
        overlay.canvas.style.opacity = '0';
        overlay.canvas.style.visibility = 'hidden';
      }
      if (this.scheduler) {
        this.scheduler.stop();
      }
    } else {
      if (overlay && overlay.canvas) {
        overlay.canvas.style.opacity = '1';
        overlay.canvas.style.visibility = 'visible';
        if (this.gpuBundle) {
          configureCanvas(
            this.gpuBundle.device,
            overlay.canvas,
            this.gpuBundle.presentationFormat
          );
        }
      }
      if (this.scheduler && this.settings.isEnabled && this.currentVideo && !this.currentVideo.paused) {
        this.scheduler.start();
      }
    }
  }

  private startTelemetryLoop(): void {
    window.setInterval(() => {
      const isVisible = !document.hidden;
      const isPlaying = this.currentVideo ? !this.currentVideo.paused && !this.currentVideo.ended : false;
      const hasActiveScheduler = !!(this.scheduler && this.settings.isEnabled && !this.vsrBypass);
      const liveFps = this.scheduler ? this.scheduler.getFps() : 0;
      const sourceFps = this.scheduler ? this.scheduler.getSourceFps() : 24;

      if (this.currentVideo && isVisible) {
        const payload = {
          hasVideo: true,
          active: hasActiveScheduler && isPlaying,
          vsrBypass: this.vsrBypass,
          siteHost: this.getHostName(),
          fps: liveFps,
          sourceFps: sourceFps,
          videoDimensions: {
            width: this.currentVideo.videoWidth || 0,
            height: this.currentVideo.videoHeight || 0
          },
          settings: this.settings,
          timestamp: Date.now()
        };
        safeStorageSet({ activePlayerStatus: payload });
      }

      this.updateSidePill();
      if (this.showDebugHud) {
        this.updateDebugHud();
      }
    }, 500);
  }

  private startVideoObservation(): void {
    this.findAndAttachVideo();

    const observer = new MutationObserver(() => {
      this.findAndAttachVideo();
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    window.setInterval(() => {
      this.findAndAttachVideo();
    }, 2000);
  }

  private findAndAttachVideo(): void {
    if (this.currentVideo && document.contains(this.currentVideo)) {
      const rect = this.currentVideo.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 140) {
        if (!this.currentVideo.paused || !this.hasOtherActivePlayingVideo()) {
          return;
        }
      }
    }

    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    if (videos.length === 0) return;

    const ytMain = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
    if (ytMain && !ytMain.src?.includes('blank.mp4')) {
      const rect = ytMain.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 140) {
        if (this.currentVideo !== ytMain) {
          this.attachToVideo(ytMain);
        }
        return;
      }
    }

    const activeShorts = document.querySelector('ytd-reel-video-renderer[is-active] video') as HTMLVideoElement | null;
    if (activeShorts) {
      if (this.currentVideo !== activeShorts) {
        this.attachToVideo(activeShorts);
      }
      return;
    }

    let candidate: HTMLVideoElement | null = null;
    let maxArea = 0;

    for (const v of videos) {
      const src = v.currentSrc || v.src || '';
      if (src.includes('blank.mp4')) continue;

      const rect = v.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 140) continue;

      const area = rect.width * rect.height;

      if (!v.paused && !v.ended) {
        if (area > maxArea) {
          maxArea = area;
          candidate = v;
        }
      } else if (!candidate && area > maxArea) {
        maxArea = area;
        candidate = v;
      }
    }

    if (candidate && candidate !== this.currentVideo) {
      this.attachToVideo(candidate);
    }
  }

  private hasOtherActivePlayingVideo(): boolean {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    for (const v of videos) {
      if (v !== this.currentVideo && !v.paused && !v.ended) {
        const rect = v.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) {
          return true;
        }
      }
    }
    return false;
  }

  private async ensureWebGPU(): Promise<boolean> {
    if (!this.gpuBundle) {
      this.gpuBundle = await initWebGPU();
      if (!this.gpuBundle) return false;
    }

    if (!this.pipelineManager) {
      this.pipelineManager = new PipelineManager(
        this.gpuBundle.device,
        this.gpuBundle.presentationFormat,
        this.settings
      );
    }

    return true;
  }

  private async attachToVideo(video: HTMLVideoElement): Promise<void> {
    if (this.isAttaching) return;
    this.isAttaching = true;

    try {
      if (this.currentVideo === video && this.scheduler) {
        return;
      }

      if (this.scheduler) {
        this.scheduler.destroy();
        this.scheduler = null;
      }

      this.currentVideo = video;
      const overlay = this.overlayManager.attach(video);

      const success = await this.ensureWebGPU();
      if (!success || !this.gpuBundle || !this.pipelineManager) {
        this.isAttaching = false;
        return;
      }

      configureCanvas(
        this.gpuBundle.device,
        overlay.canvas,
        this.gpuBundle.presentationFormat
      );

      const gpuContext = overlay.canvas.getContext('webgpu') as unknown as GPUCanvasContext;

      this.scheduler = new FrameScheduler(
        video,
        overlay.canvas,
        gpuContext,
        this.gpuBundle.device,
        this.pipelineManager,
        this.settings
      );

      this.overlayManager.setOnResize(() => {
        if (this.gpuBundle) {
          configureCanvas(
            this.gpuBundle.device,
            overlay.canvas,
            this.gpuBundle.presentationFormat
          );
        }
      });

      if (this.settings.isEnabled && !this.vsrBypass) {
        this.scheduler.start();
      }

      this.createOrUpdateSidePill(overlay.wrapper);
      this.updateSidePill();
    } catch (err) {
      console.warn('[FrameGen WebGPU] attachToVideo error:', err);
    } finally {
      this.isAttaching = false;
    }
  }

  private enableFrameGen(): void {
    if (this.scheduler && !this.vsrBypass) {
      this.scheduler.start();
    }
  }

  private disableFrameGen(): void {
    if (this.scheduler) {
      this.scheduler.stop();
    }
  }

  private handleMessage = (
    message: any,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) => {
    if (!message || !message.type) return;

    if (message.type === 'UPDATE_SETTINGS') {
      this.settings = { ...this.settings, ...message.settings };
      if (this.pipelineManager) {
        this.pipelineManager.updateSettings(this.settings);
      }
      if (this.scheduler) {
        this.scheduler.updateSettings(this.settings);
      }
      if (!this.settings.isEnabled) {
        this.disableFrameGen();
      } else {
        this.enableFrameGen();
      }
      this.updateSidePill();
      sendResponse({ success: true });
      return;
    }

    if (message.type === 'GET_STATUS') {
      sendResponse({
        hasVideo: !!this.currentVideo,
        active: !!(this.scheduler && this.settings.isEnabled && !this.vsrBypass),
        fps: this.scheduler ? this.scheduler.getFps() : 0,
        sourceFps: this.scheduler ? this.scheduler.getSourceFps() : 24,
        siteHost: this.getHostName(),
        settings: this.settings
      });
      return;
    }
  };

  // Compact Left Edge Micro-Switch with enlarged hit target & center-focused hover area
  private createOrUpdateSidePill(wrapper: HTMLElement): void {
    if (!this.settings.showSideControls) {
      if (this.sidePillElement && this.sidePillElement.parentElement) {
        this.sidePillElement.parentElement.removeChild(this.sidePillElement);
      }
      this.sidePillElement = null;
      return;
    }

    if (!this.sidePillElement) {
      const container = document.createElement('div');
      container.className = 'framegen-side-container';
      container.style.position = 'absolute';
      container.style.left = '0';
      container.style.top = '50%';
      container.style.transform = 'translateY(-50%)';
      container.style.zIndex = '2147483647';
      container.style.pointerEvents = 'auto';
      container.style.display = 'flex';
      container.style.alignItems = 'center';

      // Compact edge hover sensor (Height 70px, Width 18px centered at 50% line)
      const sensor = document.createElement('div');
      sensor.style.position = 'absolute';
      sensor.style.left = '0';
      sensor.style.top = '-35px';
      sensor.style.width = '18px';
      sensor.style.height = '70px';
      sensor.style.cursor = 'pointer';
      sensor.style.zIndex = '2147483647';

      // Micro-Pill Switch with enlarged comfortable hit area (24px height)
      const pill = document.createElement('div');
      pill.className = 'framegen-micro-pill';
      pill.style.display = 'inline-flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '6px';
      pill.style.padding = '4px 10px';
      pill.style.height = '24px';
      pill.style.background = 'rgba(13, 17, 23, 0.95)';
      pill.style.backdropFilter = 'blur(8px)';
      pill.style.border = '1px solid rgba(255, 255, 255, 0.22)';
      pill.style.borderLeft = 'none';
      pill.style.borderRadius = '0 12px 12px 0';
      pill.style.boxShadow = '0 3px 10px rgba(0, 0, 0, 0.75)';
      pill.style.color = '#f1f5f9';
      pill.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      pill.style.fontSize = '11px';
      pill.style.fontWeight = '600';
      pill.style.cursor = 'pointer';
      pill.style.userSelect = 'none';
      pill.style.whiteSpace = 'nowrap';
      pill.style.opacity = '0';
      pill.style.pointerEvents = 'none';
      pill.style.transform = 'translateX(-12px)';
      pill.style.transition = 'transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease, border-color 0.18s ease';
      pill.title = 'FrameGen WebGPU Quick Toggle';

      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleVsrBypass();
      });

      container.appendChild(sensor);
      container.appendChild(pill);

      // Smooth Edge Hover Logic & 2.5s Auto-Fadeout
      const showPill = () => {
        if (this.pillFadeTimeout) clearTimeout(this.pillFadeTimeout);
        pill.style.transform = 'translateX(0)';
        pill.style.opacity = '1';
        pill.style.pointerEvents = 'auto';

        this.pillFadeTimeout = window.setTimeout(() => {
          hidePill();
        }, 2500);
      };

      const hidePill = () => {
        pill.style.transform = 'translateX(-12px)';
        pill.style.opacity = '0';
        pill.style.pointerEvents = 'none';
      };

      sensor.addEventListener('mouseenter', showPill);
      pill.addEventListener('mouseenter', showPill);
      container.addEventListener('mouseleave', () => {
        if (this.pillFadeTimeout) clearTimeout(this.pillFadeTimeout);
        this.pillFadeTimeout = window.setTimeout(hidePill, 600);
      });

      // Global capture mousemove: strictly triggered within +/- 35px vertically from center
      const onGlobalMouseMove = (e: MouseEvent) => {
        if (!this.settings.showSideControls || !this.currentVideo) return;
        const rect = this.currentVideo.getBoundingClientRect();

        const inPlayerBounds =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;

        if (!inPlayerBounds) {
          hidePill();
          return;
        }

        const centerY = rect.top + rect.height * 0.5;

        // Compact zone near left edge (within 20px) and near center (+- 35px)
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.left + 20 &&
          e.clientY >= centerY - 35 &&
          e.clientY <= centerY + 35
        ) {
          showPill();
        }
      };
      window.addEventListener('mousemove', onGlobalMouseMove, true);

      this.sidePillElement = container;
    }

    this.updateSidePill();

    if (!wrapper.contains(this.sidePillElement)) {
      wrapper.appendChild(this.sidePillElement);
    }
  }

  private updateSidePill(): void {
    if (!this.settings.showSideControls) {
      if (this.sidePillElement && this.sidePillElement.parentElement) {
        this.sidePillElement.parentElement.removeChild(this.sidePillElement);
      }
      this.sidePillElement = null;
      return;
    }

    if (!this.sidePillElement) return;

    const pill = this.sidePillElement.querySelector('.framegen-micro-pill') as HTMLElement;
    if (!pill) return;

    const isGenOn = this.settings.isEnabled && !this.vsrBypass;
    const t = getTranslation(this.settings.language);

    if (isGenOn) {
      // Active FrameGen State
      let fpsText = 'x2';
      if (this.settings.multiplierMode === 'target_fps') {
        fpsText = `${this.settings.targetFps} FPS`;
      } else {
        fpsText = `x${this.settings.multiplier}`;
      }
      pill.style.borderColor = 'rgba(56, 189, 248, 0.5)';
      pill.innerHTML = `
        <span style="width: 6px; height: 6px; border-radius: 50%; background: #38bdf8; display: inline-block;"></span>
        <span>${t.sideOn} [${fpsText}]</span>
      `;
    } else {
      // VSR / Native OFF State
      pill.style.borderColor = 'rgba(34, 197, 94, 0.5)';
      pill.innerHTML = `
        <span style="width: 6px; height: 6px; border-radius: 50%; background: #22c55e; display: inline-block;"></span>
        <span style="color: #4ade80;">${t.sideOff}</span>
      `;
    }
  }

  private updateDebugHud(): void {
    const overlay = this.overlayManager.getActiveState();
    if (!overlay) return;

    if (!this.showDebugHud) {
      if (this.debugHudElement && this.debugHudElement.parentElement) {
        this.debugHudElement.parentElement.removeChild(this.debugHudElement);
      }
      this.debugHudElement = null;
      return;
    }

    if (!this.debugHudElement) {
      this.debugHudElement = document.createElement('div');
      this.debugHudElement.className = 'framegen-hud';
      this.debugHudElement.style.position = 'absolute';
      this.debugHudElement.style.top = '12px';
      this.debugHudElement.style.left = '12px';
      this.debugHudElement.style.padding = '10px 14px';
      this.debugHudElement.style.background = 'rgba(13, 17, 23, 0.94)';
      this.debugHudElement.style.backdropFilter = 'blur(8px)';
      this.debugHudElement.style.color = '#e2e8f0';
      this.debugHudElement.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      this.debugHudElement.style.fontSize = '11px';
      this.debugHudElement.style.borderRadius = '6px';
      this.debugHudElement.style.border = '1px solid rgba(255, 255, 255, 0.15)';
      this.debugHudElement.style.zIndex = '2147483646';
      this.debugHudElement.style.pointerEvents = 'auto';
      this.debugHudElement.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.7)';
      this.debugHudElement.style.minWidth = '250px';
      overlay.wrapper.appendChild(this.debugHudElement);
    }

    const t = getTranslation(this.settings.language);
    const vRes = this.currentVideo ? `${this.currentVideo.videoWidth}x${this.currentVideo.videoHeight}` : '--';
    const outRes = overlay.canvas ? `${overlay.canvas.width}x${overlay.canvas.height}` : '--';
    const vStatus = this.currentVideo ? (this.currentVideo.paused ? t.paused : t.playing) : '--';
    
    const sourceFps = this.scheduler ? this.scheduler.getSourceFps() : 24;
    const liveFps = this.scheduler ? this.scheduler.getFps() : 0;
    const latency = this.scheduler ? this.scheduler.getLatencyMs() : 0;

    let fpsText = '';
    if (this.currentVideo?.paused) {
      fpsText = `<span style="color:#94a3b8;">0 FPS (${t.paused})</span>`;
    } else if (this.vsrBypass) {
      fpsText = `<span style="color:#4ade80;">${sourceFps} FPS (${t.nativeVsr})</span>`;
    } else if (this.settings.isEnabled) {
      fpsText = `<span style="color:#38bdf8;font-weight:700;">${sourceFps} FPS → ${liveFps || 60} FPS</span>`;
    } else {
      fpsText = `<span style="color:#94a3b8;">${sourceFps} FPS (${t.nativeFps})</span>`;
    }

    const isOnnx = this.pipelineManager ? this.pipelineManager.isOnnxActive() : false;
    const engineTag = isOnnx ? `<span style="color:#38bdf8;font-weight:600;">[${t.hudEngineOnnx}]</span>` : `<span style="color:#94a3b8;">[${t.hudEngineWgsl}]</span>`;

    let upscalerText = 'AMD FSR 1.0';
    switch (this.settings.scalerAlgorithm) {
      case 'anime4k': upscalerText = 'Anime4K v4.0'; break;
      case 'span': upscalerText = `SPAN x2 ${engineTag}`; break;
      case 'compact': upscalerText = `Real-ESRGAN Compact ${engineTag}`; break;
      case 'bicubic': upscalerText = 'Bicubic Catmull-Rom'; break;
      case 'off': upscalerText = '1:1 Direct'; break;
      case 'fsr': default: upscalerText = 'AMD FSR 1.0 (EASU+RCAS)'; break;
    }

    let rowsHtml = '';

    // Mode-adaptive display
    if (this.settings.mode === 'generator_only') {
      const modeInfo = this.settings.multiplierMode === 'target_fps' ? `Target ${this.settings.targetFps} FPS` : `x${this.settings.multiplier}`;
      rowsHtml += `
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudMode}:</span><span style="color:#38bdf8;">${t.modeGenOnly} (${modeInfo})</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudLatency}:</span><span style="color:#38bdf8;">${latency} ms</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudVideoSource}:</span><span style="color:#f1f5f9;">${vRes} (${vStatus})</span></div>
      `;
    } else if (this.settings.mode === 'upscale_only') {
      rowsHtml += `
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudMode}:</span><span style="color:#38bdf8;">${t.modeUpscaleOnly}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudUpscaler}:</span><span style="color:#f1f5f9;">${upscalerText}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudLatency}:</span><span style="color:#38bdf8;">${latency} ms</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudVideoSource}:</span><span style="color:#f1f5f9;">${vRes}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudScreenOutput}:</span><span style="color:#f1f5f9;">${outRes}</span></div>
      `;
    } else {
      // Hybrid
      const modeInfo = this.settings.multiplierMode === 'target_fps' ? `Target ${this.settings.targetFps} FPS` : `x${this.settings.multiplier}`;
      rowsHtml += `
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudMode}:</span><span style="color:#38bdf8;">${t.modeHybrid} (${modeInfo})</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudUpscaler}:</span><span style="color:#f1f5f9;">${upscalerText}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudLatency}:</span><span style="color:#38bdf8;">${latency} ms</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudVideoSource}:</span><span style="color:#f1f5f9;">${vRes} (${vStatus})</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudScreenOutput}:</span><span style="color:#f1f5f9;">${outRes}</span></div>
      `;
    }

    this.debugHudElement.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:4px;color:#f8fafc;display:flex;justify-content:space-between;">
        <span>${t.hudTitle}</span>
        ${fpsText}
      </div>
      ${rowsHtml}
      <div style="font-size:9px;color:#64748b;margin-top:6px;text-align:right;">${t.hudHideHint}</div>
    `;
  }
}

// Instantiate controller in content script
new ContentController();
