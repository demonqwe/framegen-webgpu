# RIFE ONNX Models for Anime Frame Generation (WebGPU)

This directory stores the quantized ONNX models used by the Chrome Extension.

### Required Files:
1. `rife_720p_fp16.onnx` — Optimized for 720p / lightweight interpolation.
2. `rife_1080p_fp16.onnx` — Optimized for 1080p high quality interpolation.

### Model Specification:
- **Inputs**: 
  - `img0`: `[1, 3, H, W]` (Float16 or Float32)
  - `img1`: `[1, 3, H, W]` (Float16 or Float32)
  - `timestep` (optional): `[1]` (Float scalar, e.g. 0.5)
- **Output**:
  - `output` / `T0.5`: `[1, 3, H, W]` (Float16 or Float32)

### Fallback Mode:
If the ONNX model files are not yet placed in this folder, the extension automatically activates high-speed WebGPU Anime4K shader mode, ensuring video playback is uninterrupted.
