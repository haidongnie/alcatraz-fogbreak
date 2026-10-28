import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages serves /<repo>/).
  base: './',
  build: {
    target: 'esnext',            // top-level await in main.ts; every WebGPU-capable browser supports it
    sourcemap: false,
    chunkSizeWarningLimit: 4000, // three + the inlined Rapier WASM + playroomkit are large by nature
  },
  assetsInclude: ['**/*.hdr', '**/*.glb', '**/*.ktx2'],
  server: { host: '127.0.0.1' },
});
