import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, 'dist');
const assetsDir = path.join(distDir, 'assets');
const indexHtmlPath = path.join(distDir, 'index.html');

let html = fs.readFileSync(indexHtmlPath, 'utf-8');
const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];

const cssFiles = files.filter((f) => f.endsWith('.css'));
const jsFiles = files.filter((f) => f.endsWith('.js'));

let inlinedCss = '';
for (const f of cssFiles) {
  inlinedCss += fs.readFileSync(path.join(assetsDir, f), 'utf-8') + '\n';
}

let inlinedJs = '';
for (const f of jsFiles) {
  inlinedJs += fs.readFileSync(path.join(assetsDir, f), 'utf-8') + '\n';
}

// 移除原有的 stylesheet link 和 module script 标签
html = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/gi, '');
html = html.replace(/<link[^>]+rel="manifest"[^>]*>/gi, '');
html = html.replace(/<script[^>]+type="module"[^>]*><\/script>/gi, '');

// 注入内联的 CSS 和 JS（避免 WebView file:// 协议下的 ES Module CORS 限制）
html = html.replace('</head>', () => `<style>\n${inlinedCss}\n</style>\n</head>`);
html = html.replace('</body>', () => `<script>\n${inlinedJs}\n</script>\n</body>`);

fs.writeFileSync(indexHtmlPath, html, 'utf-8');
console.log('[Bundle] Successfully inlined CSS & JS into dist/index.html');
