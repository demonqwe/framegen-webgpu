/**
 * AMD FidelityFX Super Resolution 1.0 (FSR) - RCAS (Robust Contrast-Adaptive Sharpening)
 * Ported to WebGPU WGSL for 1440p post-upscale sharpening.
 */

struct FsrRcasConstants {
  rcasConfig: vec4<f32>, // [sharpness, outW, outH, pad]
};

@group(0) @binding(0) var<uniform> rcasConsts: FsrRcasConstants;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

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
  let dTex = vec2<f32>(1.0 / max(1.0, rcasConsts.rcasConfig.y), 1.0 / max(1.0, rcasConsts.rcasConfig.z));

  // 5-tap cross neighborhood
  let c = textureSample(inputTexture, linearSampler, uv).rgb;
  let n = textureSample(inputTexture, linearSampler, uv + vec2<f32>( 0.0, -1.0) * dTex).rgb;
  let s = textureSample(inputTexture, linearSampler, uv + vec2<f32>( 0.0,  1.0) * dTex).rgb;
  let w = textureSample(inputTexture, linearSampler, uv + vec2<f32>(-1.0,  0.0) * dTex).rgb;
  let e = textureSample(inputTexture, linearSampler, uv + vec2<f32>( 1.0,  0.0) * dTex).rgb;

  // Local contrast range (RGB min/max)
  let minCol = min(c, min(min(n, s), min(w, e)));
  let maxCol = max(c, max(max(n, s), max(w, e)));

  // Perceptual luma
  let lumaC = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  let lumaMin = dot(minCol, vec3<f32>(0.299, 0.587, 0.114));
  let lumaMax = dot(maxCol, vec3<f32>(0.299, 0.587, 0.114));

  // Sharpness weight with contrast adaptation
  let sharpness = rcasConsts.rcasConfig.x; // e.g. 0.8
  let peak = max(0.0001, min(lumaC - lumaMin, lumaMax - lumaC));
  let weight = -clamp(peak / max(0.0001, lumaMax - lumaMin) * sharpness * 0.25, 0.0, 0.22);

  let sharpened = (c + (n + s + w + e) * weight) / (1.0 + 4.0 * weight);

  // Anti-ringing clamp to local min/max
  let clamped = clamp(sharpened, minCol, maxCol);

  return vec4<f32>(clamped, 1.0);
}
