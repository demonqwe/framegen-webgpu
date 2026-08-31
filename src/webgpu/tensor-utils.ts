/**
 * WebGPU compute shaders and utilities for zero-copy texture <-> tensor conversions (NCHW format & padding).
 */

export interface PaddedDimensions {
  originalWidth: number;
  originalHeight: number;
  paddedWidth: number;
  paddedHeight: number;
}

export function calculatePaddedDimensions(width: number, height: number, align = 32): PaddedDimensions {
  const paddedWidth = Math.ceil(width / align) * align;
  const paddedHeight = Math.ceil(height / align) * align;
  return {
    originalWidth: width,
    originalHeight: height,
    paddedWidth,
    paddedHeight
  };
}

const RGBA_TO_NCHW_WGSL = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    dstWidth: u32,
    dstHeight: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outputBuffer: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = id.x;
    let y = id.y;

    if (x >= params.dstWidth || y >= params.dstHeight) {
        return;
    }

    var color = vec4f(0.0, 0.0, 0.0, 1.0);
    if (x < params.srcWidth && y < params.srcHeight) {
        color = textureLoad(inputTex, vec2<u32>(x, y), 0);
    }

    let planeSize = params.dstWidth * params.dstHeight;
    let pixelIndex = y * params.dstWidth + x;

    // NCHW format: [1, 3, H, W]
    outputBuffer[0u * planeSize + pixelIndex] = color.r;
    outputBuffer[1u * planeSize + pixelIndex] = color.g;
    outputBuffer[2u * planeSize + pixelIndex] = color.b;
}
`;

const NCHW_TO_RGBA_WGSL = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    dstWidth: u32,
    dstHeight: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> inputBuffer: array<f32>;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = id.x;
    let y = id.y;

    if (x >= params.dstWidth || y >= params.dstHeight) {
        return;
    }

    let planeSize = params.srcWidth * params.srcHeight;
    let pixelIndex = y * params.srcWidth + x;

    let r = clamp(inputBuffer[0u * planeSize + pixelIndex], 0.0, 1.0);
    let g = clamp(inputBuffer[1u * planeSize + pixelIndex], 0.0, 1.0);
    let b = clamp(inputBuffer[2u * planeSize + pixelIndex], 0.0, 1.0);

    textureStore(outputTex, vec2<u32>(x, y), vec4f(r, g, b, 1.0));
}
`;

export class TensorTextureConverter {
  private device: GPUDevice;
  private toNCHWPipeline: GPUComputePipeline;
  private toRGBAPipeline: GPUComputePipeline;
  private uniformBuffer: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;

    const toNCHWModule = device.createShaderModule({
      label: 'RGBA to NCHW Compute Shader',
      code: RGBA_TO_NCHW_WGSL
    });

    this.toNCHWPipeline = device.createComputePipeline({
      label: 'RGBA to NCHW Pipeline',
      layout: 'auto',
      compute: { module: toNCHWModule, entryPoint: 'main' }
    });

    const toRGBAModule = device.createShaderModule({
      label: 'NCHW to RGBA Compute Shader',
      code: NCHW_TO_RGBA_WGSL
    });

    this.toRGBAPipeline = device.createComputePipeline({
      label: 'NCHW to RGBA Pipeline',
      layout: 'auto',
      compute: { module: toRGBAModule, entryPoint: 'main' }
    });

    this.uniformBuffer = device.createBuffer({
      label: 'TensorConverter Uniforms',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  /**
   * Copies HTMLVideoElement into a GPUTexture directly (Zero-Copy)
   */
  public copyVideoToTexture(
    video: HTMLVideoElement,
    targetTexture: GPUTexture,
    width: number,
    height: number
  ): void {
    this.device.queue.copyExternalImageToTexture(
      { source: video },
      { texture: targetTexture },
      [width, height]
    );
  }

  /**
   * Converts RGBA GPUTexture into an NCHW flat float buffer with padding
   */
  public convertTextureToNCHW(
    srcTexture: GPUTexture,
    dstBuffer: GPUBuffer,
    dims: PaddedDimensions
  ): void {
    const params = new Uint32Array([
      dims.originalWidth,
      dims.originalHeight,
      dims.paddedWidth,
      dims.paddedHeight
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, params.buffer);

    const bindGroup = this.device.createBindGroup({
      layout: this.toNCHWPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: srcTexture.createView() },
        { binding: 2, resource: { buffer: dstBuffer } }
      ]
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.toNCHWPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(dims.paddedWidth / 16),
      Math.ceil(dims.paddedHeight / 16)
    );
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Converts NCHW output buffer into an RGBA GPUTexture
   */
  public convertNCHWToTexture(
    srcBuffer: GPUBuffer,
    dstTexture: GPUTexture,
    dims: PaddedDimensions
  ): void {
    const params = new Uint32Array([
      dims.paddedWidth,
      dims.paddedHeight,
      dims.originalWidth,
      dims.originalHeight
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, params.buffer);

    const bindGroup = this.device.createBindGroup({
      layout: this.toRGBAPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: srcBuffer } },
        { binding: 2, resource: dstTexture.createView() }
      ]
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.toRGBAPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(dims.originalWidth / 16),
      Math.ceil(dims.originalHeight / 16)
    );
    pass.end();

    this.device.queue.submit([encoder.finish()]);
  }
}
