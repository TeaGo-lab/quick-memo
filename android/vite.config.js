import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..', 'desktop');
const DESKTOP_CONFIG_PATH = path.join(DESKTOP_ROOT, '.quick-memo-config.json');
const DESKTOP_VAULT_INDEX = path.join(DESKTOP_ROOT, 'vault', '.quick-memo-index.json');

function androidDesktopBridgePlugin() {
  return {
    name: 'quick-memo-android-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        if (req.url?.startsWith('/api/bootstrap') && req.method === 'GET') {
          let config = null;
          let memos = [];
          try {
            if (fs.existsSync(DESKTOP_CONFIG_PATH)) {
              config = JSON.parse(fs.readFileSync(DESKTOP_CONFIG_PATH, 'utf-8'));
            }
          } catch {}
          try {
            if (fs.existsSync(DESKTOP_VAULT_INDEX)) {
              memos = JSON.parse(fs.readFileSync(DESKTOP_VAULT_INDEX, 'utf-8'));
            }
          } catch {}

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ config, memos }));
          return;
        }
        next();
      });
    }
  };
}

export default {
  base: './',
  plugins: [androidDesktopBridgePlugin()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1421,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 512000
  }
};
