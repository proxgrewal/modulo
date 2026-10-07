import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.MODULO_API ?? 'http://localhost:4000';

export default defineConfig(({ command }) => ({
  // The built editor is served by the Modulo server at /_editor/.
  base: command === 'build' ? '/_editor/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target, changeOrigin: false, ws: true },
      '^/s(/|$)': { target, changeOrigin: false },
      '^/media/': { target, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1500 },
}));
