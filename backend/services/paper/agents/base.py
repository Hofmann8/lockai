"""
BaseAgent — 所有 Agent 的抽象基类
"""

from abc import ABC, abstractmethod
from typing import Generator

from ..session import PaperSession


class BaseAgent(ABC):
    """所有 Agent 的抽象基类"""

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

    @abstractmethod
    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        """
        执行 Agent 任务。
        Yields progress/result events as dicts:
        - {"type": "progress", "stage": "...", "detail": "..."}
        - {"type": "result", "data": ...}
        """
        ...
