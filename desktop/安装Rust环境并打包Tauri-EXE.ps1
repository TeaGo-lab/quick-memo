# QuickMemo - Tauri v2 EXE 一键环境检查与打包脚本
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== 1. 检查 Node.js 依赖 ===" -ForegroundColor Cyan
if (-not (Test-Path "node_modules")) {
    Write-Host "正在安装前端与 Tauri CLI 依赖..." -ForegroundColor Yellow
    npm install
}

Write-Host "`n=== 2. 检查 Rust (cargo) 编译工具链 ===" -ForegroundColor Cyan
$cargoPath = "$env:USERPROFILE\.cargo\bin"
if (Test-Path "$cargoPath\cargo.exe") {
    $env:Path = "$cargoPath;$env:Path"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "未检测到 Rust 编译器 (Tauri 打包 .exe 依赖 Rust 后端)。" -ForegroundColor Yellow
    $ans = Read-Host "是否现在通过 winget 自动安装 Rustup (Rust 官方工具链)？(Y/N)"
    if ($ans -match "^[Yy]") {
        winget install --id Rustlang.Rustup -e --accept-package-agreements --accept-source-agreements
        $env:Path = "$cargoPath;$env:Path"
    } else {
        Write-Host "已跳过 Rust 安装。你依然可以直接双击 [启动QuickMemo桌面端.bat] 立即使用全部功能！" -ForegroundColor Green
        exit 0
    }
}

Write-Host "`n=== 3. 开始编译打包 Tauri 桌面程序 (.exe) ===" -ForegroundColor Cyan
npm run tauri:build

Write-Host "`n🎉 打包完成！生成的 .exe 位于：" -ForegroundColor Green
Write-Host "$PSScriptRoot\src-tauri\target\release\quick-memo.exe" -ForegroundColor Green
