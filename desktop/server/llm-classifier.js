import path from 'node:path';
let _cachedOpenAI = undefined;
async function getOpenAIConstructor() {
  if (_cachedOpenAI !== undefined) return _cachedOpenAI;
  try {
    const mod = await import('openai');
    _cachedOpenAI = mod.default || mod.OpenAI || null;
  } catch {
    _cachedOpenAI = null;
  }
  return _cachedOpenAI;
}

async function createChatCompletionFallback(baseURL, apiKey, reqParams, timeoutMs) {
  const res = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey || 'ollama'}`
    },
    body: JSON.stringify(reqParams),
    signal: AbortSignal.timeout(timeoutMs || 20000)
  });
  if (!res.ok) {
    let errBody = '';
    try { errBody = await res.text(); } catch {}
    const err = new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}
import { getConfig, sanitizeFileName, detectSecretKeyInfo } from './vault-manager.js';
import { extractFileContent, isMeaninglessFileName } from './file-extractor.js';
import { extractWebPagesFromContent } from './url-extractor.js';

/**
 * 预处理附件：提取 PDF/Word/文本文件的内部正文和标题
 */
export function enrichAttachmentsWithContent(attachments = []) {
  return attachments.map((att) => {
    if (att.extractedText !== undefined) {
      return att;
    }
    const { extractedText, detectedTitle } = extractFileContent(att);
    return {
      ...att,
      extractedText,
      detectedTitle
    };
  });
}

/**
 * 根据原文件名与新文件名生成带正确扩展名的安全文件名
 */
export function normalizeRenamedFile(originalName = '', suggestedName = '') {
  const origExt = path.extname(originalName || '');
  let clean = sanitizeFileName(String(suggestedName || '').trim());
  if (!clean) return originalName;
  if (origExt && !clean.toLowerCase().endsWith(origExt.toLowerCase())) {
    clean = clean.replace(/\.[a-z0-9]{1,5}$/i, '') + origExt;
  }
  return clean;
}

/**
 * 规范化用户输入的 OpenAI 兼容 baseURL，返回可供官方 OpenAI SDK 使用的候选 baseURL 列表
 */
export function buildCandidateBaseURLs(rawBaseUrl = '') {
  let clean = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return [];
  // 如果用户误把 /chat/completions 填进了 Base URL，自动剥离
  clean = clean.replace(/\/chat\/completions$/i, '');

  if (/\/v\d+(?:\/[a-z0-9_-]+)?$/i.test(clean)) {
    return [clean];
  }
  // 如 https://api.deepseek.com 既支持直接拼 /chat/completions，也支持 /v1/chat/completions
  return [clean, `${clean}/v1`];
}

/**
 * 使用官方 openai Node.js SDK 调用兼容接口（自动处理 baseURL 回退与 JSON Mode 兼容）
 */
export async function callOpenAISdkChat({ baseUrl, apiKey, model, messages, jsonMode = false, timeoutMs = 20000 }) {
  const candidates = buildCandidateBaseURLs(baseUrl);
  if (candidates.length === 0) {
    throw new Error('未配置 API Base URL');
  }

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidateBaseURL = candidates[i];
    const OpenAIClass = await getOpenAIConstructor();
    const client = OpenAIClass
      ? new OpenAIClass({
          baseURL: candidateBaseURL,
          apiKey: apiKey || 'ollama',
          timeout: timeoutMs,
          maxRetries: 1
        })
      : {
          chat: {
            completions: {
              create: (params) => createChatCompletionFallback(candidateBaseURL, apiKey, params, timeoutMs)
            }
          }
        };

    try {
      const reqParams = {
        model: model || 'deepseek-flash',
        temperature: 0.2,
        messages
      };
      if (jsonMode) {
        reqParams.response_format = { type: 'json_object' };
      }

      try {
        const completion = await client.chat.completions.create(reqParams);
        return { completion, usedBaseURL: candidateBaseURL };
      } catch (innerErr) {
        // 如果模型不支持 response_format: json_object (HTTP 400)，去掉 response_format 重试一次
        if (jsonMode && innerErr?.status === 400) {
          delete reqParams.response_format;
          const completion = await client.chat.completions.create(reqParams);
          return { completion, usedBaseURL: candidateBaseURL };
        }
        throw innerErr;
      }
    } catch (err) {
      lastError = err;
      // 如果是 404 且还有带 /v1 的备选地址，继续尝试
      if (err?.status === 404 && i < candidates.length - 1) {
        continue;
      }
      break;
    }
  }

  const msg = lastError?.error?.message || lastError?.message || '调用 OpenAI 兼容接口失败';
  throw new Error(msg);
}

/**
 * 阶段一：当用户刚拖入/选择文件上传时，立即提取文件内容并自动生成重命名后的清晰文件名
 */
export async function smartRenameUploadedFile(att, noteText = '') {
  const origName = att.name || '未命名文件';
  const origExt = path.extname(origName);
  const { extractedText, detectedTitle } = extractFileContent(att);
  const config = getConfig();
  const llmCfg = config.llm || {};

  // 先计算基于文档内部真实标题的保底新文件名
  let fallbackName = origName;
  if (detectedTitle) {
    fallbackName = normalizeRenamedFile(origName, detectedTitle);
  } else if (noteText && isMeaninglessFileName(origName)) {
    const firstLine = noteText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    if (firstLine) fallbackName = normalizeRenamedFile(origName, firstLine.slice(0, 28));
  }

  const canUseLlm = Boolean(
    llmCfg.enabled &&
    llmCfg.baseUrl &&
    (llmCfg.apiKey || llmCfg.providerPreset === 'ollama')
  );

  if (!canUseLlm) {
    return {
      originalName: origName,
      newName: fallbackName,
      renamed: fallbackName !== origName,
      extractedText,
      detectedTitle,
      aiUsed: false
    };
  }

  const isImg = (att.mimeType || '').startsWith('image/') && att.dataBase64;
  if (!extractedText && !isImg && !noteText) {
    return {
      originalName: origName,
      newName: fallbackName,
      renamed: fallbackName !== origName,
      extractedText,
      detectedTitle,
      aiUsed: false
    };
  }

  const sysPrompt = `你是专业的文件归档重命名助手。请根据用户上传文件的内部提取文本（或图片内容）及备注，为该文件起一个清晰、准确、便于日后搜索的中文文件名（10~26个字以内，必须保留原扩展名 "${origExt}"）。
请严格只输出 JSON 对象：{"newName": "清晰的新文件名${origExt}"}`;

  const userPrompt = `原文件名：${origName}
用户备注：${noteText || '无'}
文件内部提取文本：
${extractedText ? extractedText.slice(0, 1500) : '（无文本）'}`;

  try {
    const messages = [
      { role: 'system', content: sysPrompt },
      isImg
        ? {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: att.dataBase64.startsWith('data:')
                    ? att.dataBase64
                    : `data:${att.mimeType || 'image/png'};base64,${att.dataBase64}`
                }
              }
            ]
          }
        : { role: 'user', content: userPrompt }
    ];

    const { completion } = await callOpenAISdkChat({
      baseUrl: llmCfg.baseUrl,
      apiKey: llmCfg.apiKey,
      model: llmCfg.model,
      messages,
      jsonMode: true,
      timeoutMs: 12000
    });

    const raw = completion?.choices?.[0]?.message?.content || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.newName) {
        const finalName = normalizeRenamedFile(origName, parsed.newName);
        return {
          originalName: origName,
          newName: finalName,
          renamed: finalName !== origName,
          extractedText,
          detectedTitle,
          aiUsed: true
        };
      }
    }
  } catch (err) {
    console.warn('[SmartRename] Fallback to extracted title rename:', err.message);
  }

  return {
    originalName: origName,
    newName: fallbackName,
    renamed: fallbackName !== origName,
    extractedText,
    detectedTitle,
    aiUsed: false
  };
}

/**
 * 本地启发式规则分类与文件自动重命名（当未配置 API Key 或接口异常时兜底）
 */
export function heuristicClassify({ content = '', attachments = [], webPages = [], categories = [] }) {
  const enriched = enrichAttachmentsWithContent(attachments);
  const userText = String(content || '').trim();
  const extractedTexts = enriched.map((a) => a.extractedText || '').filter(Boolean).join('\n');
  const webTexts = (webPages || [])
    .map((p) => [p.title, p.description, p.extractedText].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  const combinedText = [userText, extractedTexts, webTexts].filter(Boolean).join('\n');

  const hasImage = enriched.some((a) => (a.mimeType || '').startsWith('image/'));
  const hasDoc = enriched.some((a) => !(a.mimeType || '').startsWith('image/'));

  const validCatIds = new Set(categories.map((c) => c.id));
  const pickCat = (preferred, fallback = '99-收件箱') =>
    validCatIds.has(preferred) ? preferred : (categories[0]?.id || fallback);

  let category = pickCat('01-灵感与备忘');
  const tags = new Set();

  if (hasDoc) {
    category = pickCat('06-资料与文档');
    tags.add('文档归档');
    for (const att of enriched) {
      const ext = (att.name || '').split('.').pop()?.toUpperCase();
      if (ext && ext.length <= 6) tags.add(ext);
    }
  } else if (hasImage && userText.length < 30) {
    category = pickCat('05-截图与视觉');
    tags.add('截图');
  }

  const urlMatch = userText.match(/https?:\/\/[^\s)]+/i);
  if (urlMatch) {
    category = pickCat('03-精读与链接');
    tags.add('网页链接');
    try {
      const u = new URL(urlMatch[0]);
      const host = u.hostname.replace(/^www\./, '');
      tags.add(host);
      if (host.includes('github.com')) tags.add('GitHub');
    } catch {}
  }

  const codeIndicators = /```|function\s+\w+|const\s+\w+\s*=|import\s+.*from|def\s+\w+\(|SELECT\s+.*FROM|npm\s+install|git\s+(clone|commit|push)|docker\s+(run|build)|pip\s+install/i;
  if (codeIndicators.test(combinedText)) {
    if (!hasDoc) category = pickCat('02-技术与代码');
    tags.add('代码/技术');
  }

  if (/提示词|Prompt|Claude|GPT|大模型|Agent/i.test(combinedText)) {
    tags.add('提示词');
  }
  if (/Blender|3D|渲染|动画|FFmpeg/i.test(combinedText)) {
    tags.add('3D与视频');
  }

  const keyInfo = detectSecretKeyInfo(userText);
  if (keyInfo.isKey) {
    if (!hasDoc) category = pickCat('02-技术与代码');
    tags.add('API密钥');
  }

  const todoIndicators = /待办|TODO|截止|会议|周报|合同|发票|报销|客户|排期|明天|下周|记得/i;
  if (todoIndicators.test(combinedText)) {
    if (!hasDoc) category = pickCat('04-工作与待办');
    tags.add('待办事项');
  }

  const renamedFiles = enriched.map((att, idx) => {
    const origName = att.name || `附件_${idx + 1}`;
    // 如果前端已经自动改过名且不再是乱码名，尊重前端已改好的名字
    if (!isMeaninglessFileName(origName) && !att.autoRenameForced) {
      return origName;
    }
    if (att.detectedTitle) {
      return normalizeRenamedFile(origName, att.detectedTitle);
    }
    if (userText && isMeaninglessFileName(origName)) {
      const firstLine = userText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      if (firstLine) {
        return normalizeRenamedFile(origName, firstLine.slice(0, 28));
      }
    }
    return origName;
  });

  let title = '';
  const firstDetectedDocTitle = enriched.map((a) => a.detectedTitle).find(Boolean);
  const firstWebPageTitle = (webPages || []).map((p) => p.title).find(Boolean);
  if (keyInfo.isKey) {
    const cleanNote = (keyInfo.noteSummary || '')
      .replace(/^【(.+)】$/, '$1')
      .trim();
    if (cleanNote) {
      const suffix = /记录|凭证/.test(cleanNote) ? '' : '凭证记录';
      title = `${cleanNote.slice(0, 22)}${suffix}（${keyInfo.shortMask}）`;
    } else {
      title = `${keyInfo.keyType}记录（${keyInfo.shortMask}）`;
    }
  } else if (firstWebPageTitle) {
    title = firstWebPageTitle.slice(0, 36);
  } else if (userText) {
    const firstLine = userText
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*-\s]+/, '').trim())
      .find((l) => l.length > 0) || '';

    if (/^https?:\/\/\S+$/i.test(firstLine)) {
      try {
        const u = new URL(firstLine);
        const pathSeg = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '').split('/').slice(-2).join('/');
        title = pathSeg ? `链接：${u.hostname}/${pathSeg}` : `网页收藏：${u.hostname}`;
      } catch {
        title = '网页链接收藏';
      }
    } else {
      title = firstLine.slice(0, 32);
    }
  } else if (firstDetectedDocTitle) {
    title = firstDetectedDocTitle;
  } else if (renamedFiles.length > 0) {
    const firstName = path.basename(renamedFiles[0], path.extname(renamedFiles[0]));
    title = hasImage ? `图片：${firstName}` : `${firstName}`;
  } else {
    title = '随手记录';
  }

  let summary = '';
  if (webTexts) {
    const cleanWeb = webTexts.replace(/\s+/g, ' ').trim();
    summary = cleanWeb.slice(0, 120) + (cleanWeb.length > 120 ? '...' : '');
  } else if (extractedTexts) {
    const cleanDoc = extractedTexts.replace(/\s+/g, ' ').trim();
    summary = cleanDoc.slice(0, 110) + (cleanDoc.length > 110 ? '...' : '');
  } else if (userText.length > 35) {
    summary = userText.replace(/\s+/g, ' ').slice(0, 95) + (userText.length > 95 ? '...' : '');
  } else if (renamedFiles.length > 0) {
    summary = `归档附件：${renamedFiles.join('、')}${userText ? ` · 备注：${userText}` : ''}`;
  } else {
    summary = userText || '快速记录条目';
  }

  if (tags.size === 0) tags.add('随手记');

  return {
    category,
    title,
    summary,
    tags: Array.from(tags).slice(0, 5),
    renamedFiles,
    webPages: webPages || [],
    extractedPreview: (extractedTexts || webTexts).slice(0, 600),
    aiClassified: false
  };
}

/**
 * 测试用户的 OpenAI 兼容接口连接是否正常（使用官方 openai SDK）
 */
export async function testLlmConnection(customLlmCfg = null) {
  const config = getConfig();
  const llmCfg = customLlmCfg || config.llm || {};
  const start = Date.now();
  const { completion, usedBaseURL } = await callOpenAISdkChat({
    baseUrl: llmCfg.baseUrl,
    apiKey: llmCfg.apiKey,
    model: llmCfg.model,
    timeoutMs: 12000,
    messages: [
      { role: 'user', content: '请只回复 OK 两个字母' }
    ]
  });
  const reply = completion?.choices?.[0]?.message?.content?.trim() || 'OK';
  return {
    ok: true,
    latencyMs: Date.now() - start,
    endpoint: usedBaseURL,
    model: completion?.model || llmCfg.model,
    reply
  };
}

/**
 * 使用官方 OpenAI SDK 进行语义分类、标题生成、摘要提炼、打标与附件自动重命名
 */
export async function classifyWithLLM({ content = '', attachments = [], webPages = null, interactiveOnLogin = true }) {
  const config = getConfig();
  const categories = config.categories || [];
  const llmCfg = config.llm || {};

  const enriched = enrichAttachmentsWithContent(attachments);
  const resolvedWebPages = Array.isArray(webPages)
    ? webPages
    : await extractWebPagesFromContent(content, { interactiveOnLogin });

  const fallbackResult = heuristicClassify({
    content,
    attachments: enriched,
    webPages: resolvedWebPages,
    categories
  });

  if (!llmCfg.enabled || (!llmCfg.apiKey && llmCfg.providerPreset !== 'ollama') || !llmCfg.baseUrl) {
    return fallbackResult;
  }

  const categoryListDesc = categories
    .map((c) => `- "${c.id}": ${c.name}（${c.desc || ''}）`)
    .join('\n');

  const attachmentDetails = enriched.length > 0
    ? enriched.map((a, idx) => {
        const docSnippet = a.extractedText
          ? `\n    提取到的文件内部文本：\n    """\n    ${a.extractedText.slice(0, 1500)}\n    """`
          : '';
        return `附件${idx + 1}: 原文件名="${a.name}" (${a.mimeType || '未知类型'})${docSnippet}`;
      }).join('\n')
    : '无附件';

  const webPagesDetails = resolvedWebPages.length > 0
    ? resolvedWebPages.map((p, idx) => {
        return [
          `链接${idx + 1}: URL="${p.url}"`,
          p.title ? `  网页真实标题: "${p.title}"` : '',
          p.description ? `  网页Meta描述: "${p.description}"` : '',
          p.extractedText
            ? `  自动抓取到的网页正文内容：\n  """\n  ${p.extractedText.slice(0, 3200)}\n  """`
            : ''
        ].filter(Boolean).join('\n');
      }).join('\n\n')
    : '无网页链接抓取内容';

  const systemPrompt = `你是一个高效的个人知识库与文件整理助手。用户随手丢进来一段文字、链接、截图或文件（如 PDF、文档）。
请你根据【正文备注】、【自动打开链接抓取到的网页真实内容】和【提取到的文件内部文本/图像】，完成以下任务：
1. 选出最匹配的分类目录 id（category）：
   - 若包含网页链接且已抓取到网页真实内容，请**根据网页内实际探讨的主题内容**决定分类（例如网页讲技术/代码/开源库归入“02-技术与代码”，讲资料合集/提示词/教程文档归入“06-资料与文档”或“03-精读与链接”，工作项目归入“04-工作与待办”）；
2. 生成清晰、好搜索的中文记录标题（title，10~28字，优先提炼网页或文档的真实核心主题；**若内容为 API Key / Token / 密钥串，严禁将裸密钥串本身直接作为标题**，必须结合用户写的平台/用途备注生成如“Gitee API 密钥凭证记录（f26022…）”的清晰中文标题）；
3. 提炼 35~95 字的核心内容摘要（summary，总结网页或文档里具体讲了什么内容、包含哪些具体资源或核心结论，不要只写“记录了一个链接待查看”）；
4. 提取 2~5 个关键词标签（tags）；
5. **自动重命名附件（renamedFiles）**：如果包含附件，请按附件顺序为每个附件起一个清晰、具体、便于搜索的中文新文件名（保留原扩展名，如 "3D产品宣传片提示词（通用版）.pdf"）。

可选分类目录（category 必须严格返回引号内的目录 id）：
${categoryListDesc}

${llmCfg.customSystemPrompt ? `用户补充偏好：\n${llmCfg.customSystemPrompt}\n` : ''}
请严格只输出合法的 JSON 对象，格式如下：
{
  "category": "目录id",
  "title": "清晰的中文标题",
  "summary": "核心内容摘要",
  "tags": ["标签1", "标签2", "标签3"],
  "renamedFiles": ["附件1的新文件名.ext"]
}`;

  const userTextPrompt = `【用户输入的正文/备注】：
${content || '（用户未手写备注，请依据下方网页或附件内容进行分析）'}

【自动打开链接抓取到的网页真实内容】：
${webPagesDetails}

【上传的附件及内部提取内容】：
${attachmentDetails}`;

  const imageAttachments = enriched.filter((a) => (a.mimeType || '').startsWith('image/') && a.dataBase64);

  try {
    let completion;
    if (imageAttachments.length > 0) {
      try {
        const visionContent = [
          { type: 'text', text: userTextPrompt },
          ...imageAttachments.slice(0, 2).map((img) => ({
            type: 'image_url',
            image_url: {
              url: img.dataBase64.startsWith('data:')
                ? img.dataBase64
                : `data:${img.mimeType || 'image/png'};base64,${img.dataBase64}`
            }
          }))
        ];
        const res = await callOpenAISdkChat({
          baseUrl: llmCfg.baseUrl,
          apiKey: llmCfg.apiKey,
          model: llmCfg.model,
          jsonMode: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: visionContent }
          ]
        });
        completion = res.completion;
      } catch {
        const res = await callOpenAISdkChat({
          baseUrl: llmCfg.baseUrl,
          apiKey: llmCfg.apiKey,
          model: llmCfg.model,
          jsonMode: true,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userTextPrompt }
          ]
        });
        completion = res.completion;
      }
    } else {
      const res = await callOpenAISdkChat({
        baseUrl: llmCfg.baseUrl,
        apiKey: llmCfg.apiKey,
        model: llmCfg.model,
        jsonMode: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userTextPrompt }
        ]
      });
      completion = res.completion;
    }

    const rawReply = completion?.choices?.[0]?.message?.content || '';
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 未返回有效 JSON 结构');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validIds = new Set(categories.map((c) => c.id));
    const chosenCat = validIds.has(parsed.category) ? parsed.category : fallbackResult.category;

    const aiRenamedFiles = enriched.map((att, idx) => {
      const suggested = Array.isArray(parsed.renamedFiles) ? parsed.renamedFiles[idx] : '';
      if (suggested && String(suggested).trim()) {
        return normalizeRenamedFile(att.name, suggested);
      }
      return fallbackResult.renamedFiles[idx] || att.name;
    });

    let finalTitle = String(parsed.title || '').trim() || fallbackResult.title;
    const rawKeyInfo = detectSecretKeyInfo(content);
    if (rawKeyInfo.isKey && rawKeyInfo.matchedValue && finalTitle.includes(rawKeyInfo.matchedValue)) {
      finalTitle = fallbackResult.title;
    }

    return {
      category: chosenCat,
      title: finalTitle,
      summary: String(parsed.summary || '').trim() || fallbackResult.summary,
      tags: Array.isArray(parsed.tags) && parsed.tags.length > 0
        ? parsed.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6)
        : fallbackResult.tags,
      renamedFiles: aiRenamedFiles,
      webPages: resolvedWebPages,
      extractedPreview: fallbackResult.extractedPreview,
      aiClassified: true
    };
  } catch (err) {
    console.warn('[LLMClassifier] Fallback to content-aware heuristic due to error:', err.message);
    return {
      ...fallbackResult,
      errorWarning: err.message
    };
  }
}
