import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: resolve(__dirname, 'index.html'), pushTest: resolve(__dirname, 'push-test.html') } } },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/healthz': 'http://127.0.0.1:3000', '/api/push': 'http://127.0.0.1:3000' } },
});
