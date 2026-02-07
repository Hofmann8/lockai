"""
WriterAgent — 写手 Agent
按文件粒度工作，每次只写一个章节文件
渐进式披露：每章写完生成摘要，传给下一章
"""

from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


class WriterAgent(BaseAgent):
    """写手 Agent：逐章撰写纯文本内容"""

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "writing", "detail": "开始撰写论文..."}

        outline = session.file_plan.get("outline", {})
        chapter_files = sorted(k for k in outline if k.startswith("chapters/"))
        total = len(chapter_files)
        previous_summaries: list[str] = []

        for i, file_path in enumerate(chapter_files):
            plan = outline[file_path]
            title = plan.get("title", file_path)

            yield {
                "type": "progress",
                "stage": "writing",
                "detail": f"撰写第 {i + 1}/{total} 章: {title}",
            }

            content = self._write_chapter(session, file_path, plan, previous_summaries)
            session.content[file_path] = content

            # 渐进式披露：生成当前章节摘要，供后续章节参考
            summary = self._summarize_chapter(title, content)
            previous_summaries.append(f"【{title}】{summary}")

        yield {"type": "result", "data": list(session.content.keys())}

    def _write_chapter(
        self,
        session: PaperSession,
        file_path: str,
        plan: dict,
        prev_summaries: list[str],
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
