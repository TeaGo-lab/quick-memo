import {
  getConfig,
  saveConfig,
  listMemos,
  saveMemosList,
  buildMarkdownContent,
  formatDateParts
} from './storage.js';

function utf8ToBase64(str = '') {
  const bytes = new TextEncoder().encode(String(str));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUtf8(b64 = '') {
  const clean = String(b64).replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function parseOwnerAndRepo(rawOwner = '', rawRepo = 'quick-memo-vault') {
  let owner = String(rawOwner || '').trim();
  let repo = String(rawRepo || 'quick-memo-vault').trim().replace(/\.git$/i, '');

  if (owner.includes('gitee.com/') || owner.includes('github.com/')) {
    const m = owner.match(/(?:gitee|github)\.com\/([^/]+)\/([^/.]+)(?:\.git)?/i);
    if (m) {
      owner = m[1];
      repo = m[2];
    }
  } else if (owner.includes('/')) {
    const parts = owner.split('/').filter(Boolean);
    if (parts.length >= 2) {
      owner = parts[0];
      repo = parts[1].replace(/\.git$/i, '');
    }
  }

  return {
    owner,
    repo: repo || 'quick-memo-vault'
  };
}

/**
 * 提取所有已配置的云端仓库列表（支持 Gitee 单平台、GitHub 单平台、或 Gitee + GitHub 双平台同时激活）
 */
export function getConfiguredCloudProviders(gitCfg = null) {
  const cfg = gitCfg || getConfig().vaultGit || {};
  const branch = String(cfg.branch || 'main').trim() || 'main';
  const providers = [];

  const giteeToken = String(cfg.giteeToken || (cfg.provider !== 'github' ? cfg.accessToken : '') || '').trim();
  const githubToken = String(cfg.githubToken || (cfg.provider === 'github' ? cfg.accessToken : '') || '').trim();

  if (giteeToken) {
    const { owner, repo } = parseOwnerAndRepo(
      cfg.giteeOwner || (cfg.provider !== 'github' ? cfg.repoOwner : ''),
      cfg.giteeRepo || cfg.repoName || 'quick-memo-vault'
    );
    providers.push({
      provider: 'gitee',
      label: 'Gitee 码云',
      token: giteeToken,
      owner,
      repo,
      branch
    });
  }

  if (githubToken) {
    const { owner, repo } = parseOwnerAndRepo(
      cfg.githubOwner || (cfg.provider === 'github' ? cfg.repoOwner : ''),
      cfg.githubRepo || cfg.repoName || 'quick-memo-vault'
    );
    providers.push({
      provider: 'github',
      label: 'GitHub',
      token: githubToken,
      owner,
      repo,
      branch
    });
  }

  return providers;
}

/**
 * 自动获取当前 Token 对应的 Gitee 或 GitHub 用户名，并在仓库不存在时自动创建私有库
 */
export async function ensurePrivateRepoExists(rawProviderInfo) {
  const info = { ...rawProviderInfo };
  if (!info.token) {
    throw new Error(`请先填写 ${info.provider === 'gitee' ? 'Gitee 私人令牌' : 'GitHub Personal Access Token'}`);
  }

  if (info.provider === 'gitee') {
    if (!info.owner) {
      const userRes = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(info.token)}&_t=${Date.now()}`, {
        cache: 'no-store'
      });
      if (!userRes.ok) throw new Error('Gitee 令牌无效或网络异常，请检查私人令牌');
      const userData = await userRes.json();
      info.owner = userData.login;
    }

    const checkRes = await fetch(
      `https://gitee.com/api/v5/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}?access_token=${encodeURIComponent(info.token)}&_t=${Date.now()}`,
      { cache: 'no-store' }
    );
    if (checkRes.status === 404) {
      const createRes = await fetch('https://gitee.com/api/v5/user/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          access_token: info.token,
          name: info.repo,
          description: 'QuickMemo 桌面端与安卓端同步私有知识库 (Obsidian Markdown)',
          private: true,
          auto_init: true
        })
      });
      if (!createRes.ok) {
        const err = await createRes.text().catch(() => '');
        throw new Error(`自动创建 Gitee 私有库失败: ${err.slice(0, 120)}`);
      }
    } else if (checkRes.ok) {
      const repoData = await checkRes.json();
      if (repoData.default_branch) info.branch = repoData.default_branch;
    }
  } else {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${info.token}`
    };
    if (!info.owner) {
      const userRes = await fetch('https://api.github.com/user', { headers, cache: 'no-store' });
      if (!userRes.ok) throw new Error('GitHub Token 无效，请检查权限（需勾选 repo 权限）');
      const userData = await userRes.json();
      info.owner = userData.login;
    }

    const checkRes = await fetch(`https://api.github.com/repos/${info.owner}/${info.repo}`, { headers, cache: 'no-store' });
    if (checkRes.status === 404) {
      const createRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: info.repo,
          description: 'QuickMemo 桌面端与安卓端同步私有知识库 (Obsidian Markdown)',
          private: true,
          auto_init: true
        })
      });
      if (!createRes.ok) {
        const err = await createRes.text().catch(() => '');
        throw new Error(`自动创建 GitHub 私有库失败: ${err.slice(0, 120)}`);
      }
    } else if (checkRes.ok) {
      const repoData = await checkRes.json();
      if (repoData.default_branch) info.branch = repoData.default_branch;
    }
  }

  return info;
}

async function getRemoteFile(info, filePath) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  if (info.provider === 'gitee') {
    const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${encodedPath}?access_token=${encodeURIComponent(info.token)}&ref=${encodeURIComponent(info.branch)}&_t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || Array.isArray(data) || !data.content) return null;
    return {
      sha: data.sha,
      content: base64ToUtf8(data.content)
    };
  } else {
    const url = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodedPath}?ref=${encodeURIComponent(info.branch)}&_t=${Date.now()}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${info.token}`
      }
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || Array.isArray(data) || !data.content) return null;
    return {
      sha: data.sha,
      content: base64ToUtf8(data.content)
    };
  }
}

async function putRemoteFile(info, filePath, utf8Content, message) {
  const existing = await getRemoteFile(info, filePath);
  const contentB64 = utf8ToBase64(utf8Content);
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

  if (info.provider === 'gitee') {
    const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${encodedPath}`;
    const method = existing?.sha ? 'PUT' : 'POST';
    const body = {
      access_token: info.token,
      content: contentB64,
      message,
      branch: info.branch
    };
    if (existing?.sha) {
      body.sha = existing.sha;
    }
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gitee 写入文件失败 (${filePath}): ${errText.slice(0, 120)}`);
    }
    return await res.json();
  } else {
    const url = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodedPath}`;
    const body = {
      message,
      content: contentB64,
      branch: info.branch
    };
    if (existing?.sha) {
      body.sha = existing.sha;
    }
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${info.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`GitHub 写入文件失败 (${filePath}): ${errText.slice(0, 120)}`);
    }
    return await res.json();
  }
}

async function deleteRemoteFile(info, filePath, message) {
  if (!filePath) return;
  const existing = await getRemoteFile(info, filePath);
  if (!existing?.sha) return;
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

  if (info.provider === 'gitee') {
    const url = `https://gitee.com/api/v5/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${encodedPath}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        access_token: info.token,
        sha: existing.sha,
        message: message || `📱 Android 删除闪念文件: ${filePath}`,
        branch: info.branch
      })
    }).catch(() => {});
  } else {
    const url = `https://api.github.com/repos/${info.owner}/${info.repo}/contents/${encodedPath}`;
    await fetch(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${info.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: message || `📱 Android 删除闪念文件: ${filePath}`,
        sha: existing.sha,
        branch: info.branch
      })
    }).catch(() => {});
  }
}

function saveResolvedProviderMeta(gitCfg, resolvedProviders, nowStr) {
  const nextGit = { ...gitCfg, lastSyncedAt: nowStr, autoSync: true };
  for (const p of resolvedProviders) {
    if (p.provider === 'gitee') {
      nextGit.giteeOwner = p.owner;
      nextGit.giteeRepo = p.repo;
      nextGit.giteeToken = p.token;
    } else if (p.provider === 'github') {
      nextGit.githubOwner = p.owner;
      nextGit.githubRepo = p.repo;
      nextGit.githubToken = p.token;
    }
  }
  saveConfig({ vaultGit: nextGit });
}

/**
 * 从云端私有库 (Gitee / GitHub) 拉取最新笔记索引：
 * 1. 完全以云端为主（云端已删除的记录会从手机本地缓存中清理移除）；
 * 2. 若 Gitee 和 GitHub 同时配置，并发拉取并确保双端索引一致。
 */
export async function pullFromCloudVault(gitOverride = null) {
  const cfg = getConfig();
  const gitCfg = gitOverride || cfg.vaultGit;
  const rawProviders = getConfiguredCloudProviders(gitCfg);

  if (rawProviders.length === 0) {
    throw new Error('尚未配置 Gitee 或 GitHub 私人令牌，请先在「设置与协议」中填写');
  }

  const settled = await Promise.allSettled(
    rawProviders.map(async (p) => {
      const info = await ensurePrivateRepoExists(p);
      const indexFile = await getRemoteFile(info, '.quick-memo-index.json');
      let memos = null;
      if (indexFile?.content) {
        try {
          const parsed = JSON.parse(indexFile.content);
          if (Array.isArray(parsed)) memos = parsed;
        } catch {}
      }
      return { info, memos };
    })
  );

  const succeeded = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      succeeded.push(item.value);
    } else {
      errors.push(item.reason?.message || '同步异常');
    }
  }

  if (succeeded.length === 0) {
    throw new Error(errors.join('；') || '连接云端私有仓库失败');
  }

  const resolvedInfos = succeeded.map((s) => s.info);
  const syncedProviders = resolvedInfos.map((i) => `${i.label} (${i.owner}/${i.repo})`);
  const syncedShortLabels = resolvedInfos.map((i) => i.label);

  // 选择云端权威索引（优先取包含有效索引的平台）
  const withIndex = succeeded.filter((s) => Array.isArray(s.memos));
  const localMemos = listMemos();

  if (withIndex.length === 0) {
    const nowStr = formatDateParts().fullStr;
    saveResolvedProviderMeta(gitCfg, resolvedInfos, nowStr);
    return {
      ok: true,
      pulledCount: 0,
      mergedCount: localMemos.length,
      syncedProviders,
      syncedShortLabels,
      syncedAt: nowStr,
      message: '远程私有仓库已就绪（云端暂无索引，将自动上传手机记录）'
    };
  }

  // 以云端最新索引作为权威数据源
  const primaryRemoteMemos = withIndex[0].memos;
  const mergedMap = new Map();
  for (const rm of primaryRemoteMemos) {
    if (rm && rm.id) {
      mergedMap.set(rm.id, { ...rm, unsyncedLocal: false });
    }
  }

  // 仅保留手机端刚刚新建且尚未推送上云的本地记录 (unsyncedLocal === true)
  // 云端已删除的旧记录不再从手机本地缓存复活
  let hasUnsyncedLocal = false;
  for (const lm of localMemos) {
    if (lm && lm.id && lm.unsyncedLocal === true && !mergedMap.has(lm.id)) {
      mergedMap.set(lm.id, lm);
      hasUnsyncedLocal = true;
    }
  }

  const mergedList = Array.from(mergedMap.values()).sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  );

  saveMemosList(mergedList);
  const nowStr = formatDateParts().fullStr;
  saveResolvedProviderMeta(gitCfg, resolvedInfos, nowStr);

  // 如果手机有未同步的新记录，或者双云端（Gitee 与 GitHub）之间条目数不一致，自动将合并后的权威索引同步对齐到所有已配置云端
  const dualOutOfSync = withIndex.length > 1 && withIndex.some((w) => w.memos.length !== mergedList.length);
  if (hasUnsyncedLocal || dualOutOfSync) {
    pushToCloudVault(gitCfg).catch((err) => console.warn('[CloudSync] Reconcile push warning:', err));
  }

  return {
    ok: true,
    pulledCount: primaryRemoteMemos.length,
    mergedCount: mergedList.length,
    syncedProviders,
    syncedShortLabels,
    owner: resolvedInfos[0].owner,
    repo: resolvedInfos[0].repo,
    syncedAt: nowStr
  };
}

/**
 * 将手机端的闪念记录（含 .md 文件与 .quick-memo-index.json）推送到云端私有仓库
 * 若同时配置了 Gitee 和 GitHub，将同时并发推送更新到两个云端仓库！
 */
export async function pushToCloudVault(gitOverride = null, singleMemo = null, skipPrePull = false) {
  const cfg = getConfig();
  const gitCfg = gitOverride || cfg.vaultGit;
  const rawProviders = getConfiguredCloudProviders(gitCfg);

  if (rawProviders.length === 0) {
    throw new Error('尚未配置 Gitee 或 GitHub 私人令牌，请先在「设置与协议」中填写');
  }

  // 1. 先从云端拉取最新状态合并（除非是刚拉取过），防止覆盖云端其它设备的最新修改
  if (!skipPrePull) {
    try {
      await pullFromCloudVault(gitCfg);
    } catch {}
  }

  const allMemos = listMemos().map((m) => ({ ...m, unsyncedLocal: false }));
  saveMemosList(allMemos);

  const memosToWrite = singleMemo ? [{ ...singleMemo, unsyncedLocal: false }] : allMemos.slice(0, 8);
  const indexJson = JSON.stringify(allMemos, null, 2);

  // 2. 同时向所有已配置的云端平台（Gitee + GitHub）写入 .md 文件与 .quick-memo-index.json
  const settled = await Promise.allSettled(
    rawProviders.map(async (p) => {
      const info = await ensurePrivateRepoExists(p);
      for (const memo of memosToWrite) {
        if (!memo || !memo.mdRelPath) continue;
        const mdText = buildMarkdownContent(memo);
        await putRemoteFile(
          info,
          memo.mdRelPath,
          mdText,
          `📱 Android 同步闪念: ${memo.title}`
        );
      }
      await putRemoteFile(
        info,
        '.quick-memo-index.json',
        indexJson,
        `📱 Android 更新闪念索引 (${allMemos.length} 条)`
      );
      return info;
    })
  );

  const resolvedInfos = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') {
      resolvedInfos.push(item.value);
    } else {
      errors.push(item.reason?.message || '推送异常');
    }
  }

  if (resolvedInfos.length === 0) {
    throw new Error(errors.join('；') || '推送云端私有仓库失败');
  }

  const nowStr = formatDateParts().fullStr;
  saveResolvedProviderMeta(gitCfg, resolvedInfos, nowStr);

  return {
    ok: true,
    pushedTotal: allMemos.length,
    syncedProviders: resolvedInfos.map((i) => `${i.label} (${i.owner}/${i.repo})`),
    syncedShortLabels: resolvedInfos.map((i) => i.label),
    owner: resolvedInfos[0].owner,
    repo: resolvedInfos[0].repo,
    syncedAt: nowStr
  };
}

/**
 * 手机端删除记录后，立即同步更新所有已配置的云端仓库（Gitee + GitHub）：
 * 同时删除云端对应的 .md 文件并更新 .quick-memo-index.json
 */
export async function syncDeleteToRemote(deletedId, deletedMemo = null) {
  const cfg = getConfig();
  const rawProviders = getConfiguredCloudProviders(cfg.vaultGit);
  if (rawProviders.length === 0) return;

  const remaining = listMemos()
    .filter((m) => m.id !== deletedId)
    .map((m) => ({ ...m, unsyncedLocal: false }));
  saveMemosList(remaining);
  const indexJson = JSON.stringify(remaining, null, 2);

  await Promise.allSettled(
    rawProviders.map(async (p) => {
      const info = await ensurePrivateRepoExists(p);
      if (deletedMemo?.mdRelPath) {
        await deleteRemoteFile(info, deletedMemo.mdRelPath, `📱 Android 删除闪念: ${deletedMemo.title || deletedId}`);
      }
      await putRemoteFile(
        info,
        '.quick-memo-index.json',
        indexJson,
        `📱 Android 删除记录同步 (${remaining.length} 条)`
      );
    })
  );
}

/**
 * 以云端为主（Cloud-First）刷新同步：
 * 打开应用、下拉刷新或点击刷新按钮时，直接与所有已配置的云端仓库（Gitee / GitHub）同步最新状态
 */
export async function refreshAndSyncVault() {
  const beforeMemos = listMemos();
  const beforeIds = new Set(beforeMemos.map((m) => m.id));
  const cfg = getConfig();
  const rawProviders = getConfiguredCloudProviders(cfg.vaultGit);

  if (rawProviders.length === 0) {
    throw new Error('尚未配置 Gitee 或 GitHub 云端令牌，请前往「设置与协议」配置以开启自动云同步');
  }

  const cloudRes = await pullFromCloudVault(cfg.vaultGit);
  const afterMemos = listMemos();
  const afterIds = new Set(afterMemos.map((m) => m.id));

  let addedCount = 0;
  let removedCount = 0;
  for (const m of afterMemos) {
    if (!beforeIds.has(m.id)) addedCount++;
  }
  for (const oldId of beforeIds) {
    if (!afterIds.has(oldId)) removedCount++;
  }

  const nowStr = formatDateParts().timeStr;
  const sourceText = `☁️ ${(cloudRes.syncedShortLabels || ['云端']).join(' + ')}`;
  let msg = '';
  if (addedCount > 0 && removedCount > 0) {
    msg = `✅ 已同步 ${sourceText}：新增 ${addedCount} 条，清理已删记录 ${removedCount} 条（共 ${afterMemos.length} 条）`;
  } else if (removedCount > 0) {
    msg = `✅ 已同步 ${sourceText}：已清理云端删除记录 ${removedCount} 条（共 ${afterMemos.length} 条）`;
  } else if (addedCount > 0) {
    msg = `✅ 已同步 ${sourceText}：新增 ${addedCount} 条记录（共 ${afterMemos.length} 条）`;
  } else {
    msg = `✅ 已与 ${sourceText} 同步最新状态（共 ${afterMemos.length} 条记录 · ${nowStr}）`;
  }

  return {
    ok: true,
    totalCount: afterMemos.length,
    addedCount,
    removedCount,
    sourceText,
    message: msg
  };
}
