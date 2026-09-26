"""统筹模型派活给执行助手：执行助手的步骤进同一份工具记录，思考和正文不外露，正文作为报告交回。"""

import json
import sys
import types

if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = boto3

from services.ai import AIService
from services.tool_contracts import DELEGATE_TOOL, WORKER_TOOLS


def _call(name, args, cid):
    return {"delta": {"tool_calls": [{"index": 0, "id": cid, "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}, "finish_reason": "tool_calls"}


class _TwoModelLLM:
    def __init__(self):
        self.calls = []

    def get_model_config(self, model_id):
        return {"name": "Scooby 2.0", "thinking_mode": "optional", "default_thinking": True} if model_id == "scooby" else {"delegate_to": "scooby"}

    def stream_chat_completion(self, messages, model=None, *, tools=None, **kwargs):
        self.calls.append({"model": model, "tools": [t["function"]["name"] for t in tools or []], "messages": list(messages)})
        done = any(m.get("role") == "tool" for m in messages)
        if model == "scooby":
            if not done:
                yield _call("shell", {"title": "生成票务表", "command": "python make.py"}, "w1")
            else:
                yield {"delta": {"reasoning_content": "执行助手在想"}}
                yield {"delta": {"content": "做好了 tickets.csv，600 行"}, "finish_reason": "stop"}
        elif not done:
            yield _call("delegate", {"title": "票务数据", "task": "生成 600 条售票记录，存成 outputs/tickets.csv"}, "o1")
        else:
            yield {"delta": {"content": "票务数据做好了"}, "finish_reason": "stop"}


def _fake_shell(self, arguments, *, tool_trace, turn, **_):
    trace = {"kind": "shell", "id": "s1", "command": arguments["command"], "title": arguments.get("title"), "status": "running"}
    if turn.get("task_id"):
        trace["taskId"] = turn["task_id"]
    tool_trace.append(trace)
    yield {"_append_marker": True, "type": "shell_start", "id": "s1", "command": trace["command"], "taskId": turn.get("task_id")}
    trace.update({"status": "done", "success": True, "files": [{"name": "tickets.csv", "path": "tickets.csv", "size": 2048, "url": "https://x/tickets.csv"}]})
    yield {"type": "shell_end", "id": "s1", "success": True}
    return "exit_code=0"


def test_delegated_work_runs_on_the_worker_and_reports_back(monkeypatch):
    monkeypatch.setattr(AIService, "_run_shell", _fake_shell)
    service = AIService.__new__(AIService)
    service.llm = _TwoModelLLM()
    service.max_tool_rounds = 10
    content_parts, tool_trace = [], []
    turn = {"pending_images": [], "content_parts": content_parts, "delegate_to": "scooby", "user_message": "帮我做票务数据"}
    events = list(service._chat_with_stream(
        llm_messages=[{"role": "user", "content": "帮我做票务数据"}], model_id="campbell", effective_thinking=False,
        reasoning_effort=None, assistant_message_id="a1", user_id="u1", session_id="s", current_user_images=[],
        current_user_message_id=None, tool_trace=tool_trace, content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None, "seconds": 0.0, "tokens": 0},
        turn=turn, tools=[*WORKER_TOOLS, DELEGATE_TOOL],
    ))

    types_seen = [e["type"] for e in events]
    assert types_seen[:4] == ["task_start", "shell_start", "shell_end", "task_end"]
    # 执行助手的思考和正文不外露
    assert not any(e["type"] == "reasoning_delta" for e in events)
    assert all("做好了 tickets.csv" not in e.get("delta", "") for e in events)

    task, step = tool_trace
    assert task["kind"] == "task" and task["success"] is True and "600 行" in task["report"] and task["model"] == "Scooby 2.0"
    assert step["taskId"] == task["id"]
    assert "".join(content_parts) == "<!--tool:0--><!--tool:1-->票务数据做好了"
    assert turn["task_id"] is None

    worker_call = next(c for c in service.llm.calls if c["model"] == "scooby")
    assert worker_call["tools"] == ["shell"]
    assert "执行助手" in worker_call["messages"][0]["content"]
    assert "帮我做票务数据" in worker_call["messages"][1]["content"]
    # 统筹模型拿到的是报告和文件清单
    report = next(m for m in service.llm.calls[-1]["messages"] if m.get("role") == "tool")["content"]
    assert "600 行" in report and "tickets.csv（2 KB）" in report
