"""Session / SessionManager 测试"""

from services.paper.session import PaperSession, PaperStatus, SessionManager


class TestPaperSession:
    def test_defaults(self):
        s = PaperSession(id="abc", user_id="u1", topic="test")
        assert s.status == PaperStatus.PENDING
        assert s.vfs is not None
        assert s.literature == []
        assert s.content == {}
        assert s.embedding_index is not None

    def test_status_values(self):
        assert PaperStatus.PENDING.value == "pending"
        assert PaperStatus.COMPLETED.value == "completed"
        assert PaperStatus.FAILED.value == "failed"
        assert PaperStatus.RESEARCHING.value == "researching"
        assert PaperStatus.PLANNING.value == "planning"
        assert PaperStatus.WRITING.value == "writing"
        assert PaperStatus.FORMATTING.value == "formatting"
        assert PaperStatus.COMPILING.value == "compiling"


class TestSessionManager:
    def setup_method(self):
        SessionManager._sessions.clear()

    def test_create_and_get(self):
        s = SessionManager.create("u1", "topic1")
        assert s.user_id == "u1"
        assert s.topic == "topic1"
        got = SessionManager.get(s.id)
        assert got is s

    def test_get_nonexistent(self):
        assert SessionManager.get("nonexistent") is None

    def test_update_status(self):
        s = SessionManager.create("u1", "t")
        SessionManager.update_status(s.id, PaperStatus.WRITING, "writing ch1")
        assert s.status == PaperStatus.WRITING
        assert s.progress_detail == "writing ch1"

    def test_update_status_nonexistent(self):
        SessionManager.update_status("nope", PaperStatus.FAILED, "err")

    def test_delete(self):
        s = SessionManager.create("u1", "t")
        assert SessionManager.delete(s.id) is True
        assert SessionManager.get(s.id) is None
        assert SessionManager.delete(s.id) is False
