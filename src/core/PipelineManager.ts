import { ExtensionSettings, DEFAULT_SETTINGS } from '../config/defaults';
import { CadenceDetector, CadenceResult } from '../pipelines/CadenceDetector';
import { UpscalerManager } from '../models/Upscaler';
import fsrEasuShaderSource from '../shaders/fsr_easu.wgsl?raw';
import fsrRcasShaderSource from '../shaders/fsr_rcas.wgsl?raw';
import warpShaderSource from '../shaders/warp.wgsl?raw';

export class PipelineManager {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private settings: ExtensionSettings;

  private cadenceDetector: CadenceDetector;
  private upscalerManager: UpscalerManager;

  // FSR 1.0 pipelines
  private fsrEasuPipeline: GPURenderPipeline;
  private fsrRcasPipeline: GPURenderPipeline;
  private fsrConstBuffer: GPUBuffer;
  private rcasConstBuffer: GPUBuffer;

  // Warp pipeline
  private warpPipeline: GPURenderPipeline;
  private warpUniformBuffer: GPUBuffer;

  // Intermediate textures for multi-pass
  private intermediateTexture: GPUTexture | null = null;
  private intermediateWidth = 0;
  private intermediateHeight = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, settings: ExtensionSettings = DEFAULT_SETTINGS) {
    this.device = device;
    this.format = format;
    this.settings = { ...settings };

    this.cadenceDetector = new CadenceDetector(device, settings.cadenceThreshold);
    this.upscalerManager = new UpscalerManager(device, format);
    this.upscalerManager.setMode(settings.scalerAlgorithm);

    // 1. Build FSR EASU pipeline
    const fsrEasuModule = device.createShaderModule({ label: 'FSR EASU Module', code: fsrEasuShaderSource });
    this.fsrConstBuffer = device.createBuffer({
      size: 64, // 4 x vec4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.fsrEasuPipeline = device.createRenderPipeline({
      label: 'FSR EASU Pipeline',
      layout: 'auto',
      vertex: { module: fsrEasuModule, entryPoint: 'vs_main' },
      fragment: { module: fsrEasuModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });

    // 2. Build FSR RCAS pipeline
    const fsrRcasModule = device.createShaderModule({ label: 'FSR RCAS Module', code: fsrRcasShaderSource });
    this.rcasConstBuffer = device.createBuffer({
      size: 32, // vec4<f32> + pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.fsrRcasPipeline = device.createRenderPipeline({
      label: 'FSR RCAS Pipeline',
      layout: 'auto',
      vertex: { module: fsrRcasModule, entryPoint: 'vs_main' },
      fragment: { module: fsrRcasModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });

    // 3. Build Warp pipeline
    const warpModule = device.createShaderModule({ label: 'Warp Module', code: warpShaderSource });
    this.warpUniformBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.warpPipeline = device.createRenderPipeline({
      label: 'High-Res Warp Pipeline',
      layout: 'auto',
      vertex: { module: warpModule, entryPoint: 'vs_main' },
      fragment: { module: warpModule, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    });
  }

  public updateSettings(settings: Partial<ExtensionSettings>): void {
    this.settings = { ...this.settings, ...settings };
    if (settings.cadenceThreshold !== undefined) {
      this.cadenceDetector.setThreshold(settings.cadenceThreshold);
    }
    if (settings.scalerAlgorithm !== undefined) {
      this.upscalerManager.setMode(settings.scalerAlgorithm);
    }
  }

  public getInterpolationSteps(): number[] {
    switch (this.settings.multiplier) {
      case 2:
        return [0.5];
      case 3:
        return [0.333, 0.666];
      case 4:
        return [0.25, 0.5, 0.75];
      default:
        return [0.5];
    }
  }

  public async evaluateCadence(currTexture: GPUTexture, mediaTime: number, timestamp: number): Promise<CadenceResult> {
    if (!this.settings.animeCadenceDetection) {
      return {
        isDuplicate: false,
        difference: 1.0,
        prevUniqueEntry: null,
        currUniqueEntry: null,
        phaseDeltaTime: 0.033
      };
    }
    return this.cadenceDetector.evaluateFrame(currTexture, mediaTime, timestamp);
  }

  /**
   * Performs 2-pass FSR 1.0 upscaling (EASU + RCAS).
   */
  public renderFsr1440p(
    commandEncoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputTargetView: GPUTextureView,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number
  ): void {
    const con0 = new Float32Array([
      srcWidth / targetWidth,
      srcHeight / targetHeight,
      0.5 * (srcWidth / targetWidth) - 0.5,
      0.5 * (srcHeight / targetHeight) - 0.5
    ]);
    const con1 = new Float32Array([1.0 / srcWidth, 1.0 / srcHeight, 1.0 / srcWidth, -1.0 / srcHeight]);
    const con2 = new Float32Array([-1.0 / srcWidth, 2.0 / srcHeight, 1.0 / srcWidth, 2.0 / srcHeight]);
    const con3 = new Float32Array([0.0, 4.0 / srcHeight, 0.0, 0.0]);

    const fsrData = new Float32Array(16);
    fsrData.set(con0, 0);
    fsrData.set(con1, 4);
    fsrData.set(con2, 8);
    fsrData.set(con3, 12);
    this.device.queue.writeBuffer(this.fsrConstBuffer, 0, fsrData);

    const linearSampler = this.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });

    this.ensureIntermediateTexture(targetWidth, targetHeight);
    if (!this.intermediateTexture) return;

    // Pass 1: EASU -> Intermediate Texture
    const easuBindGroup = this.device.createBindGroup({
      layout: this.fsrEasuPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.fsrConstBuffer } },
        { binding: 1, resource: linearSampler },
        { binding: 2, resource: inputView }
      ]
    });

    const easuPass = commandEncoder.beginRenderPass({
      label: 'FSR EASU Pass',
      colorAttachments: [{
        view: this.intermediateTexture.createView(),
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    easuPass.setPipeline(this.fsrEasuPipeline);
    easuPass.setBindGroup(0, easuBindGroup);
    easuPass.draw(6);
    easuPass.end();

    // Pass 2: RCAS -> Final Output Target
    const rcasData = new Float32Array([
      this.settings.fsrSharpness,
      targetWidth,
      targetHeight,
      0.0
    ]);
    this.device.queue.writeBuffer(this.rcasConstBuffer, 0, rcasData);

    const rcasBindGroup = this.device.createBindGroup({
      layout: this.fsrRcasPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.rcasConstBuffer } },
        { binding: 1, resource: linearSampler },
        { binding: 2, resource: this.intermediateTexture.createView() }
      ]
    });

    const rcasPass = commandEncoder.beginRenderPass({
      label: 'FSR RCAS Pass',
      colorAttachments: [{
        view: outputTargetView,
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    rcasPass.setPipeline(this.fsrRcasPipeline);
    rcasPass.setBindGroup(0, rcasBindGroup);
    rcasPass.draw(6);
    rcasPass.end();
  }

  /**
   * Warps high-res source frames using optical flow field.
   */
  public warpFrames(
    commandEncoder: GPUCommandEncoder,
    outputTargetView: GPUTextureView,
    srcTex0: GPUTexture,
    srcTex1: GPUTexture,
    flowTex0: GPUTexture,
    flowTex1: GPUTexture,
    maskTex: GPUTexture,
    srcWidth: number,
    srcHeight: number,
    flowWidth: number,
    flowHeight: number,
    stepT: number
  ): void {
    const warpData = new Float32Array([
      srcWidth,
      srcHeight,
      flowWidth,
      flowHeight,
      stepT,
      stepT,
      0.0,
      0.0
    ]);
    this.device.queue.writeBuffer(this.warpUniformBuffer, 0, warpData);

    const linearSampler = this.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });

    const bindGroup = this.device.createBindGroup({
      layout: this.warpPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.warpUniformBuffer } },
        { binding: 1, resource: linearSampler },
        { binding: 2, resource: flowTex0.createView() },
        { binding: 3, resource: flowTex1.createView() },
        { binding: 4, resource: maskTex.createView() },
        { binding: 5, resource: srcTex0.createView() },
        { binding: 6, resource: srcTex1.createView() }
      ]
    });

    const pass = commandEncoder.beginRenderPass({
      label: 'Warp Pass',
      colorAttachments: [{
        view: outputTargetView,
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.setPipeline(this.warpPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  }

  /**
   * Dispatches selected scaler algorithm (FSR / Anime4K / SPAN / Compact / Bicubic / Off) for any resolution.
   */
  public upscaleFrame(
    commandEncoder: GPUCommandEncoder,
    srcTexture: GPUTexture,
    outputTargetView: GPUTextureView,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number
  ): void {
    if (this.settings.scalerAlgorithm === 'fsr') {
      this.renderFsr1440p(
        commandEncoder,
        srcTexture.createView(),
        outputTargetView,
        srcWidth,
        srcHeight,
        targetWidth,
        targetHeight
      );
    } else {
      this.upscalerManager.render(
        srcTexture,
        outputTargetView,
        targetWidth,
        targetHeight,
        this.settings.fsrSharpness
      );
    }
  }

  private ensureIntermediateTexture(width: number, height: number): void {
    if (this.intermediateTexture && this.intermediateWidth === width && this.intermediateHeight === height) {
      return;
    }
    if (this.intermediateTexture) {
      this.intermediateTexture.destroy();
    }
    this.intermediateWidth = width;
    this.intermediateHeight = height;
    this.intermediateTexture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
  }

  public destroy(): void {
    this.cadenceDetector.destroy();
    this.upscalerManager.destroy();
    if (this.intermediateTexture) {
      this.intermediateTexture.destroy();
      this.intermediateTexture = null;
    }
    this.fsrConstBuffer.destroy();
    this.rcasConstBuffer.destroy();
    this.warpUniformBuffer.destroy();
  }
}
