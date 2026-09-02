/**
 * WebGPU Compute Shader: Fast Bidirectional Hierarchical Motion Flow Estimation
 * Computes forward/backward motion displacement vectors between T0 and T1
 * for real-time 60-120 FPS frame interpolation in video playback.
 */

struct MotionParams {
  srcWidth: f32,
  srcHeight: f32,
  flowWidth: f32,
  flowHeight: f32,
  searchRadius: f32,       // e.g. 8.0 texels in flow space
  sceneCutThreshold: f32,  // e.g. 0.28 (SAD above this drops motion vectors to 0)
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> params: MotionParams;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var tex0: texture_2d<f32>; // Frame T0
@group(0) @binding(3) var tex1: texture_2d<f32>; // Frame T1

// Storage outputs
@group(0) @binding(4) var outFlow0: texture_storage_2d<rgba16float, write>; // -M (backward displacement to T0)
@group(0) @binding(5) var outFlow1: texture_storage_2d<rgba16float, write>; // +M (forward displacement to T1)
@group(0) @binding(6) var outMask:  texture_storage_2d<rgba16float, write>; // Confidence / Blend Mask

fn get_luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// 5-point cross pattern SAD evaluator
fn compute_block_sad(centerUv: vec2f, offsetUv: vec2f, dTex: vec2f) -> f32 {
  let uv0 = clamp(centerUv, vec2f(0.0), vec2f(1.0));
  let uv1 = clamp(centerUv + offsetUv, vec2f(0.0), vec2f(1.0));

  let c0_m = textureSampleLevel(tex0, linearSampler, uv0, 0.0).rgb;
  let c1_m = textureSampleLevel(tex1, linearSampler, uv1, 0.0).rgb;

  let c0_t = textureSampleLevel(tex0, linearSampler, clamp(uv0 + vec2f(0.0, -dTex.y), vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let c1_t = textureSampleLevel(tex1, linearSampler, clamp(uv1 + vec2f(0.0, -dTex.y), vec2f(0.0), vec2f(1.0)), 0.0).rgb;

  let c0_b = textureSampleLevel(tex0, linearSampler, clamp(uv0 + vec2f(0.0,  dTex.y), vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let c1_b = textureSampleLevel(tex1, linearSampler, clamp(uv1 + vec2f(0.0,  dTex.y), vec2f(0.0), vec2f(1.0)), 0.0).rgb;

  let c0_l = textureSampleLevel(tex0, linearSampler, clamp(uv0 + vec2f(-dTex.x, 0.0), vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let c1_l = textureSampleLevel(tex1, linearSampler, clamp(uv1 + vec2f(-dTex.x, 0.0), vec2f(0.0), vec2f(1.0)), 0.0).rgb;

  let c0_r = textureSampleLevel(tex0, linearSampler, clamp(uv0 + vec2f( dTex.x, 0.0), vec2f(0.0), vec2f(1.0)), 0.0).rgb;
  let c1_r = textureSampleLevel(tex1, linearSampler, clamp(uv1 + vec2f( dTex.x, 0.0), vec2f(0.0), vec2f(1.0)), 0.0).rgb;

  let diff_m = abs(get_luma(c0_m) - get_luma(c1_m));
  let diff_t = abs(get_luma(c0_t) - get_luma(c1_t));
  let diff_b = abs(get_luma(c0_b) - get_luma(c1_b));
  let diff_l = abs(get_luma(c0_l) - get_luma(c1_l));
  let diff_r = abs(get_luma(c0_r) - get_luma(c1_r));

  return diff_m * 0.4 + (diff_t + diff_b + diff_l + diff_r) * 0.15;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;

  if (f32(x) >= params.flowWidth || f32(y) >= params.flowHeight) {
    return;
  }

  let flowDims = vec2f(params.flowWidth, params.flowHeight);
  let dFlow = vec2f(1.0) / flowDims;
  let uv = (vec2f(f32(x) + 0.5, f32(y) + 0.5)) * dFlow;

  // Zero displacement baseline
  let zeroSad = compute_block_sad(uv, vec2f(0.0), dFlow);

  var bestSad = zeroSad;
  var bestOffset = vec2f(0.0);

  // Phase 1: Coarse Grid Search (step = 2)
  let maxR = i32(params.searchRadius);
  for (var dy = -maxR; dy <= maxR; dy = dy + 2) {
    for (var dx = -maxR; dx <= maxR; dx = dx + 2) {
      if (dx == 0 && dy == 0) { continue; }
      let offsetUv = vec2f(f32(dx), f32(dy)) * dFlow;
      let sad = compute_block_sad(uv, offsetUv, dFlow);
      // Small penalty for distance to prefer static background
      let distPenalty = length(vec2f(f32(dx), f32(dy))) * 0.003;
      if (sad + distPenalty < bestSad) {
        bestSad = sad + distPenalty;
        bestOffset = vec2f(f32(dx), f32(dy));
      }
    }
  }

  // Phase 2: Fine Search (step = 1 around best coarse)
  let coarseBest = bestOffset;
  for (var fdy = -1; fdy <= 1; fdy = fdy + 1) {
    for (var fdx = -1; fdx <= 1; fdx = fdx + 1) {
      let candidate = coarseBest + vec2f(f32(fdx), f32(fdy));
      let offsetUv = candidate * dFlow;
      let sad = compute_block_sad(uv, offsetUv, dFlow);
      let distPenalty = length(candidate) * 0.002;
      if (sad + distPenalty < bestSad) {
        bestSad = sad + distPenalty;
        bestOffset = candidate;
      }
    }
  }

  // Phase 3: Scene Cut / Major Occlusion Detection
  // If difference is above sceneCutThreshold, motion is ambiguous -> damp to 0
  let isSceneCut = zeroSad > params.sceneCutThreshold && bestSad > (params.sceneCutThreshold * 0.85);
  let motionConfidence = select(smoothstep(params.sceneCutThreshold, params.sceneCutThreshold * 0.4, bestSad), 0.0, isSceneCut);

  let finalMotion = bestOffset * motionConfidence;

  // outFlow0 = -M (sample T0 looking backward)
  // outFlow1 = +M (sample T1 looking forward)
  textureStore(outFlow0, vec2<u32>(x, y), vec4f(-finalMotion.x, -finalMotion.y, bestSad, 1.0));
  textureStore(outFlow1, vec2<u32>(x, y), vec4f( finalMotion.x,  finalMotion.y, bestSad, 1.0));

  // Blend weight: 0.5 is balanced; adjust by relative change
  let maskVal = clamp(0.5 + (zeroSad - bestSad) * 0.5, 0.1, 0.9);
  textureStore(outMask, vec2<u32>(x, y), vec4f(maskVal, motionConfidence, 0.0, 1.0));
}
