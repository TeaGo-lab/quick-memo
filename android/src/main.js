import {
  getConfig,
  saveConfig,
  listMemos,
  saveMemosList,
  clearLocalMemosCache,
  saveMemo,
  updateMemo,
  deleteMemo,
  getAttachmentData,
  detectSecretKeyClient,
  precheckMemo,
  downloadMarkdownFile,
  formatBytes,
  LLM_PRESETS
} from './storage.js';
import {
  classifyWithLLM,
  testLlmConnection,
  askMobileVaultAssistant
} from './ai-service.js';
import {
  pullFromCloudVault,
  pushToCloudVault,
  refreshAndSyncVault,
  syncDeleteToRemote,
  getConfiguredCloudProviders
} from './cloud-sync.js';
import appIconUrl from './assets/icon.png';
import alipayQrUrl from './assets/2dd30f48913ba3d796b3578f4484b6c8.jpg';
import wechatQrUrl from './assets/379e7960a912f6a825bec9003ffcdf9f.png';

const TYPE_META = {
  all: { label: '全部', icon: '✦' },
  text: { label: '笔记', icon: '📝' },
  link: { label: '链接', icon: '🔗' },
  code: { label: '代码/Key', icon: '💻' },
  image: { label: '图片', icon: '🖼️' },
  file: { label: '文档', icon: '📎' }
};

const state = {
  activeTab: 'capture', // 'capture' | 'vault' | 'chat' | 'settings'
  config: getConfig(),
  memos: listMemos(),
  saving: false,

  // 速记草稿状态
  draftContent: '',
  draftManualCategory: '',
  draftAttachments: [], // [{ id, name, mimeType, size, dataBase64 }]
  lastSavedToast: null,
  precheckModal: null,

  // 知识库筛选与详情抽屉状态
  selectedCategory: 'ALL',
  selectedType: 'all',
  selectedTag: '',
  searchQuery: '',
  detailMemoId: null,
  detailAttachmentUrls: {}, // { attId: dataBase64 }

  // 寻物对话状态
  chatDraft: '',
  chatLoading: false,
  chatMessages: [],

  // 设置与云同步状态
  llmTesting: false,
  llmTestFeedback: null,
  gitSyncing: false,
  gitFeedback: null,
  refreshToast: null, // { ok: true, text: '...' }
  qrPreviewModal: null
};

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMarkdown(escapedLine = '') {
  return escapedLine
    .replace(/`([^`\n]+)`/g, '<code class="m-inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="m-md-link">$1</a>');
}

function formatMarkdownHtml(raw = '') {
  const codeBlocks = [];
  const withPlaceholders = String(raw || '').replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const cleanCode = String(code || '').replace(/\r?\n$/, '');
    const idx = codeBlocks.length;
    const langLabel = (lang || '').trim().toUpperCase() || 'CODE / KEY';
    codeBlocks.push(`
      <div class="m-code-block">
        <div class="m-code-bar">
          <span>${escapeHtml(langLabel)}</span>
          <button type="button" class="m-copy-btn" data-copy-text="${escapeHtml(cleanCode)}">📋 复制</button>
        </div>
        <pre><code>${escapeHtml(cleanCode)}</code></pre>
      </div>
    `);
    return `\n@@CODE_${idx}@@\n`;
  });

  const lines = withPlaceholders.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const cm = trimmed.match(/^@@CODE_(\d+)@@$/);
    if (cm) {
      out.push(codeBlocks[Number(cm[1])] || '');
      continue;
    }
    if (!trimmed) {
      out.push('<div class="m-md-spacer"></div>');
      continue;
    }
    const esc = escapeHtml(line);
    if (/^#{1,4}\s+(.+)$/.test(esc)) {
      out.push(`<div class="m-md-heading">${formatInlineMarkdown(esc.replace(/^#{1,4}\s+/, ''))}</div>`);
    } else if (/^\s*[-*•]\s+(.+)$/.test(esc)) {
      out.push(`<div class="m-md-li">• ${formatInlineMarkdown(esc.replace(/^\s*[-*•]\s+/, ''))}</div>`);
    } else {
      out.push(`<div class="m-md-p">${formatInlineMarkdown(esc)}</div>`);
    }
  }
  return out.join('');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addFilesToDraft(fileList) {
  for (const file of Array.from(fileList)) {
    const dataBase64 = await fileToBase64(file);
    const origName = file.name || `手机图片_${Date.now().toString().slice(-6)}.jpg`;
    state.draftAttachments.push({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: origName,
      mimeType: file.type || 'application/octet-stream',
      size: file.size || 0,
      dataBase64
    });
  }
  render();

}

async function openMemoDetail(memoId) {
  state.detailMemoId = memoId;
  state.detailAttachmentUrls = {};
  render();


  const memo = state.memos.find((m) => m.id === memoId);
  if (memo && Array.isArray(memo.attachments) && memo.attachments.length > 0) {
    for (const att of memo.attachments) {
      if (att.id) {
        const b64 = await getAttachmentData(att.id);
        if (b64) {
          state.detailAttachmentUrls[att.id] = b64;
        }
      }
    }
    render();

  }
}

function triggerAutoCloudPush(singleMemo = null) {
  const providers = getConfiguredCloudProviders(state.config?.vaultGit);
  if (providers.length === 0) return;
  pushToCloudVault(null, singleMemo)
    .then((res) => {
      state.config = getConfig();
      state.memos = listMemos();
      state.refreshToast = {
        ok: true,
        text: `☁️ 已自动同步至 ${(res.syncedShortLabels || ['云端']).join(' + ')}（共 ${res.pushedTotal} 条）`
      };
      render();
      setTimeout(() => {
        if (state.refreshToast) {
          state.refreshToast = null;
          render();
        }
      }, 2800);
    })
    .catch((err) => console.warn('[AutoCloudSync]', err));
}

async function handlePullToRefresh() {
  if (state.gitSyncing) return;
  state.gitSyncing = true;
  state.refreshToast = null;
  render();

  try {
    const res = await refreshAndSyncVault();
    state.memos = listMemos();
    state.config = getConfig();
    state.refreshToast = {
      ok: true,
      text: res.message
    };
  } catch (err) {
    state.refreshToast = {
      ok: false,
      text: `⚠️ 刷新提示：${err.message}`
    };
  } finally {
    state.gitSyncing = false;
    render();
    setTimeout(() => {
      if (state.refreshToast) {
        state.refreshToast = null;
        render();
      }
    }, 3000);
  }
}

function bindPullToRefreshGesture() {
  if (state.activeTab !== 'capture' && state.activeTab !== 'vault') return;

  const pageEl = document.querySelector('.m-page');
  const recentZone = document.getElementById('m-recent-pull-zone');
  const banner = document.getElementById('m-ptr-banner');
  const textEl = document.getElementById('m-ptr-text');
  if (!pageEl || !banner) return;

  let startY = 0;
  let pulling = false;
  let pullDistance = 0;
  const THRESHOLD = 52;

  const attachZone = (zoneEl, allowAnywhereWhenPageAtTop = true) => {
    if (!zoneEl) return;

    zoneEl.addEventListener('touchstart', (e) => {
      if (state.gitSyncing || e.touches.length !== 1) return;
      const target = e.target;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT')) {
        return;
      }
      // 在随手记的「最近随手记」列表上往下拉，或者整个页面位于顶部时往下拉均可触发
      const isRecentListZone = zoneEl.id === 'm-recent-pull-zone';
      if (!isRecentListZone && allowAnywhereWhenPageAtTop && pageEl.scrollTop > 6) {
        return;
      }
      startY = e.touches[0].clientY;
      pulling = true;
      pullDistance = 0;
    }, { passive: true });

    zoneEl.addEventListener('touchmove', (e) => {
      if (!pulling || state.gitSyncing) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 6) {
        if (pullDistance > 0) {
          pullDistance = 0;
          banner.style.height = '0px';
          banner.style.opacity = '0';
        }
        return;
      }
      // 如果不是在最近列表区直接拉，且页面还没滚到顶，则不拦截正常滚动
      if (zoneEl.id !== 'm-recent-pull-zone' && pageEl.scrollTop > 6) {
        pulling = false;
        return;
      }
      pullDistance = Math.min(90, Math.round(dy * 0.55));
      if (pullDistance > 10) {
        if (e.cancelable) e.preventDefault();
        banner.style.height = `${Math.min(50, pullDistance)}px`;
        banner.style.opacity = String(Math.min(1, pullDistance / 36));
        if (textEl) {
          textEl.textContent = pullDistance >= THRESHOLD
            ? '↑ 松开立即同步电脑与云端最新记录'
            : '↓ 继续下拉同步最新记录...';
        }
      }
    }, { passive: false });

    const onEnd = () => {
      if (!pulling) return;
      pulling = false;
      if (pullDistance >= THRESHOLD) {
        pullDistance = 0;
        handlePullToRefresh();
      } else {
        pullDistance = 0;
        banner.style.height = '0px';
        banner.style.opacity = '0';
      }
    };

    zoneEl.addEventListener('touchend', onEnd, { passive: true });
    zoneEl.addEventListener('touchcancel', onEnd, { passive: true });
  };

  if (state.activeTab === 'capture' && recentZone) {
    attachZone(recentZone, false);
    attachZone(pageEl, true);
  } else if (state.activeTab === 'vault') {
    attachZone(pageEl, true);
  }
}

async function handleSubmitCapture(options = {}) {
  const { forceSave = false, extraNote = '' } = options;
  let content = state.draftContent.trim();
  const rawAttachments = state.draftAttachments;
  if (!content && rawAttachments.length === 0) return;
  if (state.saving) return;

  if (extraNote.trim()) {
    content = `【${extraNote.trim()}】\n${content}`;
    state.draftContent = content;
  }

  if (!forceSave) {
    const check = precheckMemo({ content, rawAttachments });
    if (check.hasDuplicate || check.keyReminder?.needsNote) {
      state.precheckModal = {
        duplicates: check.duplicates || [],
        keyReminder: check.keyReminder || null,
        noteDraft: ''
      };
      render();

      return;
    }
  }

  state.precheckModal = null;
  state.saving = true;
  render();


  try {
    const llmResult = await classifyWithLLM({
      content,
      attachments: rawAttachments
    });
    const classification = state.draftManualCategory
      ? { ...llmResult, category: state.draftManualCategory }
      : llmResult;

    const saved = await saveMemo({
      content,
      rawAttachments,
      category: classification.category,
      title: classification.title,
      summary: classification.summary,
      tags: classification.tags,
      aiClassified: classification.aiClassified
    });

    state.memos = listMemos();
    state.draftContent = '';
    state.draftAttachments = [];
    state.draftManualCategory = '';
    state.lastSavedToast = {
      memo: saved,
      classification
    };

    // 任何新增记录动作都自动推送到所有已配置的云端仓库 (Gitee / GitHub)
    triggerAutoCloudPush(saved);
  } catch (err) {
    alert(`归档失败：${err.message}`);
  } finally {
    state.saving = false;
    render();

  }
}

function getFilteredMemos() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.memos.filter((m) => {
    if (state.selectedCategory !== 'ALL' && m.category !== state.selectedCategory) return false;
    if (state.selectedType !== 'all' && m.type !== state.selectedType) return false;
    if (state.selectedTag && !(m.tags || []).includes(state.selectedTag)) return false;
    if (q) {
      const hay = [
        m.title,
        m.summary,
        m.content,
        m.category,
        ...(m.tags || []),
        ...(m.attachments || []).map((a) => a.name)
      ].join(' ').toLowerCase();
      return hay.includes(q);
    }
    return true;
  });
}

function renderTopHeader() {
  const llmReady = Boolean(state.config?.llm?.enabled && state.config?.llm?.apiKey);
  const providers = getConfiguredCloudProviders(state.config?.vaultGit);
  const gitReady = providers.length > 0;
  let gitChipLabel = '⚠️ 未绑云库';
  if (providers.length >= 2) {
    gitChipLabel = '☁️ Gitee+GitHub';
  } else if (providers.length === 1) {
    gitChipLabel = `☁️ ${providers[0].provider === 'github' ? 'GitHub' : 'Gitee'}`;
  }

  return `
    <header class="m-topbar">
      <div class="m-brand" id="btn-top-brand">
        <img src="${escapeHtml(appIconUrl)}" class="m-brand-logo" alt="QuickMemo" />
        <div class="m-brand-text">
          <div class="m-brand-title">QuickMemo <span class="m-android-badge">Android</span></div>
          <div class="m-brand-sub">闪念 AI 收纳盒 · 严禁商用</div>
        </div>
      </div>

      <div class="m-top-pills">
        <button type="button" class="m-status-chip ${gitReady ? 'sync-on' : 'sync-off'}" id="btn-top-sync" title="点击立即同步云端仓库">
          ${state.gitSyncing ? '⏳ 同步中' : gitChipLabel}
        </button>
        <button type="button" class="m-status-chip ${llmReady ? 'ai-on' : 'ai-off'}" id="btn-top-ai">
          ${llmReady ? '✨ AI 就绪' : '⚠️ 未配 AI'}
        </button>
      </div>
    </header>
  `;
}

function renderSetupReminderBanner() {
  const llmReady = Boolean(state.config?.llm?.enabled && state.config?.llm?.apiKey);
  const providers = getConfiguredCloudProviders(state.config?.vaultGit);
  const gitReady = providers.length > 0;
  if (llmReady && gitReady) return '';

  return `
    <div style="background:linear-gradient(90deg,#fffbeb,#fef3c7);border-bottom:1px solid #fde68a;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;color:#92400e;flex-shrink:0;">
      <div style="flex:1;min-width:180px;line-height:1.4;">
        <strong>🔔 待配置提醒：</strong>
        ${!gitReady ? '尚未设置 <strong>Gitee 或 GitHub 云端同步</strong>（无法自动同步云端）' : ''}
        ${!gitReady && !llmReady ? ' · ' : ''}
        ${!llmReady ? '尚未设置 <strong>AI 大模型 Key</strong>' : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        ${!gitReady ? `<button type="button" class="m-quick-chip" id="btn-m-remind-git" style="background:#d97706;color:#fff;border:none;">☁️ 去配云端</button>` : ''}
        ${!llmReady ? `<button type="button" class="m-quick-chip" id="btn-m-remind-ai" style="background:#2563eb;color:#fff;border:none;">🤖 去配 AI</button>` : ''}
      </div>
    </div>
  `;
}

function renderMobileKeyHintBox() {
  const liveKey = detectSecretKeyClient(state.draftContent);
  if (!liveKey.needsNote) return '';
  const quickKeyNotes = ['DeepSeek API Key', '硅基流动 Key', 'OpenAI Key', '阿里云百炼 Key', 'GitHub Token', '账号密码'];
  return `
    <div class="m-key-hint-box" id="m-key-hint-box">
      <div class="m-key-hint-title">🔑 检测到 ${escapeHtml(liveKey.keyType)}，点下方标签秒加备注：</div>
      <div class="m-chip-scroll">
        ${quickKeyNotes.map((tag) => `
          <button type="button" class="m-quick-chip" data-insert-key-note="${escapeHtml(tag)}">+ ${escapeHtml(tag)}</button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderCaptureTab() {
  const categories = state.config?.categories || [];
  const recentMemos = state.memos.slice(0, 8);

  return `
    <main class="m-page">
      <section class="m-capture-card">
        <div class="m-capture-head">
          <span class="m-pulse-dot"></span>
          <span>随手粘贴文字、网址、API Key，或拍照/选文件归档</span>
        </div>

        <textarea
          id="m-capture-textarea"
          class="m-capture-textarea"
          rows="5"
          placeholder="像发给微信“文件传输助手”一样随手粘贴文字、链接、密钥或灵感...&#10;AI 会自动起标题、提炼摘要并归入分类文件夹，支持一键同步到电脑端！"
        >${escapeHtml(state.draftContent)}</textarea>

        <div id="m-key-hint-slot">
          ${renderMobileKeyHintBox()}
        </div>

        ${state.draftAttachments.length > 0 ? `
          <div class="m-draft-atts">
            ${state.draftAttachments.map((att) => `
              <div class="m-draft-att-item">
                ${att.mimeType.startsWith('image/')
                  ? `<img src="${att.dataBase64}" class="m-draft-thumb" alt="${escapeHtml(att.name)}" />`
                  : `<span class="m-draft-icon">📎</span>`}
                <div class="m-draft-att-meta">
                  <input type="text" class="m-draft-name-input" data-edit-att-id="${att.id}" value="${escapeHtml(att.name)}" />
                  <span class="m-draft-size">${formatBytes(att.size)}</span>
                </div>
                <button type="button" class="m-att-remove" data-remove-att-id="${att.id}">✕</button>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="m-capture-toolbar">
          <button type="button" class="m-tool-btn" id="btn-m-paste">📋 粘贴剪贴板</button>
          <label class="m-tool-btn" for="m-image-picker">
            📷 图片/拍照
            <input id="m-image-picker" type="file" accept="image/*" multiple hidden />
          </label>
          <label class="m-tool-btn" for="m-file-picker">
            📎 手机文件
            <input id="m-file-picker" type="file" multiple hidden />
          </label>
        </div>

        <div class="m-capture-submit-row">
          <select id="m-manual-cat" class="m-cat-select">
            <option value="" ${state.draftManualCategory === '' ? 'selected' : ''}>🤖 由 AI 自动判断分类</option>
            ${categories.map((c) => `
              <option value="${escapeHtml(c.id)}" ${state.draftManualCategory === c.id ? 'selected' : ''}>
                ${c.icon || '📁'} ${escapeHtml(c.name)}
              </option>
            `).join('')}
          </select>

          <button type="button" class="m-primary-btn" id="btn-m-submit" ${state.saving ? 'disabled' : ''}>
            ${state.saving ? '⏳ AI 归档中...' : '✨ 立即归档'}
          </button>
        </div>
      </section>

      ${state.lastSavedToast ? `
        <div class="m-saved-toast" data-open-memo="${escapeHtml(state.lastSavedToast.memo.id)}">
          <div class="m-toast-top">
            <span class="m-toast-ok">✅ 已归档</span>
            <strong>${escapeHtml(state.lastSavedToast.memo.title)}</strong>
          </div>
          <div class="m-toast-meta">
            <span>📂 ${escapeHtml(state.lastSavedToast.memo.category)}</span>
            ${(state.lastSavedToast.memo.tags || []).map((t) => `<span class="m-tag-badge">#${escapeHtml(t)}</span>`).join('')}
            <span class="m-toast-tap">点此查看 →</span>
          </div>
        </div>
      ` : ''}

      <section class="m-recent-section" id="m-recent-pull-zone">
        <div class="m-ptr-banner ${state.gitSyncing ? 'is-syncing' : ''}" id="m-ptr-banner">
          <span class="m-ptr-icon">${state.gitSyncing ? '⏳' : '↓'}</span>
          <span class="m-ptr-text" id="m-ptr-text">
            ${state.gitSyncing ? '正在同步电脑端与云端最新记录...' : '下拉刷新同步最新记录'}
          </span>
        </div>

        ${state.refreshToast ? `
          <div class="m-refresh-toast ${state.refreshToast.ok ? 'ok' : 'err'}">
            <span>${escapeHtml(state.refreshToast.text)}</span>
          </div>
        ` : ''}

        <div class="m-section-head">
          <h3>最近随手记 (${state.memos.length}) <span class="m-pull-hint">↓ 下拉可刷新</span></h3>
          <div class="m-section-actions">
            <button type="button" class="m-link-btn" id="btn-quick-pull" ${state.gitSyncing ? 'disabled' : ''}>
              ${state.gitSyncing ? '⏳ 同步中...' : '🔄 刷新同步'}
            </button>
            <button type="button" class="m-link-btn" id="btn-go-vault-all">全部知识库 →</button>
          </div>
        </div>

        ${recentMemos.length === 0 ? `
          <div class="m-empty-card">
            <div class="m-empty-icon">📱</div>
            <div class="m-empty-title">手机收纳盒还是空的</div>
            <div class="m-empty-desc">在上方粘贴文字、链接或图片即可 AI 自动分类；如果你在电脑端已绑定 Gitee/GitHub 私有库，可去「设置」页一键拉取同步！</div>
          </div>
        ` : `
          <div class="m-card-list">
            ${recentMemos.map((m) => renderMobileMemoCard(m)).join('')}
          </div>
        `}
      </section>
    </main>
  `;
}

function renderMobileMemoCard(m) {
  const typeMeta = TYPE_META[m.type] || TYPE_META.text;
  return `
    <article class="m-memo-card" data-open-memo="${escapeHtml(m.id)}">
      <div class="m-card-top">
        <span class="m-cat-pill">📂 ${escapeHtml(m.category)}</span>
        <span class="m-type-icon">${typeMeta.icon} ${typeMeta.label}</span>
        <span class="m-card-time">${escapeHtml((m.createdAt || '').slice(5, 16))}</span>
      </div>
      <h4 class="m-card-title">${escapeHtml(m.title)}</h4>
      <p class="m-card-summary">${escapeHtml(m.summary || m.content?.slice(0, 90) || '无正文摘要')}</p>
      <div class="m-card-bottom">
        <div class="m-card-tags">
          ${(m.tags || []).slice(0, 3).map((t) => `<span class="m-tag-badge" data-filter-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}
        </div>
        <span class="m-ai-badge ${m.aiClassified ? 'is-ai' : ''}">
          ${m.aiClassified ? '✨ AI' : '⚡ 规则'}
        </span>
      </div>
    </article>
  `;
}

function renderVaultTab() {
  const categories = state.config?.categories || [];
  const filtered = getFilteredMemos();
  const counts = { ALL: state.memos.length };
  for (const m of state.memos) {
    counts[m.category] = (counts[m.category] || 0) + 1;
  }

  return `
    <main class="m-page" id="m-vault-pull-zone">
      <div class="m-ptr-banner ${state.gitSyncing ? 'is-syncing' : ''}" id="m-ptr-banner">
        <span class="m-ptr-icon">${state.gitSyncing ? '⏳' : '↓'}</span>
        <span class="m-ptr-text" id="m-ptr-text">
          ${state.gitSyncing ? '正在同步电脑端与云端最新记录...' : '下拉刷新同步最新记录'}
        </span>
      </div>

      ${state.refreshToast ? `
        <div class="m-refresh-toast ${state.refreshToast.ok ? 'ok' : 'err'}">
          <span>${escapeHtml(state.refreshToast.text)}</span>
        </div>
      ` : ''}

      <div class="m-search-sticky">
        <div class="m-search-row">
          <input
            id="m-vault-search"
            type="search"
            class="m-search-input"
            placeholder="🔍 搜索标题、AI 摘要、API Key、正文或标签..."
            value="${escapeHtml(state.searchQuery)}"
          />
          <button type="button" class="m-tool-btn primary" id="btn-vault-refresh" ${state.gitSyncing ? 'disabled' : ''}>
            ${state.gitSyncing ? '⏳' : '🔄 刷新'}
          </button>
        </div>

        <div class="m-cat-scroll">
          <button type="button" class="m-cat-chip ${state.selectedCategory === 'ALL' ? 'active' : ''}" data-select-cat="ALL">
            🗂️ 全部 (${counts.ALL || 0})
          </button>
          ${categories.map((c) => `
            <button type="button" class="m-cat-chip ${state.selectedCategory === c.id ? 'active' : ''}" data-select-cat="${escapeHtml(c.id)}">
              ${c.icon || '📁'} ${escapeHtml(c.name)} (${counts[c.id] || 0})
            </button>
          `).join('')}
        </div>

        <div class="m-type-scroll">
          ${Object.entries(TYPE_META).map(([k, meta]) => `
            <button type="button" class="m-type-chip ${state.selectedType === k ? 'active' : ''}" data-select-type="${k}">
              ${meta.icon} ${meta.label}
            </button>
          `).join('')}
          ${state.selectedTag ? `
            <button type="button" class="m-type-chip clear-tag" id="btn-clear-tag">✕ #${escapeHtml(state.selectedTag)}</button>
          ` : ''}
        </div>
      </div>

      <div class="m-card-list" style="margin-top: 10px;">
        ${filtered.length === 0 ? `
          <div class="m-empty-card">
            <div class="m-empty-icon">🔍</div>
            <div class="m-empty-title">没有找到匹配的记录</div>
            <div class="m-empty-desc">试试切换上方分类胶囊或清空搜索关键词</div>
          </div>
        ` : filtered.map((m) => renderMobileMemoCard(m)).join('')}
      </div>
    </main>
  `;
}

function renderChatTab() {
  const examplePrompts = [
    '帮我找一下我保存过的 API Key 或 Token',
    '我收藏过哪些网址链接或 GitHub 仓库？',
    '我最近记了哪些工作待办事项？',
    '盘点一下我手机知识库里的全部内容'
  ];

  return `
    <main class="m-chat-page">
      <div class="m-chat-header-card">
        <div>
          <div class="m-chat-title">💬 闪念寻物助手 (RAG)</div>
          <div class="m-chat-sub">已索引手机本地 <strong>${state.memos.length}</strong> 篇闪念与文档摘要</div>
        </div>
        ${state.chatMessages.length > 0 ? `
          <button type="button" class="m-mini-btn" id="btn-m-clear-chat">🗑️ 清空对话</button>
        ` : ''}
      </div>

      <div class="m-chat-messages" id="m-chat-messages">
        ${state.chatMessages.length === 0 ? `
          <div class="m-chat-empty">
            <div class="m-chat-empty-title">✦ 用自然语言找回你随手存下的任何东西</div>
            <p class="m-chat-empty-desc">直接问我关键词、API Key 平台名称或模糊印象即可：</p>
            <div class="m-prompt-list">
              ${examplePrompts.map((p) => `
                <button type="button" class="m-prompt-btn" data-chat-prompt="${escapeHtml(p)}">
                  <span>💬 ${escapeHtml(p)}</span>
                  <span>→</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : state.chatMessages.map((msg) => `
          <div class="m-msg-row ${msg.role === 'user' ? 'is-user' : 'is-assistant'}">
            <div class="m-msg-bubble">
              <div class="m-msg-body">${formatMarkdownHtml(msg.content)}</div>
              ${msg.role === 'assistant' && Array.isArray(msg.sources) && msg.sources.length > 0 ? `
                <div class="m-msg-sources">
                  <div class="m-source-head">📎 命中的本地记录 (${msg.sources.length})</div>
                  ${msg.sources.map((s) => `
                    <div class="m-source-item" data-open-memo="${escapeHtml(s.memoId)}">
                      <div class="m-source-title">📄 ${escapeHtml(s.title)}</div>
                      <div class="m-source-meta">📂 ${escapeHtml(s.category)} · 点击查看全文 →</div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          </div>
        `).join('')}

        ${state.chatLoading ? `
          <div class="m-msg-row is-assistant">
            <div class="m-msg-bubble">⏳ 正在检索手机知识库与生成回答...</div>
          </div>
        ` : ''}
      </div>

      <div class="m-chat-composer">
        <input
          id="m-chat-input"
          type="text"
          class="m-chat-input"
          placeholder="输入你想找的笔记、API Key 或链接..."
          value="${escapeHtml(state.chatDraft)}"
        />
        <button type="button" class="m-chat-send-btn" id="btn-m-send-chat" ${state.chatLoading ? 'disabled' : ''}>发送</button>
      </div>
    </main>
  `;
}

function renderSettingsTab() {
  const cfg = state.config || {};
  const llm = cfg.llm || {};
  const git = cfg.vaultGit || {};
  const isGitee = (git.provider || 'gitee') !== 'github';
  const hasGitee = Boolean((git.giteeToken || (isGitee ? git.accessToken : '') || '').trim());
  const hasGithub = Boolean((git.githubToken || (!isGitee ? git.accessToken : '') || '').trim());
  const dualConfigured = hasGitee && hasGithub;

  const activeToken = isGitee
    ? (git.giteeToken || git.accessToken || '')
    : (git.githubToken || (git.provider === 'github' ? git.accessToken : '') || '');
  const activeOwner = isGitee
    ? (git.giteeOwner || git.repoOwner || '')
    : (git.githubOwner || (git.provider === 'github' ? git.repoOwner : '') || '');
  const activeRepo = isGitee
    ? (git.giteeRepo || git.repoName || 'quick-memo-vault')
    : (git.githubRepo || git.repoName || 'quick-memo-vault');

  return `
    <main class="m-page">
      <!-- 1. 云端双向同步设置 (Gitee + GitHub 双云同启) -->
      <section class="m-settings-card">
        <div class="m-card-head-row">
          <h3>☁️ 云端主库双向同步 (Gitee / GitHub)</h3>
          <span class="m-sync-badge ${(hasGitee || hasGithub) ? 'ok' : ''}">
            ${dualConfigured ? '🔥 Gitee+GitHub 双云同启' : (hasGitee || hasGithub) ? '🟢 已绑云端令牌' : '⚪ 待配置'}
          </span>
        </div>
        <p class="m-settings-hint">
          以云端仓库为主库：任何新增、编辑、分类、删除操作都会自动推送到云端；每次打开应用自动同步云端。<strong>若同时配置 Gitee 与 GitHub，将自动同时同步与更新双云仓库！</strong>
        </p>

        <div class="m-provider-tabs">
          <button type="button" class="m-provider-tab ${isGitee ? 'active' : ''}" data-git-provider="gitee">
            🇨🇳 Gitee 码云 ${hasGitee ? '🟢' : ''}
          </button>
          <button type="button" class="m-provider-tab ${!isGitee ? 'active' : ''}" data-git-provider="github">
            🐙 GitHub ${hasGithub ? '🟢' : ''}
          </button>
        </div>

        <div class="m-form-stack">
          <label class="m-field">
            <span>${isGitee ? 'Gitee 私人令牌 (Access Token)' : 'GitHub Personal Access Token (需 repo 权限)'}</span>
            <input type="password" id="cfg-git-token" value="${escapeHtml(activeToken)}" placeholder="${isGitee ? '粘贴 Gitee 私人令牌 (留空则关闭 Gitee 同步)...' : '粘贴 GitHub Token ghp_... (留空则关闭 GitHub 同步)...'}" />
          </label>

          <label class="m-field">
            <span>${isGitee ? 'Gitee 用户名或仓库地址（可留空自动识别）' : 'GitHub 用户名或仓库地址（可留空自动识别）'}</span>
            <input type="text" id="cfg-git-owner" value="${escapeHtml(activeOwner)}" placeholder="${isGitee ? '例如：DrinkingTea（填了令牌可留空自动识别）' : '例如：TeaGo-lab（填了令牌可留空自动识别）'}" />
          </label>

          <label class="m-field">
            <span>私有仓库名称</span>
            <input type="text" id="cfg-git-repo" value="${escapeHtml(activeRepo)}" placeholder="quick-memo-vault" />
          </label>

          <label class="m-check-row">
            <input type="checkbox" id="cfg-git-autosync" ${git.autoSync !== false ? 'checked' : ''} />
            <span>每次操作记录（新增/编辑/分类/删除）及打开应用时自动同步云端</span>
          </label>

          ${git.lastSyncedAt ? `
            <div class="m-sync-time-note">🕒 最近云同步：${escapeHtml(git.lastSyncedAt)}</div>
          ` : ''}

          <div class="m-btn-grid-2">
            <button type="button" class="m-tool-btn primary" id="btn-cloud-pull" ${state.gitSyncing ? 'disabled' : ''}>
              ${state.gitSyncing ? '⏳ 正在同步...' : '⬇️ 从云端拉取同步'}
            </button>
            <button type="button" class="m-primary-btn" id="btn-cloud-push" ${state.gitSyncing ? 'disabled' : ''}>
              ${state.gitSyncing ? '⏳ 正在同步...' : '☁️ 推送到云端'}
            </button>
          </div>

          ${state.gitFeedback ? `
            <div class="m-feedback-box ${state.gitFeedback.ok ? 'ok' : 'err'}">
              ${escapeHtml(state.gitFeedback.text)}
            </div>
          ` : ''}
        </div>
      </section>

      <!-- 2. OpenAI 兼容大模型设置 -->
      <section class="m-settings-card">
        <h3>🤖 OpenAI 兼容 AI 接口设置</h3>
        <p class="m-settings-hint">手机端直连大模型，自动起中文标题、提炼摘要、分类与对话寻物。</p>

        <div class="m-preset-chips">
          ${Object.entries(LLM_PRESETS).map(([key, p]) => `
            <button type="button" class="m-quick-chip" data-llm-preset="${key}">⚡ ${escapeHtml(p.label)}</button>
          `).join('')}
        </div>

        <div class="m-form-stack">
          <label class="m-check-row">
            <input type="checkbox" id="cfg-llm-enabled" ${llm.enabled !== false ? 'checked' : ''} />
            <span>启用 AI 自动分类与寻物助手</span>
          </label>

          <label class="m-field">
            <span>API Base URL</span>
            <input type="text" id="cfg-llm-baseurl" value="${escapeHtml(llm.baseUrl || '')}" placeholder="https://api.deepseek.com" />
          </label>

          <label class="m-field">
            <span>API Key</span>
            <input type="password" id="cfg-llm-apikey" value="${escapeHtml(llm.apiKey || '')}" placeholder="sk-..." />
          </label>

          <label class="m-field">
            <span>模型名称 (Model ID)</span>
            <input type="text" id="cfg-llm-model" value="${escapeHtml(llm.model || '')}" placeholder="deepseek-chat / gpt-4o-mini" />
          </label>

          <div class="m-btn-grid-2">
            <button type="button" class="m-tool-btn" id="btn-test-llm" ${state.llmTesting ? 'disabled' : ''}>
              ${state.llmTesting ? '⏳ 测试中...' : '🔌 测试 AI 连接'}
            </button>
            <button type="button" class="m-primary-btn" id="btn-save-settings">💾 保存全部设置</button>
          </div>

          ${state.llmTestFeedback ? `
            <div class="m-feedback-box ${state.llmTestFeedback.ok ? 'ok' : 'err'}">
              ${escapeHtml(state.llmTestFeedback.text)}
            </div>
          ` : ''}
        </div>
      </section>

      <!-- 3. 本地备份导出与恢复 -->
      <section class="m-settings-card">
        <h3>📦 手机本地数据备份与恢复</h3>
        <p class="m-settings-hint">支持将手机端全部闪念导出为兼容桌面版的 <code>.json</code> 索引备份文件，或一键清除手机本地缓存重新同步电脑/云端最新数据。</p>
        <div class="m-btn-grid-2">
          <button type="button" class="m-tool-btn" id="btn-export-json">📤 导出备份 (.json)</button>
          <label class="m-tool-btn" for="m-import-json-input" style="justify-content:center;">
            📥 导入恢复备份
            <input id="m-import-json-input" type="file" accept=".json,application/json" hidden />
          </label>
        </div>
        <button type="button" class="m-tool-btn danger" id="btn-clear-cache-sync" style="width:100%;justify-content:center;margin-top:8px;" ${state.gitSyncing ? 'disabled' : ''}>
          ${state.gitSyncing ? '⏳ 正在清除缓存并同步...' : '🧹 清除手机本地缓存并重新同步'}
        </button>
      </section>

      <!-- 4. 开发者出品 · 命书官方站点与建议反馈 -->
      <section class="m-settings-card m-promo-card">
        <div class="m-promo-badge">✨ 开发者出品 · 精选官方站点</div>
        <h3 class="m-promo-title">🏮 命书 · 东方传统子平八字 × 紫微斗数双盘合参</h3>
        <p class="m-promo-desc">
          探索我们的主站 <strong><a href="https://mingshu.closty.art" target="_blank" rel="noopener" class="m-promo-link">https://mingshu.closty.art</a></strong> —— 融合子平八字与紫微斗数双盘互证，遵循古籍体例输出十四章文白融合详批命书、时辰定盘校准与即时易占体验。
        </p>
        <div class="m-btn-grid-2">
          <button type="button" class="m-primary-btn" data-open-url="https://mingshu.closty.art">
            🌐 立即访问 mingshu.closty.art
          </button>
          <button type="button" class="m-tool-btn" data-copy-text="https://mingshu.closty.art" style="justify-content:center;">
            📋 复制官网网址
          </button>
        </div>

        <div class="m-promo-contact-box">
          <div class="m-promo-contact-head">
            <span class="m-promo-contact-label">📬 建议与反馈信箱</span>
            <code class="m-promo-email">teagoxu@proton.me</code>
          </div>
          <p class="m-settings-hint" style="margin: 2px 0 6px;">
            如果你在使用 QuickMemo 时有任何改进建议、新功能想法、Bug 反馈或合作意向，欢迎随时发邮件告诉我们！
          </p>
          <div class="m-btn-grid-2">
            <button type="button" class="m-tool-btn primary" data-copy-text="teagoxu@proton.me" style="justify-content:center;">
              📋 复制邮箱地址
            </button>
            <button type="button" class="m-tool-btn" data-open-url="mailto:teagoxu@proton.me?subject=QuickMemo%20%E4%BD%BF%E7%94%A8%E5%BB%BA%E8%AE%AE%E4%B8%8E%E5%8F%8D%E9%A6%88" style="justify-content:center;">
              ✉️ 写邮件提建议
            </button>
          </div>
        </div>
      </section>

      <!-- 5. 赞赏支持 -->
      <section class="m-settings-card">
        <div class="m-card-head-row">
          <h3>☕ 赞赏与支持（请作者喝杯茶）</h3>
          <span class="m-sync-badge ok">🙏 感谢鼓励</span>
        </div>
        <p class="m-settings-hint">QuickMemo 免费开源、无商业弹窗广告、数据本地化。如果它对你有帮助，欢迎点击二维码放大赞赏支持：</p>
        <div class="m-qr-grid">
          <div class="m-qr-box wechat" data-zoom-qr="${escapeHtml(wechatQrUrl)}" data-zoom-title="💚 微信赞赏 · 喝茶去(*旭)">
            <img src="${escapeHtml(wechatQrUrl)}" alt="微信赞赏码" />
            <span>💚 微信支付赞赏</span>
          </div>
          <div class="m-qr-box alipay" data-zoom-qr="${escapeHtml(alipayQrUrl)}" data-zoom-title="💙 支付宝赞赏 · TeaGo(*旭)">
            <img src="${escapeHtml(alipayQrUrl)}" alt="支付宝赞赏码" />
            <span>💙 支付宝 · TeaGo(*旭)</span>
          </div>
        </div>
      </section>

      <!-- 6. 非商用开源协议约定 -->
      <section class="m-settings-card m-license-card">
        <div class="m-card-head-row">
          <h3>📜 非商用使用约定（禁止商用）</h3>
          <span class="m-non-commercial-badge">🚫 严禁商用</span>
        </div>
        <p class="m-settings-hint">
          本项目（含桌面端与安卓端）基于 <strong>QuickMemo 非商业开源许可协议</strong> 发布：
        </p>
        <ul class="m-license-list">
          <li><strong>✅ 允许范围</strong>：个人日常免费使用、编程学习、非商业研究及保留原作者署名的免费分享。</li>
          <li><strong>🚫 严禁商用</strong>：严禁在淘宝、闲鱼、拼多多、小红书等任何渠道售卖安装包/源码或提供有偿代装服务；严禁内嵌至商业产品/SaaS；严禁未经书面授权的企业商用及抹除版权标识。</li>
          <li><strong>📬 商业授权与反馈邮箱</strong>：<code>teagoxu@proton.me</code></li>
        </ul>
      </section>
    </main>
  `;
}

function renderBottomNav() {
  return `
    <nav class="m-bottom-nav">
      <button type="button" class="m-nav-item ${state.activeTab === 'capture' ? 'active' : ''}" data-tab="capture">
        <span class="m-nav-icon">⚡</span>
        <span class="m-nav-label">随手记</span>
      </button>
      <button type="button" class="m-nav-item ${state.activeTab === 'vault' ? 'active' : ''}" data-tab="vault">
        <span class="m-nav-icon">🗂️</span>
        <span class="m-nav-label">知识库 (${state.memos.length})</span>
      </button>
      <button type="button" class="m-nav-item ${state.activeTab === 'chat' ? 'active' : ''}" data-tab="chat">
        <span class="m-nav-icon">💬</span>
        <span class="m-nav-label">AI 寻物</span>
      </button>
      <button type="button" class="m-nav-item ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
        <span class="m-nav-icon">⚙️</span>
        <span class="m-nav-label">设置与协议</span>
      </button>
    </nav>
  `;
}

function renderDetailSheet() {
  if (!state.detailMemoId) return '';
  const memo = state.memos.find((m) => m.id === state.detailMemoId);
  if (!memo) return '';
  const categories = state.config?.categories || [];

  return `
    <div class="m-modal-backdrop" id="m-detail-backdrop">
      <div class="m-detail-sheet">
        <div class="m-detail-topbar">
          <button type="button" class="m-tool-btn" id="btn-close-detail">← 返回</button>
          <div class="m-detail-actions">
            <button type="button" class="m-tool-btn" id="btn-detail-copy" data-id="${escapeHtml(memo.id)}">📋 复制原文</button>
            <button type="button" class="m-tool-btn" id="btn-detail-export-md" data-id="${escapeHtml(memo.id)}">📥 导出 .md</button>
            <button type="button" class="m-tool-btn danger" id="btn-detail-delete" data-id="${escapeHtml(memo.id)}">🗑️</button>
          </div>
        </div>

        <div class="m-detail-scroll">
          <input
            type="text"
            id="m-detail-title-input"
            class="m-detail-title-input"
            value="${escapeHtml(memo.title)}"
          />

          <div class="m-detail-meta-row">
            <select id="m-detail-cat-select" class="m-cat-select compact">
              ${categories.map((c) => `
                <option value="${escapeHtml(c.id)}" ${memo.category === c.id ? 'selected' : ''}>
                  📂 ${escapeHtml(c.name)}
                </option>
              `).join('')}
            </select>
            <span class="m-detail-time">🕒 ${escapeHtml(memo.createdAt)}</span>
          </div>

          ${memo.summary ? `
            <div class="m-summary-card">
              <div class="m-summary-label">✨ AI 提炼摘要</div>
              <div>${escapeHtml(memo.summary)}</div>
            </div>
          ` : ''}

          <div class="m-card-tags" style="margin: 8px 0;">
            ${(memo.tags || []).map((t) => `<span class="m-tag-badge">#${escapeHtml(t)}</span>`).join('')}
          </div>

          ${Array.isArray(memo.attachments) && memo.attachments.length > 0 ? `
            <div class="m-detail-atts">
              ${memo.attachments.map((att) => {
                const b64 = state.detailAttachmentUrls[att.id] || '';
                return `
                  <div class="m-detail-att-card">
                    <div class="m-detail-att-name">📎 ${escapeHtml(att.name)} (${formatBytes(att.size)})</div>
                    ${b64 && (att.mimeType || '').startsWith('image/') ? `
                      <img src="${b64}" class="m-detail-img" alt="${escapeHtml(att.name)}" />
                    ` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}

          <div class="m-detail-body">
            ${formatMarkdownHtml(memo.content || '')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderPrecheckModal() {
  const modal = state.precheckModal;
  if (!modal) return '';
  const hasDup = Array.isArray(modal.duplicates) && modal.duplicates.length > 0;
  const hasKey = Boolean(modal.keyReminder?.needsNote);
  const quickKeyNotes = ['DeepSeek API Key', '硅基流动 Key', 'OpenAI Key', 'GitHub Token', '服务器密码'];

  return `
    <div class="m-modal-backdrop" id="m-precheck-backdrop">
      <div class="m-dialog-card">
        <div class="m-dialog-title">
          ${hasDup ? '⚠️ 发现重复记录' : '🔑 建议为密钥补充一句备注'}
        </div>

        ${hasDup ? `
          <div class="m-dialog-sec">
            <p>手机库中已有相同内容：</p>
            ${modal.duplicates.map((d) => `
              <div class="m-dup-item" data-open-memo="${escapeHtml(d.id)}">
                <strong>📄 ${escapeHtml(d.title)}</strong>
                <span>📂 ${escapeHtml(d.category)} · 点击查看已有记录</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${hasKey ? `
          <div class="m-dialog-sec">
            <p>检测到裸密钥（<code>${escapeHtml(modal.keyReminder.maskedKey)}</code>），补一句用途备注方便日后搜索：</p>
            <input
              type="text"
              id="m-precheck-note-input"
              class="m-search-input"
              placeholder="例如：DeepSeek 生产环境 Key..."
              value="${escapeHtml(modal.noteDraft || '')}"
            />
            <div class="m-chip-scroll" style="margin-top:8px;">
              ${quickKeyNotes.map((t) => `
                <button type="button" class="m-quick-chip" data-precheck-chip="${escapeHtml(t)}">+ ${escapeHtml(t)}</button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="m-btn-grid-2" style="margin-top: 14px;">
          <button type="button" class="m-tool-btn" id="btn-precheck-cancel">返回修改</button>
          <button type="button" class="m-primary-btn" id="btn-precheck-confirm">✅ 确认保存</button>
        </div>
      </div>
    </div>
  `;
}

export function render() {
  const app = document.getElementById('app');
  if (!app) return;

  // 在同一 Tab 内点击按钮重渲染前，自动记录所有纵向与横向滚动容器的位置，防止页面跳回顶部
  const sameTab = state._lastRenderedTab === state.activeTab;
  const scrollSelectors = [
    '.m-page',
    '.m-chat-messages',
    '.m-detail-scroll',
    '.m-cat-scroll',
    '.m-type-scroll',
    '.m-chip-scroll'
  ];
  const savedScrollMap = new Map();
  if (sameTab) {
    for (const sel of scrollSelectors) {
      const el = app.querySelector(sel);
      if (el && (el.scrollTop > 0 || el.scrollLeft > 0)) {
        savedScrollMap.set(sel, {
          top: el.scrollTop,
          left: el.scrollLeft
        });
      }
    }
  }
  state._lastRenderedTab = state.activeTab;

  let pageHtml = '';
  if (state.activeTab === 'capture') pageHtml = renderCaptureTab();
  else if (state.activeTab === 'vault') pageHtml = renderVaultTab();
  else if (state.activeTab === 'chat') pageHtml = renderChatTab();
  else pageHtml = renderSettingsTab();

  app.innerHTML = `
    <div class="m-app-shell">
      ${renderTopHeader()}
      ${renderSetupReminderBanner()}
      ${pageHtml}
      ${renderBottomNav()}
      ${renderDetailSheet()}
      ${renderPrecheckModal()}
      ${state.qrPreviewModal ? `
        <div class="m-modal-backdrop" id="m-qr-backdrop">
          <div class="m-dialog-card" style="text-align:center;">
            <div class="m-dialog-title">${escapeHtml(state.qrPreviewModal.title)}</div>
            <img src="${escapeHtml(state.qrPreviewModal.imgUrl)}" class="m-qr-zoom-img" alt="赞赏码" />
            <button type="button" class="m-tool-btn" id="btn-close-qr" style="width:100%;margin-top:12px;justify-content:center;">关闭</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  if (sameTab && savedScrollMap.size > 0) {
    for (const [sel, pos] of savedScrollMap.entries()) {
      const el = app.querySelector(sel);
      if (el) {
        if (pos.top > 0) el.scrollTop = pos.top;
        if (pos.left > 0) el.scrollLeft = pos.left;
      }
    }
  }

  bindEvents();
}

function collectSettingsFromDom() {
  const prevGit = state.config.vaultGit || {};
  const isGitee = (prevGit.provider || 'gitee') !== 'github';
  const tokenEl = document.getElementById('cfg-git-token');
  const ownerEl = document.getElementById('cfg-git-owner');
  const repoEl = document.getElementById('cfg-git-repo');
  const autoSyncEl = document.getElementById('cfg-git-autosync');

  const inputToken = tokenEl ? tokenEl.value.trim() : (isGitee ? (prevGit.giteeToken || prevGit.accessToken || '') : (prevGit.githubToken || ''));
  const inputOwner = ownerEl ? ownerEl.value.trim() : (isGitee ? (prevGit.giteeOwner || prevGit.repoOwner || '') : (prevGit.githubOwner || ''));
  const inputRepo = (repoEl ? repoEl.value.trim() : (isGitee ? prevGit.giteeRepo : prevGit.githubRepo)) || 'quick-memo-vault';
  const gitAutoSync = autoSyncEl ? autoSyncEl.checked : (prevGit.autoSync !== false);

  const nextGit = {
    ...prevGit,
    autoSync: gitAutoSync
  };

  if (isGitee) {
    nextGit.giteeToken = inputToken;
    nextGit.giteeOwner = inputOwner;
    nextGit.giteeRepo = inputRepo;
    nextGit.accessToken = inputToken;
    nextGit.repoOwner = inputOwner;
    nextGit.repoName = inputRepo;
  } else {
    nextGit.githubToken = inputToken;
    nextGit.githubOwner = inputOwner;
    nextGit.githubRepo = inputRepo;
    nextGit.accessToken = inputToken;
    nextGit.repoOwner = inputOwner;
    nextGit.repoName = inputRepo;
  }

  const llmEnabled = document.getElementById('cfg-llm-enabled')?.checked ?? true;
  const llmBaseUrl = document.getElementById('cfg-llm-baseurl')?.value.trim() || 'https://api.deepseek.com';
  const llmApiKey = document.getElementById('cfg-llm-apikey')?.value.trim() ?? state.config.llm?.apiKey ?? '';
  const llmModel = document.getElementById('cfg-llm-model')?.value.trim() || 'deepseek-chat';

  return saveConfig({
    llm: {
      ...state.config.llm,
      enabled: llmEnabled,
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      model: llmModel
    },
    vaultGit: nextGit
  });
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.getAttribute('data-tab');
      render();

    });
  });

  document.getElementById('btn-top-brand')?.addEventListener('click', () => {
    state.activeTab = 'capture';
    render();

  });

  document.getElementById('btn-top-ai')?.addEventListener('click', () => {
    state.activeTab = 'settings';
    render();

  });

  document.getElementById('btn-m-remind-git')?.addEventListener('click', () => {
    state.activeTab = 'settings';
    render();
  });

  document.getElementById('btn-m-remind-ai')?.addEventListener('click', () => {
    state.activeTab = 'settings';
    render();
  });

  document.getElementById('btn-top-sync')?.addEventListener('click', () => {
    handlePullToRefresh();
  });

  // 速记页事件（局部刷新密钥提示栏，绝不销毁重建 textarea 避免打断中文输入法候选框）
  const bindMobileKeyNoteChips = (root = document) => {
    root.querySelectorAll('[data-insert-key-note]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const note = chip.getAttribute('data-insert-key-note');
        if (!note) return;
        state.draftContent = `【${note}】\n${state.draftContent.trim()}`;
        render();
      });
    });
  };
  bindMobileKeyNoteChips(document);

  const captureInput = document.getElementById('m-capture-textarea');
  if (captureInput) {
    const syncMobileKeyHintSlot = () => {
      const slot = document.getElementById('m-key-hint-slot');
      if (!slot) return;
      const nextHtml = renderMobileKeyHintBox();
      const hasBoxNow = Boolean(slot.querySelector('#m-key-hint-box'));
      const wantsBox = Boolean(nextHtml);
      if (hasBoxNow !== wantsBox) {
        slot.innerHTML = nextHtml;
        if (wantsBox) bindMobileKeyNoteChips(slot);
      }
    };

    captureInput.addEventListener('input', (e) => {
      state.draftContent = e.target.value;
      if (e.isComposing) return;
      syncMobileKeyHintSlot();
    });

    captureInput.addEventListener('compositionend', (e) => {
      state.draftContent = e.target.value;
      syncMobileKeyHintSlot();
    });
  }

  document.getElementById('btn-m-paste')?.addEventListener('click', async () => {
    try {
      let text = '';
      if (window.AndroidNative && typeof window.AndroidNative.getClipboardText === 'function') {
        text = String(window.AndroidNative.getClipboardText() || '');
      } else {
        text = await navigator.clipboard.readText();
      }
      if (text) {
        state.draftContent = state.draftContent ? `${state.draftContent}\n${text}` : text;
        render();
      } else {
        alert('当前剪贴板为空，或长按输入框选择“粘贴”');
      }
    } catch {
      alert('请长按输入框选择“粘贴”');
    }
  });

  document.getElementById('m-image-picker')?.addEventListener('change', (e) => {
    if (e.target.files?.length) addFilesToDraft(e.target.files);
  });

  document.getElementById('m-file-picker')?.addEventListener('change', (e) => {
    if (e.target.files?.length) addFilesToDraft(e.target.files);
  });

  document.querySelectorAll('[data-edit-att-id]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const id = inp.getAttribute('data-edit-att-id');
      const att = state.draftAttachments.find((a) => a.id === id);
      if (att) att.name = e.target.value;
    });
  });

  document.querySelectorAll('[data-remove-att-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-remove-att-id');
      state.draftAttachments = state.draftAttachments.filter((a) => a.id !== id);
      render();

    });
  });

  document.getElementById('m-manual-cat')?.addEventListener('change', (e) => {
    state.draftManualCategory = e.target.value;
  });

  document.getElementById('btn-m-submit')?.addEventListener('click', () => {
    handleSubmitCapture();
  });

  document.getElementById('btn-go-vault-all')?.addEventListener('click', () => {
    state.activeTab = 'vault';
    render();

  });

  document.getElementById('btn-quick-pull')?.addEventListener('click', () => {
    handlePullToRefresh();
  });

  document.getElementById('btn-vault-refresh')?.addEventListener('click', () => {
    handlePullToRefresh();
  });

  // 打开记录详情
  document.querySelectorAll('[data-open-memo]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-open-memo');
      state.precheckModal = null;
      openMemoDetail(id);
    });
  });

  // 预检弹窗事件
  document.getElementById('btn-precheck-cancel')?.addEventListener('click', () => {
    state.precheckModal = null;
    render();

  });

  document.querySelectorAll('[data-precheck-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const val = chip.getAttribute('data-precheck-chip') || '';
      if (state.precheckModal) state.precheckModal.noteDraft = val;
      const inp = document.getElementById('m-precheck-note-input');
      if (inp) inp.value = val;
    });
  });

  document.getElementById('btn-precheck-confirm')?.addEventListener('click', () => {
    const note = document.getElementById('m-precheck-note-input')?.value.trim() || '';
    handleSubmitCapture({ forceSave: true, extraNote: note });
  });

  // 知识库筛选事件
  const searchInput = document.getElementById('m-vault-search');
  if (searchInput) {
    const applyMobileSearchUpdate = (target) => {
      const pos = target.selectionStart;
      state.searchQuery = target.value;
      render();
      const next = document.getElementById('m-vault-search');
      if (next) {
        next.focus();
        next.setSelectionRange(pos, pos);
      }
    };
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      if (e.isComposing) return;
      applyMobileSearchUpdate(e.target);
    });
    searchInput.addEventListener('compositionend', (e) => {
      applyMobileSearchUpdate(e.target);
    });
  }

  document.querySelectorAll('[data-select-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedCategory = btn.getAttribute('data-select-cat');
      render();

    });
  });

  document.querySelectorAll('[data-select-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedType = btn.getAttribute('data-select-type');
      render();

    });
  });

  document.querySelectorAll('[data-filter-tag]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = btn.getAttribute('data-filter-tag');
      state.selectedTag = state.selectedTag === tag ? '' : tag;
      state.activeTab = 'vault';
      render();

    });
  });

  document.getElementById('btn-clear-tag')?.addEventListener('click', () => {
    state.selectedTag = '';
    render();

  });

  // 详情抽屉事件
  document.getElementById('btn-close-detail')?.addEventListener('click', () => {
    state.detailMemoId = null;
    render();

  });

  document.getElementById('m-detail-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'm-detail-backdrop') {
      state.detailMemoId = null;
      render();

    }
  });

  document.getElementById('m-detail-title-input')?.addEventListener('blur', (e) => {
    if (!state.detailMemoId) return;
    const newTitle = e.target.value.trim();
    if (newTitle) {
      const updated = updateMemo(state.detailMemoId, { title: newTitle });
      state.memos = listMemos();
      render();
      if (updated) triggerAutoCloudPush(updated);
    }
  });

  document.getElementById('m-detail-cat-select')?.addEventListener('change', (e) => {
    if (!state.detailMemoId) return;
    const updated = updateMemo(state.detailMemoId, { category: e.target.value });
    state.memos = listMemos();
    render();
    if (updated) triggerAutoCloudPush(updated);
  });

  document.getElementById('btn-detail-copy')?.addEventListener('click', async (e) => {
    const id = e.currentTarget.getAttribute('data-id');
    const memo = state.memos.find((m) => m.id === id);
    if (memo) {
      const copyStr = memo.content || memo.title;
      if (window.AndroidNative && typeof window.AndroidNative.copyToClipboard === 'function') {
        window.AndroidNative.copyToClipboard(copyStr);
      } else {
        await navigator.clipboard.writeText(copyStr);
      }
      e.currentTarget.textContent = '✅ 已复制';
      setTimeout(() => render(), 1000);
    }
  });

  document.getElementById('btn-detail-export-md')?.addEventListener('click', (e) => {
    const id = e.currentTarget.getAttribute('data-id');
    const memo = state.memos.find((m) => m.id === id);
    if (memo) downloadMarkdownFile(memo);
  });

  document.getElementById('btn-detail-delete')?.addEventListener('click', async (e) => {
    const id = e.currentTarget.getAttribute('data-id');
    const targetMemo = state.memos.find((m) => m.id === id) || null;
    if (!confirm('确定要删除这条记录吗？（将同时从云端仓库与本机移除）')) return;
    await deleteMemo(id);
    state.memos = listMemos();
    state.detailMemoId = null;
    render();
    syncDeleteToRemote(id, targetMemo)
      .then((res) => {
        if (res.deletedCloud) {
          state.pullFeedbackText = `🗑️ 已从 ${(res.providers || []).join(' + ')} 同步删除`;
          render();
          setTimeout(() => {
            state.pullFeedbackText = '';
            render();
          }, 2200);
        }
      })
      .catch((err) => console.warn('[DeleteSync]', err));
  });

  // 寻物对话事件
  const chatInput = document.getElementById('m-chat-input');
  if (chatInput) {
    chatInput.addEventListener('input', (e) => {
      state.chatDraft = e.target.value;
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('btn-m-send-chat')?.click();
      }
    });
  }

  const sendChat = async (textOverride = '') => {
    const q = (textOverride || state.chatDraft || '').trim();
    if (!q || state.chatLoading) return;
    const history = state.chatMessages.slice(-4).map((m) => ({ role: m.role, content: m.content }));
    state.chatMessages.push({ role: 'user', content: q });
    state.chatDraft = '';
    state.chatLoading = true;
    render();


    try {
      const res = await askMobileVaultAssistant({ message: q, history });
      state.chatMessages.push({
        role: 'assistant',
        content: res.reply,
        sources: res.sources || []
      });
    } catch (err) {
      state.chatMessages.push({
        role: 'assistant',
        content: `⚠️ 检索出错：${err.message}`
      });
    } finally {
      state.chatLoading = false;
      render();

      const box = document.getElementById('m-chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    }
  };

  document.getElementById('btn-m-send-chat')?.addEventListener('click', () => sendChat());
  document.querySelectorAll('[data-chat-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => sendChat(btn.getAttribute('data-chat-prompt')));
  });
  document.getElementById('btn-m-clear-chat')?.addEventListener('click', () => {
    state.chatMessages = [];
    render();

  });

  // 设置页事件
  document.querySelectorAll('[data-git-provider]').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.config = collectSettingsFromDom();
      const provider = tab.getAttribute('data-git-provider');
      state.config = saveConfig({
        vaultGit: { ...state.config.vaultGit, provider }
      });
      state.gitFeedback = null;
      render();
    });
  });

  document.querySelectorAll('[data-llm-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.config = collectSettingsFromDom();
      const key = btn.getAttribute('data-llm-preset');
      const preset = LLM_PRESETS[key];
      if (!preset) return;
      state.config = saveConfig({
        llm: {
          ...state.config.llm,
          providerPreset: key,
          baseUrl: preset.baseUrl,
          model: preset.model
        }
      });
      render();
    });
  });

  document.getElementById('btn-save-settings')?.addEventListener('click', (e) => {
    state.config = collectSettingsFromDom();
    e.currentTarget.textContent = '✅ 已保存';
    setTimeout(() => render(), 900);
  });

  document.getElementById('btn-test-llm')?.addEventListener('click', async () => {
    state.config = collectSettingsFromDom();
    state.llmTesting = true;
    state.llmTestFeedback = null;
    render();

    try {
      const res = await testLlmConnection(state.config.llm);
      state.llmTestFeedback = {
        ok: true,
        text: `✅ 连接成功 (${res.latencyMs}ms) · 模型返回: ${res.reply}`
      };
    } catch (err) {
      state.llmTestFeedback = {
        ok: false,
        text: `❌ 连接失败：${err.message}`
      };
    } finally {
      state.llmTesting = false;
      render();

    }
  });

  document.getElementById('btn-cloud-pull')?.addEventListener('click', async () => {
    state.config = collectSettingsFromDom();
    state.gitSyncing = true;
    state.gitFeedback = null;
    render();

    try {
      const res = await pullFromCloudVault(state.config.vaultGit);
      state.memos = listMemos();
      state.config = getConfig();
      const syncedLabel = (res.syncedProviders || []).join(' + ') || `${res.owner}/${res.repo}`;
      state.gitFeedback = {
        ok: true,
        text: `✅ 已从 [${syncedLabel}] 拉取 ${res.pulledCount} 条云端记录，手机当前共 ${res.mergedCount} 条记录！`
      };
    } catch (err) {
      state.gitFeedback = {
        ok: false,
        text: `❌ 拉取失败：${err.message}`
      };
    } finally {
      state.gitSyncing = false;
      render();

    }
  });

  document.getElementById('btn-cloud-push')?.addEventListener('click', async () => {
    state.config = collectSettingsFromDom();
    state.gitSyncing = true;
    state.gitFeedback = null;
    render();

    try {
      const res = await pushToCloudVault(state.config.vaultGit);
      state.memos = listMemos();
      state.config = getConfig();
      const syncedLabel = (res.syncedProviders || []).join(' + ') || `${res.owner}/${res.repo}`;
      state.gitFeedback = {
        ok: true,
        text: `🎉 已将手机与云端合并后的 ${res.pushedTotal} 条记录同步推送至 [${syncedLabel}]！`
      };
    } catch (err) {
      state.gitFeedback = {
        ok: false,
        text: `❌ 推送失败：${err.message}`
      };
    } finally {
      state.gitSyncing = false;
      render();

    }
  });

  document.getElementById('btn-export-json')?.addEventListener('click', () => {
    const data = JSON.stringify(state.memos, null, 2);
    const fileName = `quick-memo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (window.AndroidNative && typeof window.AndroidNative.saveFileToDownloads === 'function') {
      window.AndroidNative.saveFileToDownloads(fileName, data);
      return;
    }
    const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  document.getElementById('btn-clear-cache-sync')?.addEventListener('click', async () => {
    clearLocalMemosCache();
    state.memos = [];
    state.gitSyncing = true;
    render();
    try {
      const res = await refreshAndSyncVault();
      state.memos = listMemos();
      state.config = getConfig();
      state.gitFeedback = {
        ok: true,
        text: `🧹 本地缓存已清空并重新同步完成（当前共 ${state.memos.length} 条记录 · ${res.sourceText}）`
      };
    } catch (err) {
      state.memos = listMemos();
      state.gitFeedback = {
        ok: false,
        text: `⚠️ 缓存已清理，但同步提示：${err.message}`
      };
    } finally {
      state.gitSyncing = false;
      render();
    }
  });

  document.getElementById('m-import-json-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('无效的备份文件格式');
      const map = new Map();
      for (const m of [...imported.map((item) => ({ ...item, unsyncedLocal: true })), ...state.memos]) {
        if (m && m.id && !map.has(m.id)) map.set(m.id, m);
      }
      const merged = Array.from(map.values());
      saveMemosList(merged);
      state.memos = merged;
      alert(`✅ 导入成功！当前共 ${merged.length} 条记录，正在自动同步至云端...`);
      render();
      triggerAutoCloudPush(null);
    } catch (err) {
      alert(`导入失败：${err.message}`);
    }
  });

  document.querySelectorAll('[data-copy-text]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const txt = btn.getAttribute('data-copy-text') || '';
      if (!txt) return;
      const origLabel = btn.textContent;
      if (window.AndroidNative && typeof window.AndroidNative.copyToClipboard === 'function') {
        window.AndroidNative.copyToClipboard(txt);
      } else {
        await navigator.clipboard.writeText(txt);
      }
      btn.textContent = '✅ 已复制';
      setTimeout(() => {
        btn.textContent = origLabel;
      }, 1000);
    });
  });

  document.querySelectorAll('[data-open-url]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.getAttribute('data-open-url') || '';
      if (!url) return;
      if (window.AndroidNative && typeof window.AndroidNative.openExternalUrl === 'function') {
        window.AndroidNative.openExternalUrl(url);
      } else {
        window.open(url, '_blank');
      }
    });
  });

  document.querySelectorAll('[data-zoom-qr]').forEach((box) => {
    box.addEventListener('click', () => {
      state.qrPreviewModal = {
        imgUrl: box.getAttribute('data-zoom-qr'),
        title: box.getAttribute('data-zoom-title') || '赞赏支持'
      };
      render();

    });
  });

  document.getElementById('btn-close-qr')?.addEventListener('click', () => {
    state.qrPreviewModal = null;
    render();

  });

  document.getElementById('m-qr-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'm-qr-backdrop') {
      state.qrPreviewModal = null;
      render();
    }
  });

  bindPullToRefreshGesture();
}

window.handleAndroidBack = function () {
  if (state.qrPreviewModal) {
    state.qrPreviewModal = null;
    render();
    return true;
  }
  if (state.precheckModal) {
    state.precheckModal = null;
    render();
    return true;
  }
  if (state.detailMemoId) {
    state.detailMemoId = null;
    render();
    return true;
  }
  if (state.activeTab !== 'capture') {
    state.activeTab = 'capture';
    render();
    return true;
  }
  return false;
};

let lastAutoStartupSyncAt = 0;

async function bootstrapCloudSyncOnStartup() {
  const providers = getConfiguredCloudProviders(state.config?.vaultGit);
  if (providers.length === 0) {
    // 未配置云端时仍尝试局域网兜底同步
    try {
      await refreshAndSyncVault();
      state.memos = listMemos();
      state.config = getConfig();
      render();
    } catch {}
    return;
  }
  lastAutoStartupSyncAt = Date.now();
  await handlePullToRefresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = Date.now();
    if (now - lastAutoStartupSyncAt > 20000) {
      lastAutoStartupSyncAt = now;
      handlePullToRefresh();
    }
  }
});

render();
bootstrapCloudSyncOnStartup();