from __future__ import annotations

import argparse
import errno
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动如视离线查看器")
    parser.add_argument("--bundle", help="要打开的 bundle 名称")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8770, help="监听端口，默认 8770")
    parser.add_argument("--no-browser", action="store_true", help="只启动服务，不自动打开浏览器")
    return parser.parse_args()


def make_handler(repo_root: Path) -> type[SimpleHTTPRequestHandler]:
    class RepoHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(repo_root), **kwargs)

        def log_message(self, fmt: str, *args) -> None:
            sys.stdout.write(f"[realsee-offline] {fmt % args}\n")

        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

    return RepoHandler


def bind_server(host: str, preferred_port: int, handler: type[SimpleHTTPRequestHandler]) -> ThreadingHTTPServer:
    candidates = [preferred_port] if preferred_port == 0 else [preferred_port + offset for offset in range(10)]
    last_error: OSError | None = None
    for port in candidates:
        try:
            return ThreadingHTTPServer((host, port), handler)
        except OSError as error:
            last_error = error
            if error.errno != errno.EADDRINUSE:
                raise
    assert last_error is not None
    raise last_error


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]

    if args.bundle:
        bundle_dir = repo_root / "offline_bundles" / args.bundle
        if not bundle_dir.exists():
            print(f"找不到 bundle: {bundle_dir}", file=sys.stderr)
            return 1

    handler = make_handler(repo_root)
    server = bind_server(args.host, args.port, handler)
    host, port = server.server_address
    target = f"http://{host}:{port}/viewer/realsee_offline/index.html"
    if args.bundle:
        target += f"?bundle={args.bundle}"

    if port != args.port:
        print(f"端口 {args.port} 已被占用，已自动切换到 {port}。")
    print(f"如视离线查看器已启动: {target}")
    print("按 Ctrl+C 停止服务。")

    if not args.no_browser:
        threading.Thread(target=lambda: webbrowser.open(target), daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭如视离线查看器...")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
