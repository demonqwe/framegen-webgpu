import diffShaderSource from '../shaders/diff.wgsl?raw';

export interface FrameHistoryEntry {
  texture: GPUTexture;
  mediaTime: number;
  timestamp: number;
  isDuplicate: boolean;
}

export interface CadenceResult {
  isDuplicate: boolean;
  isSceneCut: boolean;
  difference: number;
  prevUniqueEntry: FrameHistoryEntry | null;
  currUniqueEntry: FrameHistoryEntry | null;
  phaseDeltaTime: number; // Time between last 2 unique keyframes
}

export class CadenceDetector {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private resultBuffer: GPUBuffer;
  private readbackBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;

  // Ring buffer holding up to 4 unique frames
  private history: FrameHistoryEntry[] = [];
  private baseThreshold = 0.010;
  private estimatedNoiseFloor = 0.003;
  private effectiveThreshold = 0.010;
  private readonly MIN_THRESHOLD = 0.006;
  private readonly MAX_THRESHOLD = 0.018;

  private isMapping = false;
  private lastDifference = 1.0;

  constructor(device: GPUDevice, threshold = 0.010) {
    this.device = device;
    this.baseThreshold = threshold;
    this.effectiveThreshold = Math.min(this.MAX_THRESHOLD, Math.max(this.MIN_THRESHOLD, threshold));

    const module = device.createShaderModule({
      label: 'Cadence Diff Shader',
      code: diffShaderSource
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'Cadence Diff BindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
      ]
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'Cadence Diff PipelineLayout',
      bindGroupLayouts: [this.bindGroupLayout]
    });

    this.pipeline = device.createComputePipeline({
      label: 'Cadence Diff ComputePipeline',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'main' }
    });

    // Storage buffer for sum (fixed point) and count (2 x u32 = 8 bytes)
    this.resultBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    this.readbackBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
  }

  /**
   * Evaluates if incoming frame is a duplicate of the previous frame.
   */
  public async evaluateFrame(
    currTexture: GPUTexture,
    mediaTime: number,
    timestamp: number
  ): Promise<CadenceResult> {
    if (this.history.length === 0) {
      const entry: FrameHistoryEntry = {
        texture: currTexture,
        mediaTime,
        timestamp,
        isDuplicate: false
      };
      this.history.push(entry);
      return {
        isDuplicate: false,
        isSceneCut: false,
        difference: 1.0,
        prevUniqueEntry: null,
        currUniqueEntry: entry,
        phaseDeltaTime: 0.033
      };
    }

    const prevEntry = this.history[this.history.length - 1];

    // 1. Reset result accumulator
    const initData = new Uint32Array([0, 0]);
    this.device.queue.writeBuffer(this.resultBuffer, 0, initData);

    // 2. Dispatch diff compute pass
    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: prevEntry.texture.createView() },
        { binding: 1, resource: currTexture.createView() },
        { binding: 2, resource: { buffer: this.resultBuffer } }
      ]
    });

    const commandEncoder = this.device.createCommandEncoder({ label: 'Cadence Diff Encoder' });
    const pass = commandEncoder.beginComputePass({ label: 'Cadence Diff Pass' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(8, 8, 1); // 64 workgroups -> 4096 sampled points
    pass.end();

    commandEncoder.copyBufferToBuffer(this.resultBuffer, 0, this.readbackBuffer, 0, 8);
    this.device.queue.submit([commandEncoder.finish()]);

    // 3. Read back computed difference non-blockingly to avoid GPU-CPU pipeline stalls
    if (!this.isMapping) {
      this.isMapping = true;
      this.readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
        try {
          const readArray = new Uint32Array(this.readbackBuffer.getMappedRange());
          const sumFixed = readArray[0];
          const count = readArray[1];
          if (count > 0) {
            this.lastDifference = (sumFixed / 100000.0) / count;
          }
          this.readbackBuffer.unmap();
        } catch {
          this.lastDifference = 0.05;
        } finally {
          this.isMapping = false;
        }
      }).catch(() => {
        this.isMapping = false;
      });
    }

    const difference = this.lastDifference;
    const isSceneCut = difference >= 0.35;

    // Adaptive Noise Floor update:
    // When difference is in the sub-motion range (< 0.022) and not a scene cut,
    // it represents compression artifacts / macroblock noise between repeated drawings.
    if (difference < 0.022 && !isSceneCut) {
      if (difference < this.estimatedNoiseFloor) {
        // Fast drop if video stream is cleaner than estimated
        this.estimatedNoiseFloor = this.estimatedNoiseFloor * 0.7 + difference * 0.3;
      } else {
        // Gentle rise to track compression noise spikes
        this.estimatedNoiseFloor = this.estimatedNoiseFloor * 0.95 + difference * 0.05;
      }
      const adaptiveTarget = Math.max(this.baseThreshold, this.estimatedNoiseFloor * 1.4);
      this.effectiveThreshold = Math.min(this.MAX_THRESHOLD, Math.max(this.MIN_THRESHOLD, adaptiveTarget));
    }

    const isDuplicate = difference < this.effectiveThreshold;

    const currEntry: FrameHistoryEntry = {
      texture: currTexture,
      mediaTime,
      timestamp,
      isDuplicate
    };

    let prevUnique: FrameHistoryEntry | null = null;
    let currUnique: FrameHistoryEntry | null = null;
    let phaseDeltaTime = 0.033;

    if (!isDuplicate) {
      // Find previous unique entry
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (!this.history[i].isDuplicate) {
          prevUnique = this.history[i];
          break;
        }
      }
      currUnique = currEntry;

      if (prevUnique) {
        phaseDeltaTime = Math.max(0.016, currUnique.mediaTime - prevUnique.mediaTime);
      }

      this.history.push(currEntry);
      if (this.history.length > 4) {
        this.history.shift();
      }
    } else {
      // It's a duplicate - keep last unique entry
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (!this.history[i].isDuplicate) {
          currUnique = this.history[i];
          break;
        }
      }
    }

    return {
      isDuplicate,
      isSceneCut,
      difference,
      prevUniqueEntry: prevUnique,
      currUniqueEntry: currUnique,
      phaseDeltaTime
    };
  }

  public setThreshold(val: number): void {
    this.baseThreshold = val;
    this.effectiveThreshold = Math.min(this.MAX_THRESHOLD, Math.max(this.MIN_THRESHOLD, val));
  }

  public getThreshold(): number {
    return this.effectiveThreshold;
  }

  public reset(): void {
    this.history = [];
    this.estimatedNoiseFloor = 0.003;
    this.effectiveThreshold = this.baseThreshold;
  }

  public destroy(): void {
    this.history = [];
    this.resultBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
