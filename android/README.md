# QuickMemo Android · 移动端闪念与文件 AI 收纳盒

> ⚠️ **非商用使用约定（Non-Commercial Only）**：本项目仅供**个人学习、技术研究与非商业使用**，**严禁任何形式的商业用途**（包括但不限于售卖、付费分发、有偿代安装、商业产品内嵌或未经授权的企业商用）。详见 [LICENSE](./LICENSE)。

QuickMemo 安卓移动端采用 **Vite + Capacitor Android** 架构，专为手机单手速记设计，支持手机端直连 OpenAI 兼容大模型（DeepSeek / 硅基流动 / 通义千问 / OpenAI）自动分类归档，并通过 **Gitee（码云）/ GitHub 私有仓库** 与桌面版（`../desktop`）双向同步。

---

## ✨ 移动端核心特性

1. **⚡ 手机随手记（底部单手触控导航）**：
   - 一键读取手机剪贴板、拍照/从相册选图、上传手机文档；
   - 粘贴裸 API Key 自动识别并弹出快捷用途备注胶囊；
   - 归档前自动执行手机本地查重预检。
2. **🤖 手机端直连 AI 自动分类 + 规则兜底**：
   - 内置 DeepSeek、硅基流动、通义千问、OpenAI 一键预设；
   - 自动起中文标题、提炼摘要、打 `#标签` 并归入与桌面端一致的分类目录（`01-灵感与备忘` ~ `06-资料与文档`）。
3. **☁️ 免 Git 命令行 · Gitee / GitHub 双向云同步**：
   - 手机端直接通过 Gitee / GitHub REST API 读写远程私有库（`quick-memo-vault`）；
   - **⬇️ 拉取云端**：一键把电脑端保存的所有闪念、API Key 与摘要同步到手机；
   - **☁️ 推送云端**：手机随手记自动生成带 YAML Frontmatter 的标准 `.md` 文件并更新 `.quick-memo-index.json` 推送回私有库，电脑端 Pull 即可查看。
4. **💬 移动端 AI 寻物助手 (RAG)**：
   - 独立「AI 寻物」对话页，随时用自然语言找回保存过的 API Key、链接或笔记，支持代码块一键复制。

---

## 🚀 运行与打包 APK 指南

### 1. 本地开发与手机局域网真机预览
```powershell
cd android
npm install
npm run dev
```
启动后手机连接同一 Wi-Fi 访问终端输出的局域网地址（默认端口 `1421`），或直接添加到手机主屏幕作为全屏 PWA 使用。

### 2. 使用 Capacitor 打包原生 Android APK
```powershell
cd android
npm install
npm run build
npx cap add android
npx cap sync android
npx cap open android
```
在打开的 Android Studio 中点击 **Build -> Build Bundle(s) / APK(s) -> Build APK(s)** 即可生成安装包。
