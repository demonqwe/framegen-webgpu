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
  private isAttaching = false;

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

    const host = this.getHostName();

    // 1. Load settings with site profile prioritized over global
    safeStorageGet(['siteProfiles', 'globalSettings', 'frameGenSettings', 'showDebug', 'siteVsrOverrides'], (result) => {
      const siteProfiles = result?.siteProfiles || {};
      const globalSettings = result?.globalSettings || result?.frameGenSettings || DEFAULT_SETTINGS;

      if (siteProfiles[host]) {
        this.settings = { ...this.settings, ...globalSettings, ...siteProfiles[host] };
      } else {
        this.settings = { ...this.settings, ...globalSettings };
      }

      if (result && result.showDebug !== undefined) {
        this.showDebugHud = !!result.showDebug;
      }
      if (isExtensionValid() && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove(['siteVsrOverrides']);
      }
      this.startVideoObservation();
    });

    // 2. Listen for settings changes across frames
    if (isExtensionValid() && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'local') {
            const currentHost = this.getHostName();
            if (changes.frameGenSettings?.newValue) {
              this.applyUpdatedSettings(changes.frameGenSettings.newValue);
            } else if (changes.siteProfiles?.newValue?.[currentHost]) {
              this.applyUpdatedSettings(changes.siteProfiles.newValue[currentHost]);
            } else if (changes.globalSettings?.newValue) {
              this.applyUpdatedSettings(changes.globalSettings.newValue);
            }

            if (changes.showDebug !== undefined) {
              this.showDebugHud = !!changes.showDebug.newValue;
              this.updateDebugHud();
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

    // Keyboard shortcuts:
    // Shift + D / Alt + D: Diagnostic HUD
    // Alt + G: Toggle Master On/Off (or 'G' when mouse is hovering the video player)
    // Alt + C: Toggle A/B Compare (or 'C' when mouse is hovering the video player)
    window.addEventListener('keydown', (e) => {
      if (this.isTypingContext(e)) {
        return;
      }

      const activeCanvas = this.overlayManager.getActiveState()?.canvas;
      const isHoveringVideo = !!(this.currentVideo && (
        this.currentVideo.matches(':hover') ||
        this.currentVideo.parentElement?.matches(':hover') ||
        (activeCanvas && activeCanvas.matches(':hover'))
      ));

      // 1. Shift + D or Alt + D: Diagnostic HUD
      if ((e.shiftKey || e.altKey) && (e.key === 'D' || e.key === 'd' || e.code === 'KeyD')) {
        e.preventDefault();
        this.toggleDebugHud();
        return;
      }

      // 2. Master Toggle: Alt+G anywhere, or 'G' when mouse is hovering over video
      const isAltG = e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'g' || e.key === 'G' || e.code === 'KeyG');
      const isDirectG = !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && isHoveringVideo && (e.key === 'g' || e.key === 'G');
      if (isAltG || isDirectG) {
        e.preventDefault();
        this.toggleMaster();
        return;
      }

      // 3. Compare Toggle: Alt+C anywhere, or 'C' when mouse is hovering over video
      const isAltC = e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC');
      const isDirectC = !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && isHoveringVideo && (e.key === 'c' || e.key === 'C');
      if (isAltC || isDirectC) {
        e.preventDefault();
        this.toggleCompare();
        return;
      }
    }, false);

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
        if (this.scheduler && this.currentVideo && !this.currentVideo.paused && this.settings.isEnabled) {
          this.scheduler.start();
        }
      }
    });

    this.startTelemetryLoop();
  }

  private isTypingContext(e: KeyboardEvent): boolean {
    if (e.isComposing) return true;

    // 1. Check full event composed path (handles Shadow DOM on YouTube, Reddit, VK, etc.)
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const node of path) {
      if (node instanceof HTMLElement) {
        const tag = node.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') return true;
        const role = node.getAttribute('role');
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
        if (node.closest && node.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]')) {
          return true;
        }
      }
    }

    // 2. Check activeElement (piercing shadow roots)
    let active = document.activeElement as HTMLElement | null;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement as HTMLElement;
    }
    if (active) {
      const activeTag = active.tagName.toUpperCase();
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return true;
      if (active.isContentEditable || active.getAttribute('contenteditable') === 'true') return true;
      const role = active.getAttribute('role');
      if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
    }

    return false;
  }

  private toggleDebugHud(): void {
    this.showDebugHud = !this.showDebugHud;
    safeStorageSet({ showDebug: this.showDebugHud });
    this.updateDebugHud();
  }

  private startTelemetryLoop(): void {
    window.setInterval(() => {
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

      if (this.settings.isEnabled) {
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
    if (this.scheduler) {
      this.scheduler.start();
    }
  }

  private disableFrameGen(): void {
    if (this.scheduler) {
      this.scheduler.stop();
    }
  }

  private applyUpdatedSettings(newSettings: ExtensionSettings): void {
    this.settings = { ...this.settings, ...newSettings };
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
    this.updateDebugHud();
  }

  private handleMessage = (
    message: any,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) => {
    if (!message || !message.type) return;

    if (message.type === 'SETTINGS_UPDATED' || message.type === 'UPDATE_SETTINGS') {
      this.applyUpdatedSettings(message.settings);
      sendResponse({ success: true });
      return;
    }

    if (message.type === 'GET_STATUS') {
      sendResponse({
        hasVideo: !!this.currentVideo,
        active: !!(this.scheduler && this.settings.isEnabled),
        fps: this.scheduler ? this.scheduler.getFps() : 0,
        sourceFps: this.scheduler ? this.scheduler.getSourceFps() : 24,
        siteHost: this.getHostName(),
        settings: this.settings
      });
      return;
    }
  };

  // Auto-Hiding Left Edge Micro-Switch on Hover
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

      // Transparent Edge Hover Trigger (Width 28px, Height 140px centered at middle)
      const trigger = document.createElement('div');
      trigger.style.position = 'absolute';
      trigger.style.left = '0';
      trigger.style.top = '-60px';
      trigger.style.width = '28px';
      trigger.style.height = '140px';
      trigger.style.zIndex = '2147483647';
      trigger.style.cursor = 'pointer';

      // Compact Micro-Pill Switch (22px height)
      const pill = document.createElement('div');
      pill.className = 'framegen-micro-pill';
      pill.style.display = 'inline-flex';
      pill.style.alignItems = 'center';
      pill.style.gap = '5px';
      pill.style.padding = '3px 8px';
      pill.style.height = '22px';
      pill.style.background = 'rgba(13, 17, 23, 0.92)';
      pill.style.backdropFilter = 'blur(8px)';
      pill.style.border = '1px solid rgba(255, 255, 255, 0.25)';
      pill.style.borderLeft = 'none';
      pill.style.borderRadius = '0 11px 11px 0';
      pill.style.boxShadow = '0 3px 12px rgba(0, 0, 0, 0.8)';
      pill.style.color = '#f1f5f9';
      pill.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      pill.style.fontSize = '10px';
      pill.style.fontWeight = '700';
      pill.style.cursor = 'pointer';
      pill.style.userSelect = 'none';
      pill.style.whiteSpace = 'nowrap';
      // Hidden by default so it never distracts while watching
      pill.style.opacity = '0';
      pill.style.pointerEvents = 'none';
      pill.style.transform = 'translateX(-100%)';
      pill.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.22s ease';
      pill.title = 'FrameGen WebGPU Toggle (ON / OFF)';

      let hideTimer: number | null = null;

      const show = () => {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        pill.style.opacity = '1';
        pill.style.pointerEvents = 'auto';
        pill.style.transform = 'translateX(0)';

        hideTimer = window.setTimeout(() => {
          hide();
        }, 2600);
      };

      const hide = () => {
        pill.style.opacity = '0';
        pill.style.pointerEvents = 'none';
        pill.style.transform = 'translateX(-100%)';
      };

      trigger.addEventListener('mouseenter', show);
      pill.addEventListener('mouseenter', () => {
        if (hideTimer) clearTimeout(hideTimer);
        pill.style.opacity = '1';
        pill.style.pointerEvents = 'auto';
        pill.style.transform = 'translateX(0)';
      });
      pill.addEventListener('mouseleave', () => {
        hideTimer = window.setTimeout(hide, 700);
      });

      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleMaster();
        // Briefly keep visible to confirm click, then hide
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = window.setTimeout(hide, 1400);
      });

      // Also listen on wrapper for mouse movements near left edge
      wrapper.addEventListener('mousemove', (e: MouseEvent) => {
        const rect = wrapper.getBoundingClientRect();
        const distFromLeft = e.clientX - rect.left;
        const distFromCenterY = Math.abs(e.clientY - (rect.top + rect.height * 0.5));
        if (distFromLeft >= 0 && distFromLeft <= 28 && distFromCenterY <= 80) {
          show();
        }
      }, { passive: true });

      container.appendChild(trigger);
      container.appendChild(pill);
      this.sidePillElement = container;
    }

    this.updateSidePill();

    if (!wrapper.contains(this.sidePillElement)) {
      wrapper.appendChild(this.sidePillElement);
    }
  }

  private isCompareActive = false;
  private toastTimer: number | null = null;

  private toggleMaster(): void {
    const host = this.getHostName();
    this.settings.isEnabled = !this.settings.isEnabled;

    safeStorageGet(['siteProfiles'], (res) => {
      const profiles = res?.siteProfiles || {};
      profiles[host] = { ...this.settings };
      safeStorageSet({
        siteProfiles: profiles,
        frameGenSettings: this.settings
      });
    });

    this.applyUpdatedSettings(this.settings);
    this.showToast(`${host}: ${this.settings.isEnabled ? 'ВКЛ (60 FPS)' : 'ВЫКЛ'}`);
  }

  private toggleCompare(): void {
    this.isCompareActive = !this.isCompareActive;
    const overlay = this.overlayManager.getActiveState();
    if (overlay && overlay.canvas) {
      overlay.canvas.style.visibility = this.isCompareActive ? 'hidden' : 'visible';
    }
    if (this.scheduler) {
      this.scheduler.setCompareMode(this.isCompareActive);
    }
    this.showToast(
      this.isCompareActive
        ? 'Сравнение [C]: ИСХОДНОЕ ВИДЕО (Оригинал)'
        : 'Сравнение [C]: FrameGen (Интерполяция)'
    );
    this.updateDebugHud();
  }

  private showToast(msg: string): void {
    let toast = document.getElementById('framegen-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'framegen-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '50px';
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.padding = '8px 18px';
      toast.style.background = 'rgba(15, 23, 42, 0.94)';
      toast.style.backdropFilter = 'blur(8px)';
      toast.style.border = '1px solid rgba(56, 189, 248, 0.5)';
      toast.style.borderRadius = '20px';
      toast.style.color = '#38bdf8';
      toast.style.fontFamily = 'system-ui, -apple-system, sans-serif';
      toast.style.fontSize = '12px';
      toast.style.fontWeight = '600';
      toast.style.boxShadow = '0 4px 16px rgba(0,0,0,0.5)';
      toast.style.zIndex = '2147483647';
      toast.style.pointerEvents = 'none';
      toast.style.transition = 'opacity 0.2s ease';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      if (toast) toast.style.opacity = '0';
    }, 1800);
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

    const isGenOn = this.settings.isEnabled;

    if (isGenOn) {
      // Active FrameGen State: Clean ON
      pill.style.borderColor = 'rgba(56, 189, 248, 0.5)';
      pill.innerHTML = `
        <span style="width: 5px; height: 5px; border-radius: 50%; background: #38bdf8; display: inline-block;"></span>
        <span>ON</span>
      `;
    } else {
      // Native OFF State: Clean OFF
      pill.style.borderColor = 'rgba(148, 163, 184, 0.4)';
      pill.innerHTML = `
        <span style="width: 5px; height: 5px; border-radius: 50%; background: #64748b; display: inline-block;"></span>
        <span style="color: #94a3b8;">OFF</span>
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

    let fpsText = '';
    if (this.currentVideo?.paused) {
      fpsText = `<span style="color:#94a3b8;">0 FPS (${t.paused})</span>`;
    } else if (this.settings.isEnabled) {
      fpsText = `<span style="color:#38bdf8;font-weight:700;">${sourceFps} FPS → ${liveFps || 60} FPS</span>`;
    } else {
      fpsText = `<span style="color:#94a3b8;">${sourceFps} FPS (${t.nativeFps})</span>`;
    }

    const resTag = this.settings.neuralResolution === '720p' ? '720p' : (this.settings.neuralResolution === '540p' ? '540p' : 'Full');
    const engineTag = this.settings.framegenEngine === 'neural'
      ? `<span style="color:#38bdf8;font-weight:600;">EMA-VFI [${(this.settings.neuralModel === 'tfact2' || (this.settings.neuralModel as any) === 'v6') ? 'v6 tfact2 4.5MB' : 'v7 small 2.9MB'} | ${resTag}]</span>`
      : `<span style="color:#94a3b8;">Motion Flow [Hardware Compute]</span>`;

    let upscalerText = 'AMD FSR 1.0 (EASU+RCAS)';
    switch (this.settings.scalerAlgorithm) {
      case 'anime4k': upscalerText = 'Anime4K v4.0'; break;
      case 'bicubic': upscalerText = 'Bicubic Catmull-Rom'; break;
      case 'off': upscalerText = '1:1 Direct'; break;
      case 'fsr': default: upscalerText = 'AMD FSR 1.0 (EASU+RCAS)'; break;
    }

    const dups = this.scheduler ? this.scheduler.getDuplicateSkips() : 0;
    const cadenceTag = this.settings.animeCadenceDetection
      ? `<span style="color:#4ade80;font-weight:600;">Умный пропуск (ВКЛ)</span> <span style="color:#64748b;font-size:10px;">[дублей: ${dups}]</span>`
      : `<span style="color:#ef4444;font-weight:600;">Выкл</span>`;

    const compareRow = this.isCompareActive
      ? `<div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;background:rgba(251,191,36,0.15);padding:2px 4px;border-radius:4px;"><span style="color:#fbbf24;font-weight:700;">Сравнение [C]:</span><span style="color:#fbbf24;font-weight:700;">ОРИГИНАЛ (A)</span></div>`
      : '';

    let rowsHtml = compareRow;

    // Mode-adaptive display
    if (this.settings.mode === 'generator_only') {
      const modeInfo = this.settings.multiplierMode === 'target_fps' ? `Target ${this.settings.targetFps} FPS` : `x${this.settings.multiplier}`;
      rowsHtml += `
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudMode}:</span><span style="color:#38bdf8;">${t.modeGenOnly} (${modeInfo})</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">Интерполяция:</span>${engineTag}</div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">Каденс аниме:</span>${cadenceTag}</div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudVideoSource}:</span><span style="color:#f1f5f9;">${vRes} (${vStatus})</span></div>
      `;
    } else if (this.settings.mode === 'upscale_only') {
      rowsHtml += `
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudMode}:</span><span style="color:#38bdf8;">${t.modeUpscaleOnly}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudUpscaler}:</span><span style="color:#f1f5f9;">${upscalerText}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudVideoSource}:</span><span style="color:#f1f5f9;">${vRes}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudScreenOutput}:</span><span style="color:#f1f5f9;">${outRes}</span></div>
      `;
    } else {
      // Hybrid
      const modeInfo = this.settings.multiplierMode === 'target_fps' ? `Target ${this.settings.targetFps} FPS` : `x${this.settings.multiplier}`;
      rowsHtml += `
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudMode}:</span><span style="color:#38bdf8;">${t.modeHybrid} (${modeInfo})</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">Интерполяция:</span>${engineTag}</div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">${t.hudUpscaler}:</span><span style="color:#f1f5f9;">${upscalerText}</span></div>
        <div style="display:flex;justify-content:space-between;gap:16px;margin:3px 0;"><span style="color:#94a3b8;">Каденс аниме:</span>${cadenceTag}</div>
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
      <div style="font-size:9px;color:#64748b;margin-top:6px;text-align:right;">Alt+G: Вкл/Выкл • Alt+C: Сравнение • Shift+D: Скрыть</div>
    `;
  }
}

// Instantiate controller in content script
new ContentController();
