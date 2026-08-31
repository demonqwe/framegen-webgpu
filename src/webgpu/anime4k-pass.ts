import anime4kShaderCode from './shaders/anime4k_thin.wgsl?raw';

export type ScalerMode = 'anime4k' | 'fsr' | 'bicubic' | 'off';

export interface Anime4KParams {
  strength: number;          // 0.0 (off) to 1.5 (high)
  thinningThreshold?: number;// default: 0.05
  scalerMode?: ScalerMode;
}

export class Anime4KPass {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private bindGroupLayout: GPUBindGroupLayout;
  private dummyTexture: GPUTexture;

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat) {
    this.device = device;

    const shaderModule = device.createShaderModule({
      label: 'Multi-Algorithm Scaler Shader',
      code: anime4kShaderCode
    });

    this.sampler = device.createSampler({
      label: 'Video Linear Sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });

    // Uniform buffer: 8 x f32 = 32 bytes
    this.uniformBuffer = device.createBuffer({
      label: 'Scaler Uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // 1x1 dummy texture for single texture mode
    this.dummyTexture = device.createTexture({
      label: 'Dummy Texture',
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'Scaler BindGroupLayout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' }
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d' }
        }
      ]
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'Scaler PipelineLayout',
      bindGroupLayouts: [this.bindGroupLayout]
    });

    this.pipeline = device.createRenderPipeline({
      label: 'Scaler Render Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main'
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: presentationFormat
          }
        ]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none'
      }
    });
  }

  public render(
    tex0: GPUTexture,
    targetView: GPUTextureView,
    inputWidth: number,
    inputHeight: number,
    params: Anime4KParams,
    tex1: GPUTexture | null = null,
    mixFactor = 0.0
  ): void {
    const strength = params.strength ?? 0.8;
    const thinningThreshold = params.thinningThreshold ?? 0.05;
    const hasTex1 = tex1 ? 1.0 : 0.0;

    let modeCode = 0.0; // 0: Anime4K
    if (params.scalerMode === 'fsr') modeCode = 1.0;
    else if (params.scalerMode === 'bicubic') modeCode = 2.0;
    else if (params.scalerMode === 'off') modeCode = 3.0;

    // Update uniform buffer: texWidth, texHeight, strength, thinningThreshold, mixFactor, hasTex1, scalerMode, 0.0
    const uniformData = new Float32Array([
      inputWidth,
      inputHeight,
      strength,
      thinningThreshold,
      mixFactor,
      hasTex1,
      modeCode,
      0.0
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData.buffer);

    const secondTexture = tex1 || this.dummyTexture;

    const bindGroup = this.device.createBindGroup({
      label: 'Scaler BindGroup',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: tex0.createView() },
        { binding: 3, resource: secondTexture.createView() }
      ]
    });

    const commandEncoder = this.device.createCommandEncoder({
      label: 'Scaler CommandEncoder'
    });

    const passEncoder = commandEncoder.beginRenderPass({
      label: 'Scaler RenderPass',
      colorAttachments: [
        {
          view: targetView,
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3, 1, 0, 0); // Fullscreen Triangle covering [-1, 1]
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  public destroy(): void {
    this.uniformBuffer.destroy();
    this.dummyTexture.destroy();
  }
}
