"""
PaperService 单元测试
"""

from unittest.mock import MagicMock, patch

from .service import PaperService
from .session import PaperSession, PaperStatus, SessionManager
from .latex import CompileResult


# --- Helpers ---


def _make_llm():
    llm = MagicMock()
    llm.complete = MagicMock(return_value="mock response")
    return llm


def _make_storage():
    return MagicMock()


def _make_compiler(success=True, pdf_data=b"%PDF-mock", error=None):
    compiler = MagicMock()
    compiler.compile = MagicMock(
        return_value=CompileResult(success=success, pdf_data=pdf_data, error=error)
    )
    return compiler


@patch("models.db", new_callable=MagicMock, create=True)
@patch("services.paper.persist.persist_session")
def _collect_events(service, mock_persist, mock_db, user_id="user-001", topic="测试主题"):
    """Run generate() and collect all events into a list."""
    return list(service.generate(user_id, topic))


# --- 正常流程 ---


def test_generate_yields_session_created_first():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    events = _collect_events(service)

    assert events[0]["type"] == "session_created"
    assert "session_id" in events[0]


def test_generate_yields_completed_last_on_success():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    events = _collect_events(service)

    assert events[-1]["type"] == "completed"
    assert "session_id" in events[-1]


def test_generate_yields_progress_events():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    events = _collect_events(service)

    progress_events = [e for e in events if e["type"] == "progress"]
    assert len(progress_events) >= 1  # At least the compiling progress


def test_generate_forwards_agent_progress_events():
    """Agent progress events should be forwarded to the caller."""
    llm = _make_llm()
    service = PaperService(llm, _make_storage())
    service.compiler = _make_compiler()

    # Mock agents to yield known progress events
    def mock_agent_run(session):
        yield {"type": "progress", "stage": "test", "detail": "agent progress"}
        yield {"type": "result", "data": "done"}

    service.researcher.run = mock_agent_run
    service.planner.run = mock_agent_run
    service.writer.run = mock_agent_run
    service.formatter.run = mock_agent_run

    events = _collect_events(service)

    agent_progress = [e for e in events if e.get("detail") == "agent progress"]
    assert len(agent_progress) == 4  # One from each agent


def test_generate_syncs_session_progress_detail_with_last_progress_event():
    """Session.progress_detail should track the latest yielded progress detail."""
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    def mock_agent_run(session):
        yield {"type": "progress", "stage": "test", "detail": "agent progress"}
        yield {"type": "result", "data": "done"}

    service.researcher.run = mock_agent_run
    service.planner.run = mock_agent_run
    service.writer.run = mock_agent_run
    service.formatter.run = mock_agent_run

    events = _collect_events(service)

    session_id = events[0]["session_id"]
    session = SessionManager.get(session_id)
    last_detail = [e["detail"] for e in events if e["type"] == "progress" and e.get("detail")][-1]
    assert session.progress_detail == last_detail


def test_generate_does_not_forward_result_events():
    """Agent result events should NOT be forwarded."""
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    def mock_agent_run(session):
        yield {"type": "progress", "stage": "test", "detail": "ok"}
        yield {"type": "result", "data": "internal"}

    service.researcher.run = mock_agent_run
    service.planner.run = mock_agent_run
    service.writer.run = mock_agent_run
    service.formatter.run = mock_agent_run

    events = _collect_events(service)

    result_events = [e for e in events if e["type"] == "result"]
    assert len(result_events) == 0


def test_generate_compiling_progress_event():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    # Use no-op agents to simplify
    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    events = _collect_events(service)

    compiling_events = [
        e for e in events if e["type"] == "progress" and e.get("stage") == "compiling"
    ]
    assert len(compiling_events) == 2  # "正在编译 PDF..." + "正在保存..."


def test_generate_calls_compiler_with_vfs_files():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    def formatter_writes_vfs(session):
        session.vfs.write("main.tex", "\\documentclass{article}")
        yield {"type": "result", "data": None}

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = formatter_writes_vfs

    _collect_events(service)

    service.compiler.compile.assert_called_once()
    files_arg = service.compiler.compile.call_args[0][0]
    assert "main.tex" in files_arg
    assert files_arg["main.tex"] == "\\documentclass{article}"


def test_generate_stores_pdf_data_on_session():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler(pdf_data=b"%PDF-test-data")

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    events = _collect_events(service)

    session_id = events[0]["session_id"]
    session = SessionManager.get(session_id)
    assert session.pdf_data == b"%PDF-test-data"
    assert session.status == PaperStatus.COMPLETED


# --- Session 状态更新 ---


def test_generate_updates_session_status_through_pipeline():
    """Session status should progress through all pipeline stages."""
    status_history = []
    original_update = SessionManager.update_status

    @classmethod
    def tracking_update(cls, session_id, status, detail=""):
        status_history.append(status)
        original_update(session_id, status, detail)

    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    with patch.object(SessionManager, "update_status", tracking_update):
        _collect_events(service)

    assert PaperStatus.RESEARCHING in status_history
    assert PaperStatus.PLANNING in status_history
    assert PaperStatus.WRITING in status_history
    assert PaperStatus.FORMATTING in status_history
    assert PaperStatus.COMPILING in status_history
    assert PaperStatus.COMPLETED in status_history


# --- 编译失败 ---


def test_generate_yields_error_on_compile_failure():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler(success=False, pdf_data=None, error="Missing \\end{document}")

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    events = _collect_events(service)

    assert events[-1]["type"] == "error"
    assert "编译失败" in events[-1]["message"]
    assert "session_id" in events[-1]


def test_generate_sets_failed_status_on_compile_failure():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler(success=False, error="bad tex")

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    events = _collect_events(service)

    session_id = events[0]["session_id"]
    session = SessionManager.get(session_id)
    assert session.status == PaperStatus.FAILED
    assert "编译失败" in session.error


def test_generate_no_completed_event_on_compile_failure():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler(success=False, error="error")

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    events = _collect_events(service)

    completed_events = [e for e in events if e["type"] == "completed"]
    assert len(completed_events) == 0


# --- Agent 异常 ---


def test_generate_yields_error_on_agent_exception():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    def failing_agent(session):
        raise RuntimeError("LLM API timeout")
        yield  # noqa: unreachable — makes it a generator

    service.researcher.run = failing_agent

    events = _collect_events(service)

    assert events[-1]["type"] == "error"
    assert "researching" in events[-1]["message"]
    assert "LLM API timeout" in events[-1]["message"]


def test_generate_sets_failed_status_on_agent_exception():
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    def failing_agent(session):
        raise ValueError("bad data")
        yield  # noqa

    service.planner.run = failing_agent

    # Researcher needs to succeed first
    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent

    events = _collect_events(service)

    session_id = events[0]["session_id"]
    session = SessionManager.get(session_id)
    assert session.status == PaperStatus.FAILED
    assert "planning" in session.error


def test_generate_stops_pipeline_on_agent_failure():
    """If an agent fails, subsequent agents should NOT run."""
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()

    writer_called = False

    def failing_planner(session):
        raise RuntimeError("planner failed")
        yield  # noqa

    def tracking_writer(session):
        nonlocal writer_called
        writer_called = True
        yield {"type": "result", "data": None}

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = failing_planner
    service.writer.run = tracking_writer
    service.formatter.run = noop_agent

    _collect_events(service)

    assert not writer_called


def test_generate_yields_error_on_compiler_exception():
    """If compiler.compile() raises an exception (not just returns failure)."""
    service = PaperService(_make_llm(), _make_storage())
    service.compiler = MagicMock()
    service.compiler.compile = MagicMock(side_effect=OSError("xelatex not found"))

    def noop_agent(session):
        yield {"type": "result", "data": None}

    service.researcher.run = noop_agent
    service.planner.run = noop_agent
    service.writer.run = noop_agent
    service.formatter.run = noop_agent

    events = _collect_events(service)

    assert events[-1]["type"] == "error"
    assert "编译异常" in events[-1]["message"]
    assert "xelatex not found" in events[-1]["message"]


# --- Pipeline 顺序 ---


def test_agents_run_in_correct_order():
    """Agents should run in order: researcher → planner → writer → formatter."""
    call_order = []

    def make_tracking_agent(name):
        def agent_run(session):
            call_order.append(name)
            yield {"type": "result", "data": None}
        return agent_run

    service = PaperService(_make_llm(), _make_storage())
    service.compiler = _make_compiler()
    service.researcher.run = make_tracking_agent("researcher")
    service.planner.run = make_tracking_agent("planner")
    service.writer.run = make_tracking_agent("writer")
    service.formatter.run = make_tracking_agent("formatter")

    _collect_events(service)

    assert call_order == ["researcher", "planner", "writer", "formatter"]
