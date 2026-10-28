import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 从上传的文件（Base64 或磁盘路径）中提取内部文本内容与文档真实标题
 * 支持 PDF (通过 pymupdf / pypdf)、TXT/MD/JSON/CSV/代码文件、DOCX 等
 */
export function extractFileContent({
  name = '',
  mimeType = '',
  dataBase64 = '',
  absPath = '',
  maxChars = 4000,
  maxPages = 6
}) {
  const ext = path.extname(name).toLowerCase();
  let buf = null;

  try {
    if (absPath && fs.existsSync(absPath)) {
      buf = fs.readFileSync(absPath);
    } else if (dataBase64) {
      const clean = String(dataBase64).replace(/^data:[^;]+;base64,/, '');
      buf = Buffer.from(clean, 'base64');
    }
  } catch (err) {
    console.warn('[FileExtractor] Failed to read buffer:', err.message);
  }

  if (!buf || buf.length === 0) {
    return { extractedText: '', detectedTitle: '' };
  }

  // 1. 纯文本 / 代码 / Markdown / JSON / CSV
  const textExts = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.py', '.js', '.ts', '.html', '.css', '.sql', '.sh', '.bat', '.ps1', '.yaml', '.yml', '.xml', '.ini', '.log']);
  if (textExts.has(ext) || (mimeType && mimeType.startsWith('text/'))) {
    const text = buf.toString('utf-8').slice(0, maxChars);
    const firstLine = findBestHeadingLine(text);
    return {
      extractedText: text,
      detectedTitle: firstLine
    };
  }

  // 2. PDF 文档提取（优先调用本机 Python pymupdf / pypdf 精准提取中文与排版标题）
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    const tmpPdf = path.join(os.tmpdir(), `qm_extract_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pdf`);
    try {
      fs.writeFileSync(tmpPdf, buf);
      const pyScript = `
import sys, json
pdf_path = sys.argv[1]
max_pages = int(sys.argv[2])
max_chars = int(sys.argv[3])
text_pages = []
title = ""
page_count = 0
try:
    import pymupdf as fitz
    doc = fitz.open(pdf_path)
    page_count = len(doc)
    meta_title = (doc.metadata or {}).get("title", "").strip()
    if meta_title and not meta_title.lower().startswith("untitled"):
        title = meta_title
    for i in range(min(max_pages, len(doc))):
        page_text = doc[i].get_text("text")
        if page_text:
            text_pages.append(f"[第{i+1}页]\\n" + page_text.strip())
    doc.close()
except Exception:
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf_path)
        page_count = len(reader.pages)
        for i, page in enumerate(reader.pages[:max_pages]):
            t = page.extract_text()
            if t:
                text_pages.append(f"[第{i+1}页]\\n" + t.strip())
    except Exception:
        pass

full_text = "\\n\\n".join(text_pages)[:max_chars]
print(json.dumps({"title": title, "text": full_text, "pageCount": page_count}, ensure_ascii=False))
`;
      const stdout = execFileSync('python', ['-X', 'utf8', '-c', pyScript, tmpPdf, String(maxPages), String(maxChars)], {
        encoding: 'utf-8',
        timeout: 12000,
        windowsHide: true
      });
      const parsed = JSON.parse(stdout.trim());
      const extractedText = (parsed.text || '').trim();
      const cleanForHeading = extractedText.replace(/\[第\d+页\]\s*/g, '');
      const detectedTitle = findBestHeadingLine(cleanForHeading) || (parsed.title || '').trim();
      return {
        extractedText,
        detectedTitle,
        pageCount: parsed.pageCount || 0
      };
    } catch (err) {
      console.warn('[FileExtractor] PDF extract fallback:', err.message);
    } finally {
      try {
        if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
      } catch {}
    }
  }

  // 3. Word (.docx) 提取（.docx 本质是 zip 包内的 word/document.xml）
  if (ext === '.docx') {
    const tmpDocx = path.join(os.tmpdir(), `qm_extract_${Date.now()}.docx`);
    try {
      fs.writeFileSync(tmpDocx, buf);
      const pyScript = `
import sys, zipfile, xml.etree.ElementTree as ET, json
max_chars = int(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as z:
    xml_content = z.read("word/document.xml")
tree = ET.fromstring(xml_content)
texts = [node.text for node in tree.iter() if node.tag.endswith('}t') and node.text]
full_text = "".join(texts)[:max_chars]
print(json.dumps({"text": full_text}, ensure_ascii=False))
`;
      const stdout = execFileSync('python', ['-X', 'utf8', '-c', pyScript, tmpDocx, String(maxChars)], {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true
      });
      const parsed = JSON.parse(stdout.trim());
      const extractedText = (parsed.text || '').trim();
      return {
        extractedText,
        detectedTitle: findBestHeadingLine(extractedText)
      };
    } catch {
      // ignore
    } finally {
      try {
        if (fs.existsSync(tmpDocx)) fs.unlinkSync(tmpDocx);
      } catch {}
    }
  }

  return { extractedText: '', detectedTitle: '' };
}

function findBestHeadingLine(text = '') {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^(?:[#>*•\-]+\s*|\d+[.、)]\s+)/, '').trim())
    .filter((l) => l.length >= 3 && l.length <= 50);

  if (lines.length === 0) return '';
  return lines[0].slice(0, 36);
}

/**
 * 判断原文件名是否像无意义的乱码/哈希/时间戳文件名（如 3D_138074619579219233.1eadc9e2f46f2f5.pdf 或 mmexport1729...）
 */
export function isMeaninglessFileName(fileName = '') {
  const base = path.basename(fileName, path.extname(fileName));
  if (!base) return true;
  if (/^(image|screenshot|paste|attachment|未命名|截图|file)_?\d*$/i.test(base)) return true;
  if (/^(mmexport|wx_camera_|img_|dsc_|pxl_|wechatimg)\d+/i.test(base)) return true;
  // 包含超过 8 位连续数字，或 8 位以上十六进制哈希串
  if (/\d{8,}/.test(base) || /[0-9a-f]{8,}/i.test(base)) return true;
  return false;
}
