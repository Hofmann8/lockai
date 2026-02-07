"""
Paper Generation API 路由单元测试
测试 POST /api/paper/generate, GET /api/paper/<id>/status,
GET /api/paper/<id>/download, GET /api/papers
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from app import app
from models import db, PaperRecord


@pytest.fixture
def client():
    """Create a Flask test client with in-memory SQLite database."""
    app.config["TESTING"] = True
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"
    with app.app_context():
        db.create_all()
        yield app.test_client()
        db.session.remove()
        db.drop_all()


# ============ POST /api/paper/generate ============


def test_paper_generate_empty_body(client):
    """Empty request body should return 400."""
    resp = client.post("/api/paper/generate", content_type="application/json")
    assert resp.status_code == 400


def test_paper_generate_missing_topic(client):
    """Missing topic field should return 400."""
    resp = client.post(
        "/api/paper/generate",
        data=json.dumps({"user_id": "u1"}),
        content_type="application/json",
    )
    assert resp.status_code == 400
    data = resp.get_json()
    assert "研究主题不能为空" in data["error"]


def test_paper_generate_blank_topic(client):
    """Blank/whitespace-only topic should return 400."""
    resp = client.post(
        "/api/paper/generate",
        data=json.dumps({"topic": "   "}),
        content_type="application/json",
    )
    assert resp.status_code == 400
    data = resp.get_json()
    assert "研究主题不能为空" in data["error"]


def test_paper_generate_non_string_topic(client):
    """Non-string topic should return 400."""
    resp = client.post(
        "/api/paper/generate",
        data=json.dumps({"topic": 123}),
        content_type="application/json",
    )
    assert resp.status_code == 400


@patch("app.paper_service")
def test_paper_generate_returns_sse_stream(mock_service, client):
    """Valid request should return SSE event stream."""
    mock_service.generate.return_value = iter([
        {"type": "session_created", "session_id": "abc123"},
        {"type": "progress", "stage": "researching", "detail": "正在检索..."},
        {"type": "completed", "pdf_url": "https://example.com/paper.pdf", "session_id": "abc123"},
    ])

    resp = client.post(
        "/api/paper/generate",
        data=json.dumps({"topic": "深度学习综述", "user_id": "user-1"}),
        content_type="application/json",
    )

    assert resp.status_code == 200
    assert "text/event-stream" in resp.content_type
    assert resp.headers.get("Cache-Control") == "no-cache"

    body = resp.data.decode("utf-8")
    assert "event: session_created" in body
    assert "event: progress" in body
    assert "event: completed" in body
    assert "abc123" in body


@patch("app.paper_service")
def test_paper_generate_default_user_id(mock_service, client):
    """When user_id is not provided, default to 'anonymous'."""
    mock_service.generate.return_value = iter([
        {"type": "session_created", "session_id": "s1"},
    ])

    client.post(
        "/api/paper/generate",
        data=json.dumps({"topic": "测试主题"}),
        content_type="application/json",
    )

    mock_service.generate.assert_called_once_with("anonymous", "测试主题")


@patch("app.paper_service")
def test_paper_generate_strips_topic(mock_service, client):
    """Topic should be stripped of leading/trailing whitespace."""
    mock_service.generate.return_value = iter([
        {"type": "session_created", "session_id": "s1"},
    ])

    client.post(
        "/api/paper/generate",
        data=json.dumps({"topic": "  深度学习  ", "user_id": "u1"}),
        content_type="application/json",
    )

    mock_service.generate.assert_called_once_with("u1", "深度学习")


@patch("app.paper_service")
def test_paper_generate_chinese_characters_in_sse(mock_service, client):
    """Chinese characters should be preserved in SSE output (ensure_ascii=False)."""
    mock_service.generate.return_value = iter([
        {"type": "progress", "stage": "writing", "detail": "撰写第 1/6 章: 引言"},
    ])

    resp = client.post(
        "/api/paper/generate",
        data=json.dumps({"topic": "测试"}),
        content_type="application/json",
    )

    body = resp.data.decode("utf-8")
    assert "撰写第 1/6 章: 引言" in body


# ============ GET /api/paper/<paper_id>/status ============


@patch("app.SessionManager")
def test_paper_status_from_memory(mock_sm, client):
    """When session exists in memory, return its status."""
    mock_session = MagicMock()
    mock_session.id = "sess-1"
    mock_session.topic = "AI综述"
    mock_session.status.value = "writing"
    mock_session.progress_detail = "撰写第 2/6 章"
    mock_session.pdf_url = None
    mock_sm.get.return_value = mock_session

    resp = client.get("/api/paper/sess-1/status")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["id"] == "sess-1"
    assert data["status"] == "writing"
    assert data["topic"] == "AI综述"
    assert data["progress_detail"] == "撰写第 2/6 章"


def test_paper_status_from_database(client):
    """When session is not in memory, fall back to database."""
    with app.app_context():
        record = PaperRecord(
            id="db-paper-1",
            user_id="u1",
            topic="数据库论文",
            status="completed",
            pdf_url="https://example.com/paper.pdf",
        )
        db.session.add(record)
        db.session.commit()

    resp = client.get("/api/paper/db-paper-1/status")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["id"] == "db-paper-1"
    assert data["status"] == "completed"


@patch("app.SessionManager")
def test_paper_status_marks_orphan_in_progress_as_failed(mock_sm, client):
    """DB in-progress record without in-memory session should be marked as failed."""
    mock_sm.get.return_value = None

    with app.app_context():
        record = PaperRecord(
            id="db-paper-stuck-1",
            user_id="u1",
            topic="中断任务",
            status="writing",
        )
        db.session.add(record)
        db.session.commit()

    resp = client.get("/api/paper/db-paper-stuck-1/status")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["status"] == "failed"
    assert "任务已中断" in data["error"]

    with app.app_context():
        refreshed = PaperRecord.query.get("db-paper-stuck-1")
        assert refreshed.status == "failed"


@patch("app.SessionManager")
def test_paper_status_not_found(mock_sm, client):
    """Non-existent paper should return 404."""
    mock_sm.get.return_value = None

    resp = client.get("/api/paper/nonexistent/status")
    assert resp.status_code == 404
    data = resp.get_json()
    assert "论文不存在" in data["error"]


# ============ GET /api/paper/<paper_id>/download ============


def test_paper_download_success(client):
    """Should return pdf_url for a completed paper."""
    with app.app_context():
        record = PaperRecord(
            id="dl-paper-1",
            user_id="u1",
            topic="下载测试",
            status="completed",
            pdf_url="https://s3.example.com/paper.pdf",
        )
        db.session.add(record)
        db.session.commit()

    resp = client.get("/api/paper/dl-paper-1/download")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["pdf_url"] == "https://s3.example.com/paper.pdf"


def test_paper_download_not_found(client):
    """Non-existent paper should return 404."""
    resp = client.get("/api/paper/nonexistent/download")
    assert resp.status_code == 404
    data = resp.get_json()
    assert "论文不存在" in data["error"]


def test_paper_download_no_pdf(client):
    """Paper without pdf_url should return 404."""
    with app.app_context():
        record = PaperRecord(
            id="no-pdf-1",
            user_id="u1",
            topic="未完成论文",
            status="writing",
        )
        db.session.add(record)
        db.session.commit()

    resp = client.get("/api/paper/no-pdf-1/download")
    assert resp.status_code == 404
    data = resp.get_json()
    assert "PDF 尚未生成" in data["error"]


# ============ GET /api/papers ============


def test_list_papers_missing_user_id(client):
    """Missing user_id should return 400."""
    resp = client.get("/api/papers")
    assert resp.status_code == 400
    data = resp.get_json()
    assert "缺少 user_id" in data["error"]


def test_list_papers_empty(client):
    """User with no papers should return empty list."""
    resp = client.get("/api/papers?user_id=u-empty")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data == []


def test_list_papers_returns_user_papers(client):
    """Should return papers for the specified user."""
    with app.app_context():
        for i in range(3):
            record = PaperRecord(
                id=f"paper-{i}",
                user_id="u-list",
                topic=f"论文主题 {i}",
                status="completed",
                pdf_url=f"https://example.com/paper-{i}.pdf",
            )
            db.session.add(record)
        # Add a paper for a different user
        other = PaperRecord(
            id="other-paper",
            user_id="u-other",
            topic="其他用户论文",
            status="completed",
        )
        db.session.add(other)
        db.session.commit()

    resp = client.get("/api/papers?user_id=u-list")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) == 3
    assert all(p["id"].startswith("paper-") for p in data)


def test_list_papers_ordered_by_created_at_desc(client):
    """Papers should be ordered by created_at descending (newest first)."""
    from datetime import datetime, timedelta

    with app.app_context():
        base = datetime(2024, 1, 1)
        for i in range(3):
            record = PaperRecord(
                id=f"ordered-{i}",
                user_id="u-order",
                topic=f"论文 {i}",
                status="completed",
                created_at=base + timedelta(days=i),
            )
            db.session.add(record)
        db.session.commit()

    resp = client.get("/api/papers?user_id=u-order")
    data = resp.get_json()
    # Newest first: ordered-2, ordered-1, ordered-0
    assert data[0]["id"] == "ordered-2"
    assert data[-1]["id"] == "ordered-0"
