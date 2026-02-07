"""
FC/Lambda 函数 — LaTeX 编译服务
接收 files dict + entry，返回 PDF base64

部署为 HTTP 触发器，接收 POST 请求：
Request:  {"files": {"main.tex": "...", ...}, "entry": "main.tex"}
Response: {"success": true, "pdf_base64": "...", "log": "..."}
          {"success": false, "error": "...", "log": "..."}

兼容 Alibaba Cloud FC 和 AWS Lambda 事件格式。
自包含脚本，不依赖项目其他模块。
"""

import base64
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


def extract_errors(log: str) -> str:
    """从 xelatex / bibtex 日志中提取结构化错误信息（精简摘要）。"""
    if not log:
        return ""

    lines = log.splitlines()
    extracted: list[str] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        if line.startswith("!"):
            block = [line]
            for j in range(1, 6):
                if i + j < len(lines):
                    ctx = lines[i + j]
                    block.append(ctx)
                    if re.match(r"^l\.\d+", ctx):
                        break
            extracted.append("\n".join(block))
            i += len(block)
            continue

        if "error message" in line.lower() or line.startswith("Warning--"):
            extracted.append(line)
            i += 1
            continue

        if any(kw in line for kw in ("Emergency stop", "Fatal error", "No pages of output")):
            extracted.append(line)
            i += 1
            continue

        if re.match(r"^\./.*\.tex:\d+:", line):
            extracted.append(line)
            i += 1
            continue

        i += 1

    if not extracted:
        return "\n".join(lines[-30:])

    return "\n\n".join(extracted)


def compile_latex(files: dict, entry: str = "main.tex") -> dict:
    """编译 LaTeX 文件，返回结果 dict"""
    tmp_dir = tempfile.mkdtemp(prefix="fc_latex_")
    tmp_path = Path(tmp_dir)

    # Write all files to temp directory
    for file_path, content in files.items():
        full_path = tmp_path / file_path
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

    log_output = ""
    aux_name = entry.replace(".tex", "")

    # 编译顺序: xelatex → bibtex → xelatex → xelatex
    # 1) 第一遍 xelatex — 生成 .aux
    result = subprocess.run(
        ["xelatex", "-interaction=nonstopmode", "-halt-on-error", entry],
        cwd=tmp_dir, capture_output=True, text=True, timeout=120,
    )
    log_output += f"\n=== xelatex pass 1 ===\n{result.stdout}"
    if result.stderr:
        log_output += f"\n--- stderr ---\n{result.stderr}"
    if result.returncode != 0:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {
            "success": False,
            "error": f"xelatex pass 1 failed (exit {result.returncode})",
            "log": log_output,
            "errors": extract_errors(log_output),
        }

    # 2) bibtex — 处理参考文献
    result = subprocess.run(
        ["bibtex", aux_name],
        cwd=tmp_dir, capture_output=True, text=True, timeout=60,
    )
    log_output += f"\n=== bibtex ===\n{result.stdout}"
    if result.stderr:
        log_output += f"\n--- stderr ---\n{result.stderr}"
    if result.returncode > 1:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {
            "success": False,
            "error": f"bibtex failed (exit {result.returncode})",
            "log": log_output,
            "errors": extract_errors(log_output),
        }

    # 3) 第二遍 + 第三遍 xelatex — 解析引用和交叉引用
    for pass_num in (2, 3):
        result = subprocess.run(
            ["xelatex", "-interaction=nonstopmode", "-halt-on-error", entry],
            cwd=tmp_dir, capture_output=True, text=True, timeout=120,
        )
        log_output += f"\n=== xelatex pass {pass_num} ===\n{result.stdout}"
        if result.stderr:
            log_output += f"\n--- stderr ---\n{result.stderr}"
        if result.returncode != 0:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return {
                "success": False,
                "error": f"xelatex pass {pass_num} failed (exit {result.returncode})",
                "log": log_output,
                "errors": extract_errors(log_output),
            }

    # Read generated PDF
    pdf_path = tmp_path / entry.replace(".tex", ".pdf")
    if not pdf_path.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"success": False, "error": "PDF not generated", "log": log_output, "errors": extract_errors(log_output)}

    pdf_data = pdf_path.read_bytes()
    pdf_base64 = base64.b64encode(pdf_data).decode("ascii")

    shutil.rmtree(tmp_dir, ignore_errors=True)

    return {"success": True, "pdf_base64": pdf_base64, "log": log_output, "errors": ""}


def handler(event, context):
    """
    FC/Lambda handler — 兼容多种事件格式

    Alibaba Cloud FC: event 可能是 str 或 dict（含 body）
    AWS Lambda: event 是 dict（含 body str）
    """
    # Parse request body from various event formats
    if isinstance(event, str):
        body = json.loads(event)
    elif isinstance(event, dict):
        body = event.get("body", event)
        if isinstance(body, str):
            body = json.loads(body)
    else:
        body = {}

    files = body.get("files", {})
    entry = body.get("entry", "main.tex")

    if not files:
        return {
            "statusCode": 400,
            "body": json.dumps(
                {"success": False, "error": "No files provided"},
                ensure_ascii=False,
            ),
        }

    result = compile_latex(files, entry)
    return {
        "statusCode": 200,
        "body": json.dumps(result, ensure_ascii=False),
    }
