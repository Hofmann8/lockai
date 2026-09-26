"""
AI Service - 主服务入口
整合 LLM、搜索、图像生成等功能
"""

from __future__ import annotations

import json
import os
import queue
import re
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Generator
from urllib.parse import unquote, urlsplit

from models import (
    db,
    ChatMessage,
    ChatSession,
    GeneratedImage,
    sanitize_assistant_content,
    strip_assistant_reasoning,
)

from .image import ImageService
from .llm import LLMService
from .prompts import current_time_context, get_identity_reminder, get_system_prompt
from .runs import MAX_PER_USER as MAX_RUNS_PER_USER, MAX_SECONDS as MAX_RUN_SECONDS
from .sandbox import INPUTS_DIR, SandboxService, input_relpath, safe_filename
from .search import SearchService, engine_label, normalize_search_args
from .storage import StorageService, strip_image_processing
from .context import compact_turn
from .tokens import count_prompt, count_text, reasoning_tokens_of, strip_injected
from .tool_contracts import (
    CHAT_TOOLS,
    CHAT_TOOLS_WITH_SHELL,
    DELEGATE_INSTRUCTION,
    DELEGATE_TOOL,
    SANDBOX_INSTRUCTION,
    WORKER_INSTRUCTION,
    WORKER_TOOLS,
    delivery_preference,
)
from .title import TitleService


# 一次回答里最多搜几次。超过后不再真的去搜，而是告诉模型"够了，直接答"。
MAX_SEARCHES_PER_ANSWER = 4
# 同一轮里紧挨着工具调用的一小段话（"我去查一下…"）算作这一步的说明：从正文收走，挂到工具卡片上。
# 只看结构不看措辞：够短、没分段才收；长篇正文（先讲一段再去画图之类）照常留在回答里。
PREAMBLE_MAX_CHARS = 200
SEARCH_BUDGET_EXHAUSTED = (
    "本次回答已经搜索过多次，不要再调用 web_search。"
    "请基于已经拿到的搜索结果直接回答用户；信息确实不足就如实说明缺了什么。"
)
FINAL_ROUND_NUDGE = (
    "工具调用次数已用完。现在请直接用已有的信息回答用户的问题，"
    "不要再尝试调用任何工具，也不要提到工具次数。"
)
# 快到轮数 / 时间上限时提醒一次：先把做好的交付出去，别等到被截停时手里还是半成品
WRAP_UP_ROUNDS = 6
WRAP_UP_SECONDS = 5 * 60
WRAP_UP_NUDGE = (
    "这条回答能用的{budget}快用完了。现在开始收尾：不要再开新的大块工作，"
    "先把已经做好的成品整理交付（该打包的打包、该写说明的写说明），"
    "再用几句话告诉用户哪些做完了、哪些还没做；没做完的部分用户回一句「继续」就能接着做。"
)
# 输出被上游截断（finish_reason=length）时的补救：只想没写就关掉思考重来；写了一半就接着写
MAX_CONTINUATIONS = 3
CONTINUE_NUDGE = "（输出在上面断开了。紧接着断开处继续写完，不要重复已经写过的内容，不要加开场白或说明。）"
DIRECT_ANSWER_NUDGE = "思考已经足够了。现在不要再思考，直接输出给用户的完整回答。"
EMPTY_ANSWER_FALLBACK = "（这次没能生成回答，可能是思考太长把篇幅用完了。可以直接重试，或切换到「快速」再试。）"
TOOL_LIMIT_FALLBACK = "\n\n（这次查了很多资料还没理清，可以换个问法或把问题拆小一点再试。）"

# 统筹模型派给执行助手的一块工作：最多这么多轮（执行助手是免费的 Scooby，不计费）
WORKER_MAX_ROUNDS = 50

# 回答被中途停下（services/runs.py）：_chat_with_stream 返回这个值
STOPPED = "stopped"
# 不是用户自己停的，要在回答末尾说清楚为什么停、怎么接着做
STOP_NOTES = {
    "evicted": f"\n\n> 同时在回答的对话超过了 {MAX_RUNS_PER_USER} 个，这条先停在这里，已经做好的部分都保存了。发一句「继续」就能接着做。",
    "timeout": f"\n\n> 这条回答已经做了 {MAX_RUN_SECONDS // 60} 分钟，先停在这里，已经做好的部分都保存了。发一句「继续」就能接着做。",
}
# 中途出错（额度用完、上游报错）：做到一半的照样存下来，不然重试之前就什么都没了
FAIL_NOTES = {
    "quota": "\n\n> 额度用完了，这条先停在这里，已经做好的部分都保存了。额度恢复后发一句「继续」就能接着做。",
    "error": "\n\n> 回答中途出错（{message}），已经做好的部分都保存了。发一句「继续」就能接着做。",
}

TOOL_MARKER_RE = re.compile(r"<!--tool:\d+-->")

# shell 输出：给模型看的保留头尾，给界面看的只留结尾
SHELL_OUTPUT_FOR_MODEL = 8000
SHELL_OUTPUT_HEAD = 2000
SHELL_OUTPUT_FOR_UI = 6000
SHELL_STREAM_INTERVAL = 0.3


class AIService:
    """AI 服务主入口。"""

    # 没配沙箱时的默认值（测试里也会绕过 __init__ 直接构造）
    tools = CHAT_TOOLS
    sandbox: SandboxService | None = None

    def __init__(self):
        self.llm = LLMService()
        self.storage = StorageService()
        self.search = SearchService(self.llm)
        self.image = ImageService(self.llm, self.storage)
        self.title = TitleService(self.llm)
        self.sandbox = SandboxService(self.storage)
        self.tools = CHAT_TOOLS_WITH_SHELL if self.sandbox.available else CHAT_TOOLS
        from .usage import UsageService
        self.usage = UsageService()
        # 沙箱任务一步一个命令，做个 PPT 要十几轮，一次要一整套物料的能到八九十轮。
        # 这是没在 models.json 里单独配 max_tool_rounds 的模型的默认值（免费的 Scooby 配得更多）；
        # 较早的轮次会压缩（services/context.py），快到上限前提醒模型收尾，兜底的是单条回答的时间上限（runs.py）和额度
        self.max_tool_rounds = max(1, int(self._safe_env("CHAT_TOOL_MAX_ROUNDS", "80")))

    def available_models(self) -> list[dict[str, Any]]:
        result = []
        for cfg in self.llm.get_chat_models():
            result.append({
                "id": cfg["id"],
                "name": cfg.get("name", cfg["id"]),
                "description": cfg.get("description", ""),
                "available": cfg.get("available", True),
                "is_default": cfg.get("is_default", False),
                "thinking_mode": cfg.get("thinking_mode", "never"),
                "default_thinking": cfg.get("default_thinking", False),
                "tags": cfg.get("tags", []),
                "supports_reasoning_effort": cfg.get("thinking_mode", "never") != "never",
            })
        return result

    def get_default_model_id(self) -> str:
        return self.llm.get_default_chat_model_id()

    def normalize_chat_model_id(self, model_id: str | None = None) -> str:
        return self.llm.normalize_chat_model_id(model_id)

    def generate_title(self, user_message: str, assistant_message: str = "") -> str:
        return self.title.generate(user_message)

    def suggest_followups(self, user_message: str, assistant_message: str) -> list[str]:
        return self.title.suggest_followups(user_message, assistant_message)

    def chat_stream(
        self,
        message: str,
        history: list | None = None,
        model_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        images: list | None = None,
        thinking: bool | None = None,
        reasoning_effort: str | None = None,
        current_message_id: str | None = None,
        image_quality: str | None = None,
        files: list | None = None,
        delivery: str | None = None,
        control: Any = None,
    ) -> Generator[dict[str, Any], None, None]:
        """control：后台运行的这一轮（services/runs.py 的 Run），有 should_stop() 和 stop_reason"""
        requested_model_id = self.normalize_chat_model_id(model_id)
        runtime_model_id = requested_model_id
        session = ChatSession.query.get(session_id) if session_id else None
        if session_id and not session:
            yield {"type": "error", "message": "会话不存在"}
            return
        if session and session.model_id != requested_model_id:
            session.model_id = requested_model_id
            session.updated_at = datetime.utcnow()
            db.session.commit()

        cfg = self.llm.get_model_config(runtime_model_id)

        effective_thinking = self._resolve_thinking(cfg, thinking)
        hd_image = str(image_quality or "").strip().lower() == "hd"
        assistant_message_id = str(uuid.uuid4())

        billable = self._is_billable_chat(cfg)

        if billable and user_id:
            ok, scope, quota_msg = self.usage.check(user_id, self.usage.CHAT_COST)
            if not ok:
                yield {"type": "message_start", "message_id": assistant_message_id}
                yield {"type": "error", "code": f"quota_{scope}", "message": quota_msg}
                return

        yield {"type": "message_start", "message_id": assistant_message_id}

        content_parts: list[str] = []
        tool_trace: list[dict[str, Any]] = []
        # 这一轮回答里跨工具调用共享的东西：沙箱连接、当前附件、等着给模型看的图片
        turn: dict[str, Any] = {
            "session": session, "files": files or [], "images": images or [], "sandbox": None, "pending_images": [],
            "control": control,
            # 派活（delegate）用：执行助手是哪个模型、用户原话、回答正文（执行助手的步骤标记要插进来）
            "delegate_to": self._delegate_target(cfg), "user_message": message, "content_parts": content_parts,
        }
        # 思考：上游给的思考文字（有的只给小标题）照旧落库；界面只显示思考用时和 token 数
        reasoning_state: dict[str, Any] = {"parts": [], "started": None, "ended": None, "seconds": 0.0, "tokens": 0}
        llm_messages = self._build_messages(
            message=message,
            history=history or [],
            model_id=runtime_model_id,
            session_id=session_id,
            images=images or [],
            current_user_message_id=current_message_id,
            files=files or [],
            delivery=delivery,
        )
        llm_messages = self._preprocess_vision_if_blind(llm_messages, cfg)

        try:
            if self._should_stream_chat(cfg):
                completed = yield from self._noting_errors(turn, self._chat_with_stream(
                    reasoning_state=reasoning_state,
                    tools=self.tools + [DELEGATE_TOOL] if turn["delegate_to"] else None,
                    llm_messages=llm_messages,
                    model_id=runtime_model_id,
                    effective_thinking=effective_thinking,
                    reasoning_effort=reasoning_effort,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=images or [],
                    current_user_message_id=current_message_id,
                    tool_trace=tool_trace,
                    content_parts=content_parts,
                    hd_image=hd_image,
                    billable=billable,
                    turn=turn,
                ))
            else:
                completed = yield from self._noting_errors(turn, self._chat_with_complete(
                    llm_messages=llm_messages,
                    model_id=runtime_model_id,
                    effective_thinking=effective_thinking,
                    reasoning_effort=reasoning_effort,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=images or [],
                    current_user_message_id=current_message_id,
                    tool_trace=tool_trace,
                    content_parts=content_parts,
                    hd_image=hd_image,
                    billable=billable,
                    turn=turn,
                ))
            if completed == STOPPED:
                yield from self._finish_stopped(
                    reason=getattr(control, "stop_reason", None) or "user",
                    assistant_message_id=assistant_message_id,
                    session=session,
                    content_parts=content_parts,
                    tool_trace=tool_trace,
                    reasoning_state=reasoning_state,
                )
                return
            if completed is False:
                self._save_partial(
                    self._fail_note(turn.get("failure")),
                    assistant_message_id=assistant_message_id,
                    session=session,
                    content_parts=content_parts,
                    tool_trace=tool_trace,
                    reasoning_state=reasoning_state,
                )
                return

            self._save_assistant_message(
                assistant_message_id=assistant_message_id,
                session=session,
                content="".join(content_parts),
                tool_trace=tool_trace,
                reasoning="".join(reasoning_state["parts"]),
                reasoning_seconds=self._reasoning_seconds(reasoning_state),
                reasoning_tokens=reasoning_state.get("tokens") or None,
            )

            yield {"type": "message_end", "message_id": assistant_message_id}

            if session and session.title == "新对话":
                title = self.title.generate(message)
                if title:
                    session.title = title
                    session.updated_at = datetime.utcnow()
                    db.session.commit()
                    yield {"type": "title_update", "title": title}
        except Exception as exc:
            print(f"[Chat] 异常: {type(exc).__name__}: {exc}")
            db.session.rollback()
            yield {"type": "error", "message": f"聊天失败: {exc}"}
            try:
                self._save_partial(
                    self._fail_note({"message": str(exc)}),
                    assistant_message_id=assistant_message_id,
                    session=session,
                    content_parts=content_parts,
                    tool_trace=tool_trace,
                    reasoning_state=reasoning_state,
                )
            except Exception as save_exc:
                db.session.rollback()
                print(f"[Chat] 保存半截回答失败: {type(save_exc).__name__}: {save_exc}")
        finally:
            # 被新回答挤掉 / 超时的：存好快照就把沙箱释放掉，不再空等回收
            self._snapshot_later(turn, release=getattr(control, "stop_reason", None) in ("evicted", "timeout"))

    def _delegate_target(self, cfg: dict[str, Any]) -> str:
        """这个模型能派活给谁（models.json 的 delegate_to）；没配、或者没有沙箱就不派"""
        target = str((cfg or {}).get("delegate_to") or "").strip()
        return target if target and self._sandbox_ready() else ""

    def _run_delegate(
        self,
        arguments: dict[str, Any],
        *,
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        turn: dict[str, Any],
    ) -> Generator[dict[str, Any], None, str]:
        """
        统筹模型派的一块活：执行助手（免费的 Scooby）在同一个沙箱里用自己的一套上下文把它做完。
        它的每一步照常进回答的工具记录（带 taskId），界面上收在这块工作的卡片里；它的思考和正文不给用户看，
        正文就是交回给统筹模型的报告。
        """
        title = str(arguments.get("title") or "").strip()[:40] or "执行任务"
        task = str(arguments.get("task") or "").strip()
        worker_id = str(turn.get("delegate_to") or "")
        worker_cfg = self.llm.get_model_config(worker_id) or {}
        task_id = uuid.uuid4().hex[:8]
        trace: dict[str, Any] = {
            "kind": "task", "id": task_id, "title": title, "task": task, "status": "running",
            "model": worker_cfg.get("name") or worker_id,
        }
        tool_trace.append(trace)
        started = time.monotonic()
        yield {
            "_append_marker": True, "type": "task_start", "message_id": assistant_message_id,
            "id": task_id, "title": title, "task": task, "model": trace["model"],
        }

        def finish(success: bool, report: str) -> dict[str, Any]:
            seconds = round(time.monotonic() - started, 1)
            trace.update({"status": "done", "success": success, "report": report, "seconds": seconds})
            return {"type": "task_end", "message_id": assistant_message_id, "id": task_id,
                    "success": success, "report": report, "seconds": seconds}

        if not task:
            yield finish(False, "没有任务说明")
            return "task 为空：写清这块工作的目标、输入、产出文件名、规格和验收标准再派。"

        parent_parts: list[str] = turn.get("content_parts") if isinstance(turn.get("content_parts"), list) else []
        worker_parts: list[str] = []
        messages = [
            {"role": "system", "content": f"{WORKER_INSTRUCTION}\n\n{current_time_context()}\n\n{SANDBOX_INSTRUCTION}"},
            {"role": "user", "content": f"{task}\n\n---\n用户的原话（仅供参考，以上面的任务说明为准）：\n{turn.get('user_message') or ''}"},
        ]
        first_step = len(tool_trace)
        # 执行助手有自己的截图队列；统筹模型这一轮之前要看的图先收起来，做完放回去
        saved_images = turn.get("pending_images") or []
        turn["pending_images"] = []
        turn["task_id"] = task_id
        result: Any = None
        error = ""
        try:
            worker = self._chat_with_stream(
                llm_messages=messages,
                model_id=worker_id,
                effective_thinking=self._resolve_thinking(worker_cfg, None),
                reasoning_effort=None,
                assistant_message_id=assistant_message_id,
                user_id=user_id,
                session_id=session_id,
                current_user_images=[],
                current_user_message_id=None,
                tool_trace=tool_trace,
                content_parts=worker_parts,
                billable=False,
                reasoning_state={"parts": [], "started": None, "ended": None, "seconds": 0.0, "tokens": 0},
                turn=turn,
                tools=WORKER_TOOLS,
                max_rounds=WORKER_MAX_ROUNDS,
            )
            while True:
                try:
                    event = next(worker)
                except StopIteration as stop:
                    result = stop.value
                    break
                kind = event.get("type")
                if kind == "shell_start":
                    # 步骤卡片的位置标记插进回答正文（执行助手自己的正文不给用户看）
                    idx = next((i for i, t in enumerate(tool_trace) if t.get("kind") == "shell" and t.get("id") == event.get("id")), -1)
                    if idx >= 0:
                        parent_parts.append(f"<!--tool:{idx}-->")
                    yield event
                elif kind in ("shell_output", "shell_end", "shell_env"):
                    yield event
                elif kind == "error":
                    error = str(event.get("message") or "执行出错")
        finally:
            turn["task_id"] = None
            turn["pending_images"] = saved_images

        report = TOOL_MARKER_RE.sub("", "".join(worker_parts)).strip()
        steps = [t for t in tool_trace[first_step:] if t.get("kind") == "shell"]
        failed = sum(1 for t in steps if t.get("success") is False)
        delivered: dict[str, dict[str, Any]] = {}
        for step in steps:
            for f in step.get("files") or []:
                if f.get("url"):
                    delivered[f.get("path") or f.get("name")] = f
        if result == STOPPED:
            yield finish(False, report or "这块工作做到一半被停下了")
            return "回答被停下了（用户停止或超时），不要再派活。"
        success = result is True and not error
        if not report:
            report = error or "执行助手没有写报告"
        yield finish(success, report)
        lines = [f"执行助手的报告（{len(steps)} 步，{failed} 步出错）：", report]
        if delivered:
            lines.append("这块工作交付的文件：" + "、".join(f"{f.get('path') or f.get('name')}（{_human_size(f.get('size') or 0)}）" for f in delivered.values()))
        if error:
            lines.append(f"执行中断：{error}")
        return "\n".join(lines)

    def _max_rounds(self, model_id: str) -> int:
        """一条回答最多几轮工具调用：models.json 里按模型配（免费的 Scooby 给得多），没配用 CHAT_TOOL_MAX_ROUNDS"""
        getter = getattr(self.llm, "get_model_config", None)
        cfg = getter(model_id) if callable(getter) else {}
        try:
            return max(1, int((cfg or {}).get("max_tool_rounds") or self.max_tool_rounds))
        except (TypeError, ValueError):
            return self.max_tool_rounds

    @staticmethod
    def _budget_running_out(turn: dict[str, Any] | None, *, rounds_left: int) -> str:
        """轮数或时间快用完时返回提醒里的说法（"操作次数（还剩 5 次）"），还够就返回空"""
        if rounds_left <= WRAP_UP_ROUNDS:
            return f"操作次数（还剩 {rounds_left} 次）"
        started = getattr((turn or {}).get("control"), "started_at", None)
        if isinstance(started, (int, float)):
            left = MAX_RUN_SECONDS - (time.time() - started)
            if left <= WRAP_UP_SECONDS:
                return f"时间（还剩约 {max(1, round(left / 60))} 分钟）"
        return ""

    @staticmethod
    def _stopped(turn: dict[str, Any] | None) -> bool:
        control = (turn or {}).get("control")
        return bool(control and control.should_stop())

    def _finish_stopped(
        self,
        *,
        reason: str,
        assistant_message_id: str,
        session: ChatSession | None,
        content_parts: list[str],
        tool_trace: list[dict[str, Any]],
        reasoning_state: dict[str, Any],
    ) -> Generator[dict[str, Any], None, None]:
        """中途停下：已经写出来的和做完的步骤照常保存（丢弃 / 会话已删除的除外）"""
        note = STOP_NOTES.get(reason)
        if note:
            content_parts.append(note)
            yield {"type": "content_delta", "delta": note}
        if reason not in ("discard", "deleted"):
            self._save_partial(
                "",
                assistant_message_id=assistant_message_id,
                session=session,
                content_parts=content_parts,
                tool_trace=tool_trace,
                reasoning_state=reasoning_state,
            )
        print(f"[Chat] 回答中途停止（{reason}）")
        yield {"type": "message_end", "message_id": assistant_message_id, "stopped": reason}

    def _save_partial(
        self,
        note: str,
        *,
        assistant_message_id: str,
        session: ChatSession | None,
        content_parts: list[str],
        tool_trace: list[dict[str, Any]],
        reasoning_state: dict[str, Any],
    ) -> None:
        """做到一半的回答（停下 / 出错）：写出来的正文和做过的步骤存下来，末尾附一句说明；什么都还没做就不存"""
        for item in tool_trace:
            if item.get("status") == "running":
                item.update({"status": "done", "success": False})
        if not session or not ("".join(content_parts).strip() or tool_trace):
            return
        live = db.session.get(ChatSession, session.id)
        if not live:
            return
        self._save_assistant_message(
            assistant_message_id=assistant_message_id,
            session=live,
            content="".join(content_parts) + note,
            tool_trace=tool_trace,
            reasoning="".join(reasoning_state["parts"]),
            reasoning_seconds=self._reasoning_seconds(reasoning_state),
            reasoning_tokens=reasoning_state.get("tokens") or None,
        )

    @staticmethod
    def _fail_note(failure: dict[str, Any] | None) -> str:
        failure = failure or {}
        if str(failure.get("code") or "").startswith("quota_"):
            return FAIL_NOTES["quota"]
        message = str(failure.get("message") or "未知错误").strip()[:80]
        return FAIL_NOTES["error"].format(message=message)

    @staticmethod
    def _noting_errors(turn: dict[str, Any], events: Generator[dict[str, Any], None, Any]) -> Generator[dict[str, Any], None, Any]:
        """原样转发一轮回答的事件，顺手记下报过的错（出错收尾时要用它写说明）"""
        try:
            while True:
                try:
                    event = next(events)
                except StopIteration as stop:
                    return stop.value
                if event.get("type") == "error":
                    turn["failure"] = event
                yield event
        finally:
            events.close()

    def _should_stream_chat(self, cfg: dict[str, Any]) -> bool:
        transport = str(cfg.get("transport") or cfg.get("provider") or "").strip().lower()
        if transport.startswith("anthropic"):
            return False
        return True

    def _record_chat_usage(
        self, user_id: str, raw_usage: dict[str, Any] | None, model_id: str, own_prompt: int | None = None,
    ) -> None:
        try:
            cfg = self.llm.get_model_config(model_id)
            # 中转站塞进来的 instructions 不算用户的
            billed = strip_injected(raw_usage, own_prompt)
            spent = self.usage.record_chat_call(user_id, billed, cfg)
            injected = (billed or {}).get("injected_tokens") if isinstance(billed, dict) else None
            note = f"，扣除中转注入 {injected}" if injected else ""
            print(f"[Usage] chat {model_id} 扣 {spent:g} credits{note} (usage={raw_usage})")
        except Exception as exc:
            print(f"[Usage] record_chat_call failed: {type(exc).__name__}: {exc}")

    def _record_image_usage(self, user_id: str, raw_usage: dict[str, Any] | None, hd: bool) -> None:
        try:
            cfg = self.llm.get_model_config("image_generator_hd" if hd else "image_generator")
            spent = self.usage.record_image_call(user_id, raw_usage, cfg)
            print(f"[Usage] image {cfg.get('model')} 扣 {spent:g} credits (usage={raw_usage})")
        except Exception as exc:
            print(f"[Usage] record_image_call failed: {type(exc).__name__}: {exc}")

    def _is_billable_chat(self, cfg: dict[str, Any]) -> bool:
        """models.json 里标记 billable 的模型走 Campbell 配额；其他模型免费。"""
        return bool(cfg.get("billable"))

    def _chat_with_stream(
        self,
        *,
        llm_messages: list[dict[str, Any]],
        model_id: str,
        effective_thinking: bool,
        reasoning_effort: str | None,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
        hd_image: bool = False,
        billable: bool = False,
        reasoning_state: dict[str, Any] | None = None,
        turn: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_rounds: int | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        turn = turn if turn is not None else {"pending_images": []}
        tools = tools if tools is not None else self.tools
        continuations = 0
        round_thinking = effective_thinking
        max_rounds = max_rounds or self._max_rounds(model_id)
        # 收尾提醒只给在动手干活（调过工具）的回答
        used_tools = wrap_up_sent = False
        # 这条回答自己产生的消息从这里开始；较早的工具轮次攒够一批就压缩（services/context.py）
        turn_start = compacted = len(llm_messages)
        for _round in range(max_rounds):
            if self._stopped(turn):
                return STOPPED
            if used_tools and not wrap_up_sent:
                budget = self._budget_running_out(turn, rounds_left=max_rounds - _round - 1)
                if budget:
                    llm_messages.append({"role": "system", "content": WRAP_UP_NUDGE.format(budget=budget)})
                    wrap_up_sent = True
            before = compacted
            compacted = compact_turn(llm_messages, turn_start, compacted)
            if compacted != before:
                print(f"[Chat] 第 {_round + 1} 轮压缩较早的工具记录，上下文约 {count_prompt(llm_messages, tools)} token")
            if _round > 0 and billable and user_id:
                ok, scope, quota_msg = self.usage.check(user_id, self.usage.CHAT_COST)
                if not ok:
                    yield {"type": "error", "code": f"quota_{scope}", "message": quota_msg}
                    return False

            round_content = ""
            parsed_calls = []
            round_usage: dict[str, Any] | None = None
            tool_call_accumulators: dict[int, dict[str, Any]] = {}

            # 最后一轮不给工具，逼模型用手里已有的结果作答，而不是吐一句"轮数已达上限"
            final_round = _round == max_rounds - 1
            if final_round and _round > 0:
                llm_messages.append({"role": "system", "content": FINAL_ROUND_NUDGE})
            round_tools = None if final_round and _round > 0 else tools
            round_start = len(content_parts)
            finish_reason = ""
            own_prompt = count_prompt(llm_messages, round_tools) if billable and user_id else None
            # 这一轮从发出请求到开始出正文 / 调工具，就是模型在想的时间
            round_began = time.monotonic()
            round_output_at: float | None = None
            round_reasoning: list[str] = []

            upstream = self.llm.stream_chat_completion(
                llm_messages,
                model=model_id,
                tools=round_tools,
                enable_thinking=round_thinking,
                reasoning_effort=reasoning_effort,
            )
            for chunk in upstream:
                if self._stopped(turn):
                    # 用户停止 / 被挤掉：断开上游，不再为这一轮付 token
                    close = getattr(upstream, "close", None)
                    if close:
                        close()
                    break
                if chunk.get("finish_reason"):
                    finish_reason = str(chunk["finish_reason"])
                if chunk.get("type") == "error":
                    yield {"type": "error", "message": chunk.get("content", "请求失败")}
                    return False

                if chunk.get("type") == "usage":
                    round_usage = chunk.get("usage")
                    continue

                delta = chunk.get("delta") or {}
                reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                if isinstance(reasoning, str) and reasoning:
                    round_reasoning.append(reasoning)
                    if reasoning_state is not None:
                        now = time.monotonic()
                        if reasoning_state["started"] is None:
                            reasoning_state["started"] = now
                        reasoning_state["ended"] = now
                        reasoning_state["parts"].append(reasoning)
                    yield {"type": "reasoning_delta", "delta": reasoning}
                content = delta.get("content") or ""
                if (content or delta.get("tool_calls")) and round_output_at is None:
                    round_output_at = time.monotonic()
                if content:
                    round_content += content
                    content_parts.append(content)
                    yield {"type": "content_delta", "delta": content}

                for tc_delta in delta.get("tool_calls") or []:
                    idx = int(tc_delta.get("index", 0))
                    if idx not in tool_call_accumulators:
                        tool_call_accumulators[idx] = {
                            "id": tc_delta.get("id") or str(uuid.uuid4()),
                            "name": "",
                            "arguments": "",
                        }
                    accumulator = tool_call_accumulators[idx]
                    if tc_delta.get("id"):
                        accumulator["id"] = tc_delta["id"]
                    fn = tc_delta.get("function") or {}
                    if fn.get("name"):
                        accumulator["name"] = fn["name"]
                    if fn.get("arguments"):
                        accumulator["arguments"] += fn["arguments"]

            if billable and user_id:
                self._record_chat_usage(user_id, round_usage, model_id, own_prompt)

            round_ended = time.monotonic()
            round_think = self._thinking_seconds(round_began, round_output_at, round_ended, round_usage)
            stats = self._account_reasoning(
                reasoning_state,
                usage=round_usage,
                seconds=round_think,
                reasoning_text="".join(round_reasoning),
            )
            if stats:
                yield stats
            else:
                # 这一轮没有思考：从发请求到出结果的时间全算在写出来的内容上
                round_think = 0.0
            if self._stopped(turn):
                # 停在半截的工具调用不执行
                return STOPPED

            for idx in sorted(tool_call_accumulators.keys()):
                call = tool_call_accumulators[idx]
                try:
                    arguments = json.loads(call["arguments"]) if call["arguments"] else {}
                except (TypeError, ValueError, json.JSONDecodeError):
                    arguments = {}
                if not isinstance(arguments, dict):
                    arguments = {}
                parsed_calls.append({
                    "id": call["id"],
                    "name": call["name"],
                    "arguments": arguments,
                    "raw_arguments": call["arguments"],
                })
            self._attach_prep(
                parsed_calls,
                seconds=round_ended - round_began - round_think,
                usage=round_usage,
            )

            if not parsed_calls:
                if finish_reason == "length" and continuations < MAX_CONTINUATIONS:
                    continuations += 1
                    print(f"[Chat] 输出被截断（{'正文为空' if not round_content else f'已写 {len(round_content)} 字'}），第 {continuations} 次补救")
                    if round_content:
                        llm_messages.append({"role": "assistant", "content": round_content})
                        llm_messages.append({"role": "user", "content": CONTINUE_NUDGE})
                    else:
                        # 篇幅全花在思考上：关掉思考，让它直接写
                        round_thinking = False
                        llm_messages.append({"role": "system", "content": DIRECT_ANSWER_NUDGE})
                    continue
                if not "".join(content_parts).strip() and not tool_trace:
                    content_parts.append(EMPTY_ANSWER_FALLBACK)
                    yield {"type": "content_delta", "delta": EMPTY_ANSWER_FALLBACK}
                return True

            used_tools = True
            preamble = self._take_preamble(round_content, content_parts, round_start)
            llm_messages.append({
                "role": "assistant",
                "content": round_content or None,
                "tool_calls": self._build_tool_calls_for_history(parsed_calls),
            })

            for position, call in enumerate(parsed_calls):
                if self._stopped(turn):
                    return STOPPED
                yield from self._yield_tool_call_events(
                    preamble=preamble if position == 0 else "",
                    call=call,
                    tool_trace=tool_trace,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=current_user_images,
                    current_user_message_id=current_user_message_id,
                    llm_messages=llm_messages,
                    content_parts=content_parts,
                    hd_image=hd_image,
                    turn=turn,
                )
            # shell 的 show：工具结果只能是文字，图片放在这一轮所有工具结果之后单独给模型看
            if turn.get("pending_images"):
                parts: list[dict[str, Any]] = [{"type": "text", "text": "[沙箱截图] 以下是 shell 的 show 参数要求查看的图片，检查后继续。"}]
                for data_url in turn["pending_images"]:
                    parts.append({"type": "image_url", "image_url": {"url": data_url}})
                llm_messages.append({"role": "user", "content": parts})
                turn["pending_images"] = []

        limit_text = TOOL_LIMIT_FALLBACK
        content_parts.append(limit_text)
        yield {"type": "content_delta", "delta": limit_text}
        return True

    def _chat_with_complete(
        self,
        *,
        llm_messages: list[dict[str, Any]],
        model_id: str,
        effective_thinking: bool,
        reasoning_effort: str | None,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
        hd_image: bool = False,
        billable: bool = False,
        turn: dict[str, Any] | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        turn = turn if turn is not None else {"pending_images": []}
        runtime = self.llm.provider_runtime.build_state(
            messages=llm_messages,
            model_id=model_id,
            tools=self.tools,
            enable_thinking=effective_thinking,
            reasoning_effort=reasoning_effort,
        )
        if not runtime:
            yield {"type": "error", "message": "API 密钥未配置"}
            return False

        print(f"[Chat] runtime transport: {runtime.get('kind')} model={model_id}")

        for _round in range(self._max_rounds(model_id)):
            if self._stopped(turn):
                return STOPPED
            if _round > 0 and billable and user_id:
                ok, scope, quota_msg = self.usage.check(user_id, self.usage.CHAT_COST)
                if not ok:
                    yield {"type": "error", "code": f"quota_{scope}", "message": quota_msg}
                    return False

            response = self.llm.provider_runtime.request_turn(runtime)
            if response is None:
                yield {"type": "error", "message": "请求失败"}
                return False

            if billable and user_id:
                self._record_chat_usage(user_id, response.get("usage"), model_id)

            content_text = strip_assistant_reasoning(response.get("content") or "")
            parsed_calls = response.get("tool_calls") or []

            if content_text:
                content_parts.append(content_text)
                yield {"type": "content_delta", "delta": content_text}

            if not parsed_calls:
                if not content_text.strip():
                    yield {"type": "error", "message": "模型返回空响应，请重试"}
                    return False
                return True

            self.llm.provider_runtime.append_assistant_history(
                runtime,
                response.get("assistant_history_item"),
                parsed_calls=parsed_calls,
                content_text=content_text,
            )

            tool_results: list[dict[str, Any]] = []
            for call in parsed_calls:
                tool_content = yield from self._stream_tool_call_result(
                    call=call,
                    tool_trace=tool_trace,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=current_user_images,
                    current_user_message_id=current_user_message_id,
                    content_parts=content_parts,
                    hd_image=hd_image,
                    turn=turn,
                )
                turn["pending_images"] = []  # 这条通道的工具结果只收文字
                tool_results.append({
                    "id": call["id"],
                    "name": call["name"],
                    "content": tool_content,
                })

            self.llm.provider_runtime.append_tool_results(runtime, tool_results)

        limit_text = TOOL_LIMIT_FALLBACK
        content_parts.append(limit_text)
        yield {"type": "content_delta", "delta": limit_text}
        return True

    @staticmethod
    def _take_preamble(round_content: str, content_parts: list[str], round_start: int) -> str:
        """这一轮在工具调用前说的话够短，就当作这一步的说明收走：从正文删掉，交给第一个工具卡片。"""
        text = round_content.strip()
        if not text or len(text) > PREAMBLE_MAX_CHARS or "\n\n" in text:
            return ""
        del content_parts[round_start:]
        return text

    def _yield_tool_call_events(
        self,
        *,
        preamble: str = "",
        call: dict[str, Any],
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        llm_messages: list[dict[str, Any]],
        content_parts: list[str],
        hd_image: bool = False,
        turn: dict[str, Any] | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        tool_response = self._execute_tool_call(
            call,
            tool_trace=tool_trace,
            assistant_message_id=assistant_message_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
            hd_image=hd_image,
            turn=turn,
        )
        while True:
            try:
                event = next(tool_response)
                if isinstance(event, dict):
                    marker = event.pop("_append_marker", False)
                    if marker:
                        content_parts.append(f"<!--tool:{len(tool_trace) - 1}-->")
                        if preamble:
                            # 前端据此把刚显示过的这句话从正文收进卡片
                            tool_trace[-1]["preamble"] = preamble
                            event["preamble"] = preamble
                            preamble = ""
                    yield event
            except StopIteration as stop:
                llm_messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": stop.value or "工具执行完成",
                })
                return

    def _stream_tool_call_result(
        self,
        *,
        call: dict[str, Any],
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        content_parts: list[str],
        hd_image: bool = False,
        turn: dict[str, Any] | None = None,
    ) -> Generator[dict[str, Any], None, str]:
        tool_response = self._execute_tool_call(
            call,
            tool_trace=tool_trace,
            assistant_message_id=assistant_message_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
            hd_image=hd_image,
            turn=turn,
        )
        while True:
            try:
                event = next(tool_response)
                if not isinstance(event, dict):
                    continue
                marker = event.pop("_append_marker", False)
                if marker:
                    content_parts.append(f"<!--tool:{len(tool_trace) - 1}-->")
                yield event
            except StopIteration as stop:
                return stop.value or "工具执行完成"

    def _execute_tool_call(
        self,
        call: dict[str, Any],
        *,
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        hd_image: bool = False,
        turn: dict[str, Any] | None = None,
    ):
        name = str(call.get("name") or "").strip()
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        print(f"[Chat] tool_call: {name}({json.dumps(arguments, ensure_ascii=False)[:300]})")

        if name == "shell":
            return (yield from self._run_shell(
                arguments,
                prep=call.get("prep"),
                tool_trace=tool_trace,
                assistant_message_id=assistant_message_id,
                user_id=user_id,
                session_id=session_id,
                turn=turn if turn is not None else {"pending_images": []},
            ))

        if name == "delegate" and turn is not None and turn.get("delegate_to"):
            return (yield from self._run_delegate(
                arguments,
                tool_trace=tool_trace,
                assistant_message_id=assistant_message_id,
                user_id=user_id,
                session_id=session_id,
                turn=turn,
            ))

        if name == "web_search":
            search_args = normalize_search_args(arguments)
            query = search_args["query"]
            searches_done = sum(1 for item in tool_trace if item.get("kind") == "search")
            if searches_done >= MAX_SEARCHES_PER_ANSWER:
                print(f"[Chat] 搜索次数已达 {searches_done}，跳过: {query}")
                return SEARCH_BUDGET_EXHAUSTED
            trace = {"kind": "search", "query": query, "status": "running"}
            label = engine_label(search_args["engine"])
            if label:
                trace["engine"] = label
            tool_trace.append(trace)
            yield {
                "_append_marker": True,
                "type": "search_start",
                "message_id": assistant_message_id,
                "query": query,
                "engine": label,
            }
            options = {k: v for k, v in search_args.items() if k != "query"}
            result, sources = self.search.search_with_sources(query, **options) if query else ("", [])
            trace["status"] = "done"
            trace["success"] = bool(result and not result.startswith("搜索失败"))
            if sources:
                trace["sources"] = sources
            yield {
                "type": "search_end",
                "message_id": assistant_message_id,
                "query": query,
                "success": trace["success"],
                "sources": sources,
            }
            return result or "搜索失败，请基于已有知识继续回答。"

        if name == "generate_image":
            request = self.image._normalize_image_request(arguments)
            prompt = self.image.build_request_prompt(arguments) or request.get("subject") or "生成图片"
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id, len(tool_trace) + 1)
            current_model_label = self.image.model_label(hd_image)
            trace = {
                "kind": "image_gen",
                "assetId": asset_id,
                "mode": "generate",
                "prompt": prompt,
                "status": "running",
                "request": request,
                "modelLabel": current_model_label,
            }
            tool_trace.append(trace)
            yield {
                "_append_marker": True,
                "type": "image_gen_start",
                "message_id": assistant_message_id,
                "prompt": prompt,
                "mode": "generate",
                "assetId": asset_id,
                "request": request,
                "modelLabel": current_model_label,
            }
            if user_id:
                ok, _scope, quota_msg = self.usage.check(user_id, self.usage.IMAGE_COST)
                if not ok:
                    trace["status"] = "done"
                    trace["success"] = False
                    yield {
                        "type": "image_gen_end",
                        "message_id": assistant_message_id,
                        "prompt": prompt,
                        "mode": "generate",
                        "success": False,
                        "assetId": asset_id,
                        "request": request,
                        "modelLabel": current_model_label,
                        "error": quota_msg,
                    }
                    return json.dumps({
                        "status": "error",
                        "tool": "generate_image",
                        "mode": "generate",
                        "assetId": asset_id,
                        "message": quota_msg,
                        "assistantInstruction": "请用中文向用户说明 Campbell 出图额度已用完，建议明天/下月再试，或先用文字回答。不要再尝试调用 generate_image。",
                        "error": quota_msg,
                    }, ensure_ascii=False)
            result = self.image.generate(
                arguments,
                user_id=user_id,
                session_id=session_id,
                current_user_image_urls=current_user_images,
                current_user_message_id=current_user_message_id,
                hd=hd_image,
            )
            success = bool(result.get("success") and result.get("image"))
            trace["status"] = "done"
            trace["success"] = success
            trace["url"] = result.get("image")
            trace["blurredUrl"] = result.get("blurred_image")
            trace["assetId"] = asset_id
            if success and result.get("prompt"):
                trace["prompt"] = result["prompt"]
            if result.get("output_width"):
                trace["outputWidth"] = result["output_width"]
            if result.get("output_height"):
                trace["outputHeight"] = result["output_height"]
            if result.get("output_aspect_ratio"):
                trace["outputAspectRatio"] = result["output_aspect_ratio"]
            if success and result.get("image"):
                self._save_generated_image(
                    result=result,
                    user_id=user_id,
                    session_id=session_id,
                    assistant_message_id=assistant_message_id,
                )
                if user_id:
                    try:
                        self._record_image_usage(user_id, result.get("usage"), hd_image)
                    except Exception as exc:
                        print(f"[Usage] record_image_call failed: {type(exc).__name__}: {exc}")
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": trace["prompt"],
                "mode": "generate",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "blurredUrl": result.get("blurred_image"),
                "request": request,
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "modelLabel": current_model_label,
            }
            error_message = result.get("error") or "图片生成失败，请稍后重试。"
            return json.dumps({
                "status": "ok" if success else "error",
                "tool": "generate_image",
                "mode": "generate",
                "assetId": asset_id,
                "prompt": trace["prompt"],
                "url": result.get("image", ""),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "message": (
                    "Image generated successfully and already shown to the user."
                    if success else error_message
                ),
                "assistantInstruction": (
                    "请用中文简短确认图片已生成完成，并提示用户可以继续提出修改要求；不要重复输出原始 URL。"
                    if success else "请用中文简短说明图片生成失败，并询问用户是否要重试或调整提示词。"
                ),
                "error": "" if success else error_message,
            }, ensure_ascii=False)

        if name == "edit_image":
            request = self.image._normalize_image_edit_request(arguments)
            prompt = self.image.build_edit_prompt(arguments) or request.get("instruction") or "编辑图片"
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id, len(tool_trace) + 1)
            current_model_label = self.image.model_label(hd_image)
            trace = {
                "kind": "image_gen",
                "assetId": asset_id,
                "mode": "edit",
                "prompt": prompt,
                "status": "running",
                "editRequest": request,
                "modelLabel": current_model_label,
            }
            tool_trace.append(trace)
            yield {
                "_append_marker": True,
                "type": "image_gen_start",
                "message_id": assistant_message_id,
                "prompt": prompt,
                "mode": "edit",
                "assetId": asset_id,
                "editRequest": request,
                "modelLabel": current_model_label,
            }
            if user_id:
                ok, _scope, quota_msg = self.usage.check(user_id, self.usage.IMAGE_COST)
                if not ok:
                    trace["status"] = "done"
                    trace["success"] = False
                    yield {
                        "type": "image_gen_end",
                        "message_id": assistant_message_id,
                        "prompt": prompt,
                        "mode": "edit",
                        "success": False,
                        "assetId": asset_id,
                        "editRequest": request,
                        "modelLabel": current_model_label,
                        "error": quota_msg,
                    }
                    return json.dumps({
                        "status": "error",
                        "tool": "edit_image",
                        "mode": "edit",
                        "assetId": asset_id,
                        "message": quota_msg,
                        "assistantInstruction": "请用中文向用户说明 Campbell 出图额度已用完，建议明天/下月再试。不要再尝试调用 edit_image。",
                        "error": quota_msg,
                    }, ensure_ascii=False)
            result = self.image.edit(
                arguments,
                user_id=user_id,
                session_id=session_id,
                current_user_image_urls=current_user_images,
                current_user_message_id=current_user_message_id,
                hd=hd_image,
            )
            success = bool(result.get("success") and result.get("image"))
            trace["status"] = "done"
            trace["success"] = success
            trace["url"] = result.get("image")
            trace["blurredUrl"] = result.get("blurred_image")
            trace["assetId"] = asset_id
            if result.get("source_image_id"):
                trace["sourceImageId"] = result["source_image_id"]
            if result.get("source_image_url"):
                trace["sourceImageUrl"] = result["source_image_url"]
            if result.get("source_label"):
                trace["sourceLabel"] = result["source_label"]
            if success and result.get("prompt"):
                trace["prompt"] = result["prompt"]
            if result.get("resolved_edit_request"):
                trace["resolvedEditRequest"] = result["resolved_edit_request"]
            if result.get("output_width"):
                trace["outputWidth"] = result["output_width"]
            if result.get("output_height"):
                trace["outputHeight"] = result["output_height"]
            if result.get("output_aspect_ratio"):
                trace["outputAspectRatio"] = result["output_aspect_ratio"]
            if success and result.get("image"):
                self._save_generated_image(
                    result=result,
                    user_id=user_id,
                    session_id=session_id,
                    assistant_message_id=assistant_message_id,
                )
                if user_id:
                    try:
                        self._record_image_usage(user_id, result.get("usage"), hd_image)
                    except Exception as exc:
                        print(f"[Usage] record_image_call failed: {type(exc).__name__}: {exc}")
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": trace["prompt"],
                "mode": "edit",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "blurredUrl": result.get("blurred_image"),
                "editRequest": request,
                "resolvedEditRequest": result.get("resolved_edit_request"),
                "sourceImageId": result.get("source_image_id"),
                "sourceImageUrl": result.get("source_image_url"),
                "sourceLabel": result.get("source_label"),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "modelLabel": current_model_label,
            }
            error_message = result.get("error") or "图片编辑失败，请稍后重试。"
            return json.dumps({
                "status": "ok" if success else "error",
                "tool": "edit_image",
                "mode": "edit",
                "assetId": asset_id,
                "prompt": trace["prompt"],
                "url": result.get("image", ""),
                "sourceImageId": result.get("source_image_id"),
                "sourceLabel": result.get("source_label"),
                "resolvedEditRequest": result.get("resolved_edit_request"),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "message": (
                    "Image edited successfully and already shown to the user."
                    if success else error_message
                ),
                "assistantInstruction": (
                    "请用中文简短确认图片已编辑完成，并提示用户可以继续提出局部修改；不要重复输出原始 URL。"
                    if success else "请用中文简短说明图片编辑失败，并询问用户是否要重试或调整修改要求。"
                ),
                "error": "" if success else error_message,
            }, ensure_ascii=False)

        return "不支持的工具调用。"

    def _run_shell(
        self,
        arguments: dict[str, Any],
        *,
        prep: dict[str, Any] | None = None,
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        turn: dict[str, Any],
    ):
        command = str(arguments.get("command") or "").strip()
        title = str(arguments.get("title") or "").strip()[:60]
        background = bool(arguments.get("background"))
        port = arguments.get("port") if isinstance(arguments.get("port"), int) else None
        show = [str(p) for p in arguments.get("show") or [] if str(p).strip()] if isinstance(arguments.get("show"), list) else []
        step_id = uuid.uuid4().hex[:8]
        trace: dict[str, Any] = {"kind": "shell", "id": step_id, "command": command, "status": "running"}
        if title:
            trace["title"] = title
        # 执行助手做的步骤：记下属于哪一块工作，界面上收在那张子任务卡片里
        task_id = turn.get("task_id")
        if task_id:
            trace["taskId"] = task_id
        if background:
            trace["background"] = True
        # 模型写这一步花的时间和 token（见 _attach_prep）
        prep_fields = {"prepSeconds": prep["seconds"], "prepTokens": prep["tokens"]} if prep else {}
        trace.update(prep_fields)
        tool_trace.append(trace)
        yield {
            "_append_marker": True,
            "type": "shell_start",
            "message_id": assistant_message_id,
            "id": step_id,
            "command": command,
            **({"title": title} if title else {}),
            **({"taskId": task_id} if task_id else {}),
            "background": background,
            **prep_fields,
        }

        def finish(success: bool, output: str, **extra) -> dict[str, Any]:
            trace.update({"status": "done", "success": success, "output": output[-SHELL_OUTPUT_FOR_UI:], **extra})
            return {"type": "shell_end", "message_id": assistant_message_id, "id": step_id, "success": success,
                    "output": trace["output"], **extra}

        session = turn.get("session")
        if not command:
            yield finish(False, "没有命令")
            return "command 为空，请给出要执行的命令。"
        if not self._sandbox_ready() or not session:
            yield finish(False, "沙箱不可用")
            return "沙箱暂时不可用，请直接用文字回答用户，并说明这次没法实际执行。"

        try:
            sandbox = turn.get("sandbox")
            if sandbox is None:
                sandbox, env_state = self.sandbox.acquire(session, self._session_attachments(session.id, turn.get("files"), turn.get("images")))
                turn["sandbox"] = sandbox
                if env_state != "reused":
                    trace["env"] = env_state
                    yield {"type": "shell_env", "message_id": assistant_message_id, "id": step_id, "state": env_state}
        except Exception as exc:
            print(f"[Sandbox] 准备环境失败: {type(exc).__name__}: {exc}")
            yield finish(False, f"环境没有准备好：{type(exc).__name__}")
            return "沙箱启动失败，请稍后重试；这次先用文字回答用户，并说明没能实际执行。"

        # 命令在后台线程里跑，输出边出边推给前端
        chunks: "queue.Queue[str]" = queue.Queue()
        box: dict[str, Any] = {}

        def work():
            try:
                box["result"] = self.sandbox.run(
                    sandbox, command, timeout=arguments.get("timeout"), background=background, on_output=chunks.put,
                )
            except Exception as exc:  # 网络断开之类
                box["error"] = exc

        worker = threading.Thread(target=work, daemon=True)
        worker.start()
        pending = ""
        last_push = time.monotonic()
        interrupted = False
        seen: list[str] = []
        while worker.is_alive() or not chunks.empty():
            if not interrupted and self._stopped(turn):
                # 回答被停下：不等命令自己跑完，直接掐掉
                interrupted = True
                interrupted_at = time.monotonic()
                threading.Thread(target=self.sandbox.interrupt, args=(sandbox,), daemon=True).start()
            if interrupted and time.monotonic() - interrupted_at > 5:
                break
            try:
                chunk = chunks.get(timeout=0.1)
                pending += chunk
                seen.append(chunk)
            except queue.Empty:
                pass
            if pending and (time.monotonic() - last_push >= SHELL_STREAM_INTERVAL or not worker.is_alive()):
                yield {"type": "shell_output", "message_id": assistant_message_id, "id": step_id, "delta": pending}
                pending = ""
                last_push = time.monotonic()
        if interrupted and worker.is_alive():
            if pending:
                yield {"type": "shell_output", "message_id": assistant_message_id, "id": step_id, "delta": pending}
            yield finish(False, "".join(seen) + "\n[回答停下了，命令被中止]")
            return "命令被中止（回答已停止）。"
        worker.join()

        if "error" in box:
            exc = box["error"]
            print(f"[Sandbox] 执行异常: {type(exc).__name__}: {exc}")
            turn["sandbox"] = None  # 下次重新连
            yield finish(False, f"执行中断：{type(exc).__name__}")
            return f"命令执行中断（{type(exc).__name__}: {str(exc)[:200]}）。可以重试一次；反复失败就告诉用户环境出了问题。"

        result = box["result"]
        output = result.get("output") or ""
        exit_code = result.get("exit_code")
        success = background or (exit_code == 0 and not result.get("timed_out"))
        if interrupted:
            output = output.rstrip() + "\n[回答停下了，命令被中止]"
            success = False
        extra: dict[str, Any] = {"seconds": result.get("seconds")}
        if exit_code is not None:
            extra["exitCode"] = exit_code

        files: list[dict[str, Any]] = []
        try:
            files = self.sandbox.collect_outputs(sandbox, user_id, session.id)
        except Exception as exc:
            print(f"[Sandbox] 收集成品失败: {type(exc).__name__}: {exc}")
        if files:
            extra["files"] = [{k: v for k, v in f.items() if k != "key"} for f in files]
        if background and port:
            try:
                extra["previewUrl"] = self.sandbox.preview_url(sandbox, port)
            except Exception as exc:
                print(f"[Sandbox] 预览地址失败: {exc}")

        shown: list[str] = []
        show_problems: list[str] = []
        if show:
            shown, show_problems = self.sandbox.read_images(sandbox, show)
            turn.setdefault("pending_images", []).extend(shown)
            if shown:
                extra["shown"] = len(shown)

        yield finish(success, output, **extra)
        return self._format_shell_result(result, files, extra.get("previewUrl"), len(shown), show_problems)

    @staticmethod
    def _format_shell_result(
        result: dict[str, Any],
        files: list[dict[str, Any]],
        preview_url: str | None,
        shown: int,
        show_problems: list[str],
    ) -> str:
        output = result.get("output") or ""
        if len(output) > SHELL_OUTPUT_FOR_MODEL:
            tail = SHELL_OUTPUT_FOR_MODEL - SHELL_OUTPUT_HEAD
            output = f"{output[:SHELL_OUTPUT_HEAD]}\n…（中间省略 {len(output) - SHELL_OUTPUT_FOR_MODEL} 字，需要时用 grep / sed 看具体部分）…\n{output[-tail:]}"
        if result.get("background"):
            head = f"已在后台运行（pid {result.get('pid')}），以下是前几秒的输出"
        elif result.get("timed_out"):
            head = "超时被中止"
        else:
            head = f"exit_code={result.get('exit_code')}，用时 {result.get('seconds')}s"
        lines = [head, output.strip() or "（没有输出）"]
        delivered = [f for f in files if f.get("url")]
        if delivered:
            lines.append("已交付给用户：" + "、".join(f"{f['path']}（{_human_size(f['size'])}）" for f in delivered))
        failed = [f for f in files if f.get("error")]
        if failed:
            lines.append("没能交付：" + "、".join(f"{f['path']}（{f['error']}）" for f in failed))
        if preview_url:
            lines.append(f"预览地址（沙箱回收前有效）：{preview_url}")
        if shown:
            lines.append(f"已附上 {shown} 张图片，在下一条消息里。")
        lines.extend(show_problems)
        return "\n".join(lines)

    def _session_attachments(
        self, session_id: str, current: list | None, current_images: list | None = None,
    ) -> list[dict[str, Any]]:
        """会话里用户上传过的所有附件和图片（沙箱重建时要重新放进 inputs/）。"""
        seen: set[str] = set()
        items: list[dict[str, Any]] = []
        messages = (
            ChatMessage.query
            .filter(ChatMessage.session_id == session_id, ChatMessage.role == "user")
            .filter(ChatMessage.files.isnot(None) | ChatMessage.images.isnot(None))
            .all()
        )
        candidates: list[dict[str, Any]] = []
        for m in messages:
            candidates += m.files_list() + _image_attachments(m.to_dict().get("images"))
        candidates += list(current or []) + _image_attachments(current_images)
        for item in candidates:
            url = str(item.get("url") or "")
            if url and url not in seen:
                seen.add(url)
                items.append(item)
        return items

    def _sandbox_ready(self) -> bool:
        return self.sandbox is not None and self.sandbox.available

    def _snapshot_later(self, turn: dict[str, Any], release: bool = False) -> None:
        """用过沙箱的回答结束后，后台把工作区存一份到 OSS；release 时存完就把沙箱关掉。"""
        sandbox = turn.get("sandbox")
        session = turn.get("session")
        if sandbox is None or session is None:
            return
        sandbox_id, session_id = sandbox.sandbox_id, session.id

        def job() -> None:
            saved = self.sandbox.snapshot(sandbox_id, session_id)
            # 快照确实落到 OSS 才释放；没存上就留着沙箱等空闲回收，下次还能接着用
            if release and saved:
                self.sandbox.kill(sandbox_id)
                print(f"[Sandbox] 已释放 {sandbox_id}（{session_id} 的回答被停下，工作区已存快照）")

        threading.Thread(target=job, daemon=True).start()

    def _build_messages(
        self,
        *,
        message: str,
        history: list[dict[str, Any]],
        model_id: str,
        session_id: str | None,
        images: list[str],
        current_user_message_id: str | None,
        files: list[dict[str, Any]] | None = None,
        delivery: str | None = None,
    ) -> list[dict[str, Any]]:
        cfg = self.llm.get_model_config(model_id)
        prompt_id = str(cfg.get("prompt_id") or model_id)
        system_prompt = f"{get_system_prompt(prompt_id)}\n\n{current_time_context()}"
        if self._sandbox_ready():
            system_prompt = f"{system_prompt}\n\n{SANDBOX_INSTRUCTION}\n{delivery_preference(delivery)}"
            if self._delegate_target(cfg):
                system_prompt = f"{system_prompt}\n\n{DELEGATE_INSTRUCTION}"
        asset_catalog = self.image.build_asset_catalog_message(
            session_id,
            images,
            current_user_message_id=current_user_message_id,
        )
        if asset_catalog:
            system_prompt = f"{system_prompt}\n\n{asset_catalog}"

        messages = [{"role": "system", "content": system_prompt}]
        # 历史里的图片每轮都要重发给模型：只让最近几条带图的用户消息保留原图，
        # 更早的只留一行"原图在 inputs/images/…"，需要时用 show 回看（没有沙箱就回看不了，只能全带着）
        inline_from = 0
        if self._sandbox_ready():
            with_images = [i for i, it in enumerate(history) if it.get("role") != "assistant" and it.get("images")]
            keep = max(0, HISTORY_IMAGE_MESSAGES - (1 if images else 0))
            if not keep:
                inline_from = len(history)
            elif len(with_images) > keep:
                inline_from = with_images[-keep]
        for index, item in enumerate(history):
            role = "assistant" if item.get("role") == "assistant" else "user"
            item_images = item.get("images") or []
            if role == "user" and item_images and index < inline_from:
                user_text = self._with_attachments(item.get("content", ""), item.get("files"), item_images, images_inline=False)
                messages.append({"role": "user", "content": user_text})
                continue
            tool_trace = item.get("tool_trace") if isinstance(item.get("tool_trace"), list) else []
            user_text = self._with_attachments(item.get("content", ""), item.get("files"), item_images) if role == "user" else ""
            if role == "user" and item_images:
                parts = [{"type": "text", "text": user_text}]
                for image_url in item_images:
                    if image_url:
                        parts.append({"type": "image_url", "image_url": {"url": image_url}})
                messages.append({"role": "user", "content": parts})
            elif role == "assistant":
                assistant_content = self._strip_tool_markers(str(item.get("content") or ""))
                tool_summary = self._format_tool_trace_summary(tool_trace)
                if tool_summary:
                    assistant_content = (
                        f"{assistant_content}\n\n[工具执行记录]\n{tool_summary}".strip()
                        if assistant_content
                        else f"[工具执行记录]\n{tool_summary}"
                    )
                if assistant_content:
                    messages.append({"role": "assistant", "content": assistant_content})
            else:
                messages.append({"role": role, "content": user_text})

        message = self._with_attachments(message, files, images)
        if images:
            parts = [{"type": "text", "text": message}]
            for image_url in images:
                if image_url:
                    parts.append({"type": "image_url", "image_url": {"url": image_url}})
            messages.append({"role": "user", "content": parts})
        else:
            messages.append({"role": "user", "content": message})

        # 上游通道会在更早的位置注入自己的产品人设，开头的身份提示词压不住它。
        # 实测在消息列表末尾再锚一次身份，中英文越权提问才不会泄露底层模型。
        if cfg.get("identity_guard"):
            series = prompt_id.capitalize() if prompt_id else None
            messages.append({"role": "system", "content": get_identity_reminder(series)})
        return messages

    def _with_attachments(
        self, text: str, files: list | None, images: list | None = None, *, images_inline: bool = True,
    ) -> str:
        """用户附件写进消息文字里，告诉模型它们在沙箱的哪个位置（没有沙箱时给下载地址）。

        上传整个文件夹时可能有几百个文件：文件多了就按目录汇总（几个文件、多大），细节让模型自己 ls / find。
        """
        in_sandbox = self._sandbox_ready()
        entries = []
        for item in files or []:
            if isinstance(item, dict) and (rel := input_relpath(item)):
                entries.append((rel, int(item.get("size") or 0), item.get("url")))
        lines = []
        if not in_sandbox:
            lines = [f"- {rel}（{_human_size(size)}）：{url}" for rel, size, url in entries]
        elif len(entries) <= LIST_ALL_ATTACHMENTS:
            lines = [f"- {INPUTS_DIR}/{rel}（{_human_size(size)}）" for rel, size, _ in entries]
        else:
            groups: dict[str, list[int]] = {}
            loose = []
            for rel, size, _ in entries:
                if "/" in rel:
                    groups.setdefault(rel.split("/", 1)[0], []).append(size)
                else:
                    loose.append((rel, size))
            for folder, sizes in groups.items():
                lines.append(f"- {INPUTS_DIR}/{folder}/ 文件夹：{len(sizes)} 个文件，共 {_human_size(sum(sizes))}")
            lines += [f"- {INPUTS_DIR}/{rel}（{_human_size(size)}）" for rel, size in loose[:LIST_ALL_ATTACHMENTS]]
            if len(loose) > LIST_ALL_ATTACHMENTS:
                lines.append(f"- 另有 {len(loose) - LIST_ALL_ATTACHMENTS} 个文件直接在 {INPUTS_DIR}/ 下")
            lines.append(f"（共 {len(entries)} 个文件，用 ls / find 看具体内容）")
        # 图片模型本来就看得到；也放进 inputs/images/，既能在沙箱里处理原图，上下文压缩后也能回看
        image_items = _image_attachments(images) if in_sandbox else []
        if image_items:
            paths = "、".join(f"{INPUTS_DIR}/{input_relpath(it)}" for it in image_items)
            if images_inline:
                lines.append(f"- 这条消息里的 {len(image_items)} 张图片（你能直接看到）→ {paths}")
            else:
                lines.append(f"- 这条消息里的 {len(image_items)} 张图片已不在上下文里，原图在 {paths}，需要时用 shell 的 show 再看")
        if not lines:
            return text
        title = "[用户上传的附件，已放在沙箱里]" if in_sandbox else "[用户上传的附件]"
        return f"{text}\n\n{title}\n" + "\n".join(lines)

    def _strip_tool_markers(self, content: str) -> str:
        return TOOL_MARKER_RE.sub("", content or "").strip()

    def _is_vision_blind_transport(self, cfg: dict[str, Any]) -> bool:
        # models.json 里显式写了 vision 就以它为准；deepseek-flash 现在能直接看图
        if "vision" in cfg:
            return not bool(cfg.get("vision"))
        transport = str(cfg.get("transport") or cfg.get("provider") or "").strip().lower()
        return transport.startswith("deepseek")

    def _preprocess_vision_if_blind(
        self,
        messages: list[dict[str, Any]],
        cfg: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if not self._is_vision_blind_transport(cfg):
            return messages
        return self._describe_image_parts(messages)

    def _describe_image_parts(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        transformed: list[dict[str, Any]] = []
        cache: dict[str, str] = {}
        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                transformed.append(msg)
                continue

            new_parts: list[dict[str, Any]] = []
            for part in content:
                if not isinstance(part, dict) or part.get("type") != "image_url":
                    new_parts.append(part)
                    continue
                image_url = str((part.get("image_url") or {}).get("url") or "").strip()
                if not image_url:
                    continue
                if image_url not in cache:
                    cache[image_url] = self._describe_single_image(image_url)
                new_parts.append({
                    "type": "text",
                    "text": f"[用户上传的图片，由视觉模型识别得到的描述]\n{cache[image_url]}",
                })
            transformed.append({**msg, "content": new_parts})
        return transformed

    def _describe_single_image(self, image_url: str) -> str:
        prompt = (
            "请用中文详细描述这张图片的内容，目标是让一个不支持视觉的语言模型能基于你的描述理解图片。"
            "请涵盖：主体/人物/物体、可见文字、布局结构、风格氛围、关键细节。"
            "直接输出描述，不要前缀。"
        )
        try:
            description = self.llm.complete(
                [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                }],
                model="image_describer",
                enable_thinking=False,
            )
        except Exception as exc:
            print(f"[vision-preprocess] 描述失败: {type(exc).__name__}: {exc}")
            return "[图片识别失败，请基于用户的文字提问继续回答]"
        text = strip_assistant_reasoning(str(description or "")).strip()
        return text or "[图片识别失败，请基于用户的文字提问继续回答]"

    def _format_tool_trace_summary(self, tool_trace: list[dict[str, Any]]) -> str:
        if not tool_trace:
            return ""

        lines: list[str] = []
        for item in tool_trace:
            kind = item.get("kind")
            status = "成功" if item.get("success", item.get("status") == "done") else "失败"

            if kind == "search":
                query = str(item.get("query") or "").strip()
                summary = f"- web_search(query={json.dumps(query, ensure_ascii=False)}): {status}（结果未保留，追问需要具体数据时重新搜索）"
                lines.append(summary)
                continue

            if kind == "task":
                report = " ".join(str(item.get("report") or "").split())
                if len(report) > 300:
                    report = report[:300] + "…"
                lines.append(f"- delegate(「{item.get('title') or ''}」): {status}{'；报告：' + report if report else ''}")
                continue

            if kind == "shell":
                command = " ".join(str(item.get("command") or "").split())
                if len(command) > 120:
                    command = command[:120] + "…"
                files = [f.get("path") or f.get("name") for f in item.get("files") or [] if f.get("url")]
                code = item.get("exitCode")
                result = "后台运行" if item.get("background") else (f"exit {code}" if code is not None else status)
                suffix = f"；交付 {', '.join(files)}" if files else ""
                lines.append(f"- shell: {command} → {result}{suffix}")
                continue

            if kind == "image_gen":
                mode = "edit_image" if item.get("mode") == "edit" else "generate_image"
                prompt = str(item.get("prompt") or "").strip()
                extra = []
                if item.get("sourceImageId"):
                    extra.append(f"sourceImageId={item['sourceImageId']}")
                if item.get("assetId"):
                    extra.append(f"assetId={item['assetId']}")
                if item.get("outputAspectRatio"):
                    extra.append(f"outputAspectRatio={item['outputAspectRatio']}")
                if item.get("url"):
                    extra.append("image_ready=true")
                suffix = f" ({', '.join(extra)})" if extra else ""
                lines.append(f"- {mode}(prompt={json.dumps(prompt, ensure_ascii=False)}): {status}{suffix}")

        return "\n".join(lines)

    def _build_tool_calls_for_history(self, parsed_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        tool_calls = []
        for call in parsed_calls:
            tool_calls.append({
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call["arguments"], ensure_ascii=False),
                },
            })
        return tool_calls

    def _resolve_thinking(self, cfg: dict[str, Any], thinking: bool | None) -> bool:
        mode = str(cfg.get("thinking_mode") or "never")
        if mode == "always":
            return True
        if mode == "optional":
            if thinking is None:
                return bool(cfg.get("default_thinking", False))
            return bool(thinking)
        return False

    @staticmethod
    def _attach_prep(calls: list[dict[str, Any]], *, seconds: float, usage: dict[str, Any] | None) -> None:
        """
        一轮里除去思考的时间和输出 token，记到这一轮写出来的工具调用头上。

        模型把整篇论文写进一条命令时，界面上既不涨思考也不涨工具时间，其实它在"写这一步"；
        这笔账归给写出来的那一步（按参数长度分给同一轮的几个调用），思考只算真正在想的部分。
        """
        if not calls:
            return
        weights = [max(1, len(c.get("raw_arguments") or "")) for c in calls]
        total_weight = sum(weights)
        completion = int((usage or {}).get("completion_tokens") or 0)
        reasoning = reasoning_tokens_of(usage) or 0
        if completion > reasoning:
            tokens = completion - reasoning
        else:
            tokens = sum(count_text(c.get("raw_arguments") or "") for c in calls)
        seconds = max(0.0, seconds)
        for call, weight in zip(calls, weights):
            share = weight / total_weight
            call["prep"] = {"seconds": round(seconds * share, 1), "tokens": int(round(tokens * share))}

    @staticmethod
    def _thinking_seconds(
        began: float,
        output_at: float | None,
        ended: float,
        usage: dict[str, Any] | None,
    ) -> float:
        """
        一轮里模型想了多久。

        正文 / 工具参数是一点点流出来的，到第一段输出的时间就是思考时间。
        但中转会把工具调用攒到最后一次性吐出来，这时"到第一段输出"其实是整轮生成的时间，
        就按思考 token 占全部输出 token 的比例折算。
        """
        first = output_at if output_at is not None else ended
        seconds = first - began
        reasoning = reasoning_tokens_of(usage)
        completion = int((usage or {}).get("completion_tokens") or 0)
        burst = ended - first < 0.5
        if burst and reasoning is not None and completion > reasoning:
            seconds = min(seconds, (ended - began) * reasoning / completion)
        return max(0.0, seconds)

    @staticmethod
    def _account_reasoning(
        state: dict[str, Any] | None,
        *,
        usage: dict[str, Any] | None,
        seconds: float,
        reasoning_text: str,
    ) -> dict[str, Any] | None:
        """
        一轮结束后把这轮的思考用时 / token 累加进去，有变化就返回一条 reasoning_stats 事件。

        token 优先用上游报的；上游没报（非流式通道之类）就按思考文字数一下。
        只有真的想了（有思考 token 或思考文字）才算用时，不然就只是网络等待。
        """
        if state is None:
            return None
        tokens = reasoning_tokens_of(usage)
        if tokens is None:
            tokens = count_text(reasoning_text) if reasoning_text else 0
        if tokens <= 0 and not reasoning_text:
            return None
        state["tokens"] = int(state.get("tokens") or 0) + max(0, tokens)
        state["seconds"] = float(state.get("seconds") or 0.0) + max(0.0, seconds)
        return {
            "type": "reasoning_stats",
            "seconds": max(1, round(state["seconds"])),
            "tokens": state["tokens"],
        }

    @staticmethod
    def _reasoning_seconds(state: dict[str, Any]) -> int | None:
        if state.get("seconds"):
            return max(1, round(state["seconds"]))
        if state.get("started") is None or state.get("ended") is None:
            return None
        return max(1, round(state["ended"] - state["started"]))

    def _save_assistant_message(
        self,
        *,
        assistant_message_id: str,
        session: ChatSession | None,
        content: str,
        tool_trace: list[dict[str, Any]],
        reasoning: str = "",
        reasoning_seconds: int | None = None,
        reasoning_tokens: int | None = None,
    ) -> None:
        if not session:
            return

        stored_content = sanitize_assistant_content(content, tool_trace)
        assistant_message = ChatMessage(
            id=assistant_message_id,
            session_id=session.id,
            role="assistant",
            content=stored_content,
            tool_trace=json.dumps(tool_trace, ensure_ascii=False) if tool_trace else None,
            reasoning=reasoning or None,
            reasoning_seconds=reasoning_seconds if (reasoning or reasoning_tokens) else None,
            reasoning_tokens=reasoning_tokens or None,
        )
        db.session.add(assistant_message)
        session.updated_at = datetime.utcnow()
        db.session.commit()

    def _save_generated_image(
        self,
        *,
        result: dict[str, Any],
        user_id: str | None,
        session_id: str | None,
        assistant_message_id: str,
    ) -> None:
        if not user_id or not session_id or not result.get("s3_key") or not result.get("image"):
            return

        image_record = GeneratedImage(
            id=result.get("image_id", uuid.uuid4().hex),
            user_id=user_id,
            session_id=session_id,
            message_id=assistant_message_id,
            prompt=result.get("prompt"),
            s3_key=result["s3_key"],
            url=result["image"],
        )
        db.session.add(image_record)
        db.session.commit()

    def _safe_env(self, name: str, default: str) -> int:
        try:
            return int(os.environ.get(name, default))
        except Exception:
            return int(default)


# 历史里保留原图的最近几条带图用户消息（含当前这条）
HISTORY_IMAGE_MESSAGES = 2
# 附件不超过这么多就逐个列出路径，再多按目录汇总
LIST_ALL_ATTACHMENTS = 30


def _image_attachments(urls: list | None) -> list[dict[str, Any]]:
    """用户发的图片也当附件放进沙箱的 inputs/images/，文件名取地址里的原名。"""
    items = []
    for url in urls or []:
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        clean = strip_image_processing(url)
        name = safe_filename(unquote(urlsplit(clean).path.rsplit("/", 1)[-1]))
        if name:
            items.append({"name": name, "path": f"images/{name}", "url": clean, "size": 0})
    return items


def _human_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / 1024 / 1024:.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"
