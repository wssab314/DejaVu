# DejaVu 🐞

**"那个BUG又出现了...等等，我抓到它了！"**

`DejaVu` 是一款为 QA 和开发人员设计的 Chrome 调试助手，用于捕获那些最令人头疼的、难以复现的偶发性BUG。它就像一个飞行黑匣子，在你测试时，它会持续记录一个5分钟的环形缓冲区，当BUG发生时，你可以立即“抓取快照”，将完整的复现上下文打包下载。

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

---

### 痛点 (The Problem)

你是否遇到过这些情况：
* 一个只在特定操作顺序下才出现的**偶发性BUG**。
* 一个一闪而过的**渲染抖动**或数据错误。
* 一个难以复现的**拖拽**或UI交互异常。

当你终于复现了它，你停下来准备提单，但此时...
* 你忘了刚才5分钟内具体点过什么。
* 关键的网络请求日志早已被冲刷掉。
* 你无法向开发证明这个BUG确实存在。

### 解决方案 (The Solution)

`DejaVu` 在后台运行，当你开始测试时，它会启动一个**低内存占用的5分钟环形录制**。

当BUG出现的那一刻，你只需点击插件图标并选择 **"抓取BUG！"**

`DejaVu` 会立即停止录制，并将过去5分钟内发生的**三件关键事物**打包成一个`.zip`文件下载给你：

1.  **📺 屏幕录像 (Video.webm):** 过去5分钟的完整视频录屏，眼见为实。
2.  **🌐 网络日志 (Network.json):** 所有Fetch/XHR请求和响应的完整日志。
3.  **🖱️ 用户操作 (Actions.json):** 你的每一次点击和键盘输入的操作序列（附带XPath）。

你只需将这个ZIP文件附加到你的Jira或Bug单中，开发人员将获得**完美的复现上下文**。

---

### 核心功能 (Features)

* **📼 5分钟环形录屏:**
    核心功能。通过修改`RecordRTC.js` 实现了一个**环形缓冲区(Ring Buffer)**，只在内存中保留最新的视频数据块，解决了长时间录制导致的内存溢出问题。
* **📡 网络请求监听:**
    自动捕获所有`Fetch/XHR`请求，并将其保存为HAR-like的JSON文件。
* **🖱️ 用户操作追踪:**
    使用Content Script注入页面，监听`click`, `input`等DOM事件，并记录其XPath路径，生成可读的操作日志。
* **📦 一键打包下载:**
    使用`JSZip`将视频、网络和操作日志合并为一个带时间戳的ZIP压缩包。
* **🕵️ (高级) 请求模拟:**
    (开发中) 允许你拦截特定的API请求，并返回自定义的Mock JSON数据，用于测试各种边缘Case。

---

### 快速开始 / 如何使用 (How to Use)

1.  **安装:**
    * (推荐) 从 Chrome Web Store 安装 `DejaVu` (链接待定)。
    * (开发) 或从源码加载：
        1.  `git clone https://github.com/your-repo/dejavu.git`
        2.  打开 Chrome -> `chrome://extensions`
        3.  开启 "Developer mode"
        4.  点击 "Load unpacked" 并选择 `dist` 目录。

2.  **开始录制:**
    * 打开一个测试网页。
    * 点击浏览器右上角的`DejaVu`图标，点击 **"Start Recording"**。
    * 插件图标会变为红色，表示正在录制。

3.  **开始测试:**
    * 正常执行你的测试流程。`DejaVu`正在后台的环形缓冲区中记录一切。

4.  **抓取BUG:**
    * **当BUG出现时**，立刻点击`DejaVu`图标，点击 **"Capture Bug!"**。
    * 插件会立即停止录制，并自动下载一个 `bug_report_[timestamp].zip` 文件。

5.  **提交BUG:**
    * 将这个ZIP文件附加到你的Bug工单中。**任务完成！**

---

### 技术实现 (Technical Deep-Dive)

本项目基于Chrome Manifest V3，其核心是`background.js` (Service Worker) 和 `content.js`。

**环形缓冲区 (Ring Buffer) 的实现:**

1.  **启动:** `chrome.tabCapture` API获取当前标签页的`MediaStream`。
2.  **切片:** `RecordRTC`被初始化并设置了`timeslice: 1000` (每秒1片)。
3.  **入队:** `ondataavailable`事件每秒触发一次，返回一个`Blob` (视频数据块)。
4.  **缓冲:** 我们将此`Blob`推入一个数组 `videoBuffer`。
5.  **出队 (核心):** 当`videoBuffer.length > 300` (5分钟 * 60秒)时，我们执行`videoBuffer.shift()`，从数组头部丢弃最老的数据块。
6.  **打包:** 用户点击“抓取”时，`RecordRTC`停止，我们将`videoBuffer`中的所有`Blob`块合并成一个完整的`Blob`文件，并使用`JSZip`打包。

这种设计确保了`DejaVu`的内存占用是**恒定的**，无论你录制10分钟还是10小时。

---

### Stage 1: MVP 核心功能交付现状

第一阶段聚焦“5分钟环形录屏”的可用 MVP，当前仓库已经包含以下交付物，位于 `extension/` 目录：

* `manifest.json`: Manifest V3 配置，注册 Service Worker 与 Popup UI 所需权限。
* `background.js`: 核心 Service Worker，负责 tabCapture 流、MediaRecorder 管理以及环形缓冲区逻辑。
* `ringBuffer.js`: 纯内存 Blob Ring Buffer 实现，维持固定窗口的最近 5 分钟视频片段。
* `popup.html / popup.js / popup.css`: 轻量化的控制面板，提供 Start / Stop / Capture Bug! 三个入口并实时反馈状态。

> 当前 MVP 专注于视频录制链路（KR1、KR2、KR4），网络日志与用户操作抓取将在后续阶段补齐。

---

### 本地加载与调试

1. 构建目录 (一次性)
    ```bash
    git clone <repo-url>
    cd DejaVu/extension
    ```
2. 打开 Chrome → 访问 `chrome://extensions/`。
3. 开启右上角 **Developer mode**。
4. 点击 **Load unpacked**，选择 `DejaVu/extension` 目录。
5. 固定 DejaVu 图标后，就可以在需要的标签页执行：
    - `Start Recording`: 触发 `chrome.tabCapture.capture` + `MediaRecorder`，开始 5 分钟环形缓存。
    - `Capture Bug!`: 立即请求最新数据块、合并 Blob，并通过 `chrome.downloads` 下载 `.webm`。
    - `Stop Recording`: 释放 MediaRecorder 与 tabCapture 流，重置缓冲区。

加载成功后，可以在扩展弹窗底部的提示区查看提示信息（例如下载文件名、缓冲时长与估算体积）。

---

### 内存占用验证（KR3）建议流程

1. **开启录制**：在目标页面点击 `Start Recording`，等待 ~30 秒确保缓冲区被填充。
2. **运行 10 分钟**：保持标签页前台以便持续写入视频数据，过程中可执行常规操作。
3. **监控内存**：
    - 方式 A：打开浏览器菜单 → More tools → **Task Manager**，关注 “DejaVu” 扩展的 Memory footprint。
    - 方式 B：在扩展弹窗中多次点击 `Capture Bug!`，观察提示信息里的 `~XX MB`，确认大小趋于稳定。
4. **记录结果**：确保 10 分钟后内存波动在 ±5% 内。若发现异常增长，可在 Task Manager 截图并附带扩展日志。

为了辅助排查，`background.js` 中的 `getStatus` 会返回 `chunkCount / approxSizeBytes` 等指标，可在 DevTools → Extensions Service Worker 控制台执行：

```js
chrome.runtime.sendMessage({ type: "GET_STATUS" }, console.log);
```

---

### 路线图 (Roadmap)

* [ ] (P1) 完善`chrome.debugger` API的请求模拟功能。
* [ ] (P2) 增加快捷操作按钮（如一键清除缓存/Cookies）。
* [ ] (P3) 优化XPath的稳定性，对抗动态UI。
* [ ] (P3) 集成Jira/GitLab API，实现一键提单。

### 贡献 (Contributing)

欢迎提交PRs！

### 许可 (License)

MIT
