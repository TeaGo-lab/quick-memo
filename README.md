# QuickMemo · 闪念与文件 AI 收纳盒（Desktop & Android）

> ⚠️ **非商用使用约定（Non-Commercial Only）**：本项目仅供**个人学习、技术研究与非商业使用**，**严禁任何形式的商业用途**（包括但不限于在电商/二手平台售卖、付费分发、有偿代安装、内嵌至商业产品或未经授权的企业商用）。详见 [LICENSE](./LICENSE)。

专为解决**“随手发给微信文件传输助手，转头就忘、找起来极麻烦”**而设计的跨端本地优先（Local-First）闪念、API Key 保险箱与多格式文档 AI 收纳工具。所有记录 **100% 存储为按分类整理的 Markdown (`.md`) 文件夹**，支持通过 **Gitee（码云）/ GitHub 私有仓库** 在电脑与手机间双向同步。

---

## 📁 仓库目录结构

- **[`./desktop`](./desktop/README.md)**：**Windows 桌面端**（Node.js 本地服务 + Windows 原生无黑框托盘启动器 `QuickMemo.exe` / Tauri v2，支持 `Alt + Space` 全局秒级唤出、贴边隐藏、开机静默自启、在线热更新）。
- **[`./android`](./android/README.md)**：**Android 移动端**（Vite + Capacitor Android，专为手机单手速记设计，支持手机直连大模型分类归档与 Gitee / GitHub REST API 免命令行云同步）。

---

## 🚀 快速开始

### 💻 Windows 桌面端 (`./desktop`)
直接双击运行 `desktop/QuickMemo.exe`，或在终端执行：
```powershell
cd desktop
npm start
```
详细编译与使用说明请参阅 [desktop/README.md](./desktop/README.md)。

### 📱 Android 移动端 (`./android`)
```powershell
cd android
npm install
npm run dev
```
详细真机预览与 APK 打包指南请参阅 [android/README.md](./android/README.md)。

---

## 📜 开源协议与使用约定（禁止商用）

本项目采用 **[QuickMemo 非商业开源许可协议 (QuickMemo Non-Commercial License)](./LICENSE)**：

- **✅ 允许范围**：个人日常免费使用、个人编程学习、学术研究及非商业性质的技术交流与修改（需完整保留原作者署名与本非商用声明）。
- **🚫 严禁商用**：
  1. **严禁售卖或变相收费**：严禁在淘宝、闲鱼、拼多多、小红书、知识星球等任何渠道售卖本软件、源码、安装包或提供有偿代装服务；
  2. **严禁商业内嵌与捆绑**：严禁将本项目全部或部分代码集成、封装或内嵌至任何商业软件、付费产品或商业 SaaS 服务中；
  3. **严禁未经授权的企业商用**：未经作者事前书面授权，严禁将本软件用于企业内部商业运营或营利性业务场景；
  4. **严禁抹除版权标识**：严禁移除或篡改软件界面、源码及文档中的版权声明与非商用标识。
- **📬 商业授权与联系**：如需商业授权或合作，请联系作者邮箱：`teagoxu@proton.me`。
