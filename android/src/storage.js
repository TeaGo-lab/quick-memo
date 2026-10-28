import { SEED_CONFIG, SEED_MEMOS } from './seed-data.js';

const CONFIG_STORAGE_KEY = 'quick_memo_android_config_v1';
const MEMOS_META_KEY = 'quick_memo_android_memos_v1';
const IDB_NAME = 'QuickMemoAndroidVaultDB';
const IDB_STORE = 'attachments_blob_store';

export const DEFAULT_CATEGORIES = [
  { id: '01-灵感与备忘', name: '灵感与备忘', icon: '💡', desc: '随手记下的想法、灵感、日常备忘、语录摘抄' },
  { id: '02-技术与代码', name: '技术与代码', icon: '💻', desc: '代码片段、命令行、报错信息、架构方案、AI Prompt' },
  { id: '03-精读与链接', name: '精读与链接', icon: '🔗', desc: '网址链接、GitHub 仓库、文章收藏、工具网站' },
  { id: '04-工作与待办', name: '工作与待办', icon: '📌', desc: '待办事项、项目推进、会议纪要、重要通知或参数' },
  { id: '05-截图与视觉', name: '截图与视觉', icon: '🖼️', desc: '屏幕截图、参考图、海报、图表、照片' },
  { id: '06-资料与文档', name: '资料与文档', icon: '📂', desc: 'PDF、Word、Excel、压缩包等本地文件归档' },
  { id: '99-收件箱', name: '收件箱', icon: '📥', desc: '暂未分类或其它杂项内容' }
];

export const LLM_PRESETS = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct'
  },
  dashscope: {
    label: '阿里云通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  openai: {
    label: 'OpenAI 官方/代理',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  }
};

export const DEFAULT_CONFIG = {
  llm: {
    enabled: true,
    providerPreset: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    customSystemPrompt: ''
  },
  vaultGit: {
    provider: 'gitee', // 当前设置界面选中的 Tab: 'gitee' | 'github'
    giteeToken: '',
    giteeOwner: '',
    giteeRepo: 'quick-memo-vault',
    githubToken: '',
    githubOwner: '',
    githubRepo: 'quick-memo-vault',
    repoOwner: '',
    repoName: 'quick-memo-vault',
    branch: 'main',
    accessToken: '',
    autoSync: true,
    lastSyncedAt: ''
  },
  categories: DEFAULT_CATEGORIES
};

function openAttachmentDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAttachmentData(attId, dataBase64) {
  try {
    const db = await openAttachmentDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(dataBase64, attId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[Storage] Failed to save attachment to IDB:', err);
    return false;
  }
}

export async function getAttachmentData(attId) {
  try {
    const db = await openAttachmentDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(attId);
      req.onsuccess = () => resolve(req.result || '');
      req.onerror = () => resolve('');
    });
  } catch {
    return '';
  }
}

export async function deleteAttachmentData(attId) {
  try {
    const db = await openAttachmentDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(attId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export function getConfig() {
  const seedGit = SEED_CONFIG?.vaultGit || {};
  const seedLlm = SEED_CONFIG?.llm || {};
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const mergedLlm = { ...DEFAULT_CONFIG.llm, ...seedLlm, ...(parsed.llm || {}) };
      if (!mergedLlm.apiKey && seedLlm.apiKey) mergedLlm.apiKey = seedLlm.apiKey;

      const pGit = parsed.vaultGit || {};
      const mergedGit = { ...DEFAULT_CONFIG.vaultGit, ...seedGit, ...pGit };
      // 向下兼容旧版单字段 accessToken
      if (pGit.accessToken) {
        if (pGit.provider === 'github' && !mergedGit.githubToken) {
          mergedGit.githubToken = pGit.accessToken;
          mergedGit.githubOwner = pGit.repoOwner || mergedGit.githubOwner || '';
          mergedGit.githubRepo = pGit.repoName || mergedGit.githubRepo || 'quick-memo-vault';
        } else if (!mergedGit.giteeToken) {
          mergedGit.giteeToken = pGit.accessToken;
          mergedGit.giteeOwner = pGit.repoOwner || mergedGit.giteeOwner || '';
          mergedGit.giteeRepo = pGit.repoName || mergedGit.giteeRepo || 'quick-memo-vault';
        }
      }
      if (!mergedGit.giteeToken && seedGit.giteeToken) {
        mergedGit.giteeToken = seedGit.giteeToken;
        mergedGit.giteeOwner = mergedGit.giteeOwner || seedGit.giteeOwner || '';
      }
      if (!mergedGit.githubToken && seedGit.githubToken) {
        mergedGit.githubToken = seedGit.githubToken;
        mergedGit.githubOwner = mergedGit.githubOwner || seedGit.githubOwner || '';
      }
      mergedGit.autoSync = true;

      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        llm: mergedLlm,
        vaultGit: mergedGit,
        categories: Array.isArray(parsed.categories) && parsed.categories.length > 0
          ? parsed.categories
          : DEFAULT_CATEGORIES
      };
    }
  } catch (err) {
    console.warn('[Storage] Config load error:', err);
  }
  const initial = structuredClone(DEFAULT_CONFIG);
  if (SEED_CONFIG?.llm) {
    initial.llm = { ...initial.llm, ...SEED_CONFIG.llm };
  }
  if (SEED_CONFIG?.vaultGit) {
    initial.vaultGit = { ...initial.vaultGit, ...SEED_CONFIG.vaultGit, autoSync: true };
  }
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(initial));
  return initial;
}

export function saveConfig(nextConfig) {
  const current = getConfig();
  const merged = {
    ...current,
    ...nextConfig,
    llm: { ...current.llm, ...(nextConfig.llm || {}) },
    vaultGit: { ...current.vaultGit, ...(nextConfig.vaultGit || {}) },
    categories: Array.isArray(nextConfig.categories) && nextConfig.categories.length > 0
      ? nextConfig.categories
      : current.categories
  };
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function listMemos() {
  try {
    const raw = localStorage.getItem(MEMOS_META_KEY);
    if (!raw) {
      if (Array.isArray(SEED_MEMOS) && SEED_MEMOS.length > 0) {
        localStorage.setItem(MEMOS_META_KEY, JSON.stringify(SEED_MEMOS));
        return structuredClone(SEED_MEMOS);
      }
      return [];
    }
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const filtered = list.filter((m) => m && m.id && m.id !== 'memo_1793188166396_njbr');
    if (filtered.length !== list.length) {
      localStorage.setItem(MEMOS_META_KEY, JSON.stringify(filtered));
    }
    return filtered;
  } catch {
    return [];
  }
}

export function saveMemosList(memos) {
  localStorage.setItem(MEMOS_META_KEY, JSON.stringify(memos));
  return memos;
}

export function clearLocalMemosCache() {
  localStorage.removeItem(MEMOS_META_KEY);
  return [];
}

export function sanitizeFileName(name) {
  return String(name || '未命名')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名';
}

export function formatDateParts(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return {
    dateStr: `${yyyy}-${MM}-${dd}`,
    timeStr: `${HH}:${mm}:${ss}`,
    fullStr: `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`,
    compactTime: `${HH}${mm}${ss}`,
    compactFull: `${yyyy}${MM}${dd}_${HH}${mm}${ss}`
  };
}

export function formatBytes(bytes = 0) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function detectMemoType(content = '', attachments = []) {
  if (attachments.some((a) => (a.mimeType || '').startsWith('image/'))) {
    return 'image';
  }
  if (attachments.length > 0) {
    return 'file';
  }
  const trimmed = String(content || '').trim();
  if (/^https?:\/\/\S+$/i.test(trimmed) || (trimmed.includes('http') && trimmed.split('\n').length <= 3)) {
    return 'link';
  }
  if (trimmed.includes('```') || (/[{}();=>]/.test(trimmed) && trimmed.split('\n').length >= 3)) {
    return 'code';
  }
  return 'text';
}

/**
 * 生成与桌面版 100% 兼容的标准 Markdown 内容（含 YAML Frontmatter）
 */
export function buildMarkdownContent(memo) {
  const tagsYaml = (memo.tags || []).map((t) => `  - "${String(t).replace(/"/g, '\\"')}"`).join('\n');
  const attachmentsYaml = (memo.attachments || []).map((a) =>
    `  - name: "${String(a.name).replace(/"/g, '\\"')}"\n    relPath: "${a.relPath || `./assets/${a.name}`}"\n    mimeType: "${a.mimeType || ''}"\n    size: ${a.size || 0}`
  ).join('\n');

  const frontmatter = [
    '---',
    `id: "${memo.id}"`,
    `title: "${String(memo.title || '').replace(/"/g, '\\"')}"`,
    `category: "${String(memo.category || '99-收件箱').replace(/"/g, '\\"')}"`,
    `type: "${memo.type || 'text'}"`,
    `created_at: "${memo.createdAt}"`,
    `ai_classified: ${Boolean(memo.aiClassified)}`,
    `summary: "${String(memo.summary || '').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`,
    memo.tags && memo.tags.length > 0 ? `tags:\n${tagsYaml}` : 'tags: []',
    memo.attachments && memo.attachments.length > 0 ? `attachments:\n${attachmentsYaml}` : 'attachments: []',
    '---'
  ].join('\n');

  const tagBadges = (memo.tags || []).map((t) => `#${t}`).join(' ');
  const metaQuote = [
    `> **分类**：\`${memo.category}\` · **时间**：${memo.createdAt}${tagBadges ? ` · **标签**：${tagBadges}` : ''}`,
    memo.summary ? `> **摘要**：${memo.summary}` : null
  ].filter(Boolean).join('\n');

  const attachmentSection = [];
  if (memo.attachments && memo.attachments.length > 0) {
    for (const att of memo.attachments) {
      const rel = att.relPath || `./assets/${att.name}`;
      if (att.mimeType && att.mimeType.startsWith('image/')) {
        attachmentSection.push(`![${att.name}](${rel})`);
      } else {
        attachmentSection.push(`- 📎 [${att.name} (${formatBytes(att.size)})](${rel})`);
      }
    }
  }

  const bodyParts = [
    frontmatter,
    '',
    `# ${memo.title}`,
    '',
    metaQuote,
    '',
    '---',
    ''
  ];

  if (memo.content && memo.content.trim()) {
    bodyParts.push(memo.content.trim(), '');
  }

  if (attachmentSection.length > 0) {
    bodyParts.push('## 附件与媒体', '', ...attachmentSection, '');
  }

  return bodyParts.join('\n');
}

/**
 * 保存新闪念记录到手机本地库
 */
export async function saveMemo(payload) {
  const now = new Date();
  const { dateStr, fullStr, compactTime, compactFull } = formatDateParts(now);
  const id = payload.id || `memo_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
  const category = sanitizeFileName(payload.category || '99-收件箱');
  const title = (payload.title || '随手记录').trim();
  const safeTitle = sanitizeFileName(title);

  const savedAttachments = [];
  if (Array.isArray(payload.rawAttachments) && payload.rawAttachments.length > 0) {
    for (let i = 0; i < payload.rawAttachments.length; i++) {
      const item = payload.rawAttachments[i];
      const attId = item.id || `att_${now.getTime()}_${i}`;
      const cleanName = sanitizeFileName(item.name || `附件_${i + 1}`);
      const fileName = `${compactFull}_${cleanName}`;
      if (item.dataBase64) {
        await saveAttachmentData(attId, item.dataBase64);
      }
      savedAttachments.push({
        id: attId,
        name: cleanName,
        relPath: `./assets/${fileName}`,
        mimeType: item.mimeType || 'application/octet-stream',
        size: item.size || 0
      });
    }
  }

  const mdFileName = `${dateStr}_${compactTime}_${safeTitle}.md`;
  const memoRecord = {
    id,
    title,
    category,
    type: payload.type || detectMemoType(payload.content, savedAttachments),
    content: payload.content || '',
    summary: payload.summary || '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    createdAt: payload.createdAt || fullStr,
    aiClassified: Boolean(payload.aiClassified),
    attachments: savedAttachments,
    webPages: [],
    mdRelPath: `${category}/${mdFileName}`,
    unsyncedLocal: true
  };

  const memos = listMemos().filter((m) => m.id !== id);
  memos.unshift(memoRecord);
  saveMemosList(memos);
  return memoRecord;
}

export function updateMemo(id, patch) {
  const memos = listMemos();
  const idx = memos.findIndex((m) => m.id === id);
  if (idx === -1) throw new Error('找不到该记录');

  const oldMemo = memos[idx];
  const newCategory = sanitizeFileName(patch.category || oldMemo.category);
  const newTitle = (patch.title !== undefined ? patch.title : oldMemo.title).trim() || oldMemo.title;
  const safeTitle = sanitizeFileName(newTitle);
  const prefixMatch = (oldMemo.mdRelPath || '').split('/').pop()?.match(/^(\d{4}-\d{2}-\d{2}_\d{6})_/);
  const prefix = prefixMatch ? prefixMatch[1] : formatDateParts().compactFull;

  const updated = {
    ...oldMemo,
    ...patch,
    title: newTitle,
    category: newCategory,
    mdRelPath: `${newCategory}/${prefix}_${safeTitle}.md`,
    unsyncedLocal: true
  };

  memos[idx] = updated;
  saveMemosList(memos);
  return updated;
}

export async function deleteMemo(id) {
  const memos = listMemos();
  const target = memos.find((m) => m.id === id);
  if (target && Array.isArray(target.attachments)) {
    for (const att of target.attachments) {
      if (att.id) {
        await deleteAttachmentData(att.id);
      }
    }
  }
  const next = memos.filter((m) => m.id !== id);
  saveMemosList(next);
  return { deleted: true, id };
}

/**
 * 识别文本中是否包含 API Key / Token / 密钥
 */
export function detectSecretKeyClient(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return { isKey: false, needsNote: false };

  const patterns = [
    { type: 'sk- 开头 API Key', regex: /\bsk-[a-zA-Z0-9_-]{14,}\b/ },
    { type: 'GitHub Token', regex: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{16,}\b/ },
    { type: '云厂商 AccessKey', regex: /\b(LTAI|AKIA|ASIA)[a-zA-Z0-9]{12,}\b/ },
    { type: 'AppSecret / 密钥', regex: /\b(cli_[a-zA-Z0-9]{12,}|[a-f0-9]{32,64})\b/i },
    { type: 'UUID 密钥', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i }
  ];

  let matchedType = '';
  let matchedValue = '';
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m) {
      matchedType = p.type;
      matchedValue = m[0];
      break;
    }
  }

  if (!matchedType) return { isKey: false, needsNote: false };

  const remainder = text
    .replace(matchedValue, '')
    .replace(/\b(API_KEY|SECRET_KEY|ACCESS_TOKEN|Bearer|key|token)\b/gi, '')
    .replace(/[=:;"'`\s\-_]/g, '')
    .trim();

  const cjkCount = (remainder.match(/[\u4e00-\u9fa5]/g) || []).length;
  const hasMeaningfulNote = cjkCount >= 2 || remainder.length >= 6;

  return {
    isKey: true,
    needsNote: !hasMeaningfulNote,
    keyType: matchedType,
    maskedKey: matchedValue.length > 10 ? `${matchedValue.slice(0, 6)}...${matchedValue.slice(-4)}` : matchedValue
  };
}

/**
 * 归档前查重预检
 */
export function precheckMemo({ content = '', rawAttachments = [] }) {
  const existingMemos = listMemos();
  const norm = String(content || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const duplicates = [];

  for (const m of existingMemos) {
    const mNorm = String(m.content || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (norm && mNorm && norm === mNorm) {
      duplicates.push({
        id: m.id,
        title: m.title,
        category: m.category,
        createdAt: m.createdAt,
        matchReason: '正文完全相同'
      });
      continue;
    }
    if (rawAttachments.length > 0 && Array.isArray(m.attachments)) {
      const sameFile = rawAttachments.find((ra) =>
        m.attachments.some((ma) => ma.name === ra.name && ma.size === ra.size)
      );
      if (sameFile) {
        duplicates.push({
          id: m.id,
          title: m.title,
          category: m.category,
          createdAt: m.createdAt,
          matchReason: `同名同大小附件 (${sameFile.name})`
        });
      }
    }
  }

  const keyReminder = detectSecretKeyClient(content);
  return {
    hasDuplicate: duplicates.length > 0,
    duplicates: duplicates.slice(0, 3),
    keyReminder
  };
}

/**
 * 触发手机浏览器/WebView 下载单篇 .md 文件
 */
export function downloadMarkdownFile(memo) {
  const mdText = buildMarkdownContent(memo);
  const fileName = `${sanitizeFileName(memo.title)}.md`;
  if (window.AndroidNative && typeof window.AndroidNative.saveFileToDownloads === 'function') {
    window.AndroidNative.saveFileToDownloads(fileName, mdText);
    return;
  }
  const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
