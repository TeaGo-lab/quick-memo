import { getConfig } from './vault-manager.js';
import { callOpenAISdkChat } from './llm-classifier.js';
import { searchDocIndex } from './doc-indexer.js';

/**
 * 从命中片段中截取围绕关键词的高亮摘要段落
 */
function buildBestSnippet(chunks = [], queryTokens = [], fallbackSummary = '') {
  if (!chunks || chunks.length === 0) {
    return { sourceLabel: '记录摘要', snippet: fallbackSummary || '无正文内容' };
  }
  const best = chunks[0];
  const raw = String(best.text || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return { sourceLabel: best.sourceLabel || '笔记正文', snippet: fallbackSummary || '' };
  }

  // 找到第一个命中词的位置，截取前后上下文
  const lower = raw.toLowerCase();
  let hitPos = -1;
  for (const tk of queryTokens) {
    const idx = lower.indexOf(tk.toLowerCase());
    if (idx !== -1) {
      hitPos = idx;
      break;
    }
  }

  if (hitPos <= 40) {
    return {
      sourceLabel: best.sourceLabel || '文档片段',
      snippet: raw.slice(0, 220) + (raw.length > 220 ? '...' : '')
    };
  }

  const start = Math.max(0, hitPos - 35);
  const slice = raw.slice(start, start + 220);
  return {
    sourceLabel: best.sourceLabel || '文档片段',
    snippet: (start > 0 ? '...' : '') + slice + (start + 220 < raw.length ? '...' : '')
  };
}

/**
 * 当未配置 LLM Key 或接口报错（如 401）时，基于全文文档索引生成自然流畅的对话式检索回答
 */
function buildLocalGroundedReply({ message, results, queryTokens, isOverviewQuery, stats }) {
  if (stats.totalDocs === 0) {
    return '你的闪念收纳盒目前还是空的，快去「随手丢入」粘贴一段文字、链接或拖入 PDF 文档吧！';
  }

  const realMatches = results.filter((r) => r.score > 1);

  if (isOverviewQuery || realMatches.length === 0) {
    const header = isOverviewQuery
      ? `📚 我帮你盘点了当前已建立索引的 **${stats.totalDocs} 条记录**（共 **${stats.totalChunks} 个文档片段**，含 **${stats.totalAttachmentFiles} 个附件**）：`
      : `🔍 在已索引的 ${stats.totalDocs} 篇文档中没有找到完全包含「${message}」的字面词条，但我为你列出了收纳盒中最近的记录：`;

    const lines = results.map((item, idx) => {
      const d = item.doc;
      const attInfo = (d.attachments || []).length > 0
        ? ` · 📎 附件：${d.attachments.map((a) => a.name).join('、')}`
        : '';
      const best = buildBestSnippet(item.matchedChunks, queryTokens, d.summary);
      return `${idx + 1}. **《${d.title}》**（📂 \`${d.category}\`${attInfo}）\n   > ${best.sourceLabel}：${best.snippet}`;
    });

    return [
      header,
      '',
      ...lines,
      '',
      '💡 你可以直接点击下方卡片的 **「查看详情」** 或 **「📕 预览 PDF」** 打开对应文件。'
    ].join('\n');
  }

  const top = realMatches[0];
  const topBest = buildBestSnippet(top.matchedChunks, queryTokens, top.doc.summary);

  const lines = [
    `🎯 找到了！在你的收纳盒索引中共匹配到 **${realMatches.length} 条相关内容**，最相关的是：`,
    ''
  ];

  realMatches.slice(0, 4).forEach((item, idx) => {
    const d = item.doc;
    const best = buildBestSnippet(item.matchedChunks, queryTokens, d.summary);
    const attNames = (d.attachments || []).map((a) => a.name).join('、');
    lines.push(
      `${idx + 1}. **《${d.title}》** · 归档于 \`${d.category}\`${attNames ? ` · 附件：\`${attNames}\`` : ''}`,
      `   - **命中位置**：${best.sourceLabel}`,
      `   - **相关内容**：${best.snippet}`,
      ''
    );
  });

  if (realMatches.length === 1 && top.matchedChunks.length > 1) {
    const secondChunk = top.matchedChunks[1];
    const extraText = String(secondChunk.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (extraText && extraText !== topBest.snippet) {
      lines.push(`📄 **文档内更多细节（${secondChunk.sourceLabel}）**：\n> ${extraText}...`, '');
    }
  }

  lines.push('👇 点击下方引用卡片即可直接定位到该记录或全屏预览 PDF：');
  return lines.join('\n');
}

/**
 * 对话式知识库寻物与文档问答入口
 */
export async function askVaultAssistant({ message = '', history = [] }) {
  const cleanMsg = String(message || '').trim();
  if (!cleanMsg) {
    throw new Error('请输入你要查找或询问的内容');
  }

  const { results, queryTokens, isOverviewQuery, stats } = searchDocIndex(cleanMsg, 5);

  // 组装前端可点击跳转的引用卡片数据源（如果存在标题与附件完全相同的重复归档，自动去重保留最新一条）
  const seenSourceKeys = new Set();
  const dedupedResults = [];
  for (const item of results) {
    const d = item.doc;
    const attKey = (d.attachments || []).map((a) => a.name).join('|');
    const dedupKey = `${d.title}::${d.category}::${attKey}`;
    if (seenSourceKeys.has(dedupKey)) continue;
    seenSourceKeys.add(dedupKey);
    dedupedResults.push(item);
  }

  const sources = dedupedResults.map((item) => {
    const d = item.doc;
    const best = buildBestSnippet(item.matchedChunks, queryTokens, d.summary);
    const pdfAtt = (d.attachments || []).find(
      (a) =>
        (a.mimeType || '').toLowerCase() === 'application/pdf' ||
        String(a.name || '').toLowerCase().endsWith('.pdf')
    );

    return {
      memoId: d.memoId,
      title: d.title,
      category: d.category,
      type: d.type,
      createdAt: d.createdAt,
      tags: d.tags || [],
      mdAbsPath: d.mdAbsPath,
      sourceLabel: best.sourceLabel,
      snippet: best.snippet,
      score: item.score,
      attachments: d.attachments || [],
      pdfAttachment: pdfAtt
        ? {
            name: pdfAtt.name,
            absPath: pdfAtt.absPath
          }
        : null
    };
  });

  const config = getConfig();
  const llmCfg = config.llm || {};
  const canUseLlm = Boolean(
    llmCfg.enabled &&
    llmCfg.baseUrl &&
    (llmCfg.apiKey || llmCfg.providerPreset === 'ollama')
  );

  // 构建给大模型的检索上下文 (RAG Grounded Context)
  const contextBlocks = dedupedResults.map((item, i) => {
    const d = item.doc;
    const attDesc = (d.attachments || []).length > 0
      ? d.attachments.map((a) => `${a.name} (${a.extractedChars || 0}字)`).join(', ')
      : '无附件';
    const chunkText = (item.matchedChunks || [])
      .map((c) => `  [${c.sourceLabel}]:\n  ${c.text}`)
      .join('\n\n');

    return `【文档 #${i + 1}】
- 标题：${d.title}
- 分类目录：${d.category}
- 保存时间：${d.createdAt}
- 标签：${(d.tags || []).join(', ') || '无'}
- 附件列表：${attDesc}
- 检索命中的内部原文片段：
${chunkText || d.summary || '（无正文）'}`;
  }).join('\n\n---\n\n');

  if (canUseLlm) {
    const systemPrompt = `你是 QuickMemo（闪念与文件收纳盒）的内置 AI 寻物与知识库问答助手。
用户通过聊天向你寻找以前保存过的笔记、链接、代码或 PDF/Word 文档内容。
当前收纳盒已建立全文索引：共 ${stats.totalDocs} 篇记录、${stats.totalChunks} 个文本片段。

请严格遵守以下回答准则：
1. **基于检索证据回答**：优先依据下方【检索到的本地文档与 PDF 内部片段】回答用户问题。
2. **明确指出来源**：回答时请自然地写出对应的记录标题（如《xxx》）、所在分类目录（如 \`06-资料与文档\`）或附件文件名，方便用户核对。
3. **直接提炼干货**：如果用户问某个文档里面讲了什么（例如提示词内容、步骤、工具、代码），请直接把文档片段里的核心信息整理出来告诉用户，不要只说“找到了”。
4. **简洁友好**：使用清晰的 Markdown 列表或分段，语气自然干练。

【检索到的本地文档与 PDF 内部片段】：
${contextBlocks || '（当前收纳盒暂无记录）'}`;

    const recentHistory = Array.isArray(history)
      ? history
          .slice(-6)
          .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
          .map((h) => ({ role: h.role, content: String(h.content).slice(0, 1200) }))
      : [];

    try {
      const { completion } = await callOpenAISdkChat({
        baseUrl: llmCfg.baseUrl,
        apiKey: llmCfg.apiKey,
        model: llmCfg.model,
        timeoutMs: 22000,
        messages: [
          { role: 'system', content: systemPrompt },
          ...recentHistory,
          { role: 'user', content: cleanMsg }
        ]
      });

      const aiReply = completion?.choices?.[0]?.message?.content?.trim();
      if (aiReply) {
        return {
          reply: aiReply,
          sources,
          stats,
          aiUsed: true
        };
      }
    } catch (err) {
      console.warn('[ChatAssistant] LLM call failed, falling back to local index reply:', err.message);
      const fallbackReply = buildLocalGroundedReply({
        message: cleanMsg,
        results,
        queryTokens,
        isOverviewQuery,
        stats
      });
      return {
        reply: fallbackReply,
        sources,
        stats,
        aiUsed: false,
        errorWarning: err.message
      };
    }
  }

  const localReply = buildLocalGroundedReply({
    message: cleanMsg,
    results,
    queryTokens,
    isOverviewQuery,
    stats
  });

  return {
    reply: localReply,
    sources,
    stats,
    aiUsed: false
  };
}
