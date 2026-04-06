# Realsee Offline Local

这个目录是独立的本地 3D 查看工作区，不依赖 `e_claude_code` 仓库。

## 打开如视离线包

```bash
python3 /Users/eutopia/workspace/realsee_offline_local/tools/realsee_offline_viewer.py --bundle BgxP9keL4ql3RNnl
```

离线包位置：

- `/Users/eutopia/workspace/realsee_offline_local/offline_bundles/BgxP9keL4ql3RNnl`

## 重新抓取如视分享页

```bash
python3 /Users/eutopia/workspace/realsee_offline_local/tools/realsee_offline_bundle.py '<分享页 URL>' --force
```

## 打开普通本地模型

```bash
python3 /Users/eutopia/workspace/realsee_offline_local/tools/local_model_viewer.py
```

## GitHub Pages

仓库已经带了 GitHub Pages 工作流：

- `/.github/workflows/deploy-pages.yml`
- `/site/index.html`

启用方法：

1. 打开仓库 `Settings -> Pages`
2. 在 `Build and deployment` 里把 `Source` 设为 `GitHub Actions`
3. 等待 `Deploy GitHub Pages` 工作流完成

部署完成后，根路径会自动跳转到当前离线查看器。
