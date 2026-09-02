/**
 * WGSL High-Res Backward Warping Shader
 * Uses low-res optical flow field from RIFE and warps high-res source textures.
 */

struct WarpUniforms {
  srcWidth: f32,
  srcHeight: f32,
  flowWidth: f32,
  flowHeight: f32,
  stepT: f32,
  blendWeight: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> uniforms: WarpUniforms;
@group(0) @binding(1) var bilinearSampler: sampler;

// Low-Res Optical Flow & Mask
@group(0) @binding(2) var flowTex0: texture_2d<f32>; // F_t->0
@group(0) @binding(3) var flowTex1: texture_2d<f32>; // F_t->1
@group(0) @binding(4) var maskTex:  texture_2d<f32>; // Mask M

// High-Res Source Textures
@group(0) @binding(5) var srcTex0:  texture_2d<f32>; // I_0 (Full-Res)
@group(0) @binding(6) var srcTex1:  texture_2d<f32>; // I_1 (Full-Res)

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );

  var uv = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0)
  );

  var out: VertexOutput;
  out.position = vec4<f32>(pos[in_vertex_index], 0.0, 1.0);
  out.uv = uv[in_vertex_index];
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let uv = in.uv;

  // 1. Bilinearly sample low-res flow field vectors and mask
  let rawFlow0 = textureSample(flowTex0, bilinearSampler, uv).xy;
  let rawFlow1 = textureSample(flowTex1, bilinearSampler, uv).xy;
  let rawMask  = textureSample(maskTex,  bilinearSampler, uv).r;

  // 2. Scale displacement vector from low-res grid to full-res grid
  let scaleX = uniforms.srcWidth  / max(1.0, uniforms.flowWidth);
  let scaleY = uniforms.srcHeight / max(1.0, uniforms.flowHeight);
  let scaleVector = vec2<f32>(scaleX, scaleY);

  // Optical flow displacement in UV coordinates (0.0 .. 1.0) scaled by stepT
  let step = clamp(uniforms.stepT, 0.0, 1.0);
  let d0 = (rawFlow0 * scaleVector * step) / vec2<f32>(uniforms.srcWidth, uniforms.srcHeight);
  let d1 = (rawFlow1 * scaleVector * (1.0 - step)) / vec2<f32>(uniforms.srcWidth, uniforms.srcHeight);

  let warpedUv0 = clamp(uv + d0, vec2<f32>(0.0), vec2<f32>(1.0));
  let warpedUv1 = clamp(uv + d1, vec2<f32>(0.0), vec2<f32>(1.0));

  // 3. Sample original high-resolution frames at warped coordinates
  let col0 = textureSample(srcTex0, bilinearSampler, warpedUv0).rgb;
  let col1 = textureSample(srcTex1, bilinearSampler, warpedUv1).rgb;

  // 4. Blend using temporal timestep and motion confidence mask
  let maskWeight = clamp(mix(step, rawMask, 0.25), 0.0, 1.0);
  let finalColor = mix(col0, col1, maskWeight);

  return vec4<f32>(finalColor, 1.0);
}
