import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CRAWLER_PROFILE_DIR = path.join(PROJECT_ROOT, '.crawler-profile');

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

/**
 * 从文本中提取所有 HTTP/HTTPS 链接（去重并清理末尾标点）
 */
export function extractUrlsFromText(rawText = '') {
  const text = String(rawText || '');
  const matches = text.match(/https?:\/\/[^\s<>"'`）)】\]]+/gi) || [];
  const seen = new Set();
  const urls = [];

  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;!?，。；！？、)>\]'"`]+$/g, '').trim();
    if (!cleaned) continue;
    try {
      const u = new URL(cleaned);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const href = u.href;
        if (!seen.has(href)) {
          seen.add(href);
          urls.push(href);
        }
      }
    } catch {}
  }
  return urls.slice(0, 3);
}

function decodeHtmlEntities(str = '') {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 从 HTML 源码中提取标题、描述和结构化正文
 */
export function parseHtmlToReadable(html = '', url = '') {
  const raw = String(html || '');
  if (!raw) return { title: '', description: '', bodyText: '' };

  // 1. 提取标题 (优先 og:title -> <title> -> h1)
  const ogTitleMatch =
    raw.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const titleTagMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  let title = decodeHtmlEntities(
    (ogTitleMatch && ogTitleMatch[1]) ||
      (titleTagMatch && titleTagMatch[1]) ||
      (h1Match && h1Match[1].replace(/<[^>]+>/g, '')) ||
      ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  // 2. 提取描述 (meta description / og:description)
  const descMatch =
    raw.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']+)["']/i) ||
    raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
  const description = decodeHtmlEntities((descMatch && descMatch[1]) || '')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. 提取正文区域（优先 <article> 或 <main>，否则取 <body>）
  let bodyHtml = raw;
  const articleMatch = raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = raw.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch && articleMatch[1].length > 300) {
    bodyHtml = articleMatch[1];
  } else if (mainMatch && mainMatch[1].length > 300) {
    bodyHtml = mainMatch[1];
  } else {
    const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) bodyHtml = bodyMatch[1];
  }

  // 剔除无关标签
  let cleaned = bodyHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  // 将标题、段落、列表转换为换行与 Markdown 标记
  cleaned = cleaned
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<\/(p|div|section|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  cleaned = decodeHtmlEntities(cleaned);

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const bodyText = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    title,
    description,
    bodyText
  };
}

/**
 * 判断抓取结果是否落入了登录墙或空白 SPA 壳
 */
function isLoginWallOrEmptySpa({ url = '', finalUrl = '', title = '', bodyText = '' }) {
  const fUrl = String(finalUrl || url).toLowerCase();
  const t = String(title || '').toLowerCase();
  const body = String(bodyText || '');

  if (
    fUrl.includes('accounts.feishu.cn/accounts/page/login') ||
    fUrl.includes('passport.feishu.cn') ||
    fUrl.includes('/login') && !url.toLowerCase().includes('/login')
  ) {
    return { isBlocked: true, reason: 'login_wall' };
  }

  if (
    t === '飞书 - 登录' ||
    t === 'lark - login' ||
    (body.includes('请使用 豆包/飞书移动端 扫码') && body.length < 600) ||
    (body.includes('扫码登录') && body.length < 400)
  ) {
    return { isBlocked: true, reason: 'login_wall' };
  }

  const isSpaDomain = /feishu\.cn|larksuite\.com|notion\.so|notion\.site|yuque\.com|xiaohongshu\.com|xhslink\.com|mp\.weixin\.qq\.com/i.test(url);
  if (isSpaDomain && body.length < 120) {
    return { isBlocked: true, reason: 'spa_empty' };
  }

  if (!title && body.length < 80) {
    return { isBlocked: true, reason: 'spa_empty' };
  }

  return { isBlocked: false, reason: '' };
}

function findEdgeBinary() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 19333;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function evaluatePageViaCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket timeout')), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });

  try {
    const evalRes = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP evaluate timeout')), 6000);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.id === 1) {
            clearTimeout(timer);
            resolve(msg);
          }
        } catch {}
      };
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `JSON.stringify({
              title: document.title || '',
              url: location.href || '',
              description: (document.querySelector('meta[name="description"], meta[property="og:description"]')?.content) || '',
              text: document.body ? document.body.innerText : ''
            })`,
            returnByValue: true
          }
        })
      );
    });

    const rawVal = evalRes?.result?.result?.value;
    if (!rawVal) return null;
    return JSON.parse(rawVal);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

/**
 * 使用本地 Edge 浏览器（带持久化 .crawler-profile 会话目录）渲染并提取动态网页内容
 * - 默认先以无头模式 (--headless=new) 静默抓取
 * - 若遇到飞书/语雀等登录拦截且开启了 interactiveOnLogin，会自动弹出一次可视窗口供用户扫码登录，登录成功后自动抓取正文并关闭窗口（后续永久免扫码静默抓取）
 */
export async function fetchUrlWithBrowser(url, { interactiveOnLogin = true, maxWaitMs = 45000 } = {}) {
  const edgeBin = findEdgeBinary();
  if (!edgeBin) return null;

  if (!fs.existsSync(CRAWLER_PROFILE_DIR)) {
    fs.mkdirSync(CRAWLER_PROFILE_DIR, { recursive: true });
  }

  // 第一步：尝试使用持久化会话目录无头静默渲染
  const headlessPort = await getFreePort();
  const headlessProc = spawn(
    edgeBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--user-agent=${BROWSER_USER_AGENT}`,
      `--user-data-dir=${CRAWLER_PROFILE_DIR}`,
      `--remote-debugging-port=${headlessPort}`,
      url
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  let headlessResult = null;
  try {
    let pageTarget = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await fetch(`http://127.0.0.1:${headlessPort}/json`);
        const targets = await res.json();
        pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (pageTarget) break;
      } catch {}
    }

    if (pageTarget) {
      // 等待 SPA 渲染（最多轮询 5 秒，一旦正文充足且非登录页即提前返回）
      for (let step = 0; step < 8; step++) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const res = await fetch(`http://127.0.0.1:${headlessPort}/json`);
          const targets = await res.json();
          const currentTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || pageTarget;
          const data = await evaluatePageViaCdp(currentTarget.webSocketDebuggerUrl);
          if (data) {
            headlessResult = data;
            const check = isLoginWallOrEmptySpa({
              url,
              finalUrl: data.url,
              title: data.title,
              bodyText: data.text
            });
            if (!check.isBlocked && (data.text || '').trim().length >= 160) {
              break;
            }
          }
        } catch {}
      }
    }
  } finally {
    try {
      headlessProc.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }

  const checkAfterHeadless = isLoginWallOrEmptySpa({
    url,
    finalUrl: headlessResult?.url || url,
    title: headlessResult?.title || '',
    bodyText: headlessResult?.text || ''
  });

  if (!checkAfterHeadless.isBlocked && headlessResult && (headlessResult.text || '').trim().length > 40) {
    return {
      url,
      finalUrl: headlessResult.url || url,
      title: (headlessResult.title || '').trim(),
      description: (headlessResult.description || '').trim(),
      bodyText: (headlessResult.text || '').trim(),
      method: 'browser-headless'
    };
  }

  // 第二步：如果是因为需要登录（如飞书知识库首次访问），且允许交互式授权，则弹出窗口等待用户扫码/登录并自动抓取
  if (interactiveOnLogin && checkAfterHeadless.reason === 'login_wall') {
    const guiPort = await getFreePort();
    const guiProc = spawn(
      edgeBin,
      [
        `--app=${url}`,
        '--window-size=980,720',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        `--user-data-dir=${CRAWLER_PROFILE_DIR}`,
        `--remote-debugging-port=${guiPort}`
      ],
      { stdio: 'ignore', windowsHide: false }
    );

    const startTime = Date.now();
    try {
      while (Date.now() - startTime < maxWaitMs) {
        if (guiProc.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 1200));

        try {
          const res = await fetch(`http://127.0.0.1:${guiPort}/json`, {
            signal: AbortSignal.timeout(2000)
          });
          const targets = await res.json();
          const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          if (!pageTarget) break;

          const data = await evaluatePageViaCdp(pageTarget.webSocketDebuggerUrl);
          if (!data) continue;

          const chk = isLoginWallOrEmptySpa({
            url,
            finalUrl: data.url,
            title: data.title,
            bodyText: data.text
          });

          if (!chk.isBlocked && (data.text || '').trim().length >= 100) {
            // 登录成功并已进入目标文档，再多等 1.8 秒确保飞书异步文档块全部渲染完毕
            await new Promise((r) => setTimeout(r, 1800));
            const finalData = (await evaluatePageViaCdp(pageTarget.webSocketDebuggerUrl)) || data;
            return {
              url,
              finalUrl: finalData.url || url,
              title: (finalData.title || '').trim(),
              description: (finalData.description || '').trim(),
              bodyText: (finalData.text || '').trim(),
              method: 'browser-authenticated'
            };
          }
        } catch {}
      }
    } finally {
      try {
        guiProc.kill();
      } catch {}
    }
  }

  return null;
}

/**
 * 抓取单个网页链接的标题、摘要与正文内容
 */
export async function extractSingleUrlContent(url, { interactiveOnLogin = true, maxChars = 10000 } = {}) {
  let directData = { title: '', description: '', bodyText: '', finalUrl: url };

  // 1. 先尝试高速 HTTP 直接抓取
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    const finalUrl = res.url || url;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && (contentType.includes('text/html') || contentType.includes('text/plain') || contentType.includes('application/xhtml'))) {
      const html = await res.text();
      const parsed = parseHtmlToReadable(html, finalUrl);
      directData = {
        ...parsed,
        finalUrl
      };
    } else {
      directData.finalUrl = finalUrl;
    }
  } catch (err) {
    console.warn(`[UrlExtractor] Direct HTTP fetch failed for ${url}:`, err.message);
  }

  // 2. 检查是否被登录墙拦截或是 SPA 动态页面（如飞书 Wiki、Notion、语雀、微信公众号等）
  const check = isLoginWallOrEmptySpa({
    url,
    finalUrl: directData.finalUrl,
    title: directData.title,
    bodyText: directData.bodyText
  });

  if (check.isBlocked) {
    const browserData = await fetchUrlWithBrowser(url, { interactiveOnLogin });
    if (browserData && (browserData.title || browserData.bodyText)) {
      return {
        url,
        finalUrl: browserData.finalUrl || url,
        title: browserData.title,
        description: browserData.description,
        extractedText: (browserData.bodyText || '').slice(0, maxChars),
        method: browserData.method,
        fetchedAt: new Date().toISOString().replace('T', ' ').slice(0, 19)
      };
    }
  }

  if (directData.title || directData.bodyText) {
    return {
      url,
      finalUrl: directData.finalUrl || url,
      title: directData.title,
      description: directData.description,
      extractedText: (directData.bodyText || directData.description || '').slice(0, maxChars),
      method: 'http-direct',
      fetchedAt: new Date().toISOString().replace('T', ' ').slice(0, 19)
    };
  }

  return null;
}

/**
 * 提取用户输入文本中的所有网页链接并抓取其内容
 */
export async function extractWebPagesFromContent(content = '', options = {}) {
  const urls = extractUrlsFromText(content);
  if (urls.length === 0) return [];

  const pages = [];
  for (const url of urls) {
    try {
      const page = await extractSingleUrlContent(url, options);
      if (page && (page.title || page.extractedText)) {
        pages.push(page);
      }
    } catch (err) {
      console.warn(`[UrlExtractor] Failed to extract ${url}:`, err.message);
    }
  }
  return pages;
}
