"""
ResearcherAgent — 研究员 Agent
MVP 阶段：基于主题用 LLM 生成模拟文献数据
后续：接入真实学术搜索 API
"""

import json
from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


class ResearcherAgent(BaseAgent):
    """研究员 Agent：用 LLM 生成模拟文献列表 + 综合摘要"""

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "researching", "detail": "正在检索相关文献..."}

        # MVP: 用 LLM 生成模拟文献
        prompt = (
            f"为研究主题「{session.topic}」生成 8-10 篇模拟参考文献。\n"
            "每篇包含：title, authors, year, abstract（50字以内）\n"
            "返回 JSON 数组格式。"
        )
        response = self._complete([{"role": "user", "content": prompt}])
        session.literature = self._parse_literature(response)

        yield {"type": "progress", "stage": "researching", "detail": "正在综合分析文献..."}

        # 生成文献综述摘要
        summary_prompt = (
            f"基于以下文献信息，为主题「{session.topic}」写一份 500 字的文献综述摘要：\n"
            f"{json.dumps(session.literature, ensure_ascii=False)}\n"
            "要求：识别研究趋势、方法分类、研究空白。"
        )
        summary = self._complete([{"role": "user", "content": summary_prompt}])
        session.literature_summary = summary or ""

        yield {"type": "result", "data": session.literature}

    def _parse_literature(self, response: str | None) -> list:
        """从 LLM 响应中提取 JSON 数组"""
        if not response:
            return []
        start = response.find("[")
        end = response.rfind("]")
        if start < 0 or end <= start:
            return []
        try:
            return json.loads(response[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            return []
