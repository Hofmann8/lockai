"""
构建镜像前把大模型文件拉到 sandbox/models/（不进 git）。

    python sandbox/fetch_models.py

文件存在 OSS 私有目录 assets/models/ 下（GitHub 在国内下不动，当初是在北京沙箱里从
hf-mirror 下好再传上去的）。密钥读 backend/.env。
"""

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / "backend" / ".env")

from services.storage import StorageService  # noqa: E402

# 文件名 → md5（rembg 下载时校验的同一个值）
MODELS = {"u2net.onnx": "60024c5c889badc19c04ad937298a77b"}


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    storage = StorageService()
    target_dir = Path(__file__).resolve().parent / "models"
    target_dir.mkdir(exist_ok=True)
    for name, expected in MODELS.items():
        target = target_dir / name
        if target.exists() and md5(target) == expected:
            print(f"{name} 已就绪")
            continue
        url = storage.presign("GET", f"assets/models/{name}", expires=3600)
        print(f"下载 {name} …")
        urllib.request.urlretrieve(url, target)
        if md5(target) != expected:
            print(f"{name} 校验失败", file=sys.stderr)
            return 1
        print(f"{name} 完成（{os.path.getsize(target) // 1024 // 1024} MB）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
