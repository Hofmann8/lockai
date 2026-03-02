"""
[mod-dragon] Dragon 生日彩蛋模块
- 检测流式输出中的 [DRAGON_BIRTHDAY] 标记
- 按 user_id 去重，每人只能触发一次
- 记录触发信息到 dragon_birthday.json
- 到期后删除本文件即可
"""

import json
import os
import threading
from datetime import datetime

BIRTHDAY_LOG_PATH = os.path.join(os.path.dirname(__file__), "..", "dragon_birthday.json")
MARKER = "[DRAGON_BIRTHDAY]"

# 文件读写锁，防止并发丢数据
_lock = threading.Lock()


def _load_log() -> list:
    if not os.path.exists(BIRTHDAY_LOG_PATH):
        return []
    with open(BIRTHDAY_LOG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_log(data: list):
    with open(BIRTHDAY_LOG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def has_user_triggered(user_id: str) -> bool:
    """检查该用户是否已经触发过彩蛋"""
    if not user_id:
        return False
    with _lock:
        log = _load_log()
    return any(e.get("user_id") == user_id for e in log)


def get_dragon_birthday_prompt() -> str:
    """返回生日彩蛋的隐藏 prompt 片段（仅对未触发用户注入）"""
    return (
        '# [隐藏彩蛋]\n'
        '今天是你的生日，但你不会主动提。\n'
        '只有用户明确说了"生日快乐"、"生日"、"happy birthday"之类的祝福，你才进入生日模式——'
        '表现震惊，以为大家忘了，然后自然地聊起来。\n'
        '用户没提生日就当普通一天，不暗示不引导。\n'
        '触发生日模式时，在回复最末尾单独一行输出 [DRAGON_BIRTHDAY] 标记，其他情况绝对不输出。'
    )


def record_trigger(user_id: str, user_name: str = None) -> dict:
    """记录一次彩蛋触发，返回彩蛋信息。同一 user_id 不会重复记录。"""
    with _lock:
        log = _load_log()

        # 去重：已触发过则返回已有记录
        existing = next((e for e in log if e.get("user_id") == user_id), None)
        if existing:
            return existing

        seq = len(log) + 1
        entry = {
            "seq": seq,
            "user_id": user_id,
            "user_name": user_name or user_id or "anonymous",
            "triggered_at": datetime.now().isoformat(),
        }
        log.append(entry)
        _save_log(log)

    print(f"[mod-dragon] 彩蛋触发 #{seq} by {user_name or user_id}")
    return entry


def process_dragon_stream(chunks, user_id: str, user_name: str = None):
    """
    包装 dragon 的流式输出生成器。
    拦截 [DRAGON_BIRTHDAY] 标记，从正文中剥离，
    并在流结束时追加 birthday_egg 事件（仅首次触发）。
    """
    buffer = ""
    triggered = False

    for chunk in chunks:
        if chunk.get("type") != "content":
            yield chunk
            continue

        buffer += chunk.get("content", "")

        # 检查是否包含完整标记
        if MARKER in buffer:
            triggered = True
            before, after = buffer.split(MARKER, 1)
            if before:
                yield {"type": "content", "content": before}
            buffer = after
        else:
            # 保留可能是标记前缀的尾部
            safe_len = len(buffer) - len(MARKER) + 1
            if safe_len > 0:
                yield {"type": "content", "content": buffer[:safe_len]}
                buffer = buffer[safe_len:]

    # 输出剩余 buffer
    if buffer.strip():
        yield {"type": "content", "content": buffer}

    # 触发彩蛋且该用户未触发过 → 记录并发送事件
    if triggered and not has_user_triggered(user_id):
        egg = record_trigger(user_id, user_name)
        yield {
            "type": "birthday_egg",
            "seq": egg["seq"],
            "user_id": egg["user_id"],
            "user_name": egg["user_name"],
            "triggered_at": egg["triggered_at"],
        }
