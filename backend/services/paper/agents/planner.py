"""
PlannerAgent — 规划师 Agent（核心）
决定论文文件结构、章节规划、引用分配
将用户讨论结果消化到每个章节的 requirements 中
"""

import json
from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


class PlannerAgent(BaseAgent):
    """规划师 Agent：生成完整的论文文件规划 JSON"""

    GATE_CRITERIA = (
        "1. outline 字段必须存在且包含至少 4 个 chapters/ 开头的章节\n"
        "2. 每个章节必须有 title、sections、key_points、citations 字段\n"
        "3. 必须有 title（论文标题）且不是占位符\n"
        "4. 章节结构合理：应包含引言、方法/理论、结果/讨论、结论等基本学术结构\n"
        "5. citations 引用分配合理，不能所有章节都引用同样的文献"
    )

    def _build_gate_snapshot(self, session: PaperSession) -> str:
        """提供 file_plan 的摘要给 gate 检查"""
        plan = session.file_plan
        if not plan:
            return "file_plan 为空"
        return json.dumps(plan, ensure_ascii=False, indent=2)[:3000]

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "planning", "detail": "正在规划论文结构..."}

        # 构建引用列表
        ref_list = "\n".join(
            f"- ref{i+1}: {lit.get('title', '')} ({lit.get('year', '')})"
            for i, lit in enumerate(session.literature)
        )

        # 如果有规划对话上下文，加入提示
        context_section = ""
        if session.design_context:
            context_section = f"""
用户与 AI 的前期规划讨论（你必须严格按照讨论中确定的结构、方向、格式要求来规划）：
{session.design_context[:4000]}

重要：你必须将上述讨论中的所有用户要求分解到对应章节的 requirements 字段中。
每个章节只接收与自己职权相关的要求，不要越权。
"""

        prompt = f"""你是学术论文结构规划专家。为以下研究主题规划完整的论文文件结构。

主题: {session.topic}
{context_section}
可用参考文献:
{ref_list}

文献综述摘要:
{session.literature_summary[:2000]}

请返回严格的 JSON 格式（不要有其他文字）：
{{
  "title": "论文标题",
  "citation_style": "引用格式，如 GB/T 7714、IEEE、APA 等（根据讨论确定，默认 GB/T 7714）",
  "include_abstract": true,
  "abstract_requirements": "摘要的具体要求（如字数、语言、关键词数量等）",
  "include_toc": true,
  "language": "论文语言（中文/英文/中英混合）",
  "global_requirements": "全局格式和风格要求（适用于所有章节的通用要求）",
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
      "target_words": 800,
      "requirements": "该章节的具体写作要求（从用户讨论中提取的、仅与本章节相关的要求）"
    }}
  }}
}}

要求：
1. 章节文件用数字前缀排序：01_, 02_, ...
2. 包含标准学术结构：引言、相关工作/文献综述、方法、实验/结果、讨论、结论
3. 每章 2-4 个子节
4. 合理分配引用到各章节
5. 总字数 5000-8000 字
6. requirements 字段非常重要：必须将用户讨论中的要求精确分配到对应章节，每个章节只包含自己职权范围内的要求
7. 如果用户讨论中提到了特定的引用格式、摘要要求、目录要求等，必须在顶层字段中体现
8. global_requirements 放所有章节都需要遵守的通用要求（如写作风格、术语规范等）"""

        # 最多重试 2 次，确保 outline 非空
        max_attempts = 3
        for attempt in range(max_attempts):
            response = self._complete([{"role": "user", "content": prompt}])
            plan = self._parse_plan(response)

            outline = plan.get("outline", {})
            chapter_files = [k for k in outline if k.startswith("chapters/")]

            if chapter_files:
                session.file_plan = plan
                break

            print(f"[Planner] 第 {attempt + 1} 次规划缺少 outline（章节数={len(chapter_files)}），"
                  f"原始响应前 500 字: {(response or '')[:500]}")

            if attempt < max_attempts - 1:
                yield {"type": "progress", "stage": "planning",
                       "detail": f"规划结果不完整，正在重试（{attempt + 2}/{max_attempts}）..."}
        else:
            # 所有重试都失败
            raise RuntimeError(
                f"规划失败：LLM 未返回有效的章节结构（已重试 {max_attempts} 次）。"
                f"原始响应前 300 字: {(response or '')[:300]}"
            )

        # 确保关键字段有默认值
        session.file_plan.setdefault("include_abstract", True)
        session.file_plan.setdefault("include_toc", True)
        session.file_plan.setdefault("citation_style", "plainnat")
        session.file_plan.setdefault("language", "中文")
        session.file_plan.setdefault("global_requirements", "")
        session.file_plan.setdefault("abstract_requirements", "")

        file_count = len(session.file_plan.get("files", {}))
        yield {"type": "progress", "stage": "planning", "detail": f"规划完成：{file_count} 个文件"}
        yield {"type": "result", "data": session.file_plan}

    def _parse_plan(self, response: str | None) -> dict:
        """从 LLM 响应中提取 JSON 对象，容错处理"""
        if not response:
            return {}

        text = response.strip()

        # 去掉 markdown 代码块标记
        if text.startswith("```"):
            first_nl = text.find("\n")
            if first_nl > 0:
                text = text[first_nl + 1:]
            if text.rstrip().endswith("```"):
                text = text.rstrip()[:-3].rstrip()

        # 去掉 <thinking>...</thinking> 等标签（某些模型会输出）
        import re
        text = re.sub(r"<thinking>.*?</thinking>", "", text, flags=re.DOTALL)
        text = re.sub(r"<\|.*?\|>", "", text)  # qwen 特殊标记
        text = text.strip()

        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            return json.loads(text[start : end + 1])
        except (json.JSONDecodeError, ValueError):
            return {}
