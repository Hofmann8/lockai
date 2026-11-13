"""
中转站连通与参数自检：用后端自己的代码路径把线上会发给中转站的每类请求各打一次。

覆盖：Campbell 流式对话三档思考（low / high / xhigh）、带全部工具定义的流式请求、
识图（data URL）、绘图（generations）、修图（edits）。
主供应商失败时会自动换回退（models.json 的 fallback），日志里能看到「改用回退」。
会产生少量真实费用（对话每次约 4k 输入 token，绘图按上游计价）。

用法（在 backend 目录下）：
    python -u scripts/relay_smoke.py --out <输出目录> [--skip-images]
只测回退：把新供应商的 key 置空再跑
    CAMPBELL_API_KEY= IMAGE_API_KEY= python -u scripts/relay_smoke.py --out <输出目录>
"""

import argparse
import base64
import os
import sys
import time
import traceback
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(BACKEND_DIR)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(BACKEND_DIR / ".env")

from services.image import ImageService  # noqa: E402
from services.llm import LLMService  # noqa: E402
from services.tool_contracts import CHAT_TOOLS_WITH_SHELL, DELEGATE_TOOL  # noqa: E402

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"[{'OK' if ok else 'FAIL'}] {name}: {detail}", flush=True)


def run_stream(llm: LLMService, name: str, messages: list, *, thinking: bool, effort: str | None, tools=None) -> None:
    started = time.time()
    first = None
    text, tool_names, finish, usage, error = [], [], None, None, None
    for chunk in llm.stream_chat_completion(
        messages, model="campbell", tools=tools, enable_thinking=thinking, reasoning_effort=effort,
    ):
        kind = chunk.get("type")
        if kind == "error":
            error = chunk.get("content")
            break
        if kind == "usage":
            usage = chunk["usage"]
            continue
        if first is None:
            first = time.time() - started
        delta = chunk.get("delta") or {}
        if delta.get("content"):
            text.append(delta["content"])
        for tc in delta.get("tool_calls") or []:
            fn = (tc.get("function") or {}).get("name")
            if fn:
                tool_names.append(fn)
        finish = chunk.get("finish_reason") or finish
    total = time.time() - started
    if error:
        record(name, False, f"{error}（{total:.1f}s）")
        return
    reasoning = ((usage or {}).get("completion_tokens_details") or {}).get("reasoning_tokens")
    detail = (
        f"finish={finish} 首包={first or 0:.1f}s 总={total:.1f}s "
        f"in={(usage or {}).get('prompt_tokens')} out={(usage or {}).get('completion_tokens')} 思考={reasoning}"
    )
    if tool_names:
        detail += f" 工具={tool_names}"
    detail += f" 回复={''.join(text)[:60]!r}"
    record(name, finish in ("stop", "tool_calls") and usage is not None, detail)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="生成图片的保存目录")
    parser.add_argument("--skip-images", action="store_true", help="不测绘图 / 修图")
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    llm = LLMService()
    for model_id in ("campbell", "image_generator"):
        cfg = llm.get_model_config(model_id)
        fallback = llm.fallback_config(cfg) or {}
        print(f"  {model_id}: {cfg.get('model')} @ {cfg.get('api_base') or '（未配置）'}"
              f"，回退 {fallback.get('model')} @ {fallback.get('api_base')}", flush=True)

    ping = [{"role": "user", "content": "Reply with exactly: pong"}]
    for label, thinking, effort in (("fast", False, None), ("standard", True, "high"), ("deep", True, "xhigh")):
        run_stream(llm, f"chat:{label}", ping, thinking=thinking, effort=effort)

    tool_msg = [{"role": "user", "content": "用 web_search 工具搜索「杭州 今天 天气」。只调用工具，不要直接回答。"}]
    run_stream(llm, "chat:tools", tool_msg, thinking=False, effort=None, tools=CHAT_TOOLS_WITH_SHELL + [DELEGATE_TOOL])

    generated: tuple[bytes, str] | None = None
    if not args.skip_images:
        image = ImageService(llm, storage_service=None)
        candidates = image._image_candidates(image._get_image_model_config())
        if not candidates:
            record("image:generate", False, "没有可用的绘图 key")
            candidates = [({}, "")]
        cfg, key = candidates[0]
        name = "image:generate"
        request = image._normalize_image_request({"subject": "a brass padlock on a wooden desk, soft morning light"})
        prompt = image._build_image_prompt(request)
        started = time.time()
        try:
            extracted, failure, usage = image._openai_generate(cfg, key, request, prompt) if key else (None, "跳过", None)
        except Exception:
            extracted, failure, usage = None, traceback.format_exc(limit=1), None
        if extracted:
            path = out_dir / "image_generate.png"
            path.write_bytes(extracted[0])
            meta = image._inspect_image_bytes(extracted[0], extracted[1])
            record(name, True, f"{cfg.get('model')} {time.time() - started:.1f}s {meta.get('width')}x{meta.get('height')} usage={usage} 存={path}")
            generated = extracted
        elif key:
            record(name, False, f"{cfg.get('model')} {time.time() - started:.1f}s {failure}")

        if generated:
            request = image._normalize_image_edit_request({"instruction": "make the padlock silver", "imageConfig": {"imageSize": "1K"}})
            prompt = image._build_image_edit_prompt(request)
            started = time.time()
            extracted, failure, usage = image._openai_edit(
                cfg, key, request, prompt,
                source_bytes=generated[0], source_mime=generated[1],
            )
            if extracted:
                path = out_dir / "image_edit.png"
                path.write_bytes(extracted[0])
                record("image:edit", True, f"{cfg.get('edit_model')} {time.time() - started:.1f}s usage={usage} 存={path}")
            else:
                record("image:edit", False, f"{cfg.get('edit_model')} {time.time() - started:.1f}s {failure}")

            data_url = f"data:{generated[1]};base64,{base64.b64encode(generated[0]).decode()}"
            vision_msg = [{"role": "user", "content": [
                {"type": "text", "text": "用一句话描述这张图。"},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]}]
            run_stream(llm, "chat:vision", vision_msg, thinking=False, effort=None)
        else:
            record("image:edit", False, "没有生成成功的图片可用来修")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n汇总：{passed}/{len(results)} 通过", flush=True)
    for name, ok, _ in results:
        if not ok:
            print(f"  未通过：{name}", flush=True)


if __name__ == "__main__":
    main()
