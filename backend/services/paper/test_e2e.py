"""
端到端集成测试 — 测试完整 PaperService pipeline（mock LLM + compiler 层）

与 test_service.py 的区别：这里 mock 的是 LLM 层而非 Agent 层，
让真实 Agent 代码跑起来，验证整条链路的数据流转。
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from .latex import CompileResult
from .service import PaperService
from .session import PaperStatus, SessionManager


# ---------------------------------------------------------------------------
# Mock data
# ---------------------------------------------------------------------------

MOCK_LITERATURE = json.dumps([
    {"title": "Attention Is All You Need", "authors": "Vaswani et al.", "year": "2017",
     "abstract": "Transformer architecture for sequence transduction."},
    {"title": "BERT: Pre-training of Deep Bidirectional Transformers", "authors": "Devlin et al.", "year": "2019",
     "abstract": "Bidirectional pre-training for language understanding."},
])

MOCK_FILE_PLAN = json.dumps({
    "title": "Transformer综述",
    "files": {
        "main.tex": "入口文件",
        "chapters/01_intro.tex": "引言",
        "refs.bib": "参考文献",
    },
    "outline": {
        "chapters/01_intro.tex": {
            "title": "引言",
            "sections": ["研究背景", "本文贡献"],
            "key_points": ["Transformer兴起"],
            "citations": ["ref1"],
            "target_words": 400,
        },
    },
})

MOCK_CHAPTER_CONTENT = "Transformer模型自2017年提出以来，在自然语言处理领域取得了巨大成功。"
MOCK_CHAPTER_SUMMARY = "本章介绍了Transformer的研究背景。"
MOCK_LITERATURE_SUMMARY = "近年来Transformer架构在NLP领域占据主导地位。"
MOCK_LATEX_CONTENT = "\\section{引言}\nTransformer模型自2017年提出以来。"


# ---------------------------------------------------------------------------
# Smart LLM mock — returns different responses based on prompt content
# ---------------------------------------------------------------------------

def _make_smart_llm():
    """Create an LLM mock that returns context-appropriate responses."""
    llm = MagicMock()

    def smart_complete(messages, model=None):
        prompt = messages[0]["content"] if messages else ""

        # Planner: file plan (check BEFORE researcher summary — planner prompt also contains 文献综述摘要)
        if "论文文件结构" in prompt:
            return MOCK_FILE_PLAN

        # Researcher: literature generation
        if "模拟参考文献" in prompt:
            return MOCK_LITERATURE

        # Researcher: literature summary
        if "文献综述摘要" in prompt:
            return MOCK_LITERATURE_SUMMARY

        # Writer: chapter summarization
        if "概括以下章节的核心内容" in prompt:
            return MOCK_CHAPTER_SUMMARY

        # Formatter: to_latex conversion
        if "转换为 LaTeX 格式" in prompt:
            return MOCK_LATEX_CONTENT

        # Writer: chapter writing (default for writing prompts)
        if "撰写学术论文章节" in prompt:
            return MOCK_CHAPTER_CONTENT

        return "mock fallback response"

    llm.complete = MagicMock(side_effect=smart_complete)
    return llm


def _make_compiler(success=True, pdf_data=b"%PDF-mock", error=None):
    compiler = MagicMock()
    compiler.compile = MagicMock(
        return_value=CompileResult(success=success, pdf_data=pdf_data, error=error)
    )
    return compiler


@patch("models.db", new_callable=MagicMock, create=True)
@patch("services.paper.persist.persist_session")
def _collect(service, mock_persist, mock_db, user_id="u1", topic="Transformer综述"):
    """Run generate() and return (events, session_id)."""
    events = list(service.generate(user_id, topic))
    session_id = events[0]["session_id"] if events else None
    return events, session_id


# ===========================================================================
# Test 1: Complete flow (topic → PDF)
# ===========================================================================


class TestCompleteFlow:
    """完整流程：topic → 4 agents → compile → completed"""

    def _run(self):
        service = PaperService(_make_smart_llm(), MagicMock())
        service.compiler = _make_compiler()
        events, sid = _collect(service)
        session = SessionManager.get(sid)
        return events, session

    def test_session_created_first(self):
        events, _ = self._run()
        assert events[0]["type"] == "session_created"

    def test_completed_last(self):
        events, _ = self._run()
        assert events[-1]["type"] == "completed"

    def test_progress_events_emitted(self):
        events, _ = self._run()
        progress = [e for e in events if e["type"] == "progress"]
        assert len(progress) >= 4  # at least one per agent stage + compiling

    def test_session_literature_populated(self):
        _, session = self._run()
        assert len(session.literature) == 2
        assert session.literature[0]["title"] == "Attention Is All You Need"

    def test_session_file_plan_populated(self):
        _, session = self._run()
        assert "title" in session.file_plan
        assert "chapters/01_intro.tex" in session.file_plan.get("outline", {})

    def test_session_content_populated(self):
        _, session = self._run()
        assert "chapters/01_intro.tex" in session.content

    def test_session_vfs_populated(self):
        _, session = self._run()
        files = session.vfs.list_files()
        assert "main.tex" in files
        assert "refs.bib" in files


# ===========================================================================
# Test 2: Compile failure scenario
# ===========================================================================


class TestCompileFailure:
    """编译失败：agents 正常完成，compiler 返回失败"""

    def _run(self):
        service = PaperService(_make_smart_llm(), MagicMock())
        service.compiler = _make_compiler(
            success=False, pdf_data=None, error="Missing \\end{document}"
        )
        events, sid = _collect(service)
        session = SessionManager.get(sid)
        return events, session

    def test_error_event_emitted(self):
        events, _ = self._run()
        errors = [e for e in events if e["type"] == "error"]
        assert len(errors) == 1
        assert "编译失败" in errors[0]["message"]

    def test_no_completed_event(self):
        events, _ = self._run()
        completed = [e for e in events if e["type"] == "completed"]
        assert len(completed) == 0

    def test_session_status_failed(self):
        _, session = self._run()
        assert session.status == PaperStatus.FAILED


# ===========================================================================
# Test 3: LLM call failure scenario
# ===========================================================================


class TestLLMFailure:
    """LLM 调用失败：第一次 complete() 就抛异常，pipeline 应立即停止"""

    def _run(self):
        llm = MagicMock()
        llm.complete = MagicMock(side_effect=RuntimeError("API timeout"))

        service = PaperService(llm, MagicMock())
        service.compiler = _make_compiler()
        events, sid = _collect(service)
        session = SessionManager.get(sid)
        return events, session

    def test_error_event_emitted(self):
        events, _ = self._run()
        errors = [e for e in events if e["type"] == "error"]
        assert len(errors) == 1
        assert "API timeout" in errors[0]["message"]

    def test_session_status_failed(self):
        _, session = self._run()
        assert session.status == PaperStatus.FAILED

    def test_pipeline_stops(self):
        """No completed event and no subsequent agent stages after failure."""
        events, _ = self._run()
        completed = [e for e in events if e["type"] == "completed"]
        assert len(completed) == 0
        # Should only see researching stage (where failure happens), not planning/writing/formatting
        stages = {e.get("stage") for e in events if e["type"] == "progress"}
        assert "planning" not in stages
        assert "writing" not in stages
        assert "formatting" not in stages
