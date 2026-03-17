"""
FormatterAgent — 排版师 Agent
WriterAgent 已直接输出 LaTeX，本 Agent 负责：
1. 生成 main.tex 文档框架（根据 plan 元数据动态构建）
2. 将 writer 输出的 LaTeX 章节写入 VFS（strip code fences）
3. 生成 refs.bib
4. 轻量级质量检查
5. 编译错误修复（repair）
绝对不使用 itemize/enumerate/item 结构
"""

from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


# 引用格式 → natbib bibliographystyle 映射
_BIBSTYLE_MAP = {
    "gb/t 7714": "unsrtnat",
    "gbt7714": "unsrtnat",
    "ieee": "ieeetr",
    "apa": "apalike",
    "plainnat": "plainnat",
    "harvard": "apalike",
}


class FormatterAgent(BaseAgent):
    """排版师 Agent：组装 main.tex + 写入章节 + refs.bib + 质量检查"""

    GATE_CRITERIA = (
        "1. VFS 中必须有 main.tex 和至少 1 个 chapters/*.tex 文件和 refs.bib\n"
        "2. main.tex 必须包含 \\documentclass 和 \\begin{document}\n"
        "3. 章节 .tex 文件必须包含 \\section 标记\n"
        "4. 不能包含 \\begin{itemize} 或 \\begin{enumerate}\n"
        "5. 不能有 ``` markdown 残留"
    )

    def _build_gate_snapshot(self, session: PaperSession) -> str:
        """提供 VFS 文件列表和关键文件片段给 gate 检查"""
        vfs = session.vfs
        files = [f for f in vfs.list_files() if not f.startswith("__meta__/")]
        parts = [f"VFS 文件: {', '.join(files)}"]
        main = vfs.read("main.tex")
        if main:
            parts.append(f"\nmain.tex 前 500 字:\n{main[:500]}")
        for f in files:
            if f.startswith("chapters/") and f.endswith(".tex"):
                content = vfs.read(f) or ""
                parts.append(f"\n{f} 前 300 字:\n{content[:300]}")
        return "\n".join(parts)[:3000]

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "formatting", "detail": "正在生成 LaTeX 文件..."}

        vfs = session.vfs
        plan = session.file_plan

        # 1. 生成 main.tex（根据 plan 元数据动态构建）
        yield {"type": "progress", "stage": "formatting", "detail": "生成 main.tex..."}
        vfs.write("main.tex", self._generate_main(plan, session))

        # 2. 将 writer 输出的 LaTeX 章节直接写入 VFS（仅 strip code fences）
        outline = plan.get("outline", {})
        chapter_files = sorted(k for k in outline if k.startswith("chapters/"))

        for file_path in chapter_files:
            content = session.content.get(file_path, "")
            yield {"type": "progress", "stage": "formatting", "detail": f"写入 {file_path}..."}
            cleaned = self._strip_code_fences(content) if content else ""
            vfs.write(file_path, cleaned)

        # 3. 生成 refs.bib
        yield {"type": "progress", "stage": "formatting", "detail": "生成 refs.bib..."}
        vfs.write("refs.bib", self._generate_bib(session.literature))

        # 4. 轻量级质量检查
        yield {"type": "progress", "stage": "formatting", "detail": "执行质量检查..."}
        for evt in self._quality_check(session):
            yield evt

        yield {"type": "result", "data": vfs.list_files()}

    # ---- main.tex 生成 ----

    def _generate_main(self, plan: dict, session: PaperSession) -> str:
        """根据 plan 元数据动态生成 main.tex"""
        title = plan.get("title", "Untitled")
        outline = plan.get("outline", {})
        chapter_files = sorted(k for k in outline if k.startswith("chapters/"))
        include_abstract = plan.get("include_abstract", True)
        include_toc = plan.get("include_toc", True)
        citation_style = plan.get("citation_style", "plainnat").lower().strip()

        bibstyle = _BIBSTYLE_MAP.get(citation_style, "plainnat")

        includes = "\n".join(
            f"\\input{{{f.replace('.tex', '')}}}" for f in chapter_files
        )

        abstract_block = ""
        if include_abstract:
            abstract_text = session.content.get("__abstract__", "")
            if abstract_text:
                # writer 已输出 LaTeX 安全文本，只需 strip code fences
                abstract_latex = self._strip_code_fences(abstract_text)
                abstract_block = (
                    "\n\\begin{abstract}\n"
                    f"{abstract_latex}\n"
                    "\\end{abstract}\n"
                )

        toc_block = ""
        if include_toc:
            toc_block = "\n\\tableofcontents\n\\newpage\n"

        return (
            "\\documentclass[12pt,a4paper]{article}\n"
            "\\usepackage{ctex}\n"
            "\\usepackage{fontspec}\n"
            "\\usepackage{geometry}\n"
            "\\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}\n"
            "\\usepackage{amsmath,amssymb}\n"
            "\\usepackage{graphicx}\n"
            "\\usepackage[hidelinks]{hyperref}\n"
            "\\usepackage{natbib}\n"
            "\\usepackage{setspace}\n"
            "\\onehalfspacing\n"
            "\n"
            f"\\title{{{title}}}\n"
            "\\author{}\n"
            "\\date{\\today}\n"
            "\n"
            "\\begin{document}\n"
            "\\maketitle\n"
            f"{abstract_block}"
            f"{toc_block}"
            "\n"
            f"{includes}\n"
            "\n"
            f"\\bibliographystyle{{{bibstyle}}}\n"
            "\\bibliography{refs}\n"
            "\\end{document}\n"
        )

    # ---- LLM 质量检查 ----

    _QC_PROMPT = (
        "你是 LaTeX 学术论文质量审查专家。检查以下 LaTeX 文件并直接输出修复后的完整内容。\n\n"
        "检查清单：\n"
        "1. 所有引用必须用 \\cite{refN} 格式，不能有 [refN]、[ref1, ref2] 等原始标记\n"
        "2. 绝对不能出现 \\begin{itemize}、\\begin{enumerate}、\\item，改用段落自然组织\n"
        "3. 不能有 ``` 等 markdown 残留\n"
        "4. 所有 \\begin{} 必须有对应的 \\end{}\n"
        "5. 不能有 \\documentclass、\\begin{document} 等（这些只属于 main.tex）\n"
        "6. \\section / \\subsection 层级正确，不能有孤立的 \\subsection 没有上级 \\section\n"
        "7. 数学公式 $...$ 和 \\[...\\] 必须正确闭合\n"
        "8. 不能有乱码、'latex 这类异常字符串\n"
        "9. 段落之间用空行分隔，不要用 \\\\\\\\ 强制换行\n\n"
        "规则：\n"
        "- 如果没有问题，原样输出内容即可\n"
        "- 如果有问题，直接修复后输出完整内容\n"
        "- 只输出文件内容本身，不要任何解释、不要代码块标记"
    )

    def _quality_check(self, session: PaperSession) -> Generator[dict, None, None]:
        """
        LLM 逐文件质量检查。
        每个 .tex 文件独立一次 LLM 调用，只传该文件内容 + 检查清单。
        """
        vfs = session.vfs
        tex_files = [f for f in vfs.list_files() if f.endswith(".tex")]
        total = len(tex_files)

        for i, file_path in enumerate(tex_files):
            content = vfs.read(file_path) or ""
            if not content.strip():
                continue

            yield {
                "type": "progress",
                "stage": "formatting",
                "detail": f"质量检查 ({i + 1}/{total}): {file_path}",
            }

            fixed = self._complete([
                {"role": "system", "content": self._QC_PROMPT},
                {"role": "user", "content": content},
            ])

            if fixed and fixed.strip() and fixed.strip() != content.strip():
                # 去掉 LLM 可能包裹的代码块标记
                cleaned = self._strip_code_fences(fixed)
                vfs.write(file_path, cleaned)

        yield {"type": "progress", "stage": "formatting", "detail": "质量检查完成"}

    @staticmethod
    def _strip_code_fences(text: str) -> str:
        """去掉 LLM 输出中可能包裹的 ```latex ... ``` 代码块"""
        stripped = text.strip()
        if stripped.startswith("```"):
            # 去掉第一行 ```xxx
            first_nl = stripped.find("\n")
            if first_nl > 0:
                stripped = stripped[first_nl + 1:]
            # 去掉末尾 ```
            if stripped.rstrip().endswith("```"):
                stripped = stripped.rstrip()[:-3].rstrip()
        return stripped

    # ---- repair (编译错误修复 — LLM 自主调用 embedding 检索) ----

    REPAIR_TOOLS = [
        {
            "type": "function",
            "function": {
                "name": "search_chunks",
                "description": "语义检索：输入查询文本，返回论文中最相关的代码块（精确到 section 级，含文件路径和行号）。可多次调用、换关键词缩小范围",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "检索关键词，如错误信息、文件名、section 标题等"},
                        "top_k": {"type": "integer", "description": "返回数量，默认 3", "default": 3},
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取指定文件的完整内容",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径"},
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "将修复后的内容写入指定文件（覆盖整个文件）",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "文件路径"},
                        "content": {"type": "string", "description": "修复后的完整文件内容"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
    ]

    def repair(self, session: PaperSession, error_log: str) -> Generator[dict, None, None]:
        """
        编译错误修复：LLM 自主调用 search_chunks 检索相关代码块，定位并修复。
        """
        vfs = session.vfs
        idx = session.embedding_index
        yield {"type": "progress", "stage": "compiling", "detail": "分析编译错误..."}

        modified_files: list[str] = []
        all_files = [f for f in vfs.list_files() if not f.startswith("__meta__/")]

        def tool_handler(name: str, arguments: dict) -> str:
            if name == "search_chunks":
                query = arguments.get("query", "")
                top_k = arguments.get("top_k", 3)
                if not query:
                    return "错误: query 不能为空"
                if idx and idx.chunks:
                    results = idx.search(query, top_k=top_k)
                else:
                    return "（无语义索引，请用 read_file 直接读取文件）"
                if not results:
                    return "未找到相关代码块"
                parts = []
                for chunk in results:
                    parts.append(
                        f"--- {chunk.file_path} (行 {chunk.line_start}-{chunk.line_end}, "
                        f"section: {chunk.section_title}) ---\n{chunk.content}"
                    )
                return "\n\n".join(parts)

            if name == "read_file":
                path = arguments.get("path", "")
                content = vfs.read(path)
                return content if content is not None else f"错误: 文件 {path} 不存在"

            if name == "write_file":
                path = arguments.get("path", "")
                content = arguments.get("content", "")
                vfs.write(path, content)
                modified_files.append(path)
                return f"已写入 {path}（{len(content)} 字符）"

            return f"未知工具: {name}"

        messages = [
            {
                "role": "system",
                "content": (
                    "你是 LaTeX 编译错误修复专家。\n\n"
                    "工具：\n"
                    "- search_chunks: 语义检索论文代码块，输入关键词返回最相关的 section 级代码段（含文件路径和行号）\n"
                    "- read_file: 读取完整文件\n"
                    "- write_file: 写回修复后的完整文件\n\n"
                    "流程：\n"
                    "1. 分析错误日志，提取关键信息（文件名、行号、错误类型）\n"
                    "2. 用 search_chunks 检索相关代码块，可多次检索、换关键词\n"
                    "3. 如需完整上下文，用 read_file 读取整个文件\n"
                    "4. 只修复编译错误，不改内容语义\n"
                    "5. 绝对不使用 itemize/enumerate/item\n"
                    "6. 用 write_file 写回修复后的完整文件"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"所有文件: {', '.join(all_files)}\n\n"
                    f"编译错误日志：\n```\n{error_log}\n```\n\n"
                    "请定位并修复问题。"
                ),
            },
        ]

        self._complete_with_tools(
            messages, tools=self.REPAIR_TOOLS,
            tool_handler=tool_handler, max_rounds=10,
        )

        for f in modified_files:
            yield {"type": "progress", "stage": "compiling", "detail": f"已修复 {f}"}

    # ---- refs.bib 生成 ----

    def _generate_bib(self, literature: list) -> str:
        """生成 refs.bib 文件"""
        entries = []
        for i, lit in enumerate(literature):
            # 用 @misc 类型，对字段要求最宽松，避免 bibtex 因缺少 journal 等字段跳过条目
            entry = (
                f"@misc{{ref{i + 1},\n"
                f"  title = {{{lit.get('title', '')}}},\n"
                f"  author = {{{lit.get('authors', 'Unknown')}}},\n"
                f"  year = {{{lit.get('year', '2024')}}},\n"
                f"  note = {{{lit.get('abstract', '')}}}\n"
                "}"
            )
            entries.append(entry)
        return "\n\n".join(entries)
