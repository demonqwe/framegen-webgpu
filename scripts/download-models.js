import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelsDir = path.resolve(__dirname, '../models');

if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
}

console.log('[Anime FrameGen] Models manager:');
console.log('Target models folder:', modelsDir);

// Model URLs or download helpers
const MODEL_INFO = [
  {
    name: 'rife_720p_fp16.onnx',
    url: 'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife_v4.6.onnx',
    desc: 'RIFE 720p FP16 WebGPU Model'
  },
  {
    name: 'rife_1080p_fp16.onnx',
    url: 'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife_v4.6.onnx',
    desc: 'RIFE 1080p FP16 WebGPU Model'
  }
];

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`Failed with status ${response.statusCode}`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

console.log('To download or place ONNX models, put `rife_720p_fp16.onnx` and `rife_1080p_fp16.onnx` into the `models/` directory.');
