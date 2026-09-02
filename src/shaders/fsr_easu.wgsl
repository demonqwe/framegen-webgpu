/**
 * AMD FidelityFX Super Resolution 1.0 (FSR) - EASU (Edge-Adaptive Spatial Upsampling)
 * Ported to WebGPU WGSL for 1080p -> 1440p (1.333x) and arbitrary scaling.
 */

struct FsrEasuConstants {
  con0: vec4<f32>, // [srcW/outW, srcH/outH, 0.5*srcW/outW - 0.5, 0.5*srcH/outH - 0.5]
  con1: vec4<f32>, // [1/srcW, 1/srcH, 1/srcW, -1/srcH]
  con2: vec4<f32>, // [-1/srcW, 2/srcH, 1/srcW, 2/srcH]
  con3: vec4<f32>, // [0, 4/srcH, 0, 0]
};

@group(0) @binding(0) var<uniform> fsrConsts: FsrEasuConstants;
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

// Directional Lanczos-2 weight calculation
fn FsrEasuW(d: f32) -> f32 {
  if (d >= 2.0) { return 0.0; }
  let x = d * 3.14159265;
  if (abs(x) < 0.0001) { return 1.0; }
  return (sin(x) / x) * (sin(x * 0.5) / (x * 0.5));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let pos = in.position.xy;
  
  // Transform output pixel coords to input pixel center
  let pp = pos * fsrConsts.con0.xy + fsrConsts.con0.zw;
  let fp = floor(pp);
  let f = pp - fp;

  let dTex = fsrConsts.con1.xy;
  let baseUv = (fp + vec2<f32>(0.5, 0.5)) * dTex;

  // 12-tap sampling for directional edge filtering
  let c00 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>(-1.0, -1.0) * dTex).rgb;
  let c10 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 0.0, -1.0) * dTex).rgb;
  let c20 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 1.0, -1.0) * dTex).rgb;
  
  let c01 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>(-1.0,  0.0) * dTex).rgb;
  let c11 = textureSample(inputTexture, linearSampler, baseUv).rgb;
  let c21 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 1.0,  0.0) * dTex).rgb;
  let c31 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 2.0,  0.0) * dTex).rgb;

  let c02 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>(-1.0,  1.0) * dTex).rgb;
  let c12 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 0.0,  1.0) * dTex).rgb;
  let c22 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 1.0,  1.0) * dTex).rgb;
  let c32 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 2.0,  1.0) * dTex).rgb;

  let c13 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 0.0,  2.0) * dTex).rgb;
  let c23 = textureSample(inputTexture, linearSampler, baseUv + vec2<f32>( 1.0,  2.0) * dTex).rgb;

  // Edge direction estimation using Sobel-like gradients
  let dirX = (dot(c21 - c01, vec3<f32>(0.299, 0.587, 0.114)) + dot(c22 - c02, vec3<f32>(0.299, 0.587, 0.114))) * 0.5;
  let dirY = (dot(c12 - c10, vec3<f32>(0.299, 0.587, 0.114)) + dot(c22 - c20, vec3<f32>(0.299, 0.587, 0.114))) * 0.5;

  let len = max(0.0001, sqrt(dirX * dirX + dirY * dirY));
  let dir = vec2<f32>(dirX / len, dirY / len);

  // Directional Lanczos interpolation weights
  var totalCol = vec3<f32>(0.0);
  var totalW = 0.0;

  let samples = array<vec3<f32>, 4>(c11, c21, c12, c22);
  let offsets = array<vec2<f32>, 4>(
    vec2<f32>(0.0, 0.0) - f,
    vec2<f32>(1.0, 0.0) - f,
    vec2<f32>(0.0, 1.0) - f,
    vec2<f32>(1.0, 1.0) - f
  );

  for (var i = 0; i < 4; i++) {
    let off = offsets[i];
    let dProj = abs(dot(off, dir));
    let dOrth = abs(dot(off, vec2<f32>(-dir.y, dir.x)));
    let w = FsrEasuW(dProj) * FsrEasuW(dOrth * 0.75);
    totalCol += samples[i] * w;
    totalW += w;
  }

  let finalCol = totalCol / max(0.0001, totalW);
  return vec4<f32>(clamp(finalCol, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
