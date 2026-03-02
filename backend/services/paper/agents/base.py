"""
BaseAgent — 所有 Agent 的抽象基类
含轻量 Gate 机制：每个 agent 输出后用廉价模型快速判断质量
"""

import os
from abc import ABC, abstractmethod
from typing import Generator

from ..session import PaperSession


class BaseAgent(ABC):
    """所有 Agent 的抽象基类"""

    # 子类可覆盖：gate 检查的描述（None 表示跳过 gate）
    GATE_CRITERIA: str | None = None

    def __init__(self, llm_service, model: str | None = None, api_key: str | None = None):
        self.llm = llm_service
        self.model = model
        self.api_key = api_key

    def _complete(self, messages: list, **kwargs) -> str | None:
        """调用 LLM，自动注入 model 和 api_key"""
        return self.llm.complete(
            messages,
            model=kwargs.pop("model", self.model),
            api_key=self.api_key,
            **kwargs,
        )

    def _complete_with_tools(
        self, messages: list, tools: list[dict], tool_handler: callable, **kwargs
    ) -> str | None:
        """带 function calling 的 LLM 调用，自动注入 model 和 api_key"""
        return self.llm.complete_with_tools(
            messages,
            tools=tools,
            tool_handler=tool_handler,
            model=kwargs.pop("model", self.model),
            api_key=self.api_key,
            **kwargs,
        )

    def gate_check(self, session: PaperSession) -> "GateResult":
        """
        轻量 Gate 检查：用廉价模型快速判断当前 agent 的输出是否合格。

        返回 GateResult:
          - ok=True: 通过，继续下一阶段
          - ok=False, retry=True: 不通过但可重试，附带 reason
          - ok=False, retry=False: 不通过且需要人工介入
        """
        if not self.GATE_CRITERIA:
            return GateResult(ok=True)

        snapshot = self._build_gate_snapshot(session)
        if not snapshot:
            return GateResult(ok=True)

        gate_model = os.environ.get("MODEL_GATE", "gpt-5.3-codex-high")

        prompt = (
            "你是论文生成流水线的质量检查员。判断以下 agent 输出是否合格。\n\n"
            f"检查标准：\n{self.GATE_CRITERIA}\n\n"
            f"Agent 输出摘要：\n{snapshot[:3000]}\n\n"
            "请只回复一个 JSON（不要其他文字）：\n"
            '{"ok": true/false, "retry": true/false, "reason": "简短原因"}\n\n'
            "规则：\n"
            '- 合格 → {"ok": true, "retry": false, "reason": ""}\n'
            '- 不合格但可以重试修复 → {"ok": false, "retry": true, "reason": "具体问题"}\n'
            '- 不合格且问题严重需要人工介入 → {"ok": false, "retry": false, "reason": "具体问题"}'
        )

        import json
        try:
            resp = self.llm.complete(
                [{"role": "user", "content": prompt}],
                model=gate_model,
            )
            if not resp:
                # gate 模型调用失败，不阻塞流程
                print("[Gate] 模型调用失败，放行")
                return GateResult(ok=True)

            # 解析 JSON
            text = resp.strip()
            start = text.find("{")
            end = text.rfind("}")
            if start >= 0 and end > start:
                data = json.loads(text[start:end + 1])
                return GateResult(
                    ok=bool(data.get("ok", True)),
                    retry=bool(data.get("retry", False)),
                    reason=str(data.get("reason", "")),
                )
        except Exception as e:
            print(f"[Gate] 解析失败: {e}，放行")

        return GateResult(ok=True)

    def _build_gate_snapshot(self, session: PaperSession) -> str:
        """
        构建给 gate 检查的输出摘要。子类可覆盖以提供更精确的摘要。
        默认返回空字符串（跳过 gate）。
        """
        return ""

    @abstractmethod
    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        """
        执行 Agent 任务。
        Yields progress/result events as dicts:
        - {"type": "progress", "stage": "...", "detail": "..."}
        - {"type": "result", "data": ...}
        """
        ...


class GateResult:
    """Gate 检查结果"""
    __slots__ = ("ok", "retry", "reason")

    def __init__(self, ok: bool = True, retry: bool = False, reason: str = ""):
        self.ok = ok
        self.retry = retry
        self.reason = reason

    def __repr__(self) -> str:
        return f"GateResult(ok={self.ok}, retry={self.retry}, reason={self.reason!r})"
