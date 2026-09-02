// @ts-ignore
import { createRT } from './rt.js';

export type FramegenModelType = 'v7s' | 'tfact2';

export interface NeuralFramegenConfig {
  modelType: FramegenModelType;
}

export class NeuralFramegenEngine {
  private device: GPUDevice;
  private currentModelType: FramegenModelType = 'v7s';
  private rtInstance: any = null;
  private currentW = 0;
  private currentH = 0;

  // Cached raw weights
  private weightsCache: Map<string, { bin: ArrayBuffer; json: any }> = new Map();
  private isInitializing = false;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  public get modelType(): FramegenModelType {
    return this.currentModelType;
  }

  public async setModelType(model: FramegenModelType): Promise<void> {
    if (this.currentModelType === model && this.rtInstance) return;
    this.currentModelType = model;
    if (this.currentW > 0 && this.currentH > 0) {
      await this.initPipeline(this.currentW, this.currentH, true);
    }
  }

  private async loadModelWeights(type: FramegenModelType): Promise<{ bin: ArrayBuffer; json: any }> {
    if (this.weightsCache.has(type)) {
      return this.weightsCache.get(type)!;
    }

    const jsonName = type === 'tfact2' ? 'rt_tfact2.json' : 'rt_v7s.json';
    const binName = type === 'tfact2' ? 'rt_tfact2.bin' : 'rt_v7s.bin';

    let jsonUrl = `assets/${jsonName}`;
    let binUrl = `assets/${binName}`;

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      jsonUrl = chrome.runtime.getURL(`assets/${jsonName}`);
      binUrl = chrome.runtime.getURL(`assets/${binName}`);
    }

    const [jsonRes, binRes] = await Promise.all([
      fetch(jsonUrl).then(r => r.json()),
      fetch(binUrl).then(r => r.arrayBuffer())
    ]);

    const data = { bin: binRes, json: jsonRes };
    this.weightsCache.set(type, data);
    return data;
  }

  public async initPipeline(width: number, height: number, force = false): Promise<boolean> {
    // Width and height must be divisible by 16 for WGSL tile dispatch
    const w16 = Math.max(64, Math.floor(width / 16) * 16);
    const h16 = Math.max(64, Math.floor(height / 16) * 16);

    if (!force && this.rtInstance && this.currentW === w16 && this.currentH === h16) {
      return true;
    }

    if (this.isInitializing) return false;
    this.isInitializing = true;

    try {
      if (this.rtInstance) {
        try {
          this.rtInstance.destroy();
        } catch (e) {
          console.warn('[FrameGen] Error destroying previous rt instance:', e);
        }
        this.rtInstance = null;
      }

      const { bin, json } = await this.loadModelWeights(this.currentModelType);

      this.rtInstance = await createRT(this.device, {
        w: w16,
        h: h16,
        weightsBin: bin,
        weightsManifest: json,
        textureInput: true,
        textureOutput: true
      });

      this.currentW = w16;
      this.currentH = h16;
      console.log(`[FrameGen] Neural WGSL runtime initialized (${this.currentModelType}, ${w16}x${h16})`);
      return true;
    } catch (err) {
      console.error('[FrameGen] Failed to initialize neural WGSL runtime:', err);
      return false;
    } finally {
      this.isInitializing = false;
    }
  }

  public get alignedWidth(): number {
    return this.currentW;
  }

  public get alignedHeight(): number {
    return this.currentH;
  }

  private lastPrepped0: GPUTexture | null = null;
  private lastPrepped1: GPUTexture | null = null;

  /**
   * Prepares the frame pair for interpolation (evaluates neural trunk once).
   */
  public async prepPair(tex0: GPUTexture, tex1: GPUTexture): Promise<void> {
    if (!this.rtInstance) return;
    if (this.lastPrepped0 === tex0 && this.lastPrepped1 === tex1) {
      return;
    }
    await this.rtInstance.prepPair(tex0, tex1);
    this.lastPrepped0 = tex0;
    this.lastPrepped1 = tex1;
  }

  /**
   * Generates interpolated sub-frame at timestep t in (0, 1) directly into outTex.
   */
  public runT(t: number, outTex: GPUTexture): void {
    if (!this.rtInstance) return;
    this.rtInstance.runT(t, outTex);
  }

  public destroy(): void {
    if (this.rtInstance) {
      try {
        this.rtInstance.destroy();
      } catch (e) {}
      this.rtInstance = null;
    }
    this.lastPrepped0 = null;
    this.lastPrepped1 = null;
    this.weightsCache.clear();
    this.currentW = 0;
    this.currentH = 0;
  }
}
