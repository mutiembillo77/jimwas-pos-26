import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/functions\//, /^\/rest\//, /^\/auth\//],
      },
      includeAssets: ['icon.svg', 'placeholder.svg', 'placeholder-logo.svg'],
      manifest: {
        name: 'Jimwas POS',
        short_name: 'Jimwas POS',
        description: 'Jimwas Enterprises Point of Sale System',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: '192x192 512x512',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
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
});

