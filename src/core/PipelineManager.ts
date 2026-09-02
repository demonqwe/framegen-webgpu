import { ExtensionSettings, DEFAULT_SETTINGS } from '../config/defaults';
import { CadenceDetector, CadenceResult } from '../pipelines/CadenceDetector';
import { UpscalerManager } from '../models/Upscaler';
import { NeuralFramegenEngine } from '../webgpu/neural-framegen-engine';
import fsrEasuShaderSource from '../shaders/fsr_easu.wgsl?raw';
import fsrRcasShaderSource from '../shaders/fsr_rcas.wgsl?raw';
import warpShaderSource from '../shaders/warp.wgsl?raw';
import motionFlowShaderSource from '../shaders/motion_flow.wgsl?raw';

export class PipelineManager {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private settings: ExtensionSettings;

  private cadenceDetector: CadenceDetector;
  private upscalerManager: UpscalerManager;
  private neuralFramegen: NeuralFramegenEngine;

  // FSR 1.0 pipelines
  private fsrEasuPipeline: GPURenderPipeline;
  private fsrRcasPipeline: GPURenderPipeline;
  private fsrConstBuffer: GPUBuffer;
  private rcasConstBuffer: GPUBuffer;

  // Motion Flow & Warp pipelines
  private motionFlowPipeline: GPUComputePipeline;
  private motionFlowUniformBuffer: GPUBuffer;
  private flowTex0: GPUTexture | null = null;
  private flowTex1: GPUTexture | null = null;
  private maskTex: GPUTexture | null = null;
  private flowWidth = 0;
  private flowHeight = 0;

  private warpPipeline: GPURenderPipeline;
  private warpUniformBuffer: GPUBuffer;
  private warpedTexture: GPUTexture | null = null;
  private warpedWidth = 0;
  private warpedHeight = 0;

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
    this.neuralFramegen = new NeuralFramegenEngine(device);
    if (settings.neuralModel) {
      this.neuralFramegen.setModelType(settings.neuralModel);
    }

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
      fragment: { module: warpModule, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' }
    });

    // 4. Build Motion Flow Compute pipeline
    const motionFlowModule = device.createShaderModule({ label: 'Motion Flow Module', code: motionFlowShaderSource });
    this.motionFlowUniformBuffer = device.createBuffer({
      size: 32, // 8 x f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.motionFlowPipeline = device.createComputePipeline({
      label: 'Motion Flow Pipeline',
      layout: 'auto',
      compute: { module: motionFlowModule, entryPoint: 'main' }
    });
  }

  public updateSettings(settings: Partial<ExtensionSettings>): void {
    this.settings = { ...this.settings, ...settings };
    if (settings.neuralModel !== undefined && settings.neuralModel !== this.settings.neuralModel) {
      this.neuralFramegen.setModelType(settings.neuralModel);
    }
    if (settings.cadenceThreshold !== undefined) {
      this.cadenceDetector.setThreshold(settings.cadenceThreshold);
    }
    if (settings.scalerAlgorithm !== undefined) {
      this.upscalerManager.setMode(settings.scalerAlgorithm);
    }
  }

  public isOnnxActive(): boolean {
    return this.upscalerManager.isOnnxActive();
  }

  /**
   * Computes target canvas dimensions for 1440p, 4K, or Auto.
   */
  public computeTargetDimensions(srcWidth: number, srcHeight: number, _screenWidth = 2560, screenHeight = 1440): { width: number; height: number } {
    const aspect = (srcWidth > 0 && srcHeight > 0) ? srcWidth / srcHeight : 16 / 9;

    if (this.settings.targetResolution === '4k') {
      const h = 2160;
      const w = Math.round(h * aspect);
      return { width: w, height: h };
    }

    if (this.settings.targetResolution === '1440p') {
      const h = 1440;
      const w = Math.round(h * aspect);
      return { width: w, height: h };
    }

    // Auto resolution: adapt to screen or native container
    const h = Math.max(1440, screenHeight);
    const w = Math.round(h * aspect);
    return { width: w, height: h };
  }

  private frameAccumulator = 0.0;

  public getInterpolationSteps(sourceFps = 24): number[] {
    if (this.settings.multiplierMode === 'target_fps' && this.settings.targetFps > 0 && sourceFps > 0) {
      if (sourceFps >= this.settings.targetFps) {
        return [];
      }
      const k = this.settings.targetFps / sourceFps;
      this.frameAccumulator += k;
      const framesToEmit = Math.floor(this.frameAccumulator);
      this.frameAccumulator -= framesToEmit;

      const intermediateCount = framesToEmit - 1;
      if (intermediateCount <= 0) {
        return [];
      }

      const steps: number[] = [];
      for (let i = 1; i <= intermediateCount; i++) {
        steps.push(Math.round((i / framesToEmit) * 1000) / 1000);
      }
      return steps;
    }

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
   * Performs 2-pass FSR 1.0 upscaling (EASU + RCAS) to target resolution.
   */
  public renderFsr(
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
   * Dispatches selected scaler algorithm (FSR / Anime4K / SPAN / Compact / Bicubic / Off) to 1440p or 4K.
   */
  public async upscaleFrame(
    commandEncoder: GPUCommandEncoder,
    srcTexture: GPUTexture,
    outputTargetView: GPUTextureView,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Promise<void> {
    if (this.settings.scalerAlgorithm === 'fsr') {
      this.renderFsr(
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
        this.settings.fsrSharpness,
        srcWidth,
        srcHeight
      );
    }
  }

  public computeMotionFlow(
    commandEncoder: GPUCommandEncoder,
    tex0: GPUTexture,
    tex1: GPUTexture,
    srcWidth: number,
    srcHeight: number
  ): void {
    this.ensureFlowTextures(srcWidth, srcHeight);
    if (!this.flowTex0 || !this.flowTex1 || !this.maskTex) return;

    const motionData = new Float32Array([
      srcWidth,
      srcHeight,
      this.flowWidth,
      this.flowHeight,
      8.0,  // search radius
      0.28, // sceneCutThreshold
      0.0,
      0.0
    ]);
    this.device.queue.writeBuffer(this.motionFlowUniformBuffer, 0, motionData);

    const linearSampler = this.device.createSampler({ minFilter: 'linear', magFilter: 'linear' });

    const bindGroup = this.device.createBindGroup({
      layout: this.motionFlowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.motionFlowUniformBuffer } },
        { binding: 1, resource: linearSampler },
        { binding: 2, resource: tex0.createView() },
        { binding: 3, resource: tex1.createView() },
        { binding: 4, resource: this.flowTex0.createView() },
        { binding: 5, resource: this.flowTex1.createView() },
        { binding: 6, resource: this.maskTex.createView() }
      ]
    });

    const pass = commandEncoder.beginComputePass({ label: 'Motion Flow Pass' });
    pass.setPipeline(this.motionFlowPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.flowWidth / 8),
      Math.ceil(this.flowHeight / 8)
    );
    pass.end();
  }

  /**
   * Generates a truly interpolated intermediate frame between tex0 and tex1 at timestep stepT (0.0..1.0),
   * then runs the active upscaler pipeline to the output target view.
   */
  public async generateInterpolatedFrame(
    commandEncoder: GPUCommandEncoder,
    tex0: GPUTexture,
    tex1: GPUTexture,
    stepT: number,
    outputTargetView: GPUTextureView,
    srcWidth: number,
    srcHeight: number,
    targetWidth: number,
    targetHeight: number
  ): Promise<void> {
    let modelW = srcWidth;
    let modelH = srcHeight;
    if (this.settings.neuralResolution === '720p') {
      const scale = Math.min(1, 1280 / srcWidth, 720 / srcHeight);
      modelW = Math.max(64, Math.round(srcWidth * scale));
      modelH = Math.max(64, Math.round(srcHeight * scale));
    } else if (this.settings.neuralResolution === '540p') {
      const scale = Math.min(1, 960 / srcWidth, 540 / srcHeight);
      modelW = Math.max(64, Math.round(srcWidth * scale));
      modelH = Math.max(64, Math.round(srcHeight * scale));
    }

    const alignedW = Math.max(64, Math.floor(modelW / 16) * 16);
    const alignedH = Math.max(64, Math.floor(modelH / 16) * 16);

    this.ensureWarpedTexture(alignedW, alignedH);
    if (!this.warpedTexture) return;

    // A. Neural FrameGen path (EMA-VFI v7s / tfact2 custom WGSL runtime)
    if (this.settings.framegenEngine === 'neural') {
      try {
        const initialized = await this.neuralFramegen.initPipeline(alignedW, alignedH);
        if (initialized) {
          // Run neural trunk for frame pair (conv0 + convblocks)
          await this.neuralFramegen.prepPair(tex0, tex1);
          // Generate subframe at timestep stepT directly into warped intermediate texture
          this.neuralFramegen.runT(stepT, this.warpedTexture);

          // Upscale neural intermediate frame to final canvas target view
          await this.upscaleFrame(
            commandEncoder,
            this.warpedTexture,
            outputTargetView,
            this.neuralFramegen.alignedWidth || alignedW,
            this.neuralFramegen.alignedHeight || alignedH,
            targetWidth,
            targetHeight
          );
          return;
        }
      } catch (neuralErr) {
        console.warn('[FrameGen] Neural step failed, falling back to compute flow:', neuralErr);
      }
    }

    // B. Fast hardware compute shader motion flow fallback
    // 1. Compute bidirectional motion flow between T0 and T1
    this.computeMotionFlow(commandEncoder, tex0, tex1, srcWidth, srcHeight);

    // 2. Warp source frames T0 and T1 to intermediate timestep stepT
    if (this.flowTex0 && this.flowTex1 && this.maskTex) {
      this.warpFrames(
        commandEncoder,
        this.warpedTexture.createView(),
        tex0,
        tex1,
        this.flowTex0,
        this.flowTex1,
        this.maskTex,
        srcWidth,
        srcHeight,
        this.flowWidth,
        this.flowHeight,
        stepT
      );
    }

    // 3. Upscale warped intermediate frame to final canvas target view
    await this.upscaleFrame(
      commandEncoder,
      this.warpedTexture,
      outputTargetView,
      srcWidth,
      srcHeight,
      targetWidth,
      targetHeight
    );
  }

  private ensureFlowTextures(srcWidth: number, srcHeight: number): void {
    const fW = Math.max(32, Math.round(srcWidth / 8));
    const fH = Math.max(18, Math.round(srcHeight / 8));
    if (this.flowWidth === fW && this.flowHeight === fH && this.flowTex0 && this.flowTex1 && this.maskTex) {
      return;
    }
    if (this.flowTex0) this.flowTex0.destroy();
    if (this.flowTex1) this.flowTex1.destroy();
    if (this.maskTex) this.maskTex.destroy();

    this.flowWidth = fW;
    this.flowHeight = fH;

    const desc: GPUTextureDescriptor = {
      size: [fW, fH],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    };

    this.flowTex0 = this.device.createTexture({ ...desc, label: 'MotionFlow_T0' });
    this.flowTex1 = this.device.createTexture({ ...desc, label: 'MotionFlow_T1' });
    this.maskTex = this.device.createTexture({ ...desc, label: 'MotionFlow_Mask' });
  }

  private ensureWarpedTexture(srcWidth: number, srcHeight: number): void {
    const w16 = Math.max(64, Math.floor(srcWidth / 16) * 16);
    const h16 = Math.max(64, Math.floor(srcHeight / 16) * 16);
    if (this.warpedTexture && this.warpedWidth === w16 && this.warpedHeight === h16) {
      return;
    }
    if (this.warpedTexture) {
      this.warpedTexture.destroy();
    }
    this.warpedWidth = w16;
    this.warpedHeight = h16;
    this.warpedTexture = this.device.createTexture({
      size: [w16, h16],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING
    });
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
    this.neuralFramegen.destroy();
    this.cadenceDetector.destroy();
    this.upscalerManager.destroy();
    if (this.intermediateTexture) {
      this.intermediateTexture.destroy();
      this.intermediateTexture = null;
    }
    if (this.warpedTexture) {
      this.warpedTexture.destroy();
      this.warpedTexture = null;
    }
    if (this.flowTex0) {
      this.flowTex0.destroy();
      this.flowTex0 = null;
    }
    if (this.flowTex1) {
      this.flowTex1.destroy();
      this.flowTex1 = null;
    }
    if (this.maskTex) {
      this.maskTex.destroy();
      this.maskTex = null;
    }
    this.fsrConstBuffer.destroy();
    this.rcasConstBuffer.destroy();
    this.warpUniformBuffer.destroy();
    this.motionFlowUniformBuffer.destroy();
  }
}
