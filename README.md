# youhou · 安卓浏览器油猴脚本合集

专为**安卓端浏览器（Tampermonkey / 油猴兼容环境）**整理的实用 Userscript 脚本仓库，包含移动端交互优化的悬浮工具、网页防重排查与离线保存能力。

---

## 📦 脚本目录

| 脚本名称 | 版本 | 适用场景 | 源码 | 一键安装（Raw） |
| --- | :---: | --- | --- | :---: |
| **APP体验防重助手（纳入与排除检测·可折叠贴边版）** | `1.1.0` | 记录已体验 APP 关键字，在任意网页快速排查是否重复 | [查看源码](scripts/APP%E4%BD%93%E9%AA%8C%E9%98%B2%E9%87%8D%E5%8A%A9%E6%89%8B%EF%BC%88%E7%BA%B3%E5%85%A5%E4%B8%8E%E6%8E%92%E9%99%A4%E6%A3%80%E6%B5%8B%C2%B7%E5%8F%AF%E6%8A%98%E5%8F%A0%E8%B4%B4%E8%BE%B9%E7%89%88%EF%BC%89-1.1.0.user.js) | [点击安装](https://raw.githubusercontent.com/yimisunan/youhou/main/scripts/APP%E4%BD%93%E9%AA%8C%E9%98%B2%E9%87%8D%E5%8A%A9%E6%89%8B%EF%BC%88%E7%BA%B3%E5%85%A5%E4%B8%8E%E6%8E%92%E9%99%A4%E6%A3%80%E6%B5%8B%C2%B7%E5%8F%AF%E6%8A%98%E5%8F%A0%E8%B4%B4%E8%BE%B9%E7%89%88%EF%BC%89-1.1.0.user.js) |
| **安卓网页离线保存器（HTML / PNG）** | `1.0.0` | 将当前网页保存为独立离线 HTML 或 PNG 长截图 | [查看源码](scripts/%E5%AE%89%E5%8D%93%E7%BD%91%E9%A1%B5%E7%A6%BB%E7%BA%BF%E4%BF%9D%E5%AD%98%E5%99%A8%EF%BC%88HTML_-_PNG%EF%BC%89-1.0.0.user.js) | [点击安装](https://raw.githubusercontent.com/yimisunan/youhou/main/scripts/%E5%AE%89%E5%8D%93%E7%BD%91%E9%A1%B5%E7%A6%BB%E7%BA%BF%E4%BF%9D%E5%AD%98%E5%99%A8%EF%BC%88HTML_-_PNG%EF%BC%89-1.0.0.user.js) |

> **提示**：在已安装 Tampermonkey 的浏览器中直接点击上方「点击安装」，即可跳转至油猴安装确认页；若浏览器未自动拉起安装界面，可复制链接后在油猴「实用工具 → 从 URL 安装」中导入。

---

## 🛠️ 脚本详情

### 1. APP体验防重助手（纳入与排除检测·可折叠贴边版） `v1.1.0`

适合在安卓浏览器逛应用推荐、评测、下载页时，快速标记并排查自己已经体验过的 APP，避免重复下载或踩坑。

- **贴边半隐藏悬浮球**：
  - 使用 Shadow DOM 隔离样式，不干扰原网页排版，仅在顶层窗口运行（跳过嵌套 `iframe`）。
  - 支持触屏/鼠标上下拖拽，松手后自动吸附到屏幕左侧或右侧边缘并记忆位置。
  - 默认折叠贴边半隐藏；支持「点击网页空白处自动折叠」（可在设置中开关）。
- **纳入词库管理**：
  - 支持单条或批量输入（按换行、中英文逗号、分号分隔自动去重）。
  - 支持在网页长按划词后，点击「纳入」或「填入网页选中字」自动提取选中内容。
  - 支持词库关键字搜索、单独删除、剪贴板导出备份、文本粘贴导入、一键清空。
- **排除检测与页面高亮**：
  - 点击「排除」立即扫描当前网页可见文本：
    - **命中**：悬浮球变为**红色脉冲预警**，显示命中关键字数量，支持网页正文黄色高亮及点击「定位到页面位置」循环滚动跳转。
    - **未命中**：悬浮球变为**绿色放行**状态。
  - 可开启「打开网页自动检测」与「命中时在网页高亮」。
- **跨域名存储与菜单入口**：
  - 优先使用 `GM_getValue` / `GM_setValue` 跨站点共享词库与配置，并在不支持 GM 存储的环境下自动兼容 `localStorage`。
  - 注册油猴菜单命令：`🔍 立即排除检测当前网页`、`➕ 打开APP纳入与词库管理`。

---

### 2. 安卓网页离线保存器（HTML / PNG） `v1.0.0`

用于在安卓端快速归档当前正在浏览的网页，提供「单文件离线 HTML」与「PNG 长截图」两种导出方式。

- **移动端悬浮交互与菜单**：
  - 页面右下角提供简洁 `↓` 悬浮按钮，点击展开操作面板：「保存为离线 HTML」「保存为 PNG 长截图」「关闭悬浮按钮」。
  - 同时提供油猴菜单入口：`保存当前页为离线 HTML`、`保存当前页为 PNG 长截图`、`隐藏悬浮按钮`。
- **保存为离线 HTML**：
  - 深拷贝当前 DOM 并同步实时状态（`input`、`textarea`、`select`、`option`、`details` 展开状态、`<canvas>` 像素以及元素滚动偏移）。
  - 内联各元素计算后样式（`getComputedStyle`）及同源可读 CSSOM 规则，移除原外部脚本（`script` / `noscript` / `iframe` 等）与原外链样式表，并将外链 `a[href]` 转为绝对地址。
  - 自动抓取并内联图片、视频封面（`poster`）及 CSS `url(...)` 资源为 Data URL，生成可断网直接打开的 `.html` 快照。
- **保存为 PNG 长截图**：
  - 通过 `@require` 引入 [`html2canvas`](https://github.com/niklasvh/html2canvas) `1.4.1`，按页面完整滚动宽高与最高 `2x` 设备像素比生成 `.png` 长图（截图时自动隐藏工具自身 UI）。
- **下载兼容**：
  - 优先使用 `GM_download` 保存文件；若当前油猴环境不支持直接传入 `Blob`，自动回退至 `<a download>` 触发下载。
  - *注意：若目标网页过长、存在严格跨域图片/Canvas 限制或超出移动端浏览器画布上限，PNG 导出可能失败，此时建议优先使用「保存为离线 HTML」。*

---

## 📱 安卓端推荐使用环境

以下安卓端浏览器与脚本管理器均可配合本仓库脚本使用：

- **Kiwi Browser / Lemur Browser（狐猴浏览器） / Edge Canary**：安装 **Tampermonkey（篡改猴）** 或 **Violentmonkey（暴力猴）** 扩展。
- **Firefox for Android**：安装 **Tampermonkey** 或 **Violentmonkey** 附加组件。
- **Via 浏览器 / X 浏览器**等轻量浏览器：支持通过内置脚本管理导入（其中仅依赖原生 JS 的「APP体验防重助手」可直接运行；「安卓网页离线保存器」需支持 `@require` 与 `GM_download` 的完整油猴环境以获得最佳体验）。

---

## 📁 仓库结构

```text
youhou/
├── scripts/
│   ├── APP体验防重助手（纳入与排除检测·可折叠贴边版）-1.1.0.user.js
│   └── 安卓网页离线保存器（HTML_-_PNG）-1.0.0.user.js
├── .gitignore
├── LICENSE
└── README.md
```

---

## 📄 开源协议与声明

- 本仓库采用 [MIT License](LICENSE) 开源。
- `安卓网页离线保存器（HTML / PNG）` 的 PNG 截图功能使用了第三方库 [`html2canvas` v1.4.1](https://github.com/niklasvh/html2canvas)（MIT License）。
