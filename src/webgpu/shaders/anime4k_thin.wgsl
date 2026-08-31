// High-Performance Multi-Algorithm Video Scaler & Frame Interpolator WGSL Shader
// Scaler Modes:
// 0: Anime4K v4.0 (Authentic Bicubic + Morphological Line Refinement & Deblur)
// 1: AMD FSR (Edge-Adaptive Spatial Upsampling + RCAS)
// 2: Bicubic Catmull-Rom 16-Tap (Clean, Natural Spline Interpolation)
// 3: Off / Bypass (Direct True-Color Bilinear)

struct Uniforms {
    texWidth: f32,
    texHeight: f32,
    strength: f32,          // 0.0 (off) to 1.5 (high)
    thinningThreshold: f32, // Edge sensitivity
    mixFactor: f32,         // Frame blend factor [0.0..1.0]
    hasTex1: f32,           // 1.0 if interpolating frames, 0.0 if single
    scalerMode: f32,        // 0: Anime4K, 1: FSR, 2: Bicubic, 3: Off
    padding: f32,
};

@group(0) @binding(0) var<uniform> params: Uniforms;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var texture0: texture_2d<f32>;
@group(0) @binding(3) var texture1: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32((vertexIndex << 1u) & 2u);
    let y = f32(vertexIndex & 2u);
    out.uv = vec2f(x, y);
    out.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    return out;
}

fn get_luma(color: vec3f) -> f32 {
    return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn sample_raw(uv: vec2f) -> vec4f {
    let uv_clamped = clamp(uv, vec2f(0.0), vec2f(1.0));
    let c0 = textureSampleLevel(texture0, inputSampler, uv_clamped, 0.0);
    if (params.hasTex1 > 0.5) {
        let c1 = textureSampleLevel(texture1, inputSampler, uv_clamped, 0.0);
        return mix(c0, c1, params.mixFactor);
    }
    return c0;
}

// 16-Tap Catmull-Rom Bicubic Spline Weights
fn catmull_rom_weights(f: f32) -> vec4f {
    let f2 = f * f;
    let f3 = f2 * f;
    let w0 = -0.5 * f3 + f2 - 0.5 * f;
    let w1 =  1.5 * f3 - 2.5 * f2 + 1.0;
    let w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
    let w3 =  0.5 * f3 - 0.5 * f2;
    return vec4f(w0, w1, w2, w3);
}

// Catmull-Rom 16-Tap Spline Upscaler
fn sample_bicubic_catmull(uv: vec2f, dTex: vec2f) -> vec3f {
    let texCoord = uv * vec2f(params.texWidth, params.texHeight) - 0.5;
    let f = fract(texCoord);
    let center = (floor(texCoord) + 0.5) * dTex;

    let wx = catmull_rom_weights(f.x);
    let wy = catmull_rom_weights(f.y);

    var color = vec3f(0.0);
    for (var j = 0; j < 4; j = j + 1) {
        let yOffset = f32(j - 1) * dTex.y;
        let wY = wy[j];
        for (var i = 0; i < 4; i = i + 1) {
            let xOffset = f32(i - 1) * dTex.x;
            let w = wx[i] * wY;
            let s = sample_raw(center + vec2f(xOffset, yOffset)).rgb;
            color = color + s * w;
        }
    }
    return clamp(color, vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let uv = in.uv;
    let dx = 1.0 / max(params.texWidth, 1.0);
    let dy = 1.0 / max(params.texHeight, 1.0);
    let dTex = vec2f(dx, dy);

    let cMC = sample_raw(uv).rgb;

    // Mode 3 (Bypass / Off) or zero strength: clean untouched pass
    if (params.scalerMode >= 2.5 || params.strength <= 0.01) {
        return vec4f(cMC, 1.0);
    }

    // Mode 2: Clean 16-Tap Bicubic Catmull-Rom
    if (params.scalerMode >= 1.5 && params.scalerMode < 2.5) {
        let bicubicColor = sample_bicubic_catmull(uv, dTex);
        let finalColor = mix(cMC, bicubicColor, clamp(params.strength, 0.0, 1.0));
        return vec4f(finalColor, 1.0);
    }

    // 3x3 Neighborhood Sampling
    let cTL = sample_raw(uv + vec2f(-dx, -dy)).rgb;
    let cTC = sample_raw(uv + vec2f(0.0, -dy)).rgb;
    let cTR = sample_raw(uv + vec2f(dx, -dy)).rgb;
    let cML = sample_raw(uv + vec2f(-dx, 0.0)).rgb;
    let cMR = sample_raw(uv + vec2f(dx, 0.0)).rgb;
    let cBL = sample_raw(uv + vec2f(-dx, dy)).rgb;
    let cBC = sample_raw(uv + vec2f(0.0, dy)).rgb;
    let cBR = sample_raw(uv + vec2f(dx, dy)).rgb;

    let lTL = get_luma(cTL);
    let lTC = get_luma(cTC);
    let lTR = get_luma(cTR);
    let lML = get_luma(cML);
    let lMC = get_luma(cMC);
    let lMR = get_luma(cMR);
    let lBL = get_luma(cBL);
    let lBC = get_luma(cBC);
    let lBR = get_luma(cBR);

    let lMin = min(lMC, min(min(min(lTL, lTC), min(lTR, lML)), min(min(lMR, lBL), min(lBC, lBR))));
    let lMax = max(lMC, max(max(max(lTL, lTC), max(lTR, lML)), max(max(lMR, lBL), max(lBC, lBR))));
    let lRange = lMax - lMin;

    // Noise gate: skip completely flat surfaces to preserve natural look
    if (lRange < 0.03) {
        return vec4f(cMC, 1.0);
    }

    let minC = min(cMC, min(min(cTC, cML), min(cMR, cBC)));
    let maxC = max(cMC, max(max(cTC, cML), max(cMR, cBC)));

    // --- Mode 1: AMD FSR (EASU + RCAS) ---
    if (params.scalerMode >= 0.5 && params.scalerMode < 1.5) {
        var dirX = (lTR + 2.0 * lMR + lBR) - (lTL + 2.0 * lML + lBL);
        var dirY = (lBL + 2.0 * lBC + lBR) - (lTL + 2.0 * lTC + lTR);
        let lenSq = dirX * dirX + dirY * dirY;
        let invLen = 1.0 / (sqrt(lenSq) + 0.0001);
        let dir = vec2f(dirX, dirY) * invLen * dTex;

        let s0 = sample_raw(uv - dir * 0.75).rgb;
        let s1 = sample_raw(uv - dir * 0.25).rgb;
        let s2 = sample_raw(uv + dir * 0.25).rgb;
        let s3 = sample_raw(uv + dir * 0.75).rgb;
        let easu = s1 * 0.4 + s2 * 0.4 + s0 * 0.1 + s3 * 0.1;

        let peak = -1.0 / mix(7.0, 4.0, clamp(params.strength / 1.5, 0.0, 1.0));
        let rcas = (cTC + cML + cMR + cBC) * (peak * 0.25) + easu * (1.0 - peak);
        let fsrColor = clamp(rcas, minC, maxC);

        let finalFSR = mix(cMC, fsrColor, clamp(params.strength, 0.0, 1.0));
        return vec4f(finalFSR, 1.0);
    }

    // --- Mode 0: Authentic Anime4K v4.0 (Bicubic Base + Sub-Pixel Morphological Line Refinement) ---
    let bicubicBase = sample_bicubic_catmull(uv, dTex);

    // Sobel Gradient Calculation
    let gx = (lTR + 2.0 * lMR + lBR) - (lTL + 2.0 * lML + lBL);
    let gy = (lBL + 2.0 * lBC + lBR) - (lTL + 2.0 * lTC + lTR);
    let gradLen = sqrt(gx * gx + gy * gy);

    if (gradLen > 0.04) {
        let normG = vec2f(gx, gy) / (gradLen + 0.0001);
        // Sub-pixel shift strictly limited to [0.0 .. 0.35] texels (prevents teeth/comb artifacts on text)
        let pushOffset = normG * (clamp(params.strength * 0.3, 0.0, 0.35)) * dTex;

        let sampleP = sample_raw(uv + pushOffset).rgb;
        let sampleN = sample_raw(uv - pushOffset).rgb;
        let lP = get_luma(sampleP);
        let lN = get_luma(sampleN);

        var thinColor = bicubicBase;
        if (lP > lMC && lP >= lN) {
            let factor = clamp((lP - lMC) * params.strength * 0.8, 0.0, 0.6);
            thinColor = mix(bicubicBase, sampleP, factor);
        } else if (lN > lMC) {
            let factor = clamp((lN - lMC) * params.strength * 0.8, 0.0, 0.6);
            thinColor = mix(bicubicBase, sampleN, factor);
        }

        // CAS Crispness on Top of Bicubic Base
        let peak = -1.0 / mix(8.0, 5.0, clamp(params.strength / 1.5, 0.0, 1.0));
        let amp = clamp(lRange / (lMax + 0.001), 0.0, 1.0);
        let w = peak * amp * clamp(params.strength * 0.4, 0.0, 0.5);
        let sharpened = (cTC + cML + cMR + cBC) * w + thinColor * (1.0 - 4.0 * w);

        let finalClamped = clamp(sharpened, minC, maxC);
        let edgeWeight = smoothstep(0.04, 0.20, lRange);
        let finalAnime = mix(bicubicBase, finalClamped, edgeWeight * clamp(params.strength, 0.0, 1.0));
        return vec4f(finalAnime, 1.0);
    }

    return vec4f(bicubicBase, 1.0);
}
