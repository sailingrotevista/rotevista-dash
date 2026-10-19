import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  publicDir: 'static',
  build: {
    outDir: 'public',
    emptyOutDir: true
  },
  plugins: [
    react(),
    {
      name: 'tile-proxy-dev',
      configureServer(server) {
        server.middlewares.use('/rotevista-tile', (req, res) => {
          const url = new URL(req.url || '', 'http://localhost');
          const provider = url.searchParams.get('provider');
          const z = url.searchParams.get('z');
          const x = url.searchParams.get('x');
          const y = url.searchParams.get('y');
          let target = '';
          if (provider === 'esri-dark') {
            target = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
          } else if (provider === 'esri-light') {
            target = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
          } else if (provider === 'openseamap') {
            target = `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`;
          }
          if (!target) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const https = require('https');
          https.get(target, { timeout: 4500 }, (proxyRes: any) => {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
          }).on('error', () => {
            res.statusCode = 204;
            res.end();
          });
        });
      }
    }
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true
  }
});
