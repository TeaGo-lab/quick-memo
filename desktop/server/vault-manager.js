import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, '.quick-memo-config.json');
const DEFAULT_VAULT_PATH = path.join(PROJECT_ROOT, 'vault');
const REG_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE_NAME = 'QuickMemo';

export const DEFAULT_CATEGORIES = [
  { id: '01-灵感与备忘', name: '灵感与备忘', icon: '💡', desc: '随手记下的想法、灵感、日常备忘、语录摘抄' },
  { id: '02-技术与代码', name: '技术与代码', icon: '💻', desc: '代码片段、命令行、报错信息、架构方案、AI Prompt' },
  { id: '03-精读与链接', name: '精读与链接', icon: '🔗', desc: '网址链接、GitHub 仓库、文章收藏、工具网站' },
  { id: '04-工作与待办', name: '工作与待办', icon: '📌', desc: '待办事项、项目推进、会议纪要、重要通知或参数' },
  { id: '05-截图与视觉', name: '截图与视觉', icon: '🖼️', desc: '屏幕截图、参考图、海报、图表、照片' },
  { id: '06-资料与文档', name: '资料与文档', icon: '📂', desc: 'PDF、Word、Excel、压缩包等本地文件归档' },
  { id: '99-收件箱', name: '收件箱', icon: '📥', desc: '暂未分类或其它杂项内容' }
];

export const DEFAULT_CONFIG = {
  vaultPath: DEFAULT_VAULT_PATH,
  shortcut: 'Alt+Space',
  autoStart: false,
  autoStartSilent: true,
  alwaysOnTopInQuickMode: true,
  hideAfterSubmit: false,
  llm: {
    enabled: true,
    providerPreset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    customSystemPrompt: ''
  },
  categories: DEFAULT_CATEGORIES
};

export function getAutoStartTargetCommand(silent = true) {
  const exePath = path.join(PROJECT_ROOT, 'QuickMemo.exe');
  if (fs.existsSync(exePath)) {
    return `"${exePath}"${silent ? ' --autostart' : ''}`;
  }
  const standalonePath = path.join(PROJECT_ROOT, 'server', 'standalone.js');
  return `"${process.execPath}" "${standalonePath}"${silent ? '' : ' --open'}`;
}

export function getAutoStartStatus() {
  const exePath = path.join(PROJECT_ROOT, 'QuickMemo.exe');
  if (process.platform !== 'win32') {
    return {
      supported: false,
      enabled: false,
      command: '',
      exePath
    };
  }
  try {
    const out = execFileSync('reg', ['query', REG_RUN_KEY, '/v', REG_VALUE_NAME], {
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const match = String(out || '').match(/REG_SZ\s+(.+)$/im);
    const command = match ? match[1].trim() : getAutoStartTargetCommand(true);
    return {
      supported: true,
      enabled: true,
      command,
      exePath
    };
  } catch {
    return {
      supported: true,
      enabled: false,
      command: '',
      exePath
    };
  }
}

export function applyAutoStartSetting(enabled, silent = true) {
  if (process.platform !== 'win32') {
    return getAutoStartStatus();
  }
  try {
    if (enabled) {
      const cmd = getAutoStartTargetCommand(silent);
      execFileSync(
        'reg',
        ['add', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/t', 'REG_SZ', '/d', cmd, '/f'],
        { encoding: 'utf-8', windowsHide: true, stdio: 'ignore' }
      );
    } else {
      execFileSync(
        'reg',
        ['delete', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/f'],
        { encoding: 'utf-8', windowsHide: true, stdio: 'ignore' }
      );
    }
  } catch {
    // 忽略删除不存在的注册表项时的报错
  }
  return getAutoStartStatus();
}

export function setAutoStart({ enabled, autoStartSilent } = {}) {
  const current = getConfig();
  const nextEnabled = enabled !== undefined ? Boolean(enabled) : Boolean(current.autoStart);
  const nextSilent = autoStartSilent !== undefined ? Boolean(autoStartSilent) : (current.autoStartSilent !== false);
  const status = applyAutoStartSetting(nextEnabled, nextSilent);
  const saved = saveConfig({
    ...current,
    autoStart: status.enabled,
    autoStartSilent: nextSilent
  });
  return {
    ok: true,
    enabled: status.enabled,
    autoStartSilent: nextSilent,
    command: status.command || getAutoStartTargetCommand(nextSilent),
    config: saved
  };
}

export function getConfig() {
  const regStatus = getAutoStartStatus();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      let resolvedVaultPath = parsed.vaultPath || DEFAULT_VAULT_PATH;
      if (!fs.existsSync(resolvedVaultPath) && fs.existsSync(DEFAULT_VAULT_PATH)) {
        resolvedVaultPath = DEFAULT_VAULT_PATH;
      }
      const silentPref = parsed.autoStartSilent !== undefined ? Boolean(parsed.autoStartSilent) : true;
      const autoStartEnabled = process.platform === 'win32'
        ? regStatus.enabled
        : Boolean(parsed.autoStart);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        vaultPath: resolvedVaultPath,
        autoStart: autoStartEnabled,
        autoStartSilent: silentPref,
        autoStartCommand: regStatus.command || getAutoStartTargetCommand(silentPref),
        llm: { ...DEFAULT_CONFIG.llm, ...(parsed.llm || {}) },
        categories: Array.isArray(parsed.categories) && parsed.categories.length > 0
          ? parsed.categories
          : DEFAULT_CATEGORIES
      };
    }
  } catch (err) {
    console.error('[VaultManager] Failed to read config:', err);
  }
  const initial = {
    ...DEFAULT_CONFIG,
    autoStart: regStatus.enabled,
    autoStartCommand: regStatus.command || getAutoStartTargetCommand(true)
  };
  saveConfig(initial);
  return initial;
}

export function saveConfig(newConfig) {
  const silentPref = newConfig.autoStartSilent !== undefined ? Boolean(newConfig.autoStartSilent) : true;
  const wantAutoStart = Boolean(newConfig.autoStart);
  const regStatus = applyAutoStartSetting(wantAutoStart, silentPref);
  const merged = {
    ...DEFAULT_CONFIG,
    ...newConfig,
    autoStart: process.platform === 'win32' ? regStatus.enabled : wantAutoStart,
    autoStartSilent: silentPref,
    autoStartCommand: regStatus.command || getAutoStartTargetCommand(silentPref),
    llm: { ...DEFAULT_CONFIG.llm, ...(newConfig.llm || {}) },
    categories: Array.isArray(newConfig.categories) && newConfig.categories.length > 0
      ? newConfig.categories
      : DEFAULT_CATEGORIES
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  ensureVaultStructure(merged.vaultPath, merged.categories);
  return merged;
}

export function ensureVaultStructure(vaultPath, categories = DEFAULT_CATEGORIES) {
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
  }
  for (const cat of categories) {
    const catDir = path.join(vaultPath, sanitizeFileName(cat.id));
    if (!fs.existsSync(catDir)) {
      fs.mkdirSync(catDir, { recursive: true });
    }
  }
}

export function sanitizeFileName(name) {
  return String(name || '未命名')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名';
}

function formatDateParts(date = new Date()) {
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

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function buildMarkdownContent(memo) {
  const tagsYaml = (memo.tags || []).map((t) => `  - "${String(t).replace(/"/g, '\\"')}"`).join('\n');
  const attachmentsYaml = (memo.attachments || []).map((a) =>
    `  - name: "${String(a.name).replace(/"/g, '\\"')}"\n    relPath: "${a.relPath}"\n    mimeType: "${a.mimeType || ''}"\n    size: ${a.size || 0}`
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
      if (att.mimeType && att.mimeType.startsWith('image/')) {
        attachmentSection.push(`![${att.name}](${att.relPath})`);
      } else {
        attachmentSection.push(`- 📎 [${att.name} (${formatBytes(att.size)})](${att.relPath})`);
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

  if (Array.isArray(memo.webPages) && memo.webPages.length > 0) {
    bodyParts.push('## 🌐 网页链接抓取内容', '');
    for (const page of memo.webPages) {
      const pageTitle = (page.title || page.url || '网页正文').trim();
      bodyParts.push(`### [${pageTitle}](${page.url || ''})`);
      if (page.fetchedAt) {
        bodyParts.push(`> 抓取时间：${page.fetchedAt}`);
      }
      bodyParts.push('');
      if (page.extractedText) {
        bodyParts.push(page.extractedText.trim(), '');
      }
    }
  }

  return bodyParts.join('\n');
}

function getIndexFilePath(vaultPath) {
  return path.join(vaultPath, '.quick-memo-index.json');
}

export function readIndex(vaultPath) {
  const indexPath = getIndexFilePath(vaultPath);
  try {
    if (fs.existsSync(indexPath)) {
      const items = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(items)) {
        return items;
      }
    }
  } catch (err) {
    console.error('[VaultManager] Failed to read index:', err);
  }
  return [];
}

export function writeIndex(vaultPath, items) {
  const indexPath = getIndexFilePath(vaultPath);
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf-8');
}

/**
 * 保存一条记录到对应的分类文件夹下，生成 .md 和 assets 附件
 */
export function saveMemo(payload) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  ensureVaultStructure(vaultPath, config.categories);

  const now = new Date();
  const { dateStr, fullStr, compactTime, compactFull } = formatDateParts(now);
  const id = payload.id || `memo_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
  const category = sanitizeFileName(payload.category || '99-收件箱');
  const title = (payload.title || '随手记录').trim();
  const safeTitle = sanitizeFileName(title);

  const categoryDir = path.join(vaultPath, category);
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }

  const savedAttachments = [];
  if (Array.isArray(payload.rawAttachments) && payload.rawAttachments.length > 0) {
    const assetsDir = path.join(categoryDir, 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    for (let i = 0; i < payload.rawAttachments.length; i++) {
      const item = payload.rawAttachments[i];
      // item: { name, mimeType, dataBase64 }
      const ext = path.extname(item.name || '') || guessExtension(item.mimeType);
      const baseName = sanitizeFileName(path.basename(item.name || `attachment_${i + 1}`, path.extname(item.name || '')));
      const fileName = `${compactFull}_${baseName}${ext}`;
      const absAssetPath = path.join(assetsDir, fileName);

      const base64Clean = String(item.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(base64Clean, 'base64');
      fs.writeFileSync(absAssetPath, buf);

      savedAttachments.push({
        name: item.name || fileName,
        relPath: `./assets/${fileName}`,
        absPath: absAssetPath,
        mimeType: item.mimeType || 'application/octet-stream',
        size: buf.length
      });
    }
  }

  const mdFileName = `${dateStr}_${compactTime}_${safeTitle}.md`;
  const mdAbsPath = path.join(categoryDir, mdFileName);

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
    webPages: Array.isArray(payload.webPages) ? payload.webPages : [],
    mdRelPath: `${category}/${mdFileName}`,
    mdAbsPath
  };

  const mdText = buildMarkdownContent(memoRecord);
  fs.writeFileSync(mdAbsPath, mdText, 'utf-8');

  const currentIndex = readIndex(vaultPath).filter((x) => x.id !== id);
  currentIndex.unshift(memoRecord);
  writeIndex(vaultPath, currentIndex);

  return memoRecord;
}

/**
 * 更新已有记录（例如后台 AI 分类完成后，把记录从 99-收件箱 移动到目标分类目录，或用户手动改分类/标题/内容）
 */
export function updateMemo(id, patch) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const index = readIndex(vaultPath);
  const idx = index.findIndex((x) => x.id === id);
  if (idx === -1) {
    throw new Error(`找不到记录: ${id}`);
  }

  const oldMemo = index[idx];
  const newCategory = sanitizeFileName(patch.category || oldMemo.category);
  const newTitle = (patch.title !== undefined ? patch.title : oldMemo.title).trim() || oldMemo.title;
  const newContent = patch.content !== undefined ? patch.content : oldMemo.content;
  const newSummary = patch.summary !== undefined ? patch.summary : oldMemo.summary;
  const newTags = patch.tags !== undefined ? patch.tags : oldMemo.tags;
  const newAiClassified = patch.aiClassified !== undefined ? patch.aiClassified : oldMemo.aiClassified;
  const newWebPages = patch.webPages !== undefined ? patch.webPages : (oldMemo.webPages || []);

  const newCategoryDir = path.join(vaultPath, newCategory);
  if (!fs.existsSync(newCategoryDir)) {
    fs.mkdirSync(newCategoryDir, { recursive: true });
  }

  // 如果分类发生变化，同时移动附件到新分类的 assets 下
  const updatedAttachments = [];
  for (const att of oldMemo.attachments || []) {
    const oldAssetAbs = att.absPath || path.join(path.dirname(oldMemo.mdAbsPath), att.relPath);
    if (newCategory !== oldMemo.category && fs.existsSync(oldAssetAbs)) {
      const targetAssetsDir = path.join(newCategoryDir, 'assets');
      if (!fs.existsSync(targetAssetsDir)) {
        fs.mkdirSync(targetAssetsDir, { recursive: true });
      }
      const assetFileName = path.basename(oldAssetAbs);
      const newAssetAbs = path.join(targetAssetsDir, assetFileName);
      if (oldAssetAbs !== newAssetAbs) {
        fs.renameSync(oldAssetAbs, newAssetAbs);
      }
      updatedAttachments.push({
        ...att,
        relPath: `./assets/${assetFileName}`,
        absPath: newAssetAbs
      });
    } else {
      updatedAttachments.push(att);
    }
  }

  // 删除旧的 .md 文件
  if (oldMemo.mdAbsPath && fs.existsSync(oldMemo.mdAbsPath)) {
    try {
      fs.unlinkSync(oldMemo.mdAbsPath);
    } catch (e) {
      console.warn('[VaultManager] Could not remove old md file:', e);
    }
  }

  // 生成新的 .md 文件名（保留原日期前缀）
  const datePrefixMatch = path.basename(oldMemo.mdAbsPath || '').match(/^(\d{4}-\d{2}-\d{2}_\d{6})_/);
  const prefix = datePrefixMatch ? datePrefixMatch[1] : formatDateParts().compactFull;
  const safeTitle = sanitizeFileName(newTitle);
  const newMdFileName = `${prefix}_${safeTitle}.md`;
  const newMdAbsPath = path.join(newCategoryDir, newMdFileName);

  const updatedMemo = {
    ...oldMemo,
    title: newTitle,
    category: newCategory,
    content: newContent,
    summary: newSummary,
    tags: newTags,
    aiClassified: newAiClassified,
    attachments: updatedAttachments,
    webPages: newWebPages,
    mdRelPath: `${newCategory}/${newMdFileName}`,
    mdAbsPath: newMdAbsPath
  };

  const mdText = buildMarkdownContent(updatedMemo);
  fs.writeFileSync(newMdAbsPath, mdText, 'utf-8');

  index[idx] = updatedMemo;
  writeIndex(vaultPath, index);
  return updatedMemo;
}

export function deleteMemo(id) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const index = readIndex(vaultPath);
  const target = index.find((x) => x.id === id);
  if (!target) return { deleted: false };

  if (target.mdAbsPath && fs.existsSync(target.mdAbsPath)) {
    try {
      fs.unlinkSync(target.mdAbsPath);
    } catch (e) {
      console.warn('[VaultManager] Failed to unlink md:', e);
    }
  }
  for (const att of target.attachments || []) {
    if (att.absPath && fs.existsSync(att.absPath)) {
      try {
        fs.unlinkSync(att.absPath);
      } catch (e) {
        console.warn('[VaultManager] Failed to unlink attachment:', e);
      }
    }
  }

  const next = index.filter((x) => x.id !== id);
  writeIndex(vaultPath, next);
  return { deleted: true, id };
}

/**
 * 重命名某条记录下的指定附件（同步修改磁盘 assets 下的真实文件名、.md 内容及索引）
 */
export function renameAttachment(memoId, attIndex, newNameInput) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const index = readIndex(vaultPath);
  const idx = index.findIndex((x) => x.id === memoId);
  if (idx === -1) {
    throw new Error(`找不到记录: ${memoId}`);
  }

  const memo = index[idx];
  if (!Array.isArray(memo.attachments) || !memo.attachments[attIndex]) {
    throw new Error('找不到要重命名的附件');
  }

  const att = memo.attachments[attIndex];
  const oldName = att.name || '';
  const oldExt = path.extname(oldName) || (att.absPath ? path.extname(att.absPath) : '');

  let cleanNewName = sanitizeFileName(newNameInput || '');
  if (!cleanNewName) {
    throw new Error('文件名不能为空');
  }
  // 如果用户输入的新名字没带后缀，自动补上原后缀
  if (oldExt && !cleanNewName.toLowerCase().endsWith(oldExt.toLowerCase())) {
    cleanNewName += oldExt;
  }

  const oldAbsPath = att.absPath || path.join(path.dirname(memo.mdAbsPath), att.relPath);
  let newAbsPath = oldAbsPath;
  let newRelPath = att.relPath;

  if (oldAbsPath && fs.existsSync(oldAbsPath)) {
    const assetsDir = path.dirname(oldAbsPath);
    const baseWithoutExt = path.basename(cleanNewName, path.extname(cleanNewName));
    const ext = path.extname(cleanNewName) || oldExt;
    const prefixMatch = path.basename(oldAbsPath).match(/^(\d{8}_\d{6})_/);
    const prefix = prefixMatch ? prefixMatch[1] : formatDateParts().compactFull;
    const diskFileName = `${prefix}_${sanitizeFileName(baseWithoutExt)}${ext}`;
    newAbsPath = path.join(assetsDir, diskFileName);

    if (oldAbsPath !== newAbsPath) {
      fs.renameSync(oldAbsPath, newAbsPath);
    }
    newRelPath = `./assets/${diskFileName}`;
  }

  memo.attachments[attIndex] = {
    ...att,
    name: cleanNewName,
    absPath: newAbsPath,
    relPath: newRelPath
  };

  // 如果原记录标题和摘要还带着旧的乱码文件名，同步替换为新文件名方便搜索
  let updatedTitle = memo.title;
  if (oldName && updatedTitle.includes(oldName)) {
    updatedTitle = updatedTitle.replace(oldName, cleanNewName);
  } else if (updatedTitle.startsWith('文件归档：') || updatedTitle.startsWith('图片记录：')) {
    const prefix = updatedTitle.split('：')[0];
    updatedTitle = `${prefix}：${cleanNewName}`;
  }

  let updatedSummary = memo.summary || '';
  if (oldName && updatedSummary.includes(oldName)) {
    updatedSummary = updatedSummary.replace(oldName, cleanNewName);
  }

  writeIndex(vaultPath, index);

  return updateMemo(memoId, {
    title: updatedTitle,
    summary: updatedSummary
  });
}

export function resolveAssetPathForCurrentVault(rawPath = '', vaultPath = '', mdDir = '') {
  if (rawPath && fs.existsSync(rawPath)) {
    return rawPath;
  }
  if (mdDir && rawPath && !path.isAbsolute(rawPath)) {
    const relCandidate = path.resolve(mdDir, rawPath);
    if (fs.existsSync(relCandidate)) return relCandidate;
  }
  const m = String(rawPath || '').match(/[\\/]vault[\\/](.+)$/i);
  if (m && vaultPath) {
    const migrated = path.join(vaultPath, m[1]);
    if (fs.existsSync(migrated)) return migrated;
  }
  return rawPath;
}

export function listMemos() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  ensureVaultStructure(vaultPath, config.categories);
  const items = readIndex(vaultPath);
  // 过滤掉在磁盘上已被外部删除的 .md 文件，并在换电脑/迁移目录后自动修正 mdAbsPath 与附件 absPath
  const validItems = [];
  let changed = false;
  for (const item of items) {
    const expectedAbs = item.mdRelPath ? path.join(vaultPath, item.mdRelPath) : '';
    let actualAbs = null;
    if (expectedAbs && fs.existsSync(expectedAbs)) {
      actualAbs = expectedAbs;
    } else if (item.mdAbsPath && fs.existsSync(item.mdAbsPath)) {
      actualAbs = item.mdAbsPath;
    } else {
      const migratedMd = resolveAssetPathForCurrentVault(item.mdAbsPath, vaultPath);
      if (migratedMd && fs.existsSync(migratedMd)) {
        actualAbs = migratedMd;
      }
    }

    if (!actualAbs && expectedAbs && !item.mdAbsPath) {
      // 从云端（如安卓端）同步下来的新记录，自动在本地分类目录下生成对应的 .md 文件
      try {
        const mdDir = path.dirname(expectedAbs);
        if (!fs.existsSync(mdDir)) {
          fs.mkdirSync(mdDir, { recursive: true });
        }
        fs.writeFileSync(expectedAbs, buildMarkdownContent(item), 'utf-8');
        actualAbs = expectedAbs;
        changed = true;
      } catch (e) {
        console.warn('[VaultManager] Failed to materialize synced md:', e);
      }
    }

    if (actualAbs) {
      if (item.mdAbsPath !== actualAbs) {
        item.mdAbsPath = actualAbs;
        changed = true;
      }
      const mdDir = path.dirname(actualAbs);
      if (Array.isArray(item.attachments)) {
        for (const att of item.attachments) {
          let resolvedAttAbs = null;
          if (att.relPath) {
            const byRel = path.resolve(mdDir, att.relPath);
            if (fs.existsSync(byRel)) resolvedAttAbs = byRel;
          }
          if (!resolvedAttAbs && att.absPath && fs.existsSync(att.absPath)) {
            resolvedAttAbs = att.absPath;
          }
          if (!resolvedAttAbs && att.absPath) {
            const migratedAtt = resolveAssetPathForCurrentVault(att.absPath, vaultPath, mdDir);
            if (migratedAtt && fs.existsSync(migratedAtt)) {
              resolvedAttAbs = migratedAtt;
            }
          }
          if (resolvedAttAbs && att.absPath !== resolvedAttAbs) {
            att.absPath = resolvedAttAbs;
            changed = true;
          }
        }
      }
      validItems.push(item);
    } else {
      changed = true;
    }
  }
  if (changed) {
    writeIndex(vaultPath, validItems);
  }
  return validItems;
}

export function openInExplorer(targetPath) {
  const config = getConfig();
  const abs = targetPath ? path.resolve(targetPath) : config.vaultPath;
  if (!fs.existsSync(abs)) {
    exec(`explorer.exe "${config.vaultPath}"`);
    return;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    exec(`explorer.exe "${abs}"`);
  } else {
    exec(`explorer.exe /select,"${abs}"`);
  }
}

function guessExtension(mimeType = '') {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md'
  };
  return map[mimeType] || '.bin';
}

function detectMemoType(content = '', attachments = []) {
  if (attachments.some((a) => a.mimeType && a.mimeType.startsWith('image/'))) {
    return 'image';
  }
  if (attachments.length > 0) {
    return 'file';
  }
  const trimmed = String(content || '').trim();
  if (/^https?:\/\/\S+$/i.test(trimmed) || (trimmed.includes('http') && trimmed.split('\n').length <= 3)) {
    return 'link';
  }
  if (trimmed.includes('```') || /[{}();=>]/.test(trimmed) && trimmed.split('\n').length >= 3) {
    return 'code';
  }
  return 'text';
}

/**
 * 识别文本中是否包含 API Key / Token / 密钥 / 访问凭据，并检查用户是否写了足够的中文/语义备注
 */
export function detectSecretKeyInfo(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) {
    return { isKey: false, needsNote: false };
  }

  const patterns = [
    { type: 'OpenAI / DeepSeek / 通用 sk- 密钥', regex: /\bsk-[a-zA-Z0-9_-]{14,}\b/ },
    { type: 'GitHub 访问令牌 (Token)', regex: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{16,}\b/ },
    { type: '云厂商 AccessKey (阿里云/AWS)', regex: /\b(LTAI|AKIA|ASIA)[a-zA-Z0-9]{12,}\b/ },
    { type: '飞书 / 企微 / 平台 AppSecret', regex: /\b(cli_[a-zA-Z0-9]{12,}|[a-f0-9]{32,64})\b/i },
    { type: 'UUID 格式 API Key / 密钥', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
    { type: 'JWT 认证令牌 (Bearer Token)', regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{8,}\b/ },
    { type: '环境变量密钥配置', regex: /\b(API_KEY|SECRET_KEY|ACCESS_TOKEN|APP_SECRET|PRIVATE_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i }
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

  // 如果整段文本就是一串无空格的 24~120 位高熵字母数字混合串（且不是普通网址）
  if (!matchedType && !/^https?:\/\//i.test(text) && /^[a-zA-Z0-9_\-+=/.]{24,120}$/.test(text) && /[a-zA-Z]/.test(text) && /\d/.test(text)) {
    matchedType = '高强度密钥 / Token 串';
    matchedValue = text;
  }

  if (!matchedType) {
    return { isKey: false, needsNote: false };
  }

  // 把匹配到的密钥串和常见泛称词（如 key/token/密钥/密码）剥离后，看剩下的文字里有没有说明具体平台或用途的备注
  const remainder = text
    .replace(matchedValue, '')
    .replace(/\b(API_KEY|SECRET_KEY|ACCESS_TOKEN|APP_SECRET|PRIVATE_KEY|Bearer|export|const|let|key|token|api|secret)\b/gi, '')
    .replace(/密钥|秘钥|令牌|凭证|密码/g, '')
    .replace(/[=:;"'`\s\-_]/g, '')
    .trim();

  const cjkCount = (remainder.match(/[\u4e00-\u9fa5]/g) || []).length;
  const hasMeaningfulNote = cjkCount >= 2 || remainder.length >= 3;

  const masked = matchedValue.length > 12
    ? `${matchedValue.slice(0, 6)}••••${matchedValue.slice(-4)}`
    : matchedValue;
  const shortMask = matchedValue.length > 8
    ? `${matchedValue.slice(0, 6)}…`
    : matchedValue;

  const noteSummary = text
    .replace(matchedValue, '')
    .replace(/\s+/g, ' ')
    .replace(/^[=:;,\-_\s]+|[=:;,\-_\s]+$/g, '')
    .trim();

  return {
    isKey: true,
    needsNote: !hasMeaningfulNote,
    keyType: matchedType,
    matchedValue,
    maskedKey: masked,
    shortMask,
    noteSummary
  };
}

/**
 * 归档前预检：
 * 1. 检查当前文本、链接或上传的附件是否之前已经保存过（精准返回之前保存的分类位置、标题、时间）
 * 2. 检查是否包含未写备注的 API Key / 密钥串
 */
export function precheckMemo({ content = '', rawAttachments = [] }) {
  const existingMemos = listMemos();
  const cleanText = String(content || '')
    .replace(/^### 📄 文档内容提取预览\s*/m, '')
    .trim();
  const normText = cleanText.replace(/\s+/g, ' ').toLowerCase();

  // 提取输入中的网址
  const inputUrls = (cleanText.match(/https?:\/\/[^\s)]+/gi) || []).map((u) => u.toLowerCase().replace(/\/+$/, ''));

  // 计算待上传附件的二进制 SHA-256 指纹与文件名
  const incomingAtts = (rawAttachments || []).map((att) => {
    let sha256 = '';
    let byteLength = att.size || 0;
    try {
      if (att.dataBase64) {
        const cleanB64 = String(att.dataBase64).replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(cleanB64, 'base64');
        byteLength = buf.length;
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      }
    } catch {}
    return {
      name: (att.name || '').trim(),
      originalName: (att.originalName || '').trim(),
      detectedTitle: (att.detectedTitle || '').trim(),
      size: byteLength,
      sha256
    };
  });

  const duplicates = [];

  for (const memo of existingMemos) {
    let matchReason = '';
    let matchedAttachmentName = '';

    // 1. 优先比对附件（SHA-256 完全一致，或文件名/提取标题一致）
    if (incomingAtts.length > 0 && Array.isArray(memo.attachments) && memo.attachments.length > 0) {
      for (const inc of incomingAtts) {
        for (const existAtt of memo.attachments) {
          // 比对磁盘文件的 SHA-256
          if (inc.sha256 && existAtt.absPath && fs.existsSync(existAtt.absPath)) {
            try {
              const stat = fs.statSync(existAtt.absPath);
              if (!inc.size || stat.size === inc.size) {
                const existHash = crypto.createHash('sha256').update(fs.readFileSync(existAtt.absPath)).digest('hex');
                if (existHash === inc.sha256) {
                  matchReason = '文件内容 100% 相同（SHA-256 指纹一致）';
                  matchedAttachmentName = existAtt.name;
                  break;
                }
              }
            } catch {}
          }

          // 比对重命名后的文件名或原文件名
          const existNameLower = (existAtt.name || '').toLowerCase();
          if (
            (inc.name && inc.name.toLowerCase() === existNameLower) ||
            (inc.originalName && inc.originalName.toLowerCase() === existNameLower)
          ) {
            matchReason = `已存在同名文件「${existAtt.name}」`;
            matchedAttachmentName = existAtt.name;
            break;
          }
        }
        if (matchReason) break;

        if (!matchReason && inc.detectedTitle && memo.title && inc.detectedTitle.toLowerCase() === memo.title.toLowerCase()) {
          matchReason = `已保存过同标题文档「${memo.title}」`;
          break;
        }
      }
    }

    // 2. 比对网址链接或正文文本
    if (!matchReason && normText.length >= 6) {
      const memoCleanText = String(memo.content || '')
        .replace(/^### 📄 文档内容提取预览\s*/m, '')
        .trim();
      const memoNorm = memoCleanText.replace(/\s+/g, ' ').toLowerCase();

      if (inputUrls.length > 0) {
        const memoUrls = (memoCleanText.match(/https?:\/\/[^\s)]+/gi) || []).map((u) => u.toLowerCase().replace(/\/+$/, ''));
        const sameUrl = inputUrls.find((u) => memoUrls.includes(u));
        if (sameUrl) {
          matchReason = `已保存过相同的网址链接 (${sameUrl.slice(0, 45)}${sameUrl.length > 45 ? '...' : ''})`;
        }
      }

      if (!matchReason && memoNorm) {
        if (normText === memoNorm) {
          matchReason = '正文内容完全相同';
        } else if (normText.length >= 16 && memoNorm.includes(normText)) {
          matchReason = '该段内容已包含在既有记录中';
        }
      }
    }

    if (matchReason) {
      duplicates.push({
        id: memo.id,
        title: memo.title,
        category: memo.category,
        createdAt: memo.createdAt,
        mdRelPath: memo.mdRelPath,
        mdAbsPath: memo.mdAbsPath,
        summary: memo.summary,
        matchReason,
        matchedAttachmentName
      });
    }
  }

  const keyInfo = detectSecretKeyInfo(cleanText);

  return {
    hasDuplicate: duplicates.length > 0,
    duplicates: duplicates.slice(0, 3),
    keyReminder: keyInfo
  };
}
