import json

from services.context import BATCH, KEEP_RECENT, compact_turn


def _round(i, command, output, images=0):
    msgs = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": f"c{i}",
                "type": "function",
                "function": {"name": "shell", "arguments": json.dumps({"title": f"第 {i} 步", "command": command}, ensure_ascii=False)},
            }],
        },
        {"role": "tool", "tool_call_id": f"c{i}", "content": output},
    ]
    if images:
        msgs.append({"role": "user", "content": [{"type": "text", "text": "[沙箱截图]"}] + [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}} for _ in range(images)
        ]})
    return msgs


def _conversation(rounds):
    history = [
        {"role": "system", "content": "系统提示"},
        {"role": "user", "content": "之前的问题"},
        {"role": "assistant", "content": "之前的回答"},
        {"role": "user", "content": "做一整套物料"},
    ]
    start = len(history)
    msgs = list(history)
    for i in range(rounds):
        msgs += _round(i, "cat > build.py <<'EOF'\n" + "x = 1\n" * 2000 + "EOF", "输出开头" + "o" * 5000 + "Traceback 在结尾", images=2 if i == 0 else 0)
    return msgs, start


def test_short_turns_are_left_alone():
    msgs, start = _conversation(KEEP_RECENT + BATCH - 1)
    snapshot = json.dumps(msgs, ensure_ascii=False)
    assert compact_turn(msgs, start, start) == start
    assert json.dumps(msgs, ensure_ascii=False) == snapshot


def test_old_rounds_are_compacted_and_recent_ones_kept():
    msgs, start = _conversation(KEEP_RECENT + BATCH)
    done = compact_turn(msgs, start, start)
    assert done > start

    # 之前的对话和系统提示原样不动
    assert msgs[:start] == _conversation(0)[0]

    old_call = json.loads(msgs[start]["tool_calls"][0]["function"]["arguments"])
    assert old_call["title"] == "第 0 步"
    assert len(old_call["command"]) < 600 and "cat / sed -n" in old_call["command"]
    old_result = msgs[start + 1]["content"]
    assert old_result.startswith("输出开头") and old_result.endswith("Traceback 在结尾") and len(old_result) < 1000
    assert msgs[start + 2]["content"] == "[沙箱截图] 较早查看过的 2 张截图，已从上下文移除。"

    # 最近 KEEP_RECENT 轮原样保留
    recent = [m for m in msgs[done:] if m.get("tool_calls")]
    assert len(recent) == KEEP_RECENT
    assert all(len(json.loads(m["tool_calls"][0]["function"]["arguments"])["command"]) > 10000 for m in recent)


def test_compacted_prefix_stays_stable_until_next_batch():
    msgs, start = _conversation(KEEP_RECENT + BATCH)
    done = compact_turn(msgs, start, start)
    prefix = json.dumps(msgs[:done], ensure_ascii=False)
    for i in range(BATCH - 1):
        msgs += _round(100 + i, "echo hi", "hi")
        assert compact_turn(msgs, start, done) == done
    assert json.dumps(msgs[:done], ensure_ascii=False) == prefix
    msgs += _round(200, "echo hi", "hi")
    assert compact_turn(msgs, start, done) > done
