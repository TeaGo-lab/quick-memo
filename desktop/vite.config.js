import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import {
  getConfig,
  saveConfig,
  listMemos,
  saveMemo,
  updateMemo,
  deleteMemo,
  renameAttachment,
  openInExplorer,
  precheckMemo
} from './server/vault-manager.js';
import { classifyWithLLM, heuristicClassify, testLlmConnection, smartRenameUploadedFile } from './server/llm-classifier.js';
import {
  rebuildDocIndex,
  getDocIndexStatus,
  indexSingleMemo,
  removeMemoFromDocIndex
} from './server/doc-indexer.js';
import { askVaultAssistant } from './server/chat-assistant.js';
import {
  exportVaultToZip,
  getVaultGitStatus,
  linkVaultToGitHub,
  syncVaultGit
} from './server/vault-sync.js';
import { getAppMetadata, checkReleaseUpdate, performReleaseUpdate } from './server/updater.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function quickMemoLocalServerPlugin() {
  return {
    name: 'quick-memo-local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');

        // 提供本地 Vault 附件图片/文件预览访问
        if (url.pathname === '/api/asset') {
          const filePath = url.searchParams.get('path');
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

        if (!url.pathname.startsWith('/api/')) {
          return next();
        }

        try {
          if (url.pathname === '/api/config' && req.method === 'GET') {
            return sendJson(res, 200, getConfig());
          }
          if (url.pathname === '/api/config' && req.method === 'POST') {
            const body = await readJsonBody(req);
            return sendJson(res, 200, saveConfig(body));
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

            return sendJson(res, 200, {
              memo: saved,
              classification
            });
          }
          if (url.pathname === '/api/memos/reclassify' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const memos = listMemos();
            const target = memos.find((m) => m.id === body.id);
            if (!target) {
              return sendJson(res, 404, { error: '找不到该记录' });
            }
            const classification = await classifyWithLLM({
              content: target.content,
              attachments: target.attachments || []
            });
            const updated = updateMemo(target.id, {
              category: classification.category,
              title: classification.title,
              summary: classification.summary,
              tags: classification.tags,
              webPages: classification.webPages || target.webPages || [],
              aiClassified: classification.aiClassified
            });
            return sendJson(res, 200, { memo: updated, classification });
          }
          if (url.pathname === '/api/memos/update' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const updated = updateMemo(body.id, body.patch || {});
            return sendJson(res, 200, { memo: updated });
          }
          if (url.pathname === '/api/memos/rename-attachment' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const updated = renameAttachment(body.id, Number(body.attIndex), body.newName);
            return sendJson(res, 200, { memo: updated });
          }
          if (url.pathname === '/api/memos/delete' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const delRes = deleteMemo(body.id);
            try {
              removeMemoFromDocIndex(body.id);
            } catch {}
            return sendJson(res, 200, delRes);
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
          if (url.pathname === '/api/open-explorer' && req.method === 'POST') {
            const body = await readJsonBody(req);
            openInExplorer(body.path);
            return sendJson(res, 200, { ok: true });
          }
          if (url.pathname === '/api/window-cmd' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const cmdFile = path.join(process.cwd(), '.window-cmd.json');
            fs.writeFileSync(cmdFile, JSON.stringify({ cmd: body.cmd, time: Date.now() }), 'utf-8');
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 404, { error: 'Not found' });
        } catch (err) {
          console.error('[API Error]', err);
          return sendJson(res, 500, { error: err.message || 'Internal Server Error' });
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [quickMemoLocalServerPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true
  }
});
