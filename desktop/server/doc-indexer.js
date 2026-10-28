import fs from 'node:fs';
import path from 'node:path';
import { getConfig, listMemos } from './vault-manager.js';
import { extractFileContent } from './file-extractor.js';

const INDEX_VERSION = 1;

// 常见中文对话停用词与寒暄词（用于从自然语言提问中提炼核心检索词）
const STOP_PHRASES = [
  '帮我找一下', '帮我找找', '帮我查一下', '帮我看看', '请问一下', '我想找一下', '我想找',
  '能不能找', '帮我搜索', '搜索一下', '查找一下', '之前保存的', '我保存的', '我存的',
  '收纳盒里', '知识库里', '有没有关于', '有没有', '关于', '相关的', '相关的文件',
  '相关的文档', '在哪儿', '在哪里', '在哪', '是什么', '有哪些', '讲了什么', '写了什么',
  '怎么说的', '里提到', '里面有', '的文档', '的文件', '的笔记', '文档', '文件', '笔记',
  '记录', '资料', '请问', '一下'
];

const STOP_CHARS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '哦', '哈', '是', '在', '有', '和', '与',
  '及', '或', '把', '被', '让', '给', '向', '往', '从', '到', '于', '也', '都', '就',
  '还', '又', '再', '能', '会', '可', '要', '想', '去', '来', '这', '那', '哪', '个',
  '些', '条', '篇', '份', '中', '里', '上', '下', '我', '你', '他', '它', '们', '么',
  '什', '怎', '样', '何', '为'
]);

function getDocIndexPath(vaultPath) {
  return path.join(vaultPath, '.quick-memo-doc-index.json');
}

function nowFormatted() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function readRawDocIndex(vaultPath) {
  const idxPath = getDocIndexPath(vaultPath);
  try {
    if (fs.existsSync(idxPath)) {
      const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
      if (parsed && parsed.version === INDEX_VERSION && parsed.docs && typeof parsed.docs === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[DocIndexer] Failed to read doc index:', err.message);
  }
  return {
    version: INDEX_VERSION,
    lastIndexedAt: '',
    docs: {}
  };
}

export function writeRawDocIndex(vaultPath, data) {
  const idxPath = getDocIndexPath(vaultPath);
  data.lastIndexedAt = nowFormatted();
  fs.writeFileSync(idxPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 计算单条 Memo 的变更签名，判断是否需要重新提取 PDF/Word 附件文本
 */
function computeMemoSignature(memo) {
  const attSig = (memo.attachments || [])
    .map((a) => `${a.name || ''}:${a.absPath || ''}:${a.size || 0}`)
    .join('|');
  return [
    memo.id,
    memo.title || '',
    memo.category || '',
    memo.summary || '',
    (memo.tags || []).join(','),
    (memo.content || '').length,
    attSig
  ].join('::');
}

/**
 * 将长文本切分为带重叠的检索片段 (Chunks)，便于精准引用段落
 */
export function splitTextIntoChunks(text = '', sourceLabel = '正文', chunkSize = 420, overlap = 80) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  // 先按自然段落聚合
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length <= chunkSize) {
      current = current ? `${current}\n\n${para}` : para;
    } else {
      if (current) {
        chunks.push({ sourceLabel, text: current });
      }
      if (para.length <= chunkSize) {
        current = para;
      } else {
        // 超长段落按固定窗口切分
        let start = 0;
        while (start < para.length) {
          const slice = para.slice(start, start + chunkSize);
          chunks.push({ sourceLabel, text: slice });
          if (start + chunkSize >= para.length) break;
          start += chunkSize - overlap;
        }
        current = '';
      }
    }
  }
  if (current) {
    chunks.push({ sourceLabel, text: current });
  }
  return chunks;
}

/**
 * 中英混合分词器：提取英文/数字词元 + 中文单字/双字(bigram)/三字词组
 */
export function tokenizeText(raw = '', removeStopWords = false) {
  let text = String(raw || '').toLowerCase();
  if (removeStopWords) {
    for (const phrase of STOP_PHRASES) {
      text = text.split(phrase).join(' ');
    }
  }

  const tokens = new Set();

  // 1. 提取英文单词、数字型号（如 3d, blender, v0.2, pdf, tauri, gpt-4o）
  const wordMatches = text.match(/[a-z0-9][a-z0-9._-]{0,24}/g) || [];
  for (const w of wordMatches) {
    if (w.length >= 2 || /\d/.test(w)) {
      tokens.add(w);
    }
  }

  // 2. 提取连续中文字符块，生成二元词 (Bigram)、三元词 (Trigram) 与关键连续词
  const cjkBlocks = text.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const block of cjkBlocks) {
    const filteredChars = Array.from(block).filter((ch) => !removeStopWords || !STOP_CHARS.has(ch));
    const cleanBlock = filteredChars.join('');
    if (!cleanBlock) continue;

    if (cleanBlock.length <= 4 && cleanBlock.length >= 2) {
      tokens.add(cleanBlock);
    }
    for (let i = 0; i < cleanBlock.length - 1; i++) {
      tokens.add(cleanBlock.slice(i, i + 2));
    }
    for (let i = 0; i < cleanBlock.length - 2; i++) {
      tokens.add(cleanBlock.slice(i, i + 3));
    }
    // 如果词很短（如单个核心汉字），也保留
    if (cleanBlock.length === 1) {
      tokens.add(cleanBlock);
    }
  }

  return Array.from(tokens);
}

/**
 * 为单条 Memo 构建完整索引条目（含附件 PDF/Word 全文提取与分块）
 */
export function buildDocEntryForMemo(memo) {
  const chunks = [];
  const indexedAttachments = [];
  let totalChars = 0;

  // 1. 索引元数据与正文内容
  const metaHeader = [
    `标题：${memo.title || ''}`,
    `分类：${memo.category || ''}`,
    memo.tags && memo.tags.length > 0 ? `标签：${memo.tags.join('、')}` : '',
    memo.summary ? `摘要：${memo.summary}` : ''
  ].filter(Boolean).join('\n');

  const cleanContent = String(memo.content || '')
    .replace(/^### 📄 文档内容提取预览\s*/m, '')
    .trim();

  if (cleanContent) {
    const contentChunks = splitTextIntoChunks(cleanContent, '笔记正文');
    chunks.push(...contentChunks);
    totalChars += cleanContent.length;
  } else if (metaHeader) {
    chunks.push({ sourceLabel: '记录摘要', text: metaHeader });
    totalChars += metaHeader.length;
  }

  // 2. 深度提取每个附件（PDF / Word / TXT / MD / 代码）的全文并分块索引
  for (const att of memo.attachments || []) {
    const absPath = att.absPath || '';
    const extracted = extractFileContent({
      name: att.name,
      mimeType: att.mimeType,
      absPath,
      maxChars: 20000,
      maxPages: 25
    });

    const fullAttText = (extracted.extractedText || '').trim();
    if (fullAttText) {
      // 避免与正文里的预览完全重复，如果附件全文比正文更长或是独立文件，单独按附件名建块
      const attChunks = splitTextIntoChunks(fullAttText, `附件《${att.name}》`);
      chunks.push(...attChunks);
      totalChars += fullAttText.length;
    }

    indexedAttachments.push({
      name: att.name,
      relPath: att.relPath,
      absPath,
      mimeType: att.mimeType || '',
      size: att.size || 0,
      pageCount: extracted.pageCount || 0,
      extractedChars: fullAttText.length
    });
  }

  // 3. 深度索引抓取到的网页链接正文内容
  for (const page of memo.webPages || []) {
    const pageText = [
      page.title ? `网页标题：${page.title}` : '',
      page.description ? `网页描述：${page.description}` : '',
      page.extractedText || ''
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    if (pageText) {
      const label = `网页《${(page.title || page.url || '链接').slice(0, 32)}》`;
      const pageChunks = splitTextIntoChunks(pageText, label);
      chunks.push(...pageChunks);
      totalChars += pageText.length;
    }
  }

  // 去重完全一致的 chunk
  const uniqueChunks = [];
  const seenTexts = new Set();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const norm = c.text.replace(/\s+/g, ' ').trim();
    if (!norm || seenTexts.has(norm)) continue;
    seenTexts.add(norm);
    uniqueChunks.push({
      chunkId: `${memo.id}#${uniqueChunks.length}`,
      sourceLabel: c.sourceLabel,
      text: c.text,
      tokens: tokenizeText(c.text, false)
    });
  }

  const allMetaText = [
    memo.title,
    memo.category,
    memo.summary,
    ...(memo.tags || []),
    ...indexedAttachments.map((a) => a.name),
    ...(memo.webPages || []).map((p) => `${p.title || ''} ${p.url || ''}`)
  ].filter(Boolean).join(' ');

  return {
    memoId: memo.id,
    title: memo.title || '未命名',
    category: memo.category || '99-收件箱',
    type: memo.type || 'text',
    summary: memo.summary || '',
    tags: memo.tags || [],
    createdAt: memo.createdAt || '',
    mdRelPath: memo.mdRelPath || '',
    mdAbsPath: memo.mdAbsPath || '',
    attachments: indexedAttachments,
    fullTextLength: totalChars,
    metaTokens: tokenizeText(allMetaText, false),
    chunks: uniqueChunks,
    updatedSignature: computeMemoSignature(memo)
  };
}

/**
 * 确保文档索引与当前 Vault 中的所有 Memo 同步（增量更新，秒级完成）
 */
export function ensureDocIndexSynced() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const memos = listMemos();
  const rawIndex = readRawDocIndex(vaultPath);

  const currentIds = new Set(memos.map((m) => m.id));
  let mutated = false;

  // 移除已删除的记录
  for (const existingId of Object.keys(rawIndex.docs)) {
    if (!currentIds.has(existingId)) {
      delete rawIndex.docs[existingId];
      mutated = true;
    }
  }

  // 新增或更新有变化的记录
  for (const memo of memos) {
    const sig = computeMemoSignature(memo);
    const existing = rawIndex.docs[memo.id];
    if (!existing || existing.updatedSignature !== sig) {
      rawIndex.docs[memo.id] = buildDocEntryForMemo(memo);
      mutated = true;
    }
  }

  if (mutated || !rawIndex.lastIndexedAt) {
    writeRawDocIndex(vaultPath, rawIndex);
  }

  return rawIndex;
}

/**
 * 强制全量重建所有文档索引
 */
export function rebuildDocIndex() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const memos = listMemos();
  const docs = {};

  for (const memo of memos) {
    docs[memo.id] = buildDocEntryForMemo(memo);
  }

  const nextIndex = {
    version: INDEX_VERSION,
    lastIndexedAt: nowFormatted(),
    docs
  };
  writeRawDocIndex(vaultPath, nextIndex);
  return getDocIndexStatus(nextIndex);
}

/**
 * 立即更新单条记录的文档索引
 */
export function indexSingleMemo(memo) {
  if (!memo || !memo.id) return;
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const rawIndex = readRawDocIndex(vaultPath);
  rawIndex.docs[memo.id] = buildDocEntryForMemo(memo);
  writeRawDocIndex(vaultPath, rawIndex);
}

/**
 * 从文档索引中移除单条记录
 */
export function removeMemoFromDocIndex(memoId) {
  if (!memoId) return;
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const rawIndex = readRawDocIndex(vaultPath);
  if (rawIndex.docs[memoId]) {
    delete rawIndex.docs[memoId];
    writeRawDocIndex(vaultPath, rawIndex);
  }
}

/**
 * 获取当前文档索引统计信息
 */
export function getDocIndexStatus(preloadedIndex = null) {
  const idx = preloadedIndex || ensureDocIndexSynced();
  const docList = Object.values(idx.docs || {});
  let totalChunks = 0;
  let totalAttachmentFiles = 0;
  let totalChars = 0;

  for (const doc of docList) {
    totalChunks += (doc.chunks || []).length;
    totalAttachmentFiles += (doc.attachments || []).length;
    totalChars += doc.fullTextLength || 0;
  }

  return {
    totalDocs: docList.length,
    totalChunks,
    totalAttachmentFiles,
    totalChars,
    lastIndexedAt: idx.lastIndexedAt || nowFormatted()
  };
}

/**
 * 混合全文 + 切片检索（支持自然语言提问分词、标题/文件名加权、PDF 内部段落命中高亮）
 */
export function searchDocIndex(query = '', topK = 5) {
  const idx = ensureDocIndexSynced();
  const docList = Object.values(idx.docs || {});
  const stats = getDocIndexStatus(idx);

  if (docList.length === 0) {
    return { results: [], queryTokens: [], isOverviewQuery: false, stats };
  }

  const rawQuery = String(query || '').trim();
  const queryTokens = tokenizeText(rawQuery, true);

  // 判断是否为“全局盘点/概览型问题”（例如“我存了哪些文件？”“最近保存了什么？”“总结一下我的知识库”）
  const isOverviewQuery =
    queryTokens.length === 0 ||
    /哪些文件|哪些文档|哪些记录|有什么内容|存了什么|保存了什么|全部记录|所有文件|盘点|汇总|列表/i.test(rawQuery);

  const scoredDocs = [];

  for (const doc of docList) {
    let docScore = 0;
    const matchedKeywords = new Set();

    const titleLower = (doc.title || '').toLowerCase();
    const catLower = (doc.category || '').toLowerCase();
    const summaryLower = (doc.summary || '').toLowerCase();
    const tagsLower = (doc.tags || []).map((t) => t.toLowerCase()).join(' ');
    const attNamesLower = (doc.attachments || []).map((a) => (a.name || '').toLowerCase()).join(' ');

    // 针对类型意图词加权（例如用户问“哪个 PDF”、“链接”、“网址”、“图片”、“代码”）
    if (/pdf|文档|资料|宣传片|报告/i.test(rawQuery) && attNamesLower.includes('.pdf')) {
      docScore += 10;
    }
    if (/链接|网址|网站|github|仓库/i.test(rawQuery) && (doc.type === 'link' || catLower.includes('链接'))) {
      docScore += 10;
    }
    if (/代码|脚本|命令|技术|提示词|prompt/i.test(rawQuery) && (doc.type === 'code' || catLower.includes('技术') || tagsLower.includes('提示词'))) {
      docScore += 8;
    }

    for (const token of queryTokens) {
      const weight = token.length >= 3 ? 2.2 : 1.2;
      if (titleLower.includes(token)) {
        docScore += 10 * weight;
        matchedKeywords.add(token);
      }
      if (attNamesLower.includes(token)) {
        docScore += 10 * weight;
        matchedKeywords.add(token);
      }
      if (tagsLower.includes(token)) {
        docScore += 8 * weight;
        matchedKeywords.add(token);
      }
      if (catLower.includes(token)) {
        docScore += 5 * weight;
        matchedKeywords.add(token);
      }
      if (summaryLower.includes(token)) {
        docScore += 4 * weight;
        matchedKeywords.add(token);
      }
    }

    // 对文档内部的每个 Chunk 进行评分，找出最能回答问题的具体片段
    const scoredChunks = [];
    for (const chunk of doc.chunks || []) {
      let cScore = 0;
      const chunkLower = (chunk.text || '').toLowerCase();
      for (const token of queryTokens) {
        if (chunkLower.includes(token)) {
          cScore += token.length >= 3 ? 5 : 2.5;
          matchedKeywords.add(token);
        }
      }
      if (cScore > 0 || isOverviewQuery) {
        scoredChunks.push({
          chunkId: chunk.chunkId,
          sourceLabel: chunk.sourceLabel,
          text: chunk.text,
          score: cScore
        });
      }
    }

    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.slice(0, 3);
    const bestChunkScore = topChunks.reduce((sum, c) => sum + c.score, 0);
    const totalScore = docScore + bestChunkScore;

    if (totalScore > 0 || isOverviewQuery) {
      scoredDocs.push({
        doc,
        score: totalScore,
        matchedKeywords: Array.from(matchedKeywords).slice(0, 8),
        matchedChunks: topChunks.length > 0 ? topChunks : (doc.chunks || []).slice(0, 2)
      });
    }
  }

  // 如果用户提问非常口语化导致切词未直接命中，回退返回最近保存的记录供大模型判断
  if (scoredDocs.length === 0) {
    for (const doc of docList.slice(0, topK)) {
      scoredDocs.push({
        doc,
        score: 1,
        matchedKeywords: [],
        matchedChunks: (doc.chunks || []).slice(0, 2)
      });
    }
  }

  scoredDocs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.doc.createdAt || '').localeCompare(String(a.doc.createdAt || ''));
  });

  // 相对相关性阈值过滤：如果第一名是强匹配，过滤掉只因边缘字擦边而得分极低的无关记录
  let filteredDocs = scoredDocs;
  if (!isOverviewQuery && scoredDocs.length > 1 && scoredDocs[0].score >= 15) {
    const minScoreThreshold = Math.max(8, scoredDocs[0].score * 0.25);
    filteredDocs = scoredDocs.filter((item) => item.score >= minScoreThreshold);
  }

  return {
    results: filteredDocs.slice(0, topK),
    queryTokens,
    isOverviewQuery,
    stats
  };
}
