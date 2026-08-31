export interface OverlayState {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  wrapper: HTMLElement;
  resizeObserver: ResizeObserver;
}

export class OverlayManager {
  private activeState: OverlayState | null = null;
  private onResizeCallback: ((width: number, height: number) => void) | null = null;
  private videoListeners: Array<{ event: string; fn: EventListener }> = [];

  /**
   * Sets callback invoked when overlay canvas internal resolution updates.
   */
  public setOnResize(cb: (width: number, height: number) => void): void {
    this.onResizeCallback = cb;
  }

  /**
   * Attaches an overlay canvas to the specified video element.
   */
  public attach(video: HTMLVideoElement): OverlayState {
    if (this.activeState && this.activeState.video === video) {
      this.updateCanvasResolution(video, this.activeState.canvas);
      return this.activeState;
    }

    this.detach();

    console.log('[Anime FrameGen] Attaching overlay canvas to video element:', video);

    // Create Canvas Element
    const canvas = document.createElement('canvas');
    canvas.className = 'anime-framegen-overlay-canvas';
    canvas.style.position = 'absolute';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '1';
    canvas.style.display = 'block';
    canvas.style.backgroundColor = 'transparent';

    // Find parent container
    let parent = video.parentElement || (video.getRootNode() as HTMLElement);
    if (!parent || parent === document.documentElement) {
      parent = document.body;
    }

    // Ensure parent has positioning context
    const parentComputedStyle = window.getComputedStyle(parent);
    if (parentComputedStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    // Find top player container for UI overlay attachment (fixes YouTube overflow: hidden clipping)
    const uiWrapper = (video.closest('#movie_player, .html5-video-player, ytd-player, ytd-reel-video-renderer, ytd-shorts, .player-container, .video-player') as HTMLElement) || parent;
    if (uiWrapper && window.getComputedStyle(uiWrapper).position === 'static') {
      uiWrapper.style.position = 'relative';
    }

    // Insert canvas right after video
    video.insertAdjacentElement('afterend', canvas);

    // Synchronize initial dimensions
    this.updateCanvasResolution(video, canvas);

    // Setup ResizeObserver on both video and container
    const resizeObserver = new ResizeObserver(() => {
      this.updateCanvasResolution(video, canvas);
    });
    resizeObserver.observe(video);
    if (parent !== document.body) {
      resizeObserver.observe(parent);
    }
    if (uiWrapper !== parent && uiWrapper !== document.body) {
      resizeObserver.observe(uiWrapper);
    }

    // Bind video lifecycle events to sync geometry immediately upon metadata/load
    const bindEvent = (evt: string) => {
      const fn = () => this.updateCanvasResolution(video, canvas);
      video.addEventListener(evt, fn);
      this.videoListeners.push({ event: evt, fn });
    };

    bindEvent('loadedmetadata');
    bindEvent('loadeddata');
    bindEvent('canplay');
    bindEvent('playing');
    bindEvent('resize');

    const onFsChange = () => this.updateCanvasResolution(video, canvas);
    document.addEventListener('fullscreenchange', onFsChange);
    this.videoListeners.push({ event: 'fullscreenchange', fn: onFsChange });

    this.activeState = {
      video,
      canvas,
      wrapper: uiWrapper,
      resizeObserver
    };

    return this.activeState;
  }

  public updateCanvasResolution(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    const vW = video.videoWidth || 1280;
    const vH = video.videoHeight || 720;
    const videoAspect = vW / Math.max(1, vH);

    const dpr = window.devicePixelRatio || 1;
    const clientW = video.clientWidth || (video.parentElement?.clientWidth || window.innerWidth);
    const clientH = video.clientHeight || (video.parentElement?.clientHeight || window.innerHeight);

    const displayW = Math.round(clientW * dpr);
    const displayH = Math.round(clientH * dpr);
    const containerAspect = displayW / Math.max(1, displayH);

    // Calculate aspect-ratio preserved target dimensions for the canvas texture
    let targetWidth: number;
    let targetHeight: number;

    if (containerAspect > videoAspect) {
      // Ultrawide / Pillarbox:
      targetHeight = Math.max(vH, displayH);
      targetWidth = Math.round(targetHeight * videoAspect);
    } else {
      // Letterbox:
      targetWidth = Math.max(vW, displayW);
      targetHeight = Math.round(targetWidth / videoAspect);
    }

    // Ensure even dimensions
    targetWidth = (Math.max(640, targetWidth) + 1) & ~1;
    targetHeight = (Math.max(360, targetHeight) + 1) & ~1;

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      if (this.onResizeCallback) {
        this.onResizeCallback(canvas.width, canvas.height);
      }
    }
  }

  /**
   * Detaches overlay canvas.
   */
  public detach(): void {
    if (!this.activeState) return;

    console.log('[Anime FrameGen] Detaching overlay canvas.');

    const { video, canvas, resizeObserver } = this.activeState;

    resizeObserver.disconnect();

    for (const item of this.videoListeners) {
      if (item.event === 'fullscreenchange') {
        document.removeEventListener('fullscreenchange', item.fn);
      } else {
        video.removeEventListener(item.event, item.fn);
      }
    }
    this.videoListeners = [];

    // Remove canvas
    if (canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }

    this.activeState = null;
  }

  public getActiveState(): OverlayState | null {
    return this.activeState;
  }
}
