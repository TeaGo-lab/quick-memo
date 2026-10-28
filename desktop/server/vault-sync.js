import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, openInExplorer, listMemos, readIndex, DEFAULT_CATEGORIES } from './vault-manager.js';
import { rebuildDocIndex } from './doc-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');

function formatBytes(bytes = 0) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function nowCompact() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function nowReadable() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 一键将本地 Markdown 知识库目录 (vaultPath) 下的所有文件打包为 .zip 压缩包并打开资源管理器定位
 */
export function exportVaultToZip() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`找不到本地仓库目录: ${vaultPath}`);
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const zipFileName = `QuickMemo-Vault-Backup_${nowCompact()}.zip`;
  const zipAbsPath = path.join(BACKUP_DIR, zipFileName);

  // 优先使用 Python zipfile 打包（完美支持 UTF-8 中文路径，且自动跳过 .git 目录减小体积）
  const pyScript = `
import os, sys, zipfile, json

vault_dir = sys.argv[1]
zip_path = sys.argv[2]
file_count = 0

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(vault_dir):
        if '.git' in dirs:
            dirs.remove('.git')
        for f in files:
            if f in ('Thumbs.db', '.DS_Store'):
                continue
            abs_p = os.path.join(root, f)
            rel_p = os.path.relpath(abs_p, vault_dir)
            zf.write(abs_p, rel_p)
            file_count += 1

print(json.dumps({"fileCount": file_count}))
`;

  let fileCount = 0;
  try {
    const stdout = execFileSync('python', ['-X', 'utf8', '-c', pyScript, vaultPath, zipAbsPath], {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true
    });
    const parsed = JSON.parse(stdout.trim());
    fileCount = parsed.fileCount || 0;
  } catch {
    // 回退使用 PowerShell Compress-Archive
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path "${vaultPath}\\*" -DestinationPath "${zipAbsPath}" -Force`
      ],
      { timeout: 30000, windowsHide: true }
    );
  }

  const stat = fs.statSync(zipAbsPath);
  // 自动在 Windows 资源管理器中高亮选中打包好的 .zip 文件
  openInExplorer(zipAbsPath);

  return {
    ok: true,
    zipFileName,
    zipAbsPath,
    fileCount,
    sizeBytes: stat.size,
    sizeFormatted: formatBytes(stat.size),
    exportedAt: nowReadable()
  };
}

function runGitInVault(vaultPath, args = []) {
  return execFileSync('git', args, {
    cwd: vaultPath,
    encoding: 'utf-8',
    timeout: 25000,
    windowsHide: true
  }).trim();
}

function ensureGitIdentity(vaultPath) {
  try {
    runGitInVault(vaultPath, ['config', 'core.quotepath', 'false']);
    runGitInVault(vaultPath, ['config', 'core.longpaths', 'true']);
  } catch {}
  try {
    const name = runGitInVault(vaultPath, ['config', 'user.name']);
    const email = runGitInVault(vaultPath, ['config', 'user.email']);
    if (name && email) return;
  } catch {}
  try {
    runGitInVault(vaultPath, ['config', 'user.name', 'QuickMemo Vault']);
    runGitInVault(vaultPath, ['config', 'user.email', 'vault@quickmemo.local']);
  } catch {}
}

function commitLocalVaultChanges(vaultPath, message) {
  ensureGitIdentity(vaultPath);
  runGitInVault(vaultPath, ['add', '-A']);
  const statusOut = runGitInVault(vaultPath, ['status', '--porcelain']);
  if (statusOut) {
    runGitInVault(vaultPath, ['commit', '-m', message]);
    return true;
  }
  return false;
}

/**
 * 根据云端合并后的最新 .quick-memo-index.json，清理本地已被云端删除的孤儿 .md 文件，并补全云端新增的 .md 文件
 */
function reconcileDiskWithCloudIndex(vaultPath) {
  try {
    const indexItems = readIndex(vaultPath);
    const validRelSet = new Set(
      indexItems
        .map((m) => String(m.mdRelPath || '').replace(/\\/g, '/'))
        .filter(Boolean)
    );
    const categories = getConfig().categories || DEFAULT_CATEGORIES;
    for (const cat of categories) {
      const catDir = path.join(vaultPath, cat.id);
      if (!fs.existsSync(catDir)) continue;
      const files = fs.readdirSync(catDir);
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        const rel = `${cat.id}/${f}`.replace(/\\/g, '/');
        if (!validRelSet.has(rel)) {
          try {
            fs.unlinkSync(path.join(catDir, f));
          } catch {}
        }
      }
    }
    listMemos();
  } catch (err) {
    console.warn('[VaultSync] Reconcile warning:', err.message);
  }
}

/**
 * 拉取并合并指定远程分支（支持换新电脑或双远端 Gitee + GitHub 自动合并，以云端最新状态为主）
 */
function pullAndMergeRemoteMain(vaultPath, remoteName = 'origin') {
  ensureGitIdentity(vaultPath);
  commitLocalVaultChanges(vaultPath, `backup: local save before sync ${nowReadable()}`);

  try {
    runGitInVault(vaultPath, ['fetch', remoteName]);
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes("couldn't find remote ref") || msg.includes('does not appear to be a git repository')) {
      return false;
    }
    throw new Error(`连接远程仓库 (${remoteName}) 失败：${msg}`);
  }

  let hasRemoteMain = false;
  try {
    const rev = runGitInVault(vaultPath, ['rev-parse', '--verify', `${remoteName}/main`]);
    hasRemoteMain = Boolean(rev);
  } catch {
    hasRemoteMain = false;
  }
  if (!hasRemoteMain) {
    return false;
  }

  let hasLocalHead = false;
  try {
    const headRev = runGitInVault(vaultPath, ['rev-parse', '--verify', 'HEAD']);
    hasLocalHead = Boolean(headRev);
  } catch {
    hasLocalHead = false;
  }

  if (!hasLocalHead) {
    runGitInVault(vaultPath, ['reset', '--hard', `${remoteName}/main`]);
    reconcileDiskWithCloudIndex(vaultPath);
    rebuildDocIndex();
    return true;
  }

  try {
    runGitInVault(vaultPath, [
      'merge',
      `${remoteName}/main`,
      '--allow-unrelated-histories',
      '-X',
      'theirs',
      '--no-edit',
      '-m',
      `chore: merge ${remoteName} vault ${nowReadable()}`
    ]);
  } catch (mergeErr) {
    try {
      runGitInVault(vaultPath, ['checkout', '--theirs', '.']);
      runGitInVault(vaultPath, ['add', '-A']);
      runGitInVault(vaultPath, ['commit', '-m', `chore: resolve ${remoteName} vault merge ${nowReadable()}`]);
    } catch {
      try {
        runGitInVault(vaultPath, ['merge', '--abort']);
      } catch {}
      throw new Error(`合并远程知识库 (${remoteName}) 失败：${mergeErr.message}`);
    }
  }

  reconcileDiskWithCloudIndex(vaultPath);
  rebuildDocIndex();
  return true;
}

function maskRemoteUrl(rawUrl = '') {
  return String(rawUrl || '').replace(/https:\/\/([^/@:]+):([^/@]+)@/i, 'https://');
}

function detectGitProvider(url = '') {
  const u = String(url || '').toLowerCase();
  if (u.includes('gitee.com')) return 'gitee';
  if (u.includes('github.com')) return 'github';
  return u ? 'custom' : '';
}

function injectGiteeTokenToUrl(repoUrl = '', token = '') {
  const cleanUrl = maskRemoteUrl(repoUrl).trim();
  const cleanToken = String(token || '').trim();
  if (!cleanToken || !/^https:\/\/gitee\.com\//i.test(cleanUrl)) {
    return cleanUrl;
  }
  return cleanUrl.replace(/^https:\/\/gitee\.com\//i, `https://oauth2:${encodeURIComponent(cleanToken)}@gitee.com/`);
}

function injectGitHubTokenToUrl(repoUrl = '', token = '') {
  const cleanUrl = maskRemoteUrl(repoUrl).trim();
  const cleanToken = String(token || '').trim();
  if (!cleanToken || !/^https:\/\/github\.com\//i.test(cleanUrl)) {
    return cleanUrl;
  }
  return cleanUrl.replace(/^https:\/\/github\.com\//i, `https://oauth2:${encodeURIComponent(cleanToken)}@github.com/`);
}

function setOrUpdateGitRemote(vaultPath, name, authUrl) {
  if (!authUrl) return;
  try {
    const cur = runGitInVault(vaultPath, ['remote', 'get-url', name]);
    if (cur !== authUrl) {
      runGitInVault(vaultPath, ['remote', 'set-url', name, authUrl]);
    }
  } catch {
    try {
      runGitInVault(vaultPath, ['remote', 'add', name, authUrl]);
    } catch {}
  }
}

/**
 * 解析并配置本地 vault 关联的所有云端仓库（支持 Gitee + GitHub 双远端同时存在）
 */
export function ensureConfiguredRemotes(vaultPath, config = getConfig()) {
  const vGit = config.vaultGit || {};
  let giteeUrl = maskRemoteUrl(vGit.giteeUrl || '');
  let githubUrl = maskRemoteUrl(vGit.githubUrl || '');
  const legacyUrl = maskRemoteUrl(vGit.remoteUrl || '');

  if (legacyUrl.includes('gitee.com') && !giteeUrl) giteeUrl = legacyUrl;
  if (legacyUrl.includes('github.com') && !githubUrl) githubUrl = legacyUrl;

  const gitDir = path.join(vaultPath, '.git');
  if (fs.existsSync(gitDir)) {
    try {
      const originUrl = maskRemoteUrl(runGitInVault(vaultPath, ['remote', 'get-url', 'origin']));
      if (originUrl.includes('gitee.com') && !giteeUrl) giteeUrl = originUrl;
      if (originUrl.includes('github.com') && !githubUrl) githubUrl = originUrl;
    } catch {}
    try {
      const ge = maskRemoteUrl(runGitInVault(vaultPath, ['remote', 'get-url', 'gitee']));
      if (ge && !giteeUrl) giteeUrl = ge;
    } catch {}
    try {
      const gh = maskRemoteUrl(runGitInVault(vaultPath, ['remote', 'get-url', 'github']));
      if (gh && !githubUrl) githubUrl = gh;
    } catch {}
  }

  const activeRemotes = [];
  if (fs.existsSync(gitDir)) {
    if (giteeUrl) {
      const authGitee = injectGiteeTokenToUrl(giteeUrl, vGit.giteeToken);
      setOrUpdateGitRemote(vaultPath, 'gitee', authGitee);
      activeRemotes.push({
        name: 'gitee',
        provider: 'gitee',
        label: 'Gitee 码云',
        url: giteeUrl
      });
    }
    if (githubUrl) {
      const authGithub = injectGitHubTokenToUrl(githubUrl, vGit.githubToken);
      setOrUpdateGitRemote(vaultPath, 'github', authGithub);
      activeRemotes.push({
        name: 'github',
        provider: 'github',
        label: 'GitHub',
        url: githubUrl
      });
    }
    // 确保默认 origin 指向主远端（优先 Gitee，其次 GitHub）
    if (giteeUrl) {
      setOrUpdateGitRemote(vaultPath, 'origin', injectGiteeTokenToUrl(giteeUrl, vGit.giteeToken));
    } else if (githubUrl) {
      setOrUpdateGitRemote(vaultPath, 'origin', injectGitHubTokenToUrl(githubUrl, vGit.githubToken));
    }
  }

  return {
    giteeUrl,
    githubUrl,
    activeRemotes
  };
}

/**
 * 获取本地 Vault 目录关联的独立 Git 私有仓库状态（支持 Gitee 码云 & GitHub 同时启用）
 */
export function getVaultGitStatus() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, '.git');
  const isGitInitialized = fs.existsSync(gitDir);

  let pendingChanges = 0;
  let lastCommit = '';
  let branch = 'main';

  const { giteeUrl, githubUrl, activeRemotes } = ensureConfiguredRemotes(vaultPath, config);

  if (isGitInitialized) {
    try {
      branch = runGitInVault(vaultPath, ['branch', '--show-current']) || 'main';
    } catch {}
    try {
      const statusOut = runGitInVault(vaultPath, ['status', '--porcelain']);
      pendingChanges = statusOut ? statusOut.split(/\r?\n/).filter(Boolean).length : 0;
    } catch {}
    try {
      lastCommit = runGitInVault(vaultPath, ['log', '-1', '--format=%cd · %s', '--date=format:%Y-%m-%d %H:%M']);
    } catch {}
  }

  const remoteUrl = giteeUrl && githubUrl
    ? `${giteeUrl} + ${githubUrl}`
    : (giteeUrl || githubUrl || '');
  const provider = config.vaultGit?.provider || (giteeUrl ? 'gitee' : (githubUrl ? 'github' : 'gitee'));

  let ghUser = '';
  try {
    ghUser = execFileSync('gh', ['api', 'user', '-q', '.login'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    }).trim();
  } catch {}

  return {
    vaultPath,
    isGitInitialized,
    remoteUrl,
    giteeUrl,
    githubUrl,
    activeRemotes,
    dualSyncActive: Boolean(giteeUrl && githubUrl),
    hasAnyCloud: Boolean(giteeUrl || githubUrl),
    provider,
    branch,
    pendingChanges,
    lastCommit,
    ghUser,
    hasGiteeToken: Boolean(config.vaultGit?.giteeToken),
    hasGithubToken: Boolean(config.vaultGit?.githubToken),
    autoSyncEnabled: config.vaultGit?.autoSync !== false
  };
}

/**
 * 初始化 Vault 独立 Git 仓库，并支持一键创建或关联 Gitee (国内码云) / GitHub 私有仓库（若两个都配置则同时保留并双端同步）
 */
export async function linkVaultToGitHub({
  provider = '',
  repoUrl = '',
  giteeToken = '',
  githubToken = '',
  autoCreatePrivate = false,
  repoName = 'quick-memo-vault',
  autoSync = true
}) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
  }

  const gitDir = path.join(vaultPath, '.git');
  if (!fs.existsSync(gitDir)) {
    runGitInVault(vaultPath, ['init']);
    try {
      runGitInVault(vaultPath, ['branch', '-M', 'main']);
    } catch {}
  }
  ensureGitIdentity(vaultPath);

  const vaultGitignore = path.join(vaultPath, '.gitignore');
  if (!fs.existsSync(vaultGitignore)) {
    fs.writeFileSync(vaultGitignore, '.DS_Store\nThumbs.db\n', 'utf-8');
  }

  const resolvedGiteeToken = String(giteeToken || config.vaultGit?.giteeToken || '').trim();
  const resolvedGithubToken = String(githubToken || config.vaultGit?.githubToken || '').trim();
  let targetRemoteUrl = String(repoUrl || '').trim();
  const chosenProvider = provider || detectGitProvider(targetRemoteUrl) || 'gitee';

  if (autoCreatePrivate) {
    const cleanRepoName = String(repoName || 'quick-memo-vault').trim().replace(/[^a-zA-Z0-9._-]/g, '-');

    if (chosenProvider === 'gitee') {
      if (!resolvedGiteeToken) {
        throw new Error('一键在 Gitee 自动创建私有仓库需要先填写「Gitee 私人令牌 (Access Token)」，或者你也可以直接在 Gitee 网页端新建私有库后粘贴地址绑定');
      }

      const userRes = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(resolvedGiteeToken)}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!userRes.ok) {
        throw new Error(`Gitee 私人令牌校验失败 (HTTP ${userRes.status})，请检查 Token 是否正确并勾选了 projects 权限`);
      }
      const userData = await userRes.json();
      const giteeLogin = userData.login;
      if (!giteeLogin) {
        throw new Error('未能获取到 Gitee 用户名');
      }

      const checkRes = await fetch(
        `https://gitee.com/api/v5/repos/${encodeURIComponent(giteeLogin)}/${encodeURIComponent(cleanRepoName)}?access_token=${encodeURIComponent(resolvedGiteeToken)}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!checkRes.ok) {
        const createRes = await fetch('https://gitee.com/api/v5/user/repos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({
            access_token: resolvedGiteeToken,
            name: cleanRepoName,
            description: 'QuickMemo 私人闪念与本地 Markdown 知识库云备份（私有仓库）',
            private: true,
            auto_init: false
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (!createRes.ok) {
          const errText = await createRes.text();
          throw new Error(`在 Gitee 创建私有仓库失败：${errText}`);
        }
      }

      targetRemoteUrl = `https://gitee.com/${giteeLogin}/${cleanRepoName}.git`;
    } else {
      const ghUser = execFileSync('gh', ['api', 'user', '-q', '.login'], {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true
      }).trim();

      if (!ghUser) {
        throw new Error('未检测到本机 gh 登录状态，请手动填入私有仓库地址或切换为国内 Gitee 码云');
      }

      const fullSlug = `${ghUser}/${cleanRepoName}`;
      let exists = false;
      try {
        execFileSync('gh', ['repo', 'view', fullSlug, '--json', 'name'], {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true
        });
        exists = true;
      } catch {
        exists = false;
      }

      if (!exists) {
        execFileSync(
          'gh',
          [
            'repo',
            'create',
            fullSlug,
            '--private',
            '--description',
            'QuickMemo 私人闪念与本地 Markdown 知识库云备份（私有仓库）'
          ],
          {
            encoding: 'utf-8',
            timeout: 15000,
            windowsHide: true
          }
        );
      }

      targetRemoteUrl = `https://github.com/${fullSlug}.git`;
    }
  }

  if (!targetRemoteUrl) {
    throw new Error('请填写 Gitee 或 GitHub 私有仓库地址，或点击一键创建私有仓库');
  }

  const displayRemoteUrl = maskRemoteUrl(targetRemoteUrl);
  const detectedProv = detectGitProvider(displayRemoteUrl) || chosenProvider;

  const nextGiteeUrl = detectedProv === 'gitee' ? displayRemoteUrl : (config.vaultGit?.giteeUrl || '');
  const nextGithubUrl = detectedProv === 'github' ? displayRemoteUrl : (config.vaultGit?.githubUrl || '');

  // 保存配置（同时保留 Gitee 和 GitHub 配置，不互相覆盖）
  const nextConfig = saveConfig({
    ...config,
    vaultGit: {
      ...config.vaultGit,
      provider: detectedProv,
      remoteUrl: displayRemoteUrl,
      giteeUrl: nextGiteeUrl,
      githubUrl: nextGithubUrl,
      giteeToken: resolvedGiteeToken,
      githubToken: resolvedGithubToken,
      autoSync: autoSync !== false
    }
  });

  ensureConfiguredRemotes(vaultPath, nextConfig);

  // 立即执行双向同步（同时同步所有已配置的云端仓库）
  const syncRes = syncVaultGit({ action: 'both' });
  return {
    ok: true,
    remoteUrl: displayRemoteUrl,
    provider: detectedProv,
    syncResult: syncRes,
    status: getVaultGitStatus()
  };
}

/**
 * 执行 Vault 知识库与远程私有仓库的推送 (push)、拉取 (pull) 或双向同步 (both)
 * 如果同时配置了 Gitee 和 GitHub，自动同时向两个平台拉取合并与推送更新！
 */
export function syncVaultGit({ action = 'both' } = {}) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error('当前本地库尚未初始化 Git，请先关联 Gitee 或 GitHub 私有仓库');
  }

  ensureGitIdentity(vaultPath);
  const { activeRemotes } = ensureConfiguredRemotes(vaultPath, config);

  if (activeRemotes.length === 0) {
    throw new Error('尚未配置 Gitee 或 GitHub 远程仓库地址');
  }

  try {
    runGitInVault(vaultPath, ['branch', '-M', 'main']);
  } catch {}

  const syncedProviders = [];
  const errors = [];

  if (action === 'pull' || action === 'both') {
    for (const remote of activeRemotes) {
      try {
        pullAndMergeRemoteMain(vaultPath, remote.name);
        if (!syncedProviders.includes(remote.label)) {
          syncedProviders.push(remote.label);
        }
      } catch (err) {
        errors.push(`${remote.label} 拉取提示: ${err.message}`);
      }
    }
  }

  let pushed = false;
  if (action === 'push' || action === 'both') {
    commitLocalVaultChanges(vaultPath, `backup: QuickMemo vault sync ${nowReadable()}`);
    for (const remote of activeRemotes) {
      try {
        runGitInVault(vaultPath, ['push', '-u', remote.name, 'main']);
        pushed = true;
        if (!syncedProviders.includes(remote.label)) {
          syncedProviders.push(remote.label);
        }
      } catch (pushErr) {
        const msg = String(pushErr.message || '');
        if (msg.includes('fetch first') || msg.includes('non-fast-forward') || msg.includes('[rejected]')) {
          try {
            pullAndMergeRemoteMain(vaultPath, remote.name);
            commitLocalVaultChanges(vaultPath, `backup: QuickMemo vault sync ${nowReadable()}`);
            runGitInVault(vaultPath, ['push', '-u', remote.name, 'main']);
            pushed = true;
            if (!syncedProviders.includes(remote.label)) {
              syncedProviders.push(remote.label);
            }
          } catch (retryErr) {
            errors.push(`${remote.label} 推送失败: ${retryErr.message}`);
          }
        } else {
          errors.push(`${remote.label} 推送失败: ${msg}`);
        }
      }
    }
  }

  if (syncedProviders.length === 0 && errors.length > 0) {
    throw new Error(errors.join('；'));
  }

  return {
    ok: true,
    action,
    pushed,
    syncedProviders,
    warnings: errors,
    syncedAt: nowReadable(),
    status: getVaultGitStatus()
  };
}

/**
 * 任何操作记录的动作（新增、修改、重新分类、重命名附件、删除）都自动推送到所有已配置的云端仓库（Gitee + GitHub）
 */
export function triggerAutoVaultGitSync() {
  const config = getConfig();
  const { activeRemotes } = ensureConfiguredRemotes(config.vaultPath, config);
  if (activeRemotes.length === 0) return;
  setTimeout(() => {
    try {
      syncVaultGit({ action: 'both' });
    } catch (err) {
      console.warn('[VaultSync] Auto sync warning:', err.message);
    }
  }, 200);
}
