"""
PlannerAgent — 规划师 Agent（核心）
决定论文文件结构、章节规划、引用分配
"""

import json
from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


class PlannerAgent(BaseAgent):
    """规划师 Agent：生成完整的论文文件规划 JSON"""

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "planning", "detail": "正在规划论文结构..."}

        # 构建引用列表
        ref_list = "\n".join(
            f"- ref{i+1}: {lit.get('title', '')} ({lit.get('year', '')})"
            for i, lit in enumerate(session.literature)
        )

        prompt = f"""你是学术论文结构规划专家。为以下研究主题规划完整的论文文件结构。

主题: {session.topic}

可用参考文献:
{ref_list}

文献综述摘要:
{session.literature_summary[:2000]}

请返回严格的 JSON 格式（不要有其他文字）：
{{
  "title": "论文标题",
  "files": {{
    "main.tex": "入口文件",
    "chapters/01_xxx.tex": "章节描述",
    "refs.bib": "参考文献"
  }},
  "outline": {{
    "chapters/01_xxx.tex": {{
      "title": "章节标题",
      "sections": ["子节1", "子节2"],
      "key_points": ["要点1", "要点2"],
      "citations": ["ref1", "ref2"],
      "target_words": 800
    }}
  }}
}}

要求：
1. 章节文件用数字前缀排序：01_, 02_, ...
2. 包含标准学术结构：引言、相关工作/文献综述、方法、实验/结果、讨论、结论
3. 每章 2-4 个子节
4. 合理分配引用到各章节
5. 总字数 5000-8000 字"""

        response = self._complete([{"role": "user", "content": prompt}])
        session.file_plan = self._parse_plan(response)

        file_count = len(session.file_plan.get("files", {}))
        yield {"type": "progress", "stage": "planning", "detail": f"规划完成：{file_count} 个文件"}
        yield {"type": "result", "data": session.file_plan}

    def _parse_plan(self, response: str | None) -> dict:
        """从 LLM 响应中提取 JSON 对象，容错处理"""
        if not response:
            return {}
        start = response.find("{")
        end = response.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            return json.loads(response[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            return {}
