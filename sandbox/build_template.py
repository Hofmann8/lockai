"""
把推到 ACR 的沙箱镜像登记成函数计算云沙箱模板（杭州，必须和 ACR 同地域）。

    python sandbox/build_template.py <镜像地址> [--name 模板名]

阿里云不支持 E2B 的分步构建（RUN / COPY 之类），只能 from_image 整个镜像，
所以环境改动都在 Dockerfile 里做，这里只负责登记。密钥读 backend/.env。

阿里云的模板一个名字只能构建一次，所以模板名带上镜像版本（默认 lockai-office-<tag>）；
登记好后把 backend/.env 的 SANDBOX_TEMPLATE 改成新名字、重启后端即可切换，旧模板不受影响。
"""

import argparse
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from e2b import Template, default_build_logger

load_dotenv(Path(__file__).resolve().parents[1] / "backend" / ".env")


def default_name(image: str) -> str:
    last = image.rsplit("/", 1)[-1]
    tag = last.rsplit(":", 1)[-1] if ":" in last else "latest"
    return f"lockai-office-{tag}".lower().replace(".", "-").replace("_", "-")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", help="完整镜像地址，例如 crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/lock-service/lockai-sandbox:20260925")
    parser.add_argument("--name", help="模板名，默认 lockai-office-<镜像 tag>")
    parser.add_argument("--cpu", type=int, default=2)
    parser.add_argument("--memory", type=int, default=4096, help="MB")
    args = parser.parse_args()
    name = args.name or default_name(args.image)

    started = time.time()
    info = Template.build(
        Template().from_image(args.image),
        name=name,
        cpu_count=args.cpu,
        memory_mb=args.memory,
        on_build_logs=default_build_logger(),
        api_key=os.environ["E2B_API_KEY"],
        api_url=os.environ.get("E2B_API_URL"),
        domain=os.environ.get("E2B_DOMAIN"),
    )
    print(f"\n模板 {name} 就绪（{time.time() - started:.0f}s）：{info}")
    print(f"切换：backend/.env 里设 SANDBOX_TEMPLATE={name}，重启后端")
    return 0


if __name__ == "__main__":
    sys.exit(main())
