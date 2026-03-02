"""
WriterAgent — 写手 Agent
按文件粒度工作，每次只写一个章节文件
渐进式披露：每章写完生成摘要，传给下一章
接收 planner 分配的章节级 requirements
"""

from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


class WriterAgent(BaseAgent):
    """写手 Agent：逐章撰写纯文本内容"""

    GATE_CRITERIA = (
        "1. 每个章节的 content 不能为空，且长度应接近 target_words\n"
        "2. 内容应是学术写作风格，不能是占位符或无意义文本\n"
        "3. 应包含引用标记 [refN]\n"
        "4. 不能包含 LaTeX 标记（这是纯文本阶段）\n"
        "5. 各章节内容不能大量重复"
    )

    def _build_gate_snapshot(self, session: PaperSession) -> str:
        """提供各章节内容摘要给 gate 检查"""
        parts = [f"论文主题: {session.topic}", f"章节数: {len(session.content)}"]
        for fp, content in sorted(session.content.items()):
            if fp.startswith("__"):
                continue
            parts.append(f"\n--- {fp} ({len(content)} 字) ---")
            parts.append(content[:300] + "..." if len(content) > 300 else content)
        return "\n".join(parts)[:3000]

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "writing", "detail": "开始撰写论文..."}

        plan = session.file_plan
        outline = plan.get("outline", {})
        global_req = plan.get("global_requirements", "")
        chapter_files = sorted(k for k in outline if k.startswith("chapters/"))

        if not chapter_files:
            raise RuntimeError("写作失败：论文规划中没有章节（outline 为空），请检查 planner 输出")

        total = len(chapter_files)
        previous_summaries: list[str] = []

        # 如果 plan 要求摘要，先写摘要
        if plan.get("include_abstract"):
            yield {"type": "progress", "stage": "writing", "detail": "撰写摘要..."}
            abstract = self._write_abstract(session, global_req)
            session.content["__abstract__"] = abstract

        for i, file_path in enumerate(chapter_files):
            ch_plan = outline[file_path]
            title = ch_plan.get("title", file_path)

            yield {
                "type": "progress",
                "stage": "writing",
                "detail": f"撰写第 {i + 1}/{total} 章: {title}",
            }

            content = self._write_chapter(session, file_path, ch_plan, previous_summaries, global_req)
            session.content[file_path] = content

            # 渐进式披露：生成当前章节摘要，供后续章节参考
            summary = self._summarize_chapter(title, content)
            previous_summaries.append(f"【{title}】{summary}")

        yield {"type": "result", "data": list(session.content.keys())}

    def _write_abstract(self, session: PaperSession, global_req: str) -> str:
        """撰写论文摘要"""
        plan = session.file_plan
        abstract_req = plan.get("abstract_requirements", "200-300字")
        outline = plan.get("outline", {})

        # 收集所有章节标题和要点作为摘要素材
        chapter_overview = ""
        for fp in sorted(k for k in outline if k.startswith("chapters/")):
            ch = outline[fp]
            chapter_overview += f"- {ch.get('title', '')}: {', '.join(ch.get('key_points', []))}\n"

        prompt = f"""撰写学术论文摘要（纯文本，不要 LaTeX 标记）：

论文主题: {session.topic}
论文标题: {plan.get('title', session.topic)}
章节概览:
{chapter_overview}

摘要要求: {abstract_req}
{f'全局写作要求: {global_req}' if global_req else ''}

要求：
1. 学术写作风格，简洁精炼
2. 涵盖研究背景、方法、主要发现和结论
3. 不要使用列表/枚举结构
4. 纯文本输出"""

        return self._complete([{"role": "user", "content": prompt}]) or ""

    def _write_chapter(
        self,
        session: PaperSession,
        file_path: str,
        plan: dict,
        prev_summaries: list[str],
        global_req: str,
    ) -> str:
        """撰写单个章节的纯文本内容"""
        # 只传最近 3 章摘要，控制上下文长度
        context = "\n".join(prev_summaries[-3:]) if prev_summaries else "（这是第一章）"

        # 构建该章节的引用信息
        citations_info = ""
        for ref_id in plan.get("citations", []):
            idx = int(ref_id.replace("ref", "")) - 1
            if 0 <= idx < len(session.literature):
                lit = session.literature[idx]
                citations_info += f"- [{ref_id}] {lit.get('title', '')} ({lit.get('year', '')})\n"

        # 章节级要求（planner 从讨论中提取并分配的）
        chapter_req = plan.get("requirements", "")

        # 构建要求部分
        req_section = ""
        if global_req:
            req_section += f"\n全局写作要求（所有章节必须遵守）:\n{global_req}\n"
        if chapter_req:
            req_section += f"\n本章节特定要求（来自用户讨论）:\n{chapter_req}\n"

        prompt = f"""撰写学术论文章节（纯文本，不要 LaTeX 标记）：

论文主题: {session.topic}
章节标题: {plan.get('title', '')}
子节: {', '.join(plan.get('sections', []))}
要点: {', '.join(plan.get('key_points', []))}
目标字数: {plan.get('target_words', 800)}

可引用文献:
{citations_info}

前序章节摘要:
{context}
{req_section}
要求：
1. 学术写作风格，严谨客观
2. 引用格式用 [refN]，如 [ref1]、[ref3]
3. 逻辑清晰，段落分明
4. 不要使用列表/枚举结构，用段落自然组织
5. 与前序章节保持连贯，不重复已述内容"""

        return self._complete([{"role": "user", "content": prompt}]) or ""

    def _summarize_chapter(self, title: str, content: str) -> str:
        """生成章节摘要（2-3句话），供后续章节参考"""
        prompt = f"用2-3句话概括以下章节的核心内容：\n\n{content[:1500]}"
        return self._complete([{"role": "user", "content": prompt}]) or ""
