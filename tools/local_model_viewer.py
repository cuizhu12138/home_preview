from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动本地 3D 模型查看器")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="只启动服务，不自动打开浏览器",
    )
    return parser.parse_args()


def make_handler(viewer_dir: Path) -> type[SimpleHTTPRequestHandler]:
    class ViewerHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(viewer_dir), **kwargs)

        def log_message(self, fmt: str, *args) -> None:
            sys.stdout.write(f"[viewer] {fmt % args}\n")

    return ViewerHandler


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    viewer_dir = repo_root / "viewer"

    if not viewer_dir.exists():
        print(f"找不到查看器目录: {viewer_dir}", file=sys.stderr)
        return 1

    handler = make_handler(viewer_dir)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    url = f"http://{args.host}:{args.port}/"

    print(f"本地 3D 查看器已启动: {url}")
    print("按 Ctrl+C 停止服务。")

    if not args.no_browser:
        threading.Thread(target=lambda: webbrowser.open(url), daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭查看器服务...")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
