import { getConfig, listMemos, sanitizeFileName } from './storage.js';

export function normalizeBaseUrl(rawUrl = '') {
  let clean = String(rawUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  clean = clean.replace(/\/chat\/completions$/i, '').replace(/\/v1$/i, '');
  return `${clean}/v1/chat/completions`;
}

export function normalizeModelName(baseUrl = '', model = '') {
  const m = String(model || '').trim();
  const isDeepSeekOfficial = /api\.deepseek\.com/i.test(baseUrl);
  if (isDeepSeekOfficial && (!m || /^deepseek-(flash|v4|v3|pro)/i.test(m))) {
    return 'deepseek-chat';
  }
  return m || 'deepseek-chat';
}

/**
 * 手机端离线/无 Key 时的智能启发式规则分类兜底
 */
export function heuristicClassify({ content = '', attachments = [] }) {
  const config = getConfig();
  const categories = config.categories || [];
  const text = String(content || '').trim();
  const lower = text.toLowerCase();

  let category = '01-灵感与备忘';
  const tags = [];

  if (attachments.some((a) => (a.mimeType || '').startsWith('image/'))) {
    category = '05-截图与视觉';
    tags.push('图片截图');
  } else if (attachments.length > 0) {
    category = '06-资料与文档';
    tags.push('文档附件');
  } else if (/^https?:\/\/\S+/i.test(text) || lower.includes('github.com') || lower.includes('http://') || lower.includes('https://')) {
    category = '03-精读与链接';
    tags.push('网址收藏');
  } else if (
    /\bsk-[a-zA-Z0-9_-]{12,}\b/.test(text) ||
    lower.includes('api key') ||
    lower.includes('apikey') ||
    lower.includes('token')
  ) {
    category = '04-工作与待办';
    tags.push('API密钥');
  } else if (
    text.includes('```') ||
    /\b(function|const|import|export|SELECT|docker|npm|git|python|rust)\b/.test(text)
  ) {
    category = '02-技术与代码';
    tags.push('技术笔记');
  } else if (/(待办|todo|计划|会议|周报|截止|任务)/i.test(text)) {
    category = '04-工作与待办';
    tags.push('待办事项');
  }

  if (!categories.some((c) => c.id === category) && categories.length > 0) {
    category = categories[0].id;
  }

  let title = '';
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  if (firstLine) {
    title = firstLine.replace(/^[#>*\-\s]+/, '').slice(0, 32);
  } else if (attachments.length > 0) {
    title = `附件归档：${attachments[0].name}`;
  } else {
    title = '手机随手记';
  }

  const summary = text
    ? text.replace(/\s+/g, ' ').slice(0, 80)
    : `包含 ${attachments.length} 个附件（${attachments.map((a) => a.name).join('、')}）`;

  return {
    category,
    title: sanitizeFileName(title),
    summary,
    tags: tags.length > 0 ? tags : ['随手记'],
    aiClassified: false
  };
}

/**
 * 测试 OpenAI 兼容接口连接
 */
export async function testLlmConnection(llmOverride = null) {
  const cfg = llmOverride || getConfig().llm;
  const endpoint = normalizeBaseUrl(cfg.baseUrl);
  const model = normalizeModelName(cfg.baseUrl, cfg.model);
  const apiKey = String(cfg.apiKey || '').trim();

  if (!apiKey) {
    throw new Error('请先填写有效的 API Key');
  }

  const start = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '请只回复 OK 两个字母' }],
      max_tokens: 12,
      temperature: 0
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 140)}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || 'OK';
  return {
    ok: true,
    latencyMs: Date.now() - start,
    endpoint,
    model,
    reply
  };
}

/**
 * 调用 OpenAI 兼容大模型进行智能分类、生成标题、摘要与标签
 */
export async function classifyWithLLM({ content = '', attachments = [] }) {
  const config = getConfig();
  const llm = config.llm || {};
  const fallback = heuristicClassify({ content, attachments });

  if (!llm.enabled || !String(llm.apiKey || '').trim()) {
    return fallback;
  }

  const endpoint = normalizeBaseUrl(llm.baseUrl);
  const model = normalizeModelName(llm.baseUrl, llm.model);
  const catDescriptions = (config.categories || [])
    .map((c) => `- "${c.id}" (${c.name}): ${c.desc || ''}`)
    .join('\n');

  const attSummary = attachments
    .map((a, i) => `附件${i + 1}: 文件名="${a.name}", 类型="${a.mimeType}", 大小=${a.size}B`)
    .join('\n');

  const sysPrompt = [
    '你是 QuickMemo 移动端的本地知识库智能整理助手。请根据用户输入的闪念文本或附件信息，将其归入最合适的一个分类目录，并提炼清晰的中文标题、一句话摘要与 2~4 个简短标签。',
    '可选分类目录如下（category 字段必须严格返回以下双引号内的 id）：',
    catDescriptions,
    llm.customSystemPrompt ? `用户补充偏好：${llm.customSystemPrompt}` : '',
    '请严格只返回一个合法的 JSON 对象，不要输出任何 Markdown 代码块标记，格式如下：',
    '{"category":"分类ID","title":"简明中文标题(不超过28字)","summary":"一句话核心摘要(不超过80字)","tags":["标签1","标签2"]}'
  ].filter(Boolean).join('\n\n');

  const userPrompt = [
    content ? `【用户输入正文】\n${String(content).slice(0, 3500)}` : '（无正文文本）',
    attSummary ? `【附带文件列表】\n${attSummary}` : ''
  ].filter(Boolean).join('\n\n');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(llm.apiKey).trim()}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2
      })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const rawReply = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('模型未返回有效 JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validCat = (config.categories || []).some((c) => c.id === parsed.category)
      ? parsed.category
      : fallback.category;

    return {
      category: validCat,
      title: sanitizeFileName(parsed.title || fallback.title),
      summary: String(parsed.summary || fallback.summary).slice(0, 140),
      tags: Array.isArray(parsed.tags) && parsed.tags.length > 0
        ? parsed.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 5)
        : fallback.tags,
      aiClassified: true
    };
  } catch (err) {
    console.warn('[AI Classify Fallback]', err);
    return {
      ...fallback,
      errorWarning: err.message
    };
  }
}

/**
 * 手机端闪念寻物对话助手（本地全文检索 + LLM 回答）
 */
export async function askMobileVaultAssistant({ message = '', history = [] }) {
  const memos = listMemos();
  const q = String(message || '').trim().toLowerCase();
  const keywords = q
    .replace(/[？?！!，,。、：:；;“”"']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 1);

  const scored = memos.map((m) => {
    const hay = [
      m.title,
      m.summary,
      m.content,
      m.category,
      ...(m.tags || []),
      ...(m.attachments || []).map((a) => a.name)
    ].join(' ').toLowerCase();

    let score = 0;
    if (hay.includes(q)) score += 10;
    for (const kw of keywords) {
      if (kw.length >= 2 && hay.includes(kw)) score += 4;
    }
    if (/key|密钥|token|密码/i.test(q) && /\bsk-|ghp_|token|key/i.test(hay)) {
      score += 8;
    }
    return { memo: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topHits = scored.filter((s) => s.score > 0).slice(0, 5).map((s) => s.memo);
  const contextMemos = topHits.length > 0 ? topHits : memos.slice(0, 5);

  const sources = contextMemos.slice(0, 3).map((m) => ({
    memoId: m.id,
    title: m.title,
    category: m.category,
    snippet: (m.content || m.summary || '').slice(0, 120)
  }));

  const config = getConfig();
  const llm = config.llm || {};

  if (!llm.enabled || !String(llm.apiKey || '').trim()) {
    if (topHits.length === 0) {
      return {
        reply: `当前本地收录了 **${memos.length}** 条闪念，未直接匹配到关键词「${message}」。建议在设置页填入 API Key 开启 AI 深度语义寻物。`,
        sources: [],
        aiUsed: false
      };
    }
    const listText = topHits
      .map((m, i) => `${i + 1}. **${m.title}**（📂 \`${m.category}\`）\n${(m.content || m.summary || '').slice(0, 180)}`)
      .join('\n\n');
    return {
      reply: `为你从手机本地库中找到以下 **${topHits.length}** 条相关记录：\n\n${listText}`,
      sources,
      aiUsed: false
    };
  }

  const contextBlock = contextMemos
    .map((m, i) => `【记录 ${i + 1}】标题：${m.title} | 分类：${m.category} | 时间：${m.createdAt} | 标签：${(m.tags || []).join(',')}\n正文：${(m.content || m.summary || '').slice(0, 900)}`)
    .join('\n\n---\n\n');

  const endpoint = normalizeBaseUrl(llm.baseUrl);
  const model = normalizeModelName(llm.baseUrl, llm.model);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(llm.apiKey).trim()}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: '你是 QuickMemo 手机端的「闪念寻物助手」。请基于下方提供的用户本地知识库记录，精准回答用户的寻物或细节提问。如果记录中包含 API Key、网址或命令，请用 ``` 代码块包裹以便用户在手机上一键复制。'
          },
          ...history.slice(-4),
          {
            role: 'user',
            content: `【本地知识库检索上下文（共 ${memos.length} 篇）】\n${contextBlock || '（当前知识库为空）'}\n\n【用户问题】\n${message}`
          }
        ],
        temperature: 0.3
      })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || '已完成检索。';
    return {
      reply,
      sources,
      aiUsed: true
    };
  } catch (err) {
    return {
      reply: topHits.length > 0
        ? `⚠️ LLM 接口连接异常（${err.message}），已为你通过本地全文索引定位到 **${topHits.length}** 条记录，请点击下方卡片查看。`
        : `⚠️ 检索请求失败：${err.message}`,
      sources,
      aiUsed: false
    };
  }
}
