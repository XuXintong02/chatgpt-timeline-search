# ChatGPT Timeline Search

一个面向长 ChatGPT 会话的浏览器扩展。它会在 ChatGPT 页面右侧注入一条轻量时间轴轨道，默认只显示浅灰色消息标记；鼠标移到右侧轨道、点击扩展图标或使用快捷键时，才弹出搜索和跳转面板。

![ChatGPT Timeline Search logo](assets/logo.svg)

## 项目状态

当前版本是可用的 MVP，适合在 GitHub 上开源发布，也可以作为后续 Chrome Web Store / Edge Add-ons 发布前的基础版本。

## 功能

- **运行形态**：Chrome / Edge Manifest V3 扩展。
- **注入范围**：`https://chatgpt.com/*` 和 `https://chat.openai.com/*`。
- **索引方式**：读取当前页面 DOM 中已经加载的消息节点，优先使用 ChatGPT 常见的 `data-message-author-role` 属性。
- **默认不遮挡**：不用时只露出右侧浅灰色时间轴标记。
- **悬停弹出**：鼠标移到右侧标记区域后，弹出简洁面板。
- **默认展示全部用户需求**：列表和右侧标记默认展示当前已加载的全部用户消息，小面板内部可独立滚动查找。
- **可选显示 ChatGPT 回复**：打开“显示 ChatGPT 回复”后，列表和标记会加入模型回复。
- **搜索**：在弹出面板输入关键词，结果会按消息顺序展示，点击后滚动到对应消息。
- **准确跳转到本轮起点**：点击用户需求会跳到该用户消息；点击 ChatGPT 回复时，会跳到它所属轮次的用户需求起始处。
- **历史扫描**：点击“向上扫描”会短暂滚动到会话顶部，触发页面加载更早消息，然后重新建立索引。
- **快捷键**：`Ctrl/Command + Shift + F` 打开并聚焦扩展搜索框。
- **扩展图标**：点击浏览器扩展图标可开关面板。

## 安装

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目根目录，也就是包含 `manifest.json` 的文件夹。
5. 打开或刷新 ChatGPT 会话页面，右侧会出现一列浅灰色时间轴标记。
6. 鼠标移到右侧标记区域，会弹出“时间轴”面板。

更详细的安装和使用步骤见 [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)。

## 设计边界

ChatGPT 页面通常不会在每条消息 DOM 上暴露可靠时间戳，所以当前版本的“时间轴”表示的是单次会话中的消息顺序和页面位置。扩展只索引浏览器当前已经加载到 DOM 的内容；如果很早的消息还没有被页面加载，需要先使用“向上扫描”。

## 文件结构

```text
manifest.json
assets/
  logo.svg
docs/
  USAGE.zh-CN.md
  PUBLISHING.zh-CN.md
scripts/
  package-extension.mjs
src/
  background.js
  content.js
  content.css
tests/
  e2e-chrome.mjs
  fixtures/chatgpt-like.html
  preview.html
README.md
```

## 打包

```bash
npm run package
```

打包产物会生成在 `dist/`：

```text
dist/chatgpt-timeline-search-v0.1.0.zip
```

## 开发验证

```bash
npm test
```

`tests/e2e-chrome.mjs` 会启动一份独立 Chrome 用户目录、打开本地模拟 ChatGPT 会话页面，并验证面板渲染、消息索引、搜索、跳转、角色过滤和时间轴过滤。

本地视觉预览：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开 `http://127.0.0.1:8765/tests/preview.html`。

## 隐私

扩展不会收集、上传、出售或分享你的 ChatGPT 对话内容。搜索和索引都在当前浏览器标签页本地完成。详见 [PRIVACY.md](PRIVACY.md)。

## 贡献

欢迎提交 issue 和 pull request。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发布到 GitHub

发布清单见 [docs/PUBLISHING.zh-CN.md](docs/PUBLISHING.zh-CN.md)。

## 许可证

[MIT](LICENSE)

## 后续可增强

- 支持正则、大小写敏感、整词匹配。
- 把命中关键词同步高亮到原始 ChatGPT 消息区域。
- 保存每个会话的本地索引，用于二次打开时快速恢复。
