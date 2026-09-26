"""
自己数一遍发给上游的 prompt 有多少 token。

中转站会往部分请求前面塞一段它自己的 instructions（2026-09 实测 4100~4400 token，
同一请求有时塞有时不塞，看落到哪个上游通道），这部分出现在 usage.prompt_tokens 里，
但不该算到用户头上。所以计费时拿自己数的量和上游报的量比，多出来的部分扣掉。

编码用 o200k_base（和 gpt-6-astra 实测对得上：没被注入时上游报 312，本地数 311）。
编码文件随代码放在 backend/assets/tiktoken/，服务器不用再去境外下载。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

_ASSETS = Path(__file__).resolve().parents[1] / "assets" / "tiktoken"
os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(_ASSETS))

# chat 格式每条消息的固定开销、回复前的引导 token
PER_MESSAGE = 3
REPLY_PRIMING = 3
# 图片按一张 1024 见方的高清图估（85 + 170 × 4 块）；宁可少扣不多扣
PER_IMAGE = 765

_CJK_RE = re.compile(r"[　-〿㐀-鿿＀-￯]")
_encoder: Any = None
_encoder_failed = False


def _encoding():
    global _encoder, _encoder_failed
    if _encoder is None and not _encoder_failed:
        try:
            import tiktoken

            _encoder = tiktoken.get_encoding("o200k_base")
        except Exception as exc:  # 没装 / 文件缺失：退回粗估
            print(f"[Tokens] tiktoken 不可用，改用粗估: {type(exc).__name__}: {exc}")
            _encoder_failed = True
    return _encoder


def count_text(text: str) -> int:
    if not text:
        return 0
    enc = _encoding()
    if enc is not None:
        return len(enc.encode(text, disallowed_special=()))
    # 粗估：中文一字约一个 token，其余约 3.5 字符一个
    cjk = len(_CJK_RE.findall(text))
    return cjk + round((len(text) - cjk) / 3.5)


def _content_tokens(content: Any) -> int:
    if isinstance(content, str):
        return count_text(content)
    if isinstance(content, list):
        total = 0
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") in {"image_url", "input_image", "image"}:
                total += PER_IMAGE
            else:
                total += count_text(str(part.get("text") or ""))
        return total
    return 0


def count_prompt(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> int:
    """一次 chat/completions 请求的输入 token（消息 + 工具定义）。"""
    total = REPLY_PRIMING
    for message in messages or []:
        total += PER_MESSAGE + _content_tokens(message.get("content"))
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            total += count_text(str(fn.get("name") or "")) + count_text(str(fn.get("arguments") or ""))
        if message.get("name"):
            total += 1
    if tools:
        total += count_text(json.dumps(tools, ensure_ascii=False, separators=(",", ":")))
    return total


def strip_injected(raw: dict[str, Any] | None, own_prompt: int | None) -> dict[str, Any] | None:
    """
    把上游 usage 里超出我们自己 prompt 的那部分输入扣掉，返回改过的 usage（不改原对象）。

    注入的 instructions 在最前面，缓存命中也先落在它身上，所以先从缓存里扣，扣不完再扣新输入。
    """
    if not isinstance(raw, dict) or not own_prompt:
        return raw
    key = "prompt_tokens" if "prompt_tokens" in raw else "input_tokens" if "input_tokens" in raw else None
    if key is None:
        return raw
    reported = int(raw.get(key) or 0)
    injected = max(0, reported - own_prompt)
    if injected == 0:
        return raw
    details_key = "prompt_tokens_details" if key == "prompt_tokens" else "input_tokens_details"
    details = dict(raw.get(details_key) or {})
    cached = int(details.get("cached_tokens") or 0)
    details["cached_tokens"] = max(0, cached - injected)
    adjusted = dict(raw)
    adjusted[key] = reported - injected
    adjusted[details_key] = details
    adjusted["injected_tokens"] = injected
    return adjusted


def reasoning_tokens_of(raw: dict[str, Any] | None) -> int | None:
    """上游报的思考 token（OpenAI / DeepSeek 都放在 completion_tokens_details 里）。"""
    if not isinstance(raw, dict):
        return None
    for key in ("completion_tokens_details", "output_tokens_details"):
        details = raw.get(key)
        if isinstance(details, dict) and details.get("reasoning_tokens") is not None:
            return int(details["reasoning_tokens"])
    return None
