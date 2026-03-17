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

    GATE_CRITERIA = (
        "1. literature 列表不能为空，至少 5 篇文献\n"
        "2. 每篇文献必须有 title 和 year 字段\n"
        "3. 文献主题应与论文主题相关，不能是无关领域的文献\n"
        "4. literature_summary 不能为空，应是有意义的综述摘要"
    )

    def _build_gate_snapshot(self, session: PaperSession) -> str:
        """提供文献列表和摘要给 gate 检查"""
        parts = [f"论文主题: {session.topic}"]
        parts.append(f"文献数量: {len(session.literature)}")
        for i, lit in enumerate(session.literature):
            parts.append(f"  [{i+1}] title={lit.get('title', '?')}, year={lit.get('year', '?')}")
        parts.append(f"\n综述摘要 ({len(session.literature_summary)} 字):")
        parts.append(session.literature_summary[:1000])
        return "\n".join(parts)

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "researching", "detail": "正在检索相关文献..."}

        # 如果有规划对话上下文，加入提示
        context_hint = ""
        if session.design_context:
            context_hint = f"\n\n用户与 AI 的前期规划讨论：\n{session.design_context[:3000]}\n\n请根据以上讨论内容，有针对性地检索文献。"

        # MVP: 用 LLM 生成模拟文献
        prompt = (
            f"为研究主题「{session.topic}」生成 8-10 篇模拟参考文献。\n"
            "每篇包含：title, authors, year, abstract（50字以内）\n"
            f"返回 JSON 数组格式。{context_hint}"
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
