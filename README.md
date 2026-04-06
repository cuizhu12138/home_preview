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
