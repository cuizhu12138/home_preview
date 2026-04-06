from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将如视分享页打包为本地离线 bundle")
    parser.add_argument("url", nargs="?", help="如视分享页 URL")
    parser.add_argument(
        "--bundle-id",
        help="输出 bundle 名称，默认使用 workCode",
    )
    parser.add_argument(
        "--output-root",
        default="offline_bundles",
        help="bundle 输出目录，默认 offline_bundles",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="如果目标 bundle 已存在则覆盖",
    )
    parser.add_argument(
        "--retry-failed-only",
        action="store_true",
        help="只重试现有 bundle 的失败资源，不重新抓取整页",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=8,
        help="并发下载数，默认 8",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="单个资源每个候选地址的重试次数，默认 3",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=90,
        help="单次下载超时时间（秒），默认 90",
    )
    return parser.parse_args()


def fetch_text(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", "ignore")


def fetch_bytes(url: str, timeout: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def extract_page_config(html: str) -> dict[str, Any]:
    match = re.search(
        r'id="state-page-config"[^>]*>\s*<!--\s*([\s\S]*?)\s*-->\s*</script>',
        html,
    )
    if not match:
        raise RuntimeError("页面中找不到 state-page-config")
    return json.loads(match.group(1))


def iter_urls(value: Any) -> list[str]:
    urls: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for item in node.values():
                walk(item)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str) and node.startswith(("http://", "https://")):
            urls.append(node)

    walk(value)
    return urls


def url_to_local_path(url: str) -> Path:
    parsed = urllib.parse.urlparse(url)
    path = parsed.path.lstrip("/")

    if not path:
        path = hashlib.sha1(url.encode("utf-8")).hexdigest()

    local = Path("assets") / parsed.netloc / path

    if parsed.query:
        suffix = hashlib.sha1(parsed.query.encode("utf-8")).hexdigest()[:10]
        local = local.with_name(f"{local.stem}__{suffix}{local.suffix}")

    return local


def rewrite_urls(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: rewrite_urls(item, mapping) for key, item in value.items()}
    if isinstance(value, list):
        return [rewrite_urls(item, mapping) for item in value]
    if isinstance(value, str) and value in mapping:
        return mapping[value]
    return value


def normalize_work_paths(work: dict[str, Any]) -> dict[str, Any]:
    model = work.get("model")
    if isinstance(model, dict):
        texture_base = model.get("material_base_url")
        textures = model.get("material_textures")
        if isinstance(texture_base, str) and isinstance(textures, list):
            prefix = texture_base.rstrip("/") + "/"
            normalized: list[Any] = []
            for item in textures:
                if isinstance(item, str) and item.startswith(prefix):
                    normalized.append(item[len(prefix):])
                else:
                    normalized.append(item)
            model["material_textures"] = normalized
    return work


def download_asset(
    url: str,
    destination: Path,
    retries: int,
    timeout: int,
) -> tuple[str, int]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    candidates = [url]

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "http":
        candidates.append(urllib.parse.urlunparse(parsed._replace(scheme="https")))

    last_error: Exception | None = None
    for candidate in candidates:
        for attempt in range(1, retries + 1):
            try:
                data = fetch_bytes(candidate, timeout)
                destination.write_bytes(data)
                return candidate, len(data)
            except (HTTPError, URLError, TimeoutError) as error:
                last_error = error
                if attempt < retries:
                    time.sleep(min(attempt, 3))

    raise RuntimeError(f"下载失败: {url} ({last_error})")


def main() -> int:
    args = parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    output_root = (repo_root / args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if args.retry_failed_only:
        if not args.bundle_id:
            print("--retry-failed-only 需要配合 --bundle-id 使用。", file=sys.stderr)
            return 1

        bundle_id = args.bundle_id
        bundle_dir = output_root / bundle_id
        meta_path = bundle_dir / "meta.json"
        work_path = bundle_dir / "work.json"
        if not meta_path.exists() or not work_path.exists():
            print(f"找不到现有 bundle 元数据: {bundle_dir}", file=sys.stderr)
            return 1

        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        failed_assets = meta.get("failed_assets", [])
        file_urls = [item["url"] for item in failed_assets if item.get("url")]
        directory_urls: list[str] = []
        mapping = {}
        rewritten_work = json.loads(work_path.read_text(encoding="utf-8"))
        work_code = meta.get("work_code") or bundle_id
        source_url = meta.get("source_url", "")
        title = meta.get("title") or bundle_id

        if not file_urls:
            print(f"bundle 没有待补抓的失败资源: {bundle_dir}")
            return 0
    else:
        if not args.url:
            print("缺少分享页 URL。", file=sys.stderr)
            return 1

        html = fetch_text(args.url)
        page_config = extract_page_config(html)
        firstscreen = page_config["firstscreen"]
        default_work = deepcopy(firstscreen.get("defaultWork") or {})

        if not default_work:
            print("页面里没有 defaultWork，无法生成离线 bundle。", file=sys.stderr)
            return 1

        work_code = default_work.get("code") or firstscreen["houseInfo"]["params"]["workCode"]
        bundle_id = args.bundle_id or work_code
        bundle_dir = output_root / bundle_id

        if bundle_dir.exists():
            if not args.force:
                print(f"bundle 已存在: {bundle_dir}", file=sys.stderr)
                print("如果你要覆盖，请加 --force", file=sys.stderr)
                return 1
            shutil.rmtree(bundle_dir)

        bundle_dir.mkdir(parents=True, exist_ok=True)

        default_work.setdefault("initial", {})
        default_work["initial"].setdefault("mode", "Panorama")

        urls = sorted(set(iter_urls(default_work)))
        directory_urls = [url for url in urls if urllib.parse.urlparse(url).path.endswith("/")]
        file_urls = [url for url in urls if url not in directory_urls]

        mapping = {
            url: f"./{url_to_local_path(url).as_posix()}"
            for url in urls
        }

        for url in directory_urls:
            (bundle_dir / url_to_local_path(url)).mkdir(parents=True, exist_ok=True)

        rewritten_work = normalize_work_paths(rewrite_urls(default_work, mapping))
        source_url = args.url
        title = firstscreen["houseInfo"].get("title") or default_work.get("title") or bundle_id

    print(
        f"准备下载 {len(file_urls)} 个文件资源到 {bundle_dir}"
        f"（另有 {len(directory_urls)} 个目录资源仅做路径改写）"
    )

    total_bytes = 0
    failed_urls: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=max(1, args.max_workers)) as executor:
        futures = {
            executor.submit(
                download_asset,
                url,
                bundle_dir / url_to_local_path(url),
                max(1, args.retries),
                max(1, args.timeout),
            ): url
            for url in file_urls
        }
        for future in as_completed(futures):
            asset_url = futures[future]
            try:
                actual_url, size = future.result()
            except Exception as error:
                failed_urls.append({
                    "url": asset_url,
                    "error": str(error),
                })
                print(f"下载失败 {asset_url}: {error}")
                continue

            total_bytes += size
            print(f"已下载 {size:>9} bytes  {actual_url}")

    previous_meta = {}
    meta_path = bundle_dir / "meta.json"
    if meta_path.exists():
        previous_meta = json.loads(meta_path.read_text(encoding="utf-8"))

    meta = {
        "bundle_id": bundle_id,
        "title": title,
        "work_code": work_code,
        "source_url": source_url,
        "downloaded_assets": previous_meta.get("downloaded_assets", len(file_urls)),
        "downloaded_bytes": int(previous_meta.get("downloaded_bytes", 0)) + total_bytes,
        "failed_assets": failed_urls,
        "created_at": previous_meta.get("created_at") or datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "model_url": rewritten_work.get("model", {}).get("file_url", ""),
        "panorama_count": rewritten_work.get("panorama", {}).get("count", 0),
        "observer_count": len(rewritten_work.get("observers", [])),
    }

    work_path = bundle_dir / "work.json"
    rewritten_work = normalize_work_paths(rewritten_work)
    work_path.write_text(json.dumps(rewritten_work, ensure_ascii=False, indent=2), encoding="utf-8")
    meta_path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n离线 bundle 已生成:")
    print(bundle_dir)
    print(f"\n启动查看器示例:")
    print(f"python3 {repo_root / 'tools' / 'realsee_offline_viewer.py'} --bundle {bundle_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
