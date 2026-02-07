"""
LaTeX 编译器 — 可插拔架构，开发用 LocalCompiler，生产用 RemoteCompiler。
始终使用 xelatex 以支持中文字符。
"""

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import requests


def extract_errors(log: str) -> str:
    """
    从 xelatex / bibtex 完整日志中提取结构化错误信息。

    提取规则：
    1. xelatex 错误行：以 "!" 开头的行 + 后续上下文（文件名、行号、错误描述）
    2. bibtex 错误/警告：包含 "error message" 或 "Warning--" 的行
    3. 文件定位行：形如 "l.123 ..." 的行号指示
    4. 致命错误：Emergency stop、Fatal error 等

    返回精简的错误摘要字符串，通常几十行以内，适合喂给 LLM。
    """
    if not log:
        return ""

    lines = log.splitlines()
    extracted: list[str] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        # xelatex 错误: "! " 开头
        if line.startswith("!"):
            # 收集错误块：错误行 + 后续最多 5 行上下文
            block = [line]
            for j in range(1, 6):
                if i + j < len(lines):
                    ctx = lines[i + j]
                    block.append(ctx)
                    # 遇到行号指示 "l.NNN" 就停
                    if re.match(r"^l\.\d+", ctx):
                        break
            extracted.append("\n".join(block))
            i += len(block)
            continue

        # bibtex 错误/警告
        if "error message" in line.lower() or line.startswith("Warning--"):
            extracted.append(line)
            i += 1
            continue

        # 致命错误关键词
        if any(kw in line for kw in ("Emergency stop", "Fatal error", "No pages of output")):
            extracted.append(line)
            i += 1
            continue

        # 输入文件栈中的错误定位（如 "./chapters/01_intro.tex:42: ..."）
        if re.match(r"^\./.*\.tex:\d+:", line):
            extracted.append(line)
            i += 1
            continue

        i += 1

    if not extracted:
        # fallback: 如果正则没匹配到，取日志最后 30 行
        return "\n".join(lines[-30:])

    return "\n\n".join(extracted)


@dataclass
class CompileResult:
    success: bool
    pdf_data: bytes | None = None
    error: str | None = None
    log: str = ""
    errors: str = ""  # 从 log 中提取的精简错误摘要


class LocalCompiler:
    """本地 xelatex 编译器（开发环境）"""

    def compile(self, files: dict[str, str], entry: str = "main.tex") -> CompileResult:
        import shutil

        tmp_dir = tempfile.mkdtemp(prefix="paper_")
        tmp_path = Path(tmp_dir)

        # Write all files from VFS dict to temp dir
        for file_path, content in files.items():
            full_path = tmp_path / file_path
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")

        log_output = ""
        aux_name = entry.replace(".tex", "")

        # 编译顺序: xelatex → bibtex → xelatex → xelatex
        # 1) 第一遍 xelatex — 生成 .aux 文件
        result = subprocess.run(
            ["xelatex", "-interaction=nonstopmode", "-halt-on-error", entry],
            cwd=tmp_dir, capture_output=True, text=True, timeout=120,
        )
        log_output += "\n=== xelatex pass 1 ===\n" + result.stdout
        if result.stderr:
            log_output += "\n--- stderr ---\n" + result.stderr
        if result.returncode != 0:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return CompileResult(
                success=False,
                error=f"xelatex pass 1 failed (exit code {result.returncode})",
                log=log_output,
                errors=extract_errors(log_output),
            )

        # 2) bibtex — 处理参考文献，生成 .bbl
        result = subprocess.run(
            ["bibtex", aux_name],
            cwd=tmp_dir, capture_output=True, text=True, timeout=60,
        )
        log_output += "\n=== bibtex ===\n" + result.stdout
        if result.stderr:
            log_output += "\n--- stderr ---\n" + result.stderr
        # bibtex 警告不算致命错误，只在 returncode > 1 时报错
        if result.returncode > 1:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return CompileResult(
                success=False,
                error=f"bibtex failed (exit code {result.returncode})",
                log=log_output,
                errors=extract_errors(log_output),
            )

        # 3) 第二遍 + 第三遍 xelatex — 解析引用和交叉引用
        for pass_num in (2, 3):
            result = subprocess.run(
                ["xelatex", "-interaction=nonstopmode", "-halt-on-error", entry],
                cwd=tmp_dir, capture_output=True, text=True, timeout=120,
            )
            log_output += f"\n=== xelatex pass {pass_num} ===\n" + result.stdout
            if result.stderr:
                log_output += "\n--- stderr ---\n" + result.stderr
            if result.returncode != 0:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                return CompileResult(
                    success=False,
                    error=f"xelatex pass {pass_num} failed (exit code {result.returncode})",
                    log=log_output,
                    errors=extract_errors(log_output),
                )

        # Read PDF output
        pdf_path = tmp_path / entry.replace(".tex", ".pdf")
        pdf_data = None
        if pdf_path.exists():
            pdf_data = pdf_path.read_bytes()

        shutil.rmtree(tmp_dir, ignore_errors=True)

        if pdf_data is None:
            return CompileResult(
                success=False,
                error="PDF file not generated",
                log=log_output,
            )

        return CompileResult(success=True, pdf_data=pdf_data, log=log_output)


class RemoteCompiler:
    """远程编译器（生产环境，调 FC/Lambda）"""

    def __init__(self, endpoint: str, api_key: str):
        self.endpoint = endpoint
        self.api_key = api_key

    def compile(self, files: dict[str, str], entry: str = "main.tex") -> CompileResult:
        response = requests.post(
            self.endpoint,
            json={"files": files, "entry": entry},
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            timeout=300,
        )

        if response.status_code != 200:
            return CompileResult(
                success=False,
                error=f"Remote compile failed: HTTP {response.status_code}",
                log=response.text,
            )

        data = response.json()
        import base64

        pdf_data = None
        if data.get("pdf_base64"):
            pdf_data = base64.b64decode(data["pdf_base64"])

        return CompileResult(
            success=data.get("success", False),
            pdf_data=pdf_data,
            error=data.get("error"),
            log=data.get("log", ""),
            errors=data.get("errors", ""),
        )


def get_compiler() -> LocalCompiler | RemoteCompiler:
    """工厂函数：根据环境变量选择编译器"""
    compiler_type = os.environ.get("LATEX_COMPILER", "local")

    if compiler_type == "remote":
        endpoint = os.environ["LATEX_FC_ENDPOINT"]
        api_key = os.environ["LATEX_FC_API_KEY"]
        return RemoteCompiler(endpoint=endpoint, api_key=api_key)

    return LocalCompiler()
