# GitHub 发布清单

## 发布前检查

1. 确认 `README.md` 能说明项目用途、安装步骤、测试方法和隐私边界。
2. 确认 `PRIVACY.md` 说明不采集、不上传、不存储对话内容。
3. 确认 `LICENSE` 已存在。
4. 运行测试：

```bash
npm test
```

5. 生成扩展压缩包：

```bash
npm run package
```

压缩包会生成到 `dist/` 目录。

## 建议的 GitHub 仓库设置

- Repository name: `chatgpt-timeline-search`
- Description: `A local timeline and search extension for long ChatGPT conversations.`
- Visibility: Public
- License: MIT
- Topics:
  - `chatgpt`
  - `chrome-extension`
  - `edge-extension`
  - `timeline`
  - `search`
  - `manifest-v3`

## 首次推送流程

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin git@github.com:<your-name>/chatgpt-timeline-search.git
git push -u origin main
```

如果你使用 GitHub 网页上传，可以直接上传除 `dist/`、`.tmp/`、`node_modules/` 之外的项目文件。

## Release 建议

首次 GitHub Release 可以使用：

- Tag: `v0.1.0`
- Title: `ChatGPT Timeline Search v0.1.0`
- Notes: 复制 `CHANGELOG.md` 中 `0.1.0` 的内容。
- Assets: 上传 `dist/chatgpt-timeline-search-v0.1.0.zip`。
