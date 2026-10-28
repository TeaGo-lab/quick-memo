// 统一系统桥接层：自动适配 Tauri (.exe 原生桌面端) 与 Node 本地服务模式

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

async function tauriInvoke(cmd, args = {}) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

/**
 * 在 Tauri 原生模式下直接请求 OpenAI 兼容接口（或回退本地规则）
 */
export function heuristicClassifyClient({ content = '', attachments = [], categories = [] }) {
  const text = String(content || '').trim();
  const hasImage = attachments.some((a) => (a.mimeType || '').startsWith('image/'));
  const hasDoc = attachments.some((a) => !(a.mimeType || '').startsWith('image/'));
  const validCatIds = new Set(categories.map((c) => c.id));
  const pickCat = (preferred, fallback = '99-收件箱') =>
    validCatIds.has(preferred) ? preferred : (categories[0]?.id || fallback);

  let category = pickCat('01-灵感与备忘');
  const tags = new Set();

  if (hasDoc) {
    category = pickCat('06-资料与文档');
    tags.add('文档归档');
    for (const att of attachments) {
      const ext = (att.name || '').split('.').pop()?.toUpperCase();
      if (ext && ext.length <= 6) tags.add(ext);
    }
  } else if (hasImage && text.length < 30) {
    category = pickCat('05-截图与视觉');
    tags.add('截图');
  }

  const urlMatch = text.match(/https?:\/\/[^\s)]+/i);
  if (urlMatch) {
    category = pickCat('03-精读与链接');
    tags.add('网页链接');
    try {
      const u = new URL(urlMatch[0]);
      tags.add(u.hostname.replace(/^www\./, ''));
    } catch {
      // ignore
    }
  }

  const codeIndicators = /```|function\s+\w+|const\s+\w+\s*=|import\s+.*from|def\s+\w+\(|SELECT\s+.*FROM|npm\s+install|git\s+(clone|commit|push)|docker\s+(run|build)|pip\s+install/i;
  if (codeIndicators.test(text)) {
    category = pickCat('02-技术与代码');
    tags.add('代码片段');
  }

  const todoIndicators = /待办|TODO|截止|会议|周报|合同|发票|报销|客户|排期|明天|下周|记得/i;
  if (todoIndicators.test(text)) {
    category = pickCat('04-工作与待办');
    tags.add('待办事项');
  }

  let title = '随手记录';
  if (text) {
    const firstLine = text.split(/\r?\n/).map((l) => l.replace(/^[#>*-\s]+/, '').trim()).find(Boolean) || '';
    title = firstLine.slice(0, 28) || '随手记录';
  } else if (attachments.length > 0) {
    title = `${hasImage ? '图片记录' : '文件归档'}：${attachments[0].name}`;
  }

  let summary = text.length > 35
    ? text.replace(/\s+/g, ' ').slice(0, 80) + (text.length > 80 ? '...' : '')
    : (text || `包含 ${attachments.length} 个附件`);

  if (tags.size === 0) tags.add('随手记');

  return {
    category,
    title,
    summary,
    tags: Array.from(tags).slice(0, 5),
    aiClassified: false
  };
}

async function classifyInClient({ content = '', attachments = [], config }) {
  const categories = config.categories || [];
  const llmCfg = config.llm || {};
  if (!llmCfg.enabled || !llmCfg.apiKey || !llmCfg.baseUrl) {
    return heuristicClassifyClient({ content, attachments, categories });
  }

  const categoryListDesc = categories.map((c) => `- "${c.id}": ${c.name}（${c.desc || ''}）`).join('\n');
  const attachmentDesc = attachments.length > 0
    ? attachments.map((a) => `${a.name} (${a.mimeType || '未知类型'})`).join(', ')
    : '无附件';

  const systemPrompt = `你是一个高效的个人知识库与剪贴板整理助手。请根据用户随手丢进来的内容，将其精准归入以下分类目录之一，并生成便于检索的标题、一句话摘要和标签。
可选分类目录（category 必须严格返回引号内的目录 id）：
${categoryListDesc}
${llmCfg.customSystemPrompt ? `用户补充偏好：\n${llmCfg.customSystemPrompt}\n` : ''}
请严格只输出合法的 JSON 对象，格式如下：
{"category":"目录id","title":"10~25字清晰中文标题","summary":"30~70字核心提炼","tags":["标签1","标签2"]}`;

  try {
    const endpoint = `${llmCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmCfg.apiKey}`
      },
      body: JSON.stringify({
        model: llmCfg.model || 'deepseek-chat',
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `【正文】：\n${content || '（无正文）'}\n【附件】：${attachmentDesc}` }
        ]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid JSON');
    const parsed = JSON.parse(match[0]);
    const validIds = new Set(categories.map((c) => c.id));
    const fallback = heuristicClassifyClient({ content, attachments, categories });
    return {
      category: validIds.has(parsed.category) ? parsed.category : fallback.category,
      title: String(parsed.title || '').trim() || fallback.title,
      summary: String(parsed.summary || '').trim() || fallback.summary,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean) : fallback.tags,
      aiClassified: true
    };
  } catch (err) {
    const fallback = heuristicClassifyClient({ content, attachments, categories });
    return { ...fallback, errorWarning: err.message };
  }
}

export const Bridge = {
  async getConfig() {
    if (isTauri()) {
      try {
        return await tauriInvoke('get_config');
      } catch {
        // 如果是在 tauri dev 且连着 vite server，可平滑回退到 /api/config
      }
    }
    return apiRequest('/api/config');
  },

  async saveConfig(newConfig) {
    if (isTauri()) {
      try {
        return await tauriInvoke('save_config', { newConfig });
      } catch {
        // fallback
      }
    }
    return apiRequest('/api/config', {
      method: 'POST',
      body: JSON.stringify(newConfig)
    });
  },

  async getAutoStart() {
    return apiRequest('/api/autostart');
  },

  async setAutoStart(payload = {}) {
    return apiRequest('/api/autostart', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async listMemos() {
    if (isTauri()) {
      try {
        return await tauriInvoke('list_memos');
      } catch {
        // fallback
      }
    }
    return apiRequest('/api/memos');
  },

  async quickSaveMemo(payload) {
    if (isTauri()) {
      try {
        const config = await this.getConfig();
        const attachmentsMeta = (payload.rawAttachments || []).map((a) => ({
          name: a.name,
          mimeType: a.mimeType
        }));
        const classification = payload.manualCategory
          ? {
              ...heuristicClassifyClient({ content: payload.content, attachments: attachmentsMeta, categories: config.categories }),
              category: payload.manualCategory
            }
          : await classifyInClient({ content: payload.content, attachments: attachmentsMeta, config });

        const saved = await tauriInvoke('save_memo', {
          payload: {
            content: payload.content || '',
            rawAttachments: payload.rawAttachments || [],
            category: payload.manualCategory || classification.category,
            title: payload.manualTitle || classification.title,
            summary: classification.summary,
            tags: classification.tags,
            aiClassified: classification.aiClassified
          }
        });
        return { memo: saved, classification };
      } catch {
        // fallback to local server if in tauri dev
      }
    }
    return apiRequest('/api/memos/quick-save', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async reclassifyMemo(id) {
    if (isTauri()) {
      try {
        const config = await this.getConfig();
        const memos = await this.listMemos();
        const target = memos.find((m) => m.id === id);
        if (!target) throw new Error('找不到记录');
        const classification = await classifyInClient({
          content: target.content,
          attachments: target.attachments || [],
          config
        });
        const updated = await tauriInvoke('update_memo', {
          id,
          patch: {
            category: classification.category,
            title: classification.title,
            summary: classification.summary,
            tags: classification.tags,
            aiClassified: classification.aiClassified
          }
        });
        return { memo: updated, classification };
      } catch {
        // fallback
      }
    }
    return apiRequest('/api/memos/reclassify', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
  },

  async updateMemo(id, patch) {
    if (isTauri()) {
      try {
        const memo = await tauriInvoke('update_memo', { id, patch });
        return { memo };
      } catch {
        // fallback
      }
    }
    return apiRequest('/api/memos/update', {
      method: 'POST',
      body: JSON.stringify({ id, patch })
    });
  },

  async renameAttachment(id, attIndex, newName) {
    return apiRequest('/api/memos/rename-attachment', {
      method: 'POST',
      body: JSON.stringify({ id, attIndex, newName })
    });
  },

  async deleteMemo(id) {
    if (isTauri()) {
      try {
        return await tauriInvoke('delete_memo', { id });
      } catch {
        // fallback
      }
    }
    return apiRequest('/api/memos/delete', {
      method: 'POST',
      body: JSON.stringify({ id })
    });
  },

  async openInExplorer(targetPath = '') {
    if (isTauri()) {
      try {
        return await tauriInvoke('open_in_explorer', { targetPath });
      } catch {
        // fallback
      }
    }
    return apiRequest('/api/open-explorer', {
      method: 'POST',
      body: JSON.stringify({ path: targetPath })
    });
  },

  getAssetUrl(absPath) {
    if (!absPath) return '';
    return `/api/asset?path=${encodeURIComponent(absPath)}`;
  },

  async sendWindowCommand(cmd) {
    return apiRequest('/api/window-cmd', {
      method: 'POST',
      body: JSON.stringify({ cmd })
    });
  },

  async testLlmConnection(llm) {
    return apiRequest('/api/llm/test', {
      method: 'POST',
      body: JSON.stringify({ llm })
    });
  },

  async smartRenameFile(attachment, noteText = '') {
    return apiRequest('/api/files/smart-rename', {
      method: 'POST',
      body: JSON.stringify({ attachment, noteText })
    });
  },

  async precheckMemo(payload) {
    return apiRequest('/api/memos/precheck', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async getIndexStatus() {
    return apiRequest('/api/index/status');
  },

  async rebuildIndex() {
    return apiRequest('/api/index/rebuild', {
      method: 'POST'
    });
  },

  async askChat(message, history = []) {
    return apiRequest('/api/chat/ask', {
      method: 'POST',
      body: JSON.stringify({ message, history })
    });
  },

  async exportVaultZip() {
    return apiRequest('/api/vault/export-zip', {
      method: 'POST'
    });
  },

  async getVaultGitStatus() {
    return apiRequest('/api/vault/git-status');
  },

  async linkVaultGit(payload) {
    return apiRequest('/api/vault/git-link', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async syncVaultGit(action = 'push') {
    return apiRequest('/api/vault/git-sync', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
  },

  async getAppInfo() {
    return apiRequest('/api/app/info');
  },

  async checkReleaseUpdate() {
    return apiRequest('/api/app/check-update');
  },

  async performReleaseUpdate(autoRestart = true) {
    return apiRequest('/api/app/perform-update', {
      method: 'POST',
      body: JSON.stringify({ autoRestart })
    });
  }
};
