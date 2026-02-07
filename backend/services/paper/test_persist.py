"""
persist.py 单元测试 — persist_session + restore_session
"""

import gzip
import json
from unittest.mock import MagicMock, patch

from .persist import persist_session, restore_session
from .session import PaperSession, PaperStatus
from .vfs import VirtualFileSystem


# --- Helpers ---


def _make_session(
    session_id="paper-001",
    user_id="user-001",
    topic="测试主题",
    status=PaperStatus.COMPLETED,
):
    session = PaperSession(id=session_id, user_id=user_id, topic=topic, status=status)
    session.pdf_data = b"%PDF-test-data"
    session.vfs.write("main.tex", "\\documentclass{article}")
    session.vfs.write("chapters/01_intro.tex", "Introduction content")
    session.file_plan = {"title": "测试论文", "files": {"main.tex": "入口"}}
    return session


def _make_storage(upload_url="https://s3.example.com"):
    storage = MagicMock()
    storage.upload_bytes = MagicMock(
        side_effect=lambda data, key, ct="": {"url": f"{upload_url}/{key}", "s3_key": key}
    )
    storage.upload_pdf = MagicMock(
        side_effect=lambda data, key: {"url": f"{upload_url}/{key}", "s3_key": key}
    )
    storage.download_bytes = MagicMock(return_value=None)
    return storage


def _make_db():
    db = MagicMock()
    db.session.add = MagicMock()
    db.session.commit = MagicMock()
    return db


def _make_paper_record(
    paper_id="paper-001",
    user_id="user-001",
    topic="测试主题",
    status="completed",
    has_vfs=False,
    pdf_url="https://s3.example.com/paper.pdf",
):
    record = MagicMock()
    record.id = paper_id
    record.user_id = user_id
    record.topic = topic
    record.status = status
    record.vfs_s3_key = f"users/{user_id}/papers/{paper_id}/vfs.json.gz" if has_vfs else None
    record.pdf_s3_key = f"users/{user_id}/papers/{paper_id}/paper.pdf"
    record.pdf_url = pdf_url
    record.outline_json = json.dumps({"title": "测试论文"}, ensure_ascii=False)
    return record


# --- persist_session ---


@patch("models.PaperRecord", create=True)
def test_persist_session_uploads_pdf(MockPaperRecord):
    session = _make_session()
    storage = _make_storage()
    db = _make_db()

    persist_session(session, storage, db)

    storage.upload_pdf.assert_called_once()
    call_args = storage.upload_pdf.call_args
    assert call_args[0][0] == b"%PDF-test-data"
    assert "paper.pdf" in call_args[0][1]


@patch("models.PaperRecord", create=True)
def test_persist_session_uploads_vfs_gzip(MockPaperRecord):
    session = _make_session()
    storage = _make_storage()
    db = _make_db()

    persist_session(session, storage, db)

    storage.upload_bytes.assert_called_once()
    call_args = storage.upload_bytes.call_args
    # Verify it's gzip data that decompresses to VFS JSON
    gz_data = call_args[0][0]
    decompressed = gzip.decompress(gz_data).decode("utf-8")
    vfs_dict = json.loads(decompressed)
    assert "main.tex" in vfs_dict
    assert "chapters/01_intro.tex" in vfs_dict
    # Verify content type
    assert call_args[0][2] == "application/gzip"


@patch("models.PaperRecord", create=True)
def test_persist_session_sets_s3_keys_on_session(MockPaperRecord):
    session = _make_session()
    storage = _make_storage()
    db = _make_db()

    persist_session(session, storage, db)

    assert session.pdf_s3_key is not None
    assert "paper.pdf" in session.pdf_s3_key
    assert session.vfs_s3_key is not None
    assert "vfs.json.gz" in session.vfs_s3_key
    assert session.pdf_url is not None


@patch("models.PaperRecord", create=True)
def test_persist_session_writes_db_record(MockPaperRecord):
    session = _make_session()
    storage = _make_storage()
    db = _make_db()

    persist_session(session, storage, db)

    MockPaperRecord.assert_called_once()
    kwargs = MockPaperRecord.call_args[1]
    assert kwargs["id"] == "paper-001"
    assert kwargs["user_id"] == "user-001"
    assert kwargs["topic"] == "测试主题"
    assert kwargs["status"] == "completed"
    db.session.add.assert_called_once()
    db.session.commit.assert_called_once()


@patch("models.PaperRecord", create=True)
def test_persist_session_s3_key_path_format(MockPaperRecord):
    session = _make_session(session_id="abc123", user_id="user-42")
    storage = _make_storage()
    db = _make_db()

    persist_session(session, storage, db)

    pdf_key = storage.upload_pdf.call_args[0][1]
    assert pdf_key == "users/user-42/papers/abc123/paper.pdf"

    vfs_key = storage.upload_bytes.call_args[0][1]
    assert vfs_key == "users/user-42/papers/abc123/vfs.json.gz"


@patch("models.PaperRecord", create=True)
def test_persist_session_handles_storage_unavailable(MockPaperRecord):
    """When storage returns None (unavailable), pdf_url should be None."""
    session = _make_session()
    storage = MagicMock()
    storage.upload_pdf = MagicMock(return_value=None)
    storage.upload_bytes = MagicMock(return_value=None)
    db = _make_db()

    persist_session(session, storage, db)

    assert session.pdf_url is None


# --- restore_session ---


@patch("models.PaperRecord", create=True)
def test_restore_session_returns_none_for_missing_record(MockPaperRecord):
    storage = _make_storage()
    db = _make_db()
    MockPaperRecord.query.get.return_value = None

    result = restore_session("nonexistent", storage, db)

    assert result is None


@patch("models.PaperRecord", create=True)
def test_restore_session_restores_basic_fields(MockPaperRecord):
    record = _make_paper_record()
    MockPaperRecord.query.get.return_value = record
    storage = _make_storage()
    db = _make_db()

    session = restore_session("paper-001", storage, db)

    assert session.id == "paper-001"
    assert session.user_id == "user-001"
    assert session.topic == "测试主题"
    assert session.status == PaperStatus.COMPLETED
    assert session.pdf_url == "https://s3.example.com/paper.pdf"


@patch("models.PaperRecord", create=True)
def test_restore_session_restores_vfs_from_s3(MockPaperRecord):
    vfs = VirtualFileSystem()
    vfs.write("main.tex", "\\documentclass{article}")
    vfs.write("chapters/01.tex", "Chapter 1")
    vfs_gz = gzip.compress(vfs.serialize().encode("utf-8"))

    record = _make_paper_record(has_vfs=True)
    MockPaperRecord.query.get.return_value = record
    storage = _make_storage()
    storage.download_bytes = MagicMock(return_value=vfs_gz)
    db = _make_db()

    session = restore_session("paper-001", storage, db)

    assert session.vfs.read("main.tex") == "\\documentclass{article}"
    assert session.vfs.read("chapters/01.tex") == "Chapter 1"


@patch("models.PaperRecord", create=True)
def test_restore_session_empty_vfs_when_no_s3_key(MockPaperRecord):
    record = _make_paper_record()
    record.vfs_s3_key = None
    MockPaperRecord.query.get.return_value = record
    storage = _make_storage()
    db = _make_db()

    session = restore_session("paper-001", storage, db)

    assert session.vfs.list_files() == []


@patch("models.PaperRecord", create=True)
def test_restore_session_empty_vfs_when_download_fails(MockPaperRecord):
    record = _make_paper_record(has_vfs=True)
    MockPaperRecord.query.get.return_value = record
    storage = _make_storage()
    storage.download_bytes = MagicMock(return_value=None)
    db = _make_db()

    session = restore_session("paper-001", storage, db)

    assert session.vfs.list_files() == []


@patch("models.PaperRecord", create=True)
def test_restore_session_restores_file_plan(MockPaperRecord):
    record = _make_paper_record()
    record.outline_json = json.dumps({"title": "恢复的论文", "files": {"main.tex": "入口"}})
    MockPaperRecord.query.get.return_value = record
    storage = _make_storage()
    db = _make_db()

    session = restore_session("paper-001", storage, db)

    assert session.file_plan["title"] == "恢复的论文"


@patch("models.PaperRecord", create=True)
def test_restore_session_empty_file_plan_when_no_outline(MockPaperRecord):
    record = _make_paper_record()
    record.outline_json = None
    MockPaperRecord.query.get.return_value = record
    storage = _make_storage()
    db = _make_db()

    session = restore_session("paper-001", storage, db)

    assert session.file_plan == {}
