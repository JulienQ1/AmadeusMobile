import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

const frameworkSrc = path.resolve(__dirname, 'vendor/CubismWebFramework/src');
if (!fs.existsSync(frameworkSrc)) {
  throw new Error('Live2D Cubism Framework missing: run `npm run fetch:live2d` first.');
}

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  publicDir: 'public',
  resolve: {
    alias: { '@framework': frameworkSrc },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173 },
});
