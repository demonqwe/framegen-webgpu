/**
 * WGSL Compute Shader: L1 / L2 Frame Difference & Duplicate Detector
 * Evaluates frame difference between consecutive frames with workgroup shared memory reduction.
 */

@group(0) @binding(0) var texA: texture_2d<f32>;
@group(0) @binding(1) var texB: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outputDiff: array<atomic<u32>, 2>; // [0]: sum_diff_fixed_point, [1]: sample_count

var<workgroup> sharedDiff: array<f32, 64>;

@compute @workgroup_size(8, 8, 1)
fn main(
  @builtin(global_invocation_id) global_id: vec3<u32>,
  @builtin(local_invocation_id) local_id: vec3<u32>,
  @builtin(local_invocation_index) local_idx: u32
) {
  let dims = textureDimensions(texA);
  
  // Sample every Nth pixel to cover entire frame with 64x64 workgroup grid
  let stepX = max(1u, dims.x / 64u);
  let stepY = max(1u, dims.y / 64u);

  let sampleX = global_id.x * stepX;
  let sampleY = global_id.y * stepY;

  var diffVal = 0.0;
  if (sampleX < dims.x && sampleY < dims.y) {
    let colA = textureLoad(texA, vec2<i32>(i32(sampleX), i32(sampleY)), 0).rgb;
    let colB = textureLoad(texB, vec2<i32>(i32(sampleX), i32(sampleY)), 0).rgb;
    let delta = abs(colA - colB);
    // Weighted perceptual luminance difference
    diffVal = delta.r * 0.299 + delta.g * 0.587 + delta.b * 0.114;
  }

  sharedDiff[local_idx] = diffVal;
  workgroupBarrier();

  // Parallel reduction within the 64-thread workgroup
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (local_idx < s) {
      sharedDiff[local_idx] += sharedDiff[local_idx + s];
    }
    workgroupBarrier();
  }

  // Workgroup leader adds to global accumulator (as fixed point 1/100000)
  if (local_idx == 0u) {
    let fixedVal = u32(sharedDiff[0] * 100000.0);
    atomicAdd(&outputDiff[0], fixedVal);
    atomicAdd(&outputDiff[1], 64u);
  }
}
