"""
FormatterAgent — 排版师 Agent
将纯文本转为 LaTeX，写入 VFS
绝对不使用 itemize/enumerate/item 结构
"""

from typing import Generator

from .base import BaseAgent
from ..session import PaperSession


class FormatterAgent(BaseAgent):
    """排版师 Agent：将纯文本转为 LaTeX，写入 VFS"""

    def run(self, session: PaperSession) -> Generator[dict, None, None]:
        yield {"type": "progress", "stage": "formatting", "detail": "正在生成 LaTeX 文件..."}

        vfs = session.vfs
        plan = session.file_plan

        # 1. 生成 main.tex
        yield {"type": "progress", "stage": "formatting", "detail": "生成 main.tex..."}
        vfs.write("main.tex", self._generate_main(plan))

        # 2. 逐章转换 LaTeX
        outline = plan.get("outline", {})
        chapter_files = sorted(k for k in outline if k.startswith("chapters/"))

        for file_path in chapter_files:
            chapter_plan = outline[file_path]
            content = session.content.get(file_path, "")
            title = chapter_plan.get("title", "")

            yield {"type": "progress", "stage": "formatting", "detail": f"格式化 {file_path}..."}

            latex_content = self._to_latex(title, content, chapter_plan.get("sections", []))
            vfs.write(file_path, latex_content)

        # 3. 生成 refs.bib
        yield {"type": "progress", "stage": "formatting", "detail": "生成 refs.bib..."}
        vfs.write("refs.bib", self._generate_bib(session.literature))

        yield {"type": "result", "data": vfs.list_files()}

    def _generate_main(self, plan: dict) -> str:
        """生成 main.tex 入口文件（纯字符串拼接，无 LLM 调用）"""
        title = plan.get("title", "Untitled")
        outline = plan.get("outline", {})
        chapter_files = sorted(k for k in outline if k.startswith("chapters/"))

        includes = "\n".join(
            f"\\input{{{f.replace('.tex', '')}}}" for f in chapter_files
        )

        return (
            "\\documentclass[12pt,a4paper]{article}\n"
            "\\usepackage{ctex}\n"
            "\\usepackage{fontspec}\n"
            "\\usepackage{geometry}\n"
            "\\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}\n"
            "\\usepackage{amsmath,amssymb}\n"
            "\\usepackage{graphicx}\n"
            "\\usepackage{hyperref}\n"
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
            "\n"
            f"{includes}\n"
            "\n"
            "\\bibliographystyle{plainnat}\n"
            "\\bibliography{refs}\n"
            "\\end{document}\n"
        )

    def _to_latex(self, title: str, content: str, sections: list) -> str:
        """用 LLM 将纯文本转换为 LaTeX 格式"""
        prompt = f"""将以下纯文本转换为 LaTeX 格式：

章节标题: {title}
子节标题: {', '.join(sections)}
内容:
{content}

要求：
1. 用 \\section{{{title}}} 开头
2. 子节用 \\subsection{{}}
3. 引用标记 [refN] 转为 \\cite{{refN}}
4. 数学内容用 $...$ 或 \\[...\\]
5. 绝对不使用 itemize/enumerate/item
6. 用段落自然组织，段间空行分隔
7. 只输出 LaTeX 内容，不要 documentclass 等"""

        return self._complete([{"role": "user", "content": prompt}]) or ""

    # ---- repair 用的 tool 定义 (OpenAI function calling 格式) ----

    REPAIR_TOOLS = [
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "列出 VFS 中所有文件路径",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "读取 VFS 中指定文件的完整内容",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件路径，如 main.tex 或 chapters/01_intro.tex",
                        }
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "将修复后的内容写入 VFS 中的指定文件（覆盖）",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "文件路径",
                        },
                        "content": {
                            "type": "string",
                            "description": "修复后的完整文件内容",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
    ]

    def repair(self, session: PaperSession, error_log: str) -> Generator[dict, None, None]:
        """
        根据编译错误日志，用 function calling 让 LLM 自主定位并修复出错文件。

        LLM 可调用:
          - list_files()        → 查看 VFS 文件列表
          - read_file(path)     → 读取单个文件内容
          - write_file(path, content) → 写回修复后的内容

        这样上下文里只有错误日志 + 按需读取的单个文件，不会溢出。
        """
        vfs = session.vfs

        yield {
            "type": "progress",
            "stage": "compiling",
            "detail": "分析编译错误...",
        }

        # 记录被修改的文件，用于 yield progress
        modified_files: list[str] = []

        def tool_handler(name: str, arguments: dict) -> str:
            if name == "list_files":
                files = vfs.list_files()
                return "\n".join(files) if files else "(空)"

            if name == "read_file":
                path = arguments.get("path", "")
                content = vfs.read(path)
                if content is None:
                    return f"错误: 文件 {path} 不存在"
                return content

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
                    "你是 LaTeX 编译错误修复专家。用户会给你一段 xelatex 编译错误日志，"
                    "你需要通过工具定位出错文件、读取内容、修复后写回。\n\n"
                    "规则：\n"
                    "1. 先用 list_files 查看有哪些文件\n"
                    "2. 根据错误日志中的文件名和行号，用 read_file 读取出错文件\n"
                    "3. 只修复导致编译失败的语法错误，不要改变内容语义\n"
                    "4. 绝对不使用 itemize/enumerate/item 结构\n"
                    "5. 用 write_file 写回修复后的完整文件内容\n"
                    "6. 修复完成后，回复一句简短总结说明改了什么"
                ),
            },
            {
                "role": "user",
                "content": f"以下是 xelatex 编译错误摘要，请定位并修复问题：\n\n```\n{error_log}\n```",
            },
        ]

        self._complete_with_tools(
            messages,
            tools=self.REPAIR_TOOLS,
            tool_handler=tool_handler,
            max_rounds=10,
        )

        for f in modified_files:
            yield {
                "type": "progress",
                "stage": "compiling",
                "detail": f"已修复 {f}",
            }

    def _generate_bib(self, literature: list) -> str:
        """生成 refs.bib 文件（纯字符串拼接，无 LLM 调用）"""
        entries = []
        for i, lit in enumerate(literature):
            entry = (
                f"@article{{ref{i + 1},\n"
                f"  title = {{{lit.get('title', '')}}},\n"
                f"  author = {{{lit.get('authors', 'Unknown')}}},\n"
                f"  year = {{{lit.get('year', '2024')}}}\n"
                "}"
            )
            entries.append(entry)
        return "\n\n".join(entries)
