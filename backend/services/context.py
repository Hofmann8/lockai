"""
一条回答里的上下文压缩。

沙箱任务一轮一个命令，每一轮都把之前所有命令和输出原样再发一遍：实测跑 24 轮，最后上下文约 5 万 token，
累计发出去的输入却有 75 万，越往后每一轮越贵；早期的调试输出还会分散模型的注意力。

只动这条回答自己产生的消息（系统提示、之前几轮对话不碰）。最近 KEEP_RECENT 轮原样保留，更早的：
- 工具调用参数里的长字符串（heredoc 写进去的整份脚本）只留开头：文件已经在沙箱里，要看再 cat / sed；
- 工具结果只留开头和结尾（报错一般在结尾）；
- show 附上的截图换成一行文字。
攒够 BATCH 轮才压一次：压过的前缀在接下来几轮保持不变，上游的前缀缓存还能命中。
"""

from __future__ import annotations

import json
from typing import Any

KEEP_RECENT = 6
BATCH = 8
ARG_KEEP = 400
RESULT_HEAD = 300
RESULT_TAIL = 500

ARG_NOTE = "\n…（这一步早已执行完，后面 {n} 字已从上下文省略；写出的文件还在沙箱里，需要时 cat / sed -n 查看）"
RESULT_NOTE = "\n…（较早的输出，中间 {n} 字已从上下文省略）…\n"
IMAGES_NOTE = "[沙箱截图] 较早查看过的 {n} 张截图，已从上下文移除。"


def compact_turn(messages: list[dict[str, Any]], start: int, done_upto: int) -> int:
    """压缩 messages[start:] 里较早的工具轮次，原地修改；返回压到了哪个下标（下次从这里接着算）。"""
    begin = max(start, done_upto)
    rounds = [
        i for i in range(begin, len(messages))
        if messages[i].get("role") == "assistant" and messages[i].get("tool_calls")
    ]
    if len(rounds) < KEEP_RECENT + BATCH:
        return done_upto
    cut = rounds[-KEEP_RECENT]
    for i in range(begin, cut):
        messages[i] = compact_message(messages[i])
    return cut


def compact_message(message: dict[str, Any]) -> dict[str, Any]:
    role = message.get("role")
    if role == "assistant" and message.get("tool_calls"):
        return {**message, "tool_calls": [_compact_call(call) for call in message["tool_calls"]]}
    if role == "tool" and isinstance(message.get("content"), str):
        return {**message, "content": _clip(message["content"])}
    if role == "user" and isinstance(message.get("content"), list):
        images = sum(1 for part in message["content"] if isinstance(part, dict) and part.get("type") == "image_url")
        if images:
            return {**message, "content": IMAGES_NOTE.format(n=images)}
    return message


def _compact_call(call: dict[str, Any]) -> dict[str, Any]:
    fn = call.get("function") or {}
    raw = fn.get("arguments")
    if not isinstance(raw, str) or len(raw) <= ARG_KEEP * 2:
        return call
    try:
        args = json.loads(raw)
    except (TypeError, ValueError):
        return call
    if not isinstance(args, dict):
        return call
    changed = False
    for key, value in args.items():
        if isinstance(value, str) and len(value) > ARG_KEEP * 2:
            args[key] = value[:ARG_KEEP] + ARG_NOTE.format(n=len(value) - ARG_KEEP)
            changed = True
    if not changed:
        return call
    return {**call, "function": {**fn, "arguments": json.dumps(args, ensure_ascii=False)}}


def _clip(text: str) -> str:
    if len(text) <= RESULT_HEAD + RESULT_TAIL + 200:
        return text
    omitted = len(text) - RESULT_HEAD - RESULT_TAIL
    return text[:RESULT_HEAD] + RESULT_NOTE.format(n=omitted) + text[-RESULT_TAIL:]
