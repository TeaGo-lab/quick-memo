import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(PROJECT_ROOT, 'package.json');
const GITHUB_REPO = 'TeaGo-lab/quick-memo';

function nowReadable() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function normalizeVer(v = '') {
  return String(v || '').trim().replace(/^v/i, '');
}

/**
 * 比较两个语义化版本号：若 a > b 返回 1，a < b 返回 -1，相等返回 0
 */
export function compareVersions(a = '', b = '') {
  const pa = normalizeVer(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = normalizeVer(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

export function getAppMetadata() {
  let version = '0.4.0';
  let description = '';
  try {
    if (fs.existsSync(PKG_PATH)) {
      const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
      if (pkg.version) version = pkg.version;
      if (pkg.description) description = pkg.description;
    }
  } catch {}
  return {
    name: 'QuickMemo · 闪念与文件 AI 收纳盒',
    version: normalizeVer(version),
    versionTag: `v${normalizeVer(version)}`,
    rawVersion: normalizeVer(version),
    repo: GITHUB_REPO,
    repoSlug: GITHUB_REPO,
    repoUrl: `https://github.com/${GITHUB_REPO}`,
    releasesUrl: `https://github.com/${GITHUB_REPO}/releases`,
    description
  };
}

/**
 * 检测 GitHub 最新 Release 版本信息（优先请求 GitHub REST API，失败时自动回退本机 gh CLI）
 */
export async function checkReleaseUpdate() {
  const meta = getAppMetadata();
  let releaseData = null;

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'QuickMemo-Desktop-Updater'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const json = await res.json();
      const assets = Array.isArray(json.assets) ? json.assets : [];
      const zipAsset = assets.find((a) => String(a.name || '').endsWith('.zip'));
      const exeAsset = assets.find((a) => String(a.name || '').endsWith('.exe'));
      releaseData = {
        tagName: json.tag_name || '',
        name: json.name || json.tag_name || '',
        publishedAt: json.published_at ? new Date(json.published_at).toLocaleString('zh-CN', { hour12: false }) : '',
        body: json.body || '',
        htmlUrl: json.html_url || meta.releasesUrl,
        zipDownloadUrl: zipAsset?.browser_download_url || '',
        exeDownloadUrl: exeAsset?.browser_download_url || '',
        assetSize: zipAsset?.size || exeAsset?.size || 0
      };
    }
  } catch (err) {
    console.warn('[Updater] GitHub API fetch fallback to gh CLI:', err.message);
  }

  // 回退方案：调用本机 gh release view
  if (!releaseData) {
    try {
      const stdout = execFileSync(
        'gh',
        ['release', 'view', '--repo', GITHUB_REPO, '--json', 'tagName,name,publishedAt,body,assets,url'],
        { encoding: 'utf-8', timeout: 10000, windowsHide: true }
      );
      const parsed = JSON.parse(stdout.trim());
      const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
      const zipAsset = assets.find((a) => String(a.name || '').endsWith('.zip'));
      const exeAsset = assets.find((a) => String(a.name || '').endsWith('.exe'));
      releaseData = {
        tagName: parsed.tagName || '',
        name: parsed.name || parsed.tagName || '',
        publishedAt: parsed.publishedAt ? new Date(parsed.publishedAt).toLocaleString('zh-CN', { hour12: false }) : '',
        body: parsed.body || '',
        htmlUrl: parsed.url || meta.releasesUrl,
        zipDownloadUrl: zipAsset?.url || '',
        exeDownloadUrl: exeAsset?.url || '',
        assetSize: zipAsset?.size || exeAsset?.size || 0
      };
    } catch (err) {
      throw new Error(`无法连接 GitHub 获取最新版本信息：${err.message}`);
    }
  }

  const latestVersion = `v${normalizeVer(releaseData.tagName)}`;
  const hasUpdate = compareVersions(latestVersion, meta.version) > 0;

  return {
    localVersion: meta.rawVersion,
    currentVersion: meta.versionTag,
    latestTag: latestVersion,
    latestVersion,
    hasUpdate,
    releaseName: releaseData.name,
    publishedAt: releaseData.publishedAt,
    releaseNotes: releaseData.body,
    releaseUrl: releaseData.htmlUrl,
    htmlUrl: releaseData.htmlUrl,
    zipDownloadUrl: releaseData.zipDownloadUrl,
    exeDownloadUrl: releaseData.exeDownloadUrl,
    assetSize: releaseData.assetSize || 0,
    repoUrl: meta.repoUrl,
    checkedAt: nowReadable()
  };
}

function copyDirectoryRecursive(srcDir, destDir, skipNames = new Set()) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, skipNames);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 拉取最新 GitHub Release 发行包 (QuickMemo-Windows-x64.zip)，安全覆盖更新程序文件并自动重启生效
 * 严格保护用户的 vault/ 知识库、.quick-memo-config.json 配置与 backups/ 备份不丢失
 */
export async function performReleaseUpdate({ autoRestart = true } = {}) {
  const check = await checkReleaseUpdate();
  const tag = check.latestVersion;

  const stageDir = path.join(os.tmpdir(), `QuickMemo_Update_${Date.now()}`);
  const zipPath = path.join(stageDir, 'QuickMemo-Windows-x64.zip');
  const extractDir = path.join(stageDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  let downloaded = false;

  // 1. 优先通过 HTTP 下载最新 Release 的 QuickMemo-Windows-x64.zip（内置国内高速镜像自动回退）
  if (check.zipDownloadUrl) {
    const candidateUrls = [
      check.zipDownloadUrl,
      `https://ghfast.top/${check.zipDownloadUrl}`,
      `https://mirror.ghproxy.com/${check.zipDownloadUrl}`
    ];
    for (const dlUrl of candidateUrls) {
      try {
        const res = await fetch(dlUrl, {
          headers: { 'User-Agent': 'QuickMemo-Desktop-Updater' },
          signal: AbortSignal.timeout(25000)
        });
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          if (arrayBuf.byteLength > 10000) {
            fs.writeFileSync(zipPath, Buffer.from(arrayBuf));
            downloaded = true;
            break;
          }
        }
      } catch (err) {
        console.warn(`[Updater] Download attempt failed (${dlUrl}):`, err.message);
      }
    }
  }

  // 2. 回退使用 gh release download
  if (!downloaded) {
    try {
      execFileSync(
        'gh',
        ['release', 'download', tag, '--repo', GITHUB_REPO, '--pattern', 'QuickMemo-Windows-x64.zip', '--dir', stageDir, '--clobber'],
        { encoding: 'utf-8', timeout: 45000, windowsHide: true }
      );
      if (fs.existsSync(zipPath)) {
        downloaded = true;
      }
    } catch (err) {
      throw new Error(`下载最新发行包失败：${err.message}`);
    }
  }

  if (!fs.existsSync(zipPath)) {
    throw new Error('未能获取到最新版本的 QuickMemo-Windows-x64.zip 升级包');
  }

  // 3. 解压升级包
  const pyUnzip = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'r') as zf:
    zf.extractall(sys.argv[2])
`;
  try {
    execFileSync('python', ['-X', 'utf8', '-c', pyUnzip, zipPath, extractDir], {
      timeout: 25000,
      windowsHide: true
    });
  } catch {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`],
      { timeout: 25000, windowsHide: true }
    );
  }

  // 4. 将解压后的前端 dist/、后端 server/、源码 src/ 等覆盖到项目根目录（绝不覆盖 vault、.quick-memo-config.json 和正在运行的 QuickMemo.exe）
  const protectedEntries = new Set([
    'vault',
    'backups',
    'node_modules',
    '.git',
    '.webview-profile',
    '.crawler-profile',
    '.quick-memo-config.json',
    '.window-cmd.json',
    'QuickMemo.exe',
    'LICENSE'
  ]);

  const sourceRoot = fs.existsSync(path.join(extractDir, 'desktop', 'server', 'standalone.js'))
    ? path.join(extractDir, 'desktop')
    : extractDir;

  copyDirectoryRecursive(sourceRoot, PROJECT_ROOT, protectedEntries);

  // 5. 同步更新本地 package.json 中的 version 字段为最新 Release 版本号
  try {
    if (fs.existsSync(PKG_PATH)) {
      const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
      pkg.version = normalizeVer(tag);
      fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2), 'utf-8');
    }
  } catch {}

  // 6. 如果当前目录也是 Git 仓库，顺手同步 git fetch 保持版本一致
  if (fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
    try {
      execFileSync('git', ['fetch', 'origin', '--tags'], {
        cwd: PROJECT_ROOT,
        timeout: 10000,
        windowsHide: true
      });
    } catch {}
  }

  // 7. 启动独立后台热替换脚本：通过 wscript.exe (GUI 子系统) 脱离当前 node 控制台会话，
  //    等待 HTTP 响应先返回给前端，随后关闭旧进程、替换 QuickMemo.exe 并重新拉起程序
  const newExePath = path.join(sourceRoot, 'QuickMemo.exe');
  const targetExePath = path.join(PROJECT_ROOT, 'QuickMemo.exe');

  if (autoRestart) {
    const ps1Path = path.join(stageDir, 'apply-update.ps1');
    const vbsPath = path.join(stageDir, 'launch-updater.vbs');
    const currentNodePid = process.pid;
    const escPs = (s) => String(s || '').replace(/'/g, "''");

    const psUpgradeScript = `
Start-Sleep -Milliseconds 1200
Get-Process -Name "QuickMemo" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Stop-Process -Id ${currentNodePid} -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*standalone.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and ($_.CommandLine -like '*127.0.0.1:1420*' -or $_.CommandLine -like '*.webview-profile*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
if (Test-Path -LiteralPath '${escPs(newExePath)}') {
  for ($i = 0; $i -lt 8; $i++) {
    try {
      Copy-Item -LiteralPath '${escPs(newExePath)}' -Destination '${escPs(targetExePath)}' -Force -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Milliseconds 350
    }
  }
}
if (Test-Path -LiteralPath '${escPs(targetExePath)}') {
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"${escPs(targetExePath)}"'; CurrentDirectory = '${escPs(PROJECT_ROOT)}' } -ErrorAction SilentlyContinue
  if (-not $res -or $res.ReturnValue -ne 0) {
    Start-Process -FilePath '${escPs(targetExePath)}' -WorkingDirectory '${escPs(PROJECT_ROOT)}'
  }
} else {
  Start-Process -FilePath '${escPs(process.execPath)}' -ArgumentList '"${path.join(PROJECT_ROOT, 'server', 'standalone.js')}" --open' -WorkingDirectory '${escPs(PROJECT_ROOT)}' -WindowStyle Hidden
}
Start-Sleep -Seconds 2
Remove-Item -Recurse -Force -LiteralPath '${escPs(stageDir)}' -ErrorAction SilentlyContinue
`;
    fs.writeFileSync(ps1Path, '\uFEFF' + psUpgradeScript, 'utf-8');

    const vbsContent = [
      'On Error Resume Next',
      `cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1Path}"""`,
      'Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
      'Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_',
      'startup.ShowWindow = 0',
      'Set proc = wmi.Get("Win32_Process")',
      `ret = proc.Create(cmd, "${PROJECT_ROOT}", startup, pid)`,
      'If Err.Number <> 0 Or ret <> 0 Then',
      '  Set sh = CreateObject("WScript.Shell")',
      '  sh.Run cmd, 0, False',
      'End If'
    ].join('\r\n');
    fs.writeFileSync(vbsPath, vbsContent, 'utf-8');

    const child = spawn('wscript.exe', ['//B', '//NoLogo', vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  }

  return {
    ok: true,
    updatedTo: tag,
    targetVersion: normalizeVer(tag),
    restarting: autoRestart,
    updatedAt: nowReadable(),
    message: `🎉 已成功拉取 ${tag} 最新发行包并完成更新！正在为你自动重启客户端...`
  };
}
