import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getConfig,
  saveConfig,
  getAutoStartStatus,
  setAutoStart,
  listMemos,
  saveMemo,
  updateMemo,
  deleteMemo,
  renameAttachment,
  openInExplorer,
  precheckMemo,
  resolveAssetPathForCurrentVault
} from './vault-manager.js';
import { classifyWithLLM, heuristicClassify, testLlmConnection, smartRenameUploadedFile } from './llm-classifier.js';
import {
  ensureDocIndexSynced,
  rebuildDocIndex,
  getDocIndexStatus,
  indexSingleMemo,
  removeMemoFromDocIndex
} from './doc-indexer.js';
import { askVaultAssistant } from './chat-assistant.js';
import {
  exportVaultToZip,
  getVaultGitStatus,
  linkVaultToGitHub,
  syncVaultGit,
  triggerAutoVaultGitSync
} from './vault-sync.js';
import { getAppMetadata, checkReleaseUpdate, performReleaseUpdate } from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// 确保图标存在（供 Tauri 打包使用）
export function ensureTauriIcons() {
  const iconDir = path.join(ROOT, 'src-tauri', 'icons');
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
  }
  const pngPath = path.join(iconDir, 'icon.png');
  const icoPath = path.join(iconDir, 'icon.ico');
  if (fs.existsSync(pngPath) && fs.existsSync(icoPath)) return;

  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const w = 64, h = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * (1 + w * 4) + 1 + x * 4;
      raw[idx] = 37;
      raw[idx + 1] = 99;
      raw[idx + 2] = 235;
      raw[idx + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(pngPath, png);

  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  icoHeader[6] = w;
  icoHeader[7] = h;
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(png.length, 14);
  icoHeader.writeUInt32LE(22, 18);
  fs.writeFileSync(icoPath, Buffer.concat([icoHeader, png]));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function startStandaloneServer(port = 1420, openWindow = false) {
  ensureTauriIcons();
  getConfig(); // 初始化默认配置和 vault 分类目录
  setTimeout(() => {
    try {
      const st = getDocIndexStatus();
      console.log(`[QuickMemo] 全文文档索引已就绪: ${st.totalDocs} 篇记录, ${st.totalChunks} 个检索片段`);
    } catch (e) {
      console.warn('[QuickMemo] 初始化文档索引失败:', e.message);
    }
    try {
      triggerAutoVaultGitSync();
    } catch {}
  }, 100);

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.end();
      return;
    }
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/api/asset') {
      const rawFilePath = url.searchParams.get('path');
      const filePath = resolveAssetPathForCurrentVault(rawFilePath, getConfig().vaultPath);
      if (!filePath || !fs.existsSync(filePath)) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf'
      };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      if (ext === '.pdf') {
        res.setHeader('Content-Disposition', 'inline');
      }
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname === '/api/config' && req.method === 'GET') {
          return sendJson(res, 200, getConfig());
        }
        if (url.pathname === '/api/config' && req.method === 'POST') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, saveConfig(body));
        }
        if (url.pathname === '/api/autostart' && req.method === 'GET') {
          const cfg = getConfig();
          const st = getAutoStartStatus();
          return sendJson(res, 200, {
            ...st,
            autoStartSilent: cfg.autoStartSilent !== false,
            command: st.command || cfg.autoStartCommand
          });
        }
        if (url.pathname === '/api/autostart' && req.method === 'POST') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, setAutoStart(body));
        }
        if (url.pathname === '/api/memos' && req.method === 'GET') {
          return sendJson(res, 200, listMemos());
        }
        if (url.pathname === '/api/llm/test' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await testLlmConnection(body.llm);
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/files/smart-rename' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await smartRenameUploadedFile(body.attachment || {}, body.noteText || '');
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/memos/precheck' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = precheckMemo({
            content: body.content || '',
            rawAttachments: body.rawAttachments || []
          });
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/memos/quick-save' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const rawAttachments = body.rawAttachments || [];

          const llmResult = await classifyWithLLM({
            content: body.content,
            attachments: rawAttachments
          });
          const classification = body.manualCategory
            ? { ...llmResult, category: body.manualCategory }
            : llmResult;

          // 自动用 AI 或文档内容提取器生成的清晰文件名重命名上传的附件
          const renamedRawAttachments = rawAttachments.map((att, idx) => ({
            ...att,
            name: (classification.renamedFiles && classification.renamedFiles[idx]) || att.name
          }));

          const autoContent = (body.content || '').trim();

          const saved = saveMemo({
            content: autoContent,
            rawAttachments: renamedRawAttachments,
            category: body.manualCategory || classification.category,
            title: body.manualTitle || classification.title,
            summary: classification.summary,
            tags: classification.tags,
            webPages: classification.webPages || [],
            aiClassified: classification.aiClassified
          });
          try {
            indexSingleMemo(saved);
            triggerAutoVaultGitSync();
          } catch {}

          return sendJson(res, 200, { memo: saved, classification });
        }
        if (url.pathname === '/api/memos/reclassify' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const memos = listMemos();
          const target = memos.find((m) => m.id === body.id);
          if (!target) return sendJson(res, 404, { error: '找不到该记录' });
          const classification = await classifyWithLLM({
            content: target.content,
            attachments: target.attachments || []
          });

          // 如果包含附件且自动生成了更有意义的文件名，同步重命名磁盘上的附件
          if (Array.isArray(target.attachments) && Array.isArray(classification.renamedFiles)) {
            for (let i = 0; i < target.attachments.length; i++) {
              const newFileName = classification.renamedFiles[i];
              if (newFileName && newFileName !== target.attachments[i].name) {
                try {
                  renameAttachment(target.id, i, newFileName);
                } catch {}
              }
            }
          }

          const nextContent = (target.content || '').replace(/^### 📄 文档内容提取预览[\s\S]*$/, '').trim();

          const updated = updateMemo(target.id, {
            category: classification.category,
            title: classification.title,
            content: nextContent,
            summary: classification.summary,
            tags: classification.tags,
            webPages: classification.webPages || target.webPages || [],
            aiClassified: classification.aiClassified
          });
          try {
            indexSingleMemo(updated);
            triggerAutoVaultGitSync();
          } catch {}
          return sendJson(res, 200, { memo: updated, classification });
        }
        if (url.pathname === '/api/memos/update' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const updated = updateMemo(body.id, body.patch || {});
          try {
            indexSingleMemo(updated);
            triggerAutoVaultGitSync();
          } catch {}
          return sendJson(res, 200, { memo: updated });
        }
        if (url.pathname === '/api/memos/rename-attachment' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const updated = renameAttachment(body.id, Number(body.attIndex), body.newName);
          try {
            indexSingleMemo(updated);
            triggerAutoVaultGitSync();
          } catch {}
          return sendJson(res, 200, { memo: updated });
        }
        if (url.pathname === '/api/memos/delete' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const delRes = deleteMemo(body.id);
          try {
            removeMemoFromDocIndex(body.id);
            triggerAutoVaultGitSync();
          } catch {}
          return sendJson(res, 200, delRes);
        }
        if (url.pathname === '/api/vault/export-zip' && req.method === 'POST') {
          return sendJson(res, 200, exportVaultToZip());
        }
        if (url.pathname === '/api/vault/git-status' && req.method === 'GET') {
          return sendJson(res, 200, getVaultGitStatus());
        }
        if (url.pathname === '/api/vault/git-link' && req.method === 'POST') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await linkVaultToGitHub(body));
        }
        if (url.pathname === '/api/vault/git-sync' && req.method === 'POST') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, syncVaultGit(body));
        }
        if (url.pathname === '/api/app/info' && req.method === 'GET') {
          return sendJson(res, 200, getAppMetadata());
        }
        if (url.pathname === '/api/app/check-update' && req.method === 'GET') {
          const info = await checkReleaseUpdate();
          return sendJson(res, 200, info);
        }
        if (url.pathname === '/api/app/perform-update' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await performReleaseUpdate({ autoRestart: body.autoRestart !== false });
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/index/status' && req.method === 'GET') {
          return sendJson(res, 200, getDocIndexStatus());
        }
        if (url.pathname === '/api/index/rebuild' && req.method === 'POST') {
          return sendJson(res, 200, rebuildDocIndex());
        }
        if (url.pathname === '/api/chat/ask' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const answer = await askVaultAssistant({
            message: body.message || '',
            history: body.history || []
          });
          return sendJson(res, 200, answer);
        }
        if (url.pathname === '/api/open-explorer' && req.method === 'POST') {
          const body = await readJsonBody(req);
          openInExplorer(body.path);
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/window-cmd' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const cmdFile = path.join(ROOT, '.window-cmd.json');
          fs.writeFileSync(cmdFile, JSON.stringify({ cmd: body.cmd, time: Date.now() }), 'utf-8');
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { error: 'Not found' });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // 静态文件服务（零依赖直接运行前端）
    let relPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const distFile = path.join(ROOT, 'dist', relPath);
    const rootFile = path.join(ROOT, relPath);
    let targetFile = fs.existsSync(distFile) ? distFile : rootFile;

    // 兜底：若请求 /assets/<name>-<hash>.<ext> 因热更新后 hash 变更而未命中，自动回退匹配 images/<name>.<ext> 或 dist/assets/<name>-*.<ext>
    if (!fs.existsSync(targetFile) && relPath.startsWith('/assets/')) {
      const baseName = path.basename(relPath);
      const ext = path.extname(baseName);
      const stem = baseName.slice(0, baseName.length - ext.length);
      const cleanStem = stem.replace(/-[a-zA-Z0-9_-]{6,12}$/, '');
      const imgFallback = path.join(ROOT, 'images', `${cleanStem}${ext}`);
      if (fs.existsSync(imgFallback)) {
        targetFile = imgFallback;
      } else {
        const assetsDir = path.join(ROOT, 'dist', 'assets');
        if (fs.existsSync(assetsDir)) {
          const found = fs.readdirSync(assetsDir).find((f) => f.startsWith(`${cleanStem}-`) && f.endsWith(ext));
          if (found) targetFile = path.join(assetsDir, found);
        }
      }
    }

    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
      const ext = path.extname(targetFile).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      fs.createReadStream(targetFile).pipe(res);
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const appUrl = `http://127.0.0.1:${port}`;
    console.log(`[QuickMemo] 本地服务已启动: ${appUrl}`);
    if (openWindow) {
      // 使用 Edge --app 模式打开独立桌面窗口（与 Tauri WebView2 相同的底层渲染引擎）
      exec(`start msedge --app="${appUrl}" --window-size=1080,740`, (err) => {
        if (err) {
          exec(`start "" "${appUrl}"`);
        }
      });
    }
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const shouldOpen = process.argv.includes('--open');
  startStandaloneServer(1420, shouldOpen);
}
