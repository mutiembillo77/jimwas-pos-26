import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      clientPort: 5173,
    },
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.vercel.run',
      '.vercel.app',
      '.vusercontent.net',
    ],
    middlewareMode: false,
  },
  preview: {
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.vercel.run',
      '.vercel.app',
      '.vusercontent.net',
    ],
  },
  // Vite automatically exposes all VITE_* variables through import.meta.env.
  // No manual define block is needed — adding one can override and mask correct values.
});
