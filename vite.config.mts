import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installDashboardDev } = require(process.cwd() + '/dashboardDevServer.js');
import react from '@vitejs/plugin-react';
import http from 'node:http';
import https from 'node:https';
function setupMiddlewares(server: { middlewares: any }, isVenusReachable: boolean) {
  installDashboardDev(server);
  if (!isVenusReachable) {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (
        req.url?.startsWith('/rotevista-config') ||
        req.url?.startsWith('/rotevista-history') ||
        req.url?.startsWith('/rotevista-ais')
      ) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Signal K offline' }));
        return;
      }
      next();
    });
  }

  server.middlewares.use('/rotevista-tile', (req: any, res: any) => {
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
    https.get(target, { timeout: 4500 }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    }).on('error', () => {
      res.statusCode = 204;
      res.end();
    });
  });
}

export default defineConfig(async () => {
  const isVenusReachable = await new Promise<boolean>((resolve) => {
    const req = http.get('http://venus.local:3000/signalk', { timeout: 350 }, (res) => {
      resolve(true);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

  return {
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
          setupMiddlewares(server, isVenusReachable);
        },
        configurePreviewServer(server) {
          setupMiddlewares(server, isVenusReachable);
        }
      }
    ],
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      proxy: isVenusReachable
        ? {
            '/signalk': {
              target: 'http://venus.local:3000',
              ws: true,
              changeOrigin: true,
              configure: (proxy) => {
                proxy.on('error', () => {});
                proxy.on('proxyReqWs', (proxyReq, _req, socket) => {
                  proxyReq.on('error', () => {});
                  socket.on('error', () => {});
                });
                proxy.on('open', (proxySocket) => {
                  proxySocket.on('error', () => {});
                });
              }
            },
            '/rotevista-config': {
              target: 'http://venus.local:3000',
              changeOrigin: true
            },
            '/rotevista-history': {
              target: 'http://venus.local:3000',
              changeOrigin: true
            },
            '/rotevista-ais': {
              target: 'http://venus.local:3000',
              changeOrigin: true
            }
          }
        : undefined
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true
    }
  };
});
