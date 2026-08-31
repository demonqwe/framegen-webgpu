/**
 * WebGPU Device and Context Management with shader-f16 support
 * Strictly enforces a single GPUDevice singleton per frame context.
 */

export interface GPUContextBundle {
  adapter: GPUAdapter;
  device: GPUDevice;
  hasShaderF16: boolean;
  presentationFormat: GPUTextureFormat;
}

let initPromise: Promise<GPUContextBundle> | null = null;

/**
 * Initializes and returns the high-performance WebGPU device with shader-f16 if available.
 * Thread/Async safe singleton preventing multiple conflicting GPUDevice creations.
 */
export function initWebGPU(): Promise<GPUContextBundle> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser.');
    }

    const adapter = await navigator.gpu.requestAdapter();

    if (!adapter) {
      throw new Error('Failed to acquire a WebGPU Adapter (high-performance).');
    }

    const hasShaderF16 = adapter.features.has('shader-f16');
    const requiredFeatures: GPUFeatureName[] = [];
    if (hasShaderF16) {
      requiredFeatures.push('shader-f16');
    }

    const device = await adapter.requestDevice({
      requiredFeatures
    });

    device.lost.then((info) => {
      console.error('WebGPU Device was lost:', info.message);
      initPromise = null;
    });

    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    console.log(`[Anime FrameGen] WebGPU single device initialized. shader-f16: ${hasShaderF16}, format: ${presentationFormat}`);

    return {
      adapter,
      device,
      hasShaderF16,
      presentationFormat
    };
  })();

  return initPromise;
}

/**
 * Configures a canvas element with the WebGPU device.
 */
export function configureCanvas(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat
): GPUCanvasContext {
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new Error('Could not get WebGPU context from canvas.');
  }

  // Ensure canvas dimensions are never 0 to prevent WebGPU validation error
  if (!canvas.width || canvas.width <= 0) canvas.width = 1280;
  if (!canvas.height || canvas.height <= 0) canvas.height = 720;

  context.configure({
    device,
    format,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
  });

  return context;
}
