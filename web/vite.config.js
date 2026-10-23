import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = 'http://127.0.0.1:4747';

// The server only accepts its own Host and Origin: send Host as the target and drop the browser's Origin (SSE included).
export const proxyTo = {
  target,
  changeOrigin: true,
  configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: Object.fromEntries(['/api', '/mcp', '/hook'].map((p) => [p, proxyTo])) },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.js'], include: ['test/**/*.test.{js,jsx}'] },
});
