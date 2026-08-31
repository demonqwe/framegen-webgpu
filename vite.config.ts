import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

function copyExtensionAssetsPlugin(): Plugin {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist');
      if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
      }

      // Copy content-loader.js
      if (fs.existsSync(resolve(__dirname, 'src/content/content-loader.js'))) {
        fs.copyFileSync(
          resolve(__dirname, 'src/content/content-loader.js'),
          resolve(distDir, 'content-loader.js')
        );
      }

      if (fs.existsSync(resolve(__dirname, 'src/manifest.json'))) {
        fs.copyFileSync(
          resolve(__dirname, 'src/manifest.json'),
          resolve(distDir, 'manifest.json')
        );
      } else if (fs.existsSync(resolve(__dirname, 'manifest.json'))) {
        fs.copyFileSync(
          resolve(__dirname, 'manifest.json'),
          resolve(distDir, 'manifest.json')
        );
      }

      if (fs.existsSync(resolve(__dirname, 'src/rules.json'))) {
        fs.copyFileSync(
          resolve(__dirname, 'src/rules.json'),
          resolve(distDir, 'rules.json')
        );
      }

      // Copy models folder if exists
      const modelsDir = resolve(__dirname, 'models');
      const distModelsDir = resolve(distDir, 'models');
      if (fs.existsSync(modelsDir)) {
        fs.cpSync(modelsDir, distModelsDir, { recursive: true });
      } else {
        fs.mkdirSync(distModelsDir, { recursive: true });
      }

      // Copy onnxruntime-web wasm files from node_modules if present
      const ortDistDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      if (fs.existsSync(ortDistDir)) {
        const files = fs.readdirSync(ortDistDir);
        for (const file of files) {
          if (file.endsWith('.wasm') || file.endsWith('.mjs')) {
            fs.copyFileSync(
              resolve(ortDistDir, file),
              resolve(distDir, file)
            );
          }
        }
      }
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [copyExtensionAssetsPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        content: resolve(__dirname, 'src/content/content.ts'),
        background: resolve(__dirname, 'src/background/service-worker.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'content') return 'content.js';
          if (chunkInfo.name === 'background') return 'service-worker.js';
          if (chunkInfo.name === 'popup') return 'popup.js';
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'assets/[name].[ext]';
          }
          return 'assets/[name]-[hash].[ext]';
        }
      }
    }
  }
});
