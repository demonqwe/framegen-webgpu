/**
 * Model Downloader Script for FrameGen WebGPU
 * Downloads and prepares optimized FP16 ONNX models for SPAN x2, Real-ESRGAN Compact x2, and Compact 4K.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_DIR = path.resolve(__dirname, '../models');

if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

const MODEL_SOURCES = [
  {
    name: 'span_720p_to_1440p_fp16.onnx',
    url: 'https://github.com/demonqwe/framegen-webgpu/releases/download/v1.0.0/span_720p_to_1440p_fp16.onnx'
  },
  {
    name: 'realesr_compact_animevideov3_x2_fp16.onnx',
    url: 'https://github.com/demonqwe/framegen-webgpu/releases/download/v1.0.0/realesr_compact_animevideov3_x2_fp16.onnx'
  },
  {
    name: 'compact_anime_4k_fp16.onnx',
    url: 'https://github.com/demonqwe/framegen-webgpu/releases/download/v1.0.0/compact_anime_4k_fp16.onnx'
  }
];

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    console.log(`[FrameGen Models] Downloading ${path.basename(dest)}...`);

    const request = https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        resolve(false); // Graceful skip if release asset is not uploaded yet
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          console.log(`[FrameGen Models] Saved ${path.basename(dest)}`);
          resolve(true);
        });
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      resolve(false);
    });
  });
}

async function main() {
  console.log('[FrameGen Models] Checking & downloading ONNX models into', MODELS_DIR);
  for (const item of MODEL_SOURCES) {
    const dest = path.join(MODELS_DIR, item.name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      await downloadFile(item.url, dest);
    } else {
      console.log(`[FrameGen Models] Already present: ${item.name}`);
    }
  }
  console.log('[FrameGen Models] Done.');
}

main().catch(console.error);
