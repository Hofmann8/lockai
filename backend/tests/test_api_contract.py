"""HTTP 契约测试：覆盖前端实际调用的每一条路由。

这套测试只看"前端能观察到的行为"：状态码、JSON 结构、错误信息里的 error 字段、SSE 帧格式、CORS。
框架从 Flask 换到 FastAPI 时，同一套测试必须原样通过，才算行为没变。
不打任何外部服务：聊天、标题、规划对话的上游调用都在这里替换成桩。
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import tempfile
import types
import uuid

import pytest


# ------------------------------------------------------------------
# 夹具：用临时 SQLite 起一个真实 app，并把 Flask / FastAPI 的测试客户端抹平
# ------------------------------------------------------------------

class _Resp:
    def __init__(self, status: int, headers, body: bytes):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8"))

    @property
    def text(self) -> str:
        return self.body.decode("utf-8")


class _Client:
    """同一套调用方式，底下接 Flask test_client 或 Starlette TestClient。"""

    def __init__(self, app):
        self._flask = hasattr(app, "test_client")
        if self._flask:
            self._c = app.test_client()
        else:
            from fastapi.testclient import TestClient
            self._c = TestClient(app)

    def call(self, method, path, *, json_body=None, content=None, params=None, headers=None, files=None, data=None):
        headers = dict(headers or {})
        if self._flask:
            kwargs = {"method": method, "headers": headers, "query_string": params}
            if json_body is not None:
                kwargs["json"] = json_body
            elif files is not None:
                import io
                kwargs["data"] = {**(data or {}), **{k: (io.BytesIO(v[1]), v[0]) for k, v in files.items()}}
                kwargs["content_type"] = "multipart/form-data"
            elif content is not None:
                kwargs["data"] = content
            r = self._c.open(path, **kwargs)
            return _Resp(r.status_code, r.headers, r.get_data())
        kwargs = {"headers": headers, "params": params}
        if json_body is not None:
            kwargs["json"] = json_body
        elif files is not None:
            kwargs["files"] = files
            if data:
                kwargs["data"] = data
        elif content is not None:
            kwargs["content"] = content
        r = self._c.request(method, path, **kwargs)
        return _Resp(r.status_code, r.headers, r.content)

    def get(self, path, **kw):
        return self.call("GET", path, **kw)

    def post(self, path, **kw):
        return self.call("POST", path, **kw)

    def put(self, path, **kw):
        return self.call("PUT", path, **kw)

    def delete(self, path, **kw):
        return self.call("DELETE", path, **kw)

    def options(self, path, **kw):
        return self.call("OPTIONS", path, **kw)


@pytest.fixture(scope="module")
def app_module():
    db_path = os.path.join(tempfile.mkdtemp(prefix="lockai_contract_"), "contract.db")
    os.environ["DATABASE_URL"] = "sqlite:///" + db_path.replace("\\", "/")
    for name in ("app", "asgi", "dev_routes"):
        sys.modules.pop(name, None)
    module = importlib.import_module("app")
    yield module
    os.environ.pop("DATABASE_URL", None)


@pytest.fixture(scope="module")
def client(app_module):
    return _Client(app_module.app)


def _uid() -> str:
    return f"contract-{uuid.uuid4().hex[:8]}"


def _sse_frames(text: str) -> list[str]:
    return [frame for frame in text.split("\n\n") if frame.strip()]


# ------------------------------------------------------------------
# 基础
# ------------------------------------------------------------------

def test_health(client):
    r = client.get("/health")
    assert r.status == 200
    assert r.json() == {"status": "ok"}


def test_models_lists_visible_chat_models(client):
    r = client.get("/api/models")
    assert r.status == 200
    ids = [m["id"] for m in r.json()["models"]]
    assert ids == ["campbell", "scooby"]


def test_usage_requires_user_id(client):
    r = client.get("/api/usage")
    assert r.status == 400
    assert r.json()["error"] == "缺少 user_id"


def test_usage_summary_shape(client):
    r = client.get("/api/usage", params={"user_id": _uid()})
    assert r.status == 200
    body = r.json()
    assert {"today", "month", "limits"} <= set(body)
    assert body["today"]["credits"] == 0


def test_cors_allows_dev_origin_only(client):
    ok = client.options(
        "/api/models",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"},
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3000"
    bad = client.options(
        "/api/models",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert bad.headers.get("access-control-allow-origin") is None


# ------------------------------------------------------------------
# 会话
# ------------------------------------------------------------------

def test_session_list_requires_user_id(client):
    r = client.get("/api/sessions")
    assert r.status == 400
    assert r.json()["error"] == "缺少 user_id"


def test_session_create_requires_user_id(client):
    r = client.post("/api/sessions", json_body={})
    assert r.status == 400
    assert r.json()["error"] == "缺少 user_id"


def test_session_lifecycle(client):
    uid = _uid()
    created = client.post("/api/sessions", json_body={"user_id": uid, "model_id": "leo"})
    assert created.status == 201
    session = created.json()
    assert session["model_id"] == "scooby"  # Leo 下线后归并到 Scooby
    assert session["title"] == "新对话"
    sid = session["id"]

    listed = client.get("/api/sessions", params={"user_id": uid})
    assert listed.status == 200
    assert [s["id"] for s in listed.json()] == [sid]

    updated = client.put(f"/api/sessions/{sid}", json_body={"title": "改过的标题", "model_id": "campbell"})
    assert updated.status == 200
    assert updated.json()["title"] == "改过的标题"
    assert updated.json()["model_id"] == "campbell"

    detail = client.get(f"/api/sessions/{sid}")
    assert detail.status == 200
    assert detail.json()["messages"] == []

    deleted = client.delete(f"/api/sessions/{sid}")
    assert deleted.status == 200
    assert deleted.json() == {"success": True}
    assert client.get(f"/api/sessions/{sid}").status == 404


def test_session_404s(client):
    missing = f"missing-{uuid.uuid4().hex}"
    for method, path in (
        ("GET", f"/api/sessions/{missing}"),
        ("PUT", f"/api/sessions/{missing}"),
        ("DELETE", f"/api/sessions/{missing}"),
        ("POST", f"/api/sessions/{missing}/messages"),
        ("POST", f"/api/sessions/{missing}/truncate"),
        ("POST", f"/api/sessions/{missing}/generate-title"),
    ):
        r = client.call(method, path, json_body={"role": "user", "content": "x", "message_id": "m", "user_message": "x"})
        assert r.status == 404, (method, path)
        assert r.json()["error"] == "会话不存在"


def test_messages_validation_and_truncate(client):
    uid = _uid()
    sid = client.post("/api/sessions", json_body={"user_id": uid}).json()["id"]

    no_role = client.post(f"/api/sessions/{sid}/messages", json_body={"content": "hi"})
    assert no_role.status == 400
    assert no_role.json()["error"] == "缺少 role"

    empty = client.post(f"/api/sessions/{sid}/messages", json_body={"role": "user", "content": "  "})
    assert empty.status == 400
    assert empty.json()["error"] == "消息内容不能为空"

    first = client.post(f"/api/sessions/{sid}/messages", json_body={"id": "m1", "role": "user", "content": "第一条"})
    assert first.status == 201
    assert first.json()["id"] == "m1"
    assert first.json()["content"] == "第一条"

    with_image = client.post(
        f"/api/sessions/{sid}/messages",
        json_body={"id": "m2", "role": "user", "content": "", "images": ["https://example.com/a.png"]},
    )
    assert with_image.status == 201
    assert with_image.json()["images"] == ["https://example.com/a.png"]

    dup = client.post(f"/api/sessions/{sid}/messages", json_body={"role": "assistant", "content": "回复"})
    assert dup.status == 201

    messages = client.get(f"/api/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in messages] == ["user", "user", "assistant"]

    missing_id = client.post(f"/api/sessions/{sid}/truncate", json_body={})
    assert missing_id.status == 400
    assert missing_id.json()["error"] == "缺少 message_id"

    wrong_id = client.post(f"/api/sessions/{sid}/truncate", json_body={"message_id": "nope"})
    assert wrong_id.status == 404
    assert wrong_id.json()["error"] == "消息不存在"

    ok = client.post(f"/api/sessions/{sid}/truncate", json_body={"message_id": "m2"})
    assert ok.status == 200
    assert ok.json() == {"success": True}
    remaining = client.get(f"/api/sessions/{sid}").json()["messages"]
    assert [m["id"] for m in remaining] == ["m1"]


def test_generate_title(client, app_module, monkeypatch):
    sid = client.post("/api/sessions", json_body={"user_id": _uid()}).json()["id"]

    missing = client.post(f"/api/sessions/{sid}/generate-title", json_body={})
    assert missing.status == 400
    assert missing.json()["error"] == "缺少消息内容"

    monkeypatch.setattr(app_module.ai_service, "generate_title", lambda user_message, assistant_message="": "街舞历史")
    r = client.post(f"/api/sessions/{sid}/generate-title", json_body={"user_message": "讲讲街舞历史"})
    assert r.status == 200
    assert r.json() == {"title": "街舞历史"}
    assert client.get(f"/api/sessions/{sid}").json()["title"] == "街舞历史"


def test_user_images_empty(client):
    r = client.get(f"/api/users/{_uid()}/images")
    assert r.status == 200
    assert r.json() == []


def test_upload_image_validation(client):
    empty = client.post("/api/upload-image", json_body={})
    assert empty.status == 400
    bad = client.post("/api/upload-image", json_body={"image": "not-a-data-url"})
    assert bad.status == 400
    assert bad.json()["error"] == "无效的图片数据"
    svg = client.post("/api/upload-image", json_body={"image": "data:image/svg+xml;base64,PHN2Zz4="})
    assert svg.status == 400
    big = "data:image/png;base64," + base64.b64encode(b"x" * (12 * 1024 * 1024 + 1)).decode()
    assert client.post("/api/upload-image", json_body={"image": big}).status == 413


class _FakeStorage:
    available = True
    bucket = "b"
    public_url = "https://b.example"

    def __init__(self):
        self.keys = []
        self._client = types.SimpleNamespace(upload_fileobj=lambda _f, _b, key, ExtraArgs=None: self.keys.append(key))


def test_upload_file_keeps_folder_path(client, app_module, monkeypatch):
    storage = _FakeStorage()
    monkeypatch.setattr(app_module, "storage_service", storage)
    r = client.post(
        "/api/upload-file",
        files={"file": ("a.jpg", b"jpg")},
        data={"user_id": "u1", "session_id": "s1", "path": "../活动照片/day1/a.jpg"},
    )
    assert r.status == 200
    body = r.json()
    assert body["name"] == "a.jpg" and body["path"] == "活动照片/day1/a.jpg"
    assert storage.keys[0].endswith("/活动照片/day1/a.jpg") and ".." not in storage.keys[0]

    plain = client.post("/api/upload-file", files={"file": ("b.pdf", b"pdf")}).json()
    assert "path" not in plain


def test_messages_keep_many_attachments_and_cap_images(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module, "storage_service", _FakeStorage())
    sid = client.post("/api/sessions", json_body={"user_id": _uid()}).json()["id"]
    files = [{"name": f"{i}.jpg", "path": f"照片/{i}.jpg", "url": f"https://b.example/u/{i}.jpg", "size": 1} for i in range(150)]
    images = [f"https://b.example/img{i}.png" for i in range(12)]
    r = client.post(f"/api/sessions/{sid}/messages", json_body={"role": "user", "content": "挑图", "files": files, "images": images})
    assert r.status == 201
    stored = client.get(f"/api/sessions/{sid}").json()["messages"][0]
    assert len(stored["files"]) == 150 and stored["files"][3]["path"] == "照片/3.jpg"
    assert len(stored["images"]) == 8


# ------------------------------------------------------------------
# 聊天
# ------------------------------------------------------------------

def test_chat_stream_validation(client):
    empty = client.post("/api/chat/stream", json_body={})
    assert empty.status == 400
    assert "error" in empty.json()
    blank = client.post("/api/chat/stream", json_body={"message": "   "})
    assert blank.status == 400
    assert blank.json()["error"] == "消息内容不能为空"


def test_chat_stream_sse_frames(client, app_module, monkeypatch):
    captured = {}

    def fake_stream(message, history, **kwargs):
        captured["message"] = message
        captured.update(kwargs)
        yield {"type": "message_start", "message_id": "a1"}
        yield {"type": "content_delta", "delta": "你好"}
        yield {"type": "message_end", "message_id": "a1"}

    monkeypatch.setattr(app_module.ai_service, "chat_stream", fake_stream)
    r = client.post(
        "/api/chat/stream",
        json_body={"message": "嗨", "model_id": "scooby", "user_id": "u1", "session_id": None, "thinking": False},
    )
    assert r.status == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers.get("x-accel-buffering") == "no"
    frames = _sse_frames(r.text)
    assert frames[-1] == "data: [DONE]"
    events = [json.loads(f[len("data: "):]) for f in frames[:-1] if f.startswith("data: ")]
    assert [e["type"] for e in events] == ["message_start", "content_delta", "message_end"]
    assert events[1]["delta"] == "你好"
    assert captured["message"] == "嗨"
    assert captured["model_id"] == "scooby"
    assert captured["thinking"] is False


def test_chat_stream_turns_exceptions_into_error_event(client, app_module, monkeypatch):
    def broken_stream(message, history, **kwargs):
        yield {"type": "message_start", "message_id": "a1"}
        raise RuntimeError("炸了")

    monkeypatch.setattr(app_module.ai_service, "chat_stream", broken_stream)
    r = client.post("/api/chat/stream", json_body={"message": "嗨"})
    frames = _sse_frames(r.text)
    assert frames[-1] == "data: [DONE]"
    last = json.loads(frames[-2][len("data: "):])
    assert last["type"] == "error"
    assert "RuntimeError" in last["message"]


def test_chat_non_stream(client, app_module, monkeypatch):
    def fake_stream(message, history, **kwargs):
        yield {"type": "content_delta", "delta": "一"}
        yield {"type": "content_delta", "delta": "二"}

    monkeypatch.setattr(app_module.ai_service, "chat_stream", fake_stream)
    r = client.post("/api/chat", json_body={"message": "数数"})
    assert r.status == 200
    assert r.json() == {"message": "一二"}

    bad = client.post("/api/chat", json_body={"message": ""})
    assert bad.status == 400
    assert bad.json()["code"] == "INVALID_REQUEST"


# ------------------------------------------------------------------
# 语音
# ------------------------------------------------------------------

def test_asr_missing_session_404(client):
    missing = uuid.uuid4().hex
    for method, path in (
        ("POST", f"/api/asr/sessions/{missing}/stop"),
        ("POST", f"/api/asr/sessions/{missing}/cancel"),
        ("GET", f"/api/asr/sessions/{missing}/stream"),
    ):
        r = client.call(method, path)
        assert r.status == 404, path
        assert r.json()["error"] == "语音会话不存在"
    audio = client.post(
        f"/api/asr/sessions/{missing}/audio",
        content=b"\x00\x01",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert audio.status == 404


def test_asr_transcribe_requires_file(client):
    r = client.post("/api/asr/transcribe", files={"other": ("a.txt", b"x")})
    assert r.status == 400
    assert r.json()["error"] == "缺少 audio 文件"


def test_asr_transcribe_rejects_empty_audio(client):
    r = client.post("/api/asr/transcribe", files={"audio": ("a.wav", b"")})
    assert r.status == 400
    assert r.json()["error"] == "音频内容不能为空"


# ------------------------------------------------------------------
# 论文板块已下线
# ------------------------------------------------------------------

def test_paper_and_dev_monitor_routes_are_gone(client):
    assert client.post("/api/paper/create", json_body={"topic": "x"}).status == 404
    assert client.get("/api/papers", params={"user_id": "u"}).status == 404
    assert client.get("/dev/papers").status == 404


# ------------------------------------------------------------------
# 0.9 新增：置顶、分支、思考过程、追问建议
# ------------------------------------------------------------------

def test_pin_sorts_first_without_bumping_recency(client):
    uid = _uid()
    older = client.post("/api/sessions", json_body={"user_id": uid, "title": "旧的"}).json()
    newer = client.post("/api/sessions", json_body={"user_id": uid, "title": "新的"}).json()
    before = client.get(f"/api/sessions/{older['id']}").json()["updated_at"]

    pinned = client.put(f"/api/sessions/{older['id']}", json_body={"pinned": True})
    assert pinned.status == 200
    assert pinned.json()["pinned"] is True
    assert pinned.json()["updated_at"] == before

    order = [s["id"] for s in client.get("/api/sessions", params={"user_id": uid}).json()]
    assert order == [older["id"], newer["id"]]

    client.put(f"/api/sessions/{older['id']}", json_body={"pinned": False})
    order = [s["id"] for s in client.get("/api/sessions", params={"user_id": uid}).json()]
    assert order == [newer["id"], older["id"]]


def test_reasoning_round_trips_through_messages(client):
    sid = client.post("/api/sessions", json_body={"user_id": _uid()}).json()["id"]
    r = client.post(
        f"/api/sessions/{sid}/messages",
        json_body={"role": "assistant", "content": "答案", "reasoning": "先想一想", "reasoning_seconds": 3, "reasoning_tokens": 120},
    )
    assert r.status == 201
    stored = client.get(f"/api/sessions/{sid}").json()["messages"][0]
    # 思考文字只存库不下发，界面只要用时和 token 数
    assert "reasoning" not in stored
    assert stored["reasoning_seconds"] == 3
    assert stored["reasoning_tokens"] == 120


def test_branch_copies_history_up_to_message(client):
    uid = _uid()
    sid = client.post("/api/sessions", json_body={"user_id": uid, "title": "原对话"}).json()["id"]
    for i, role in enumerate(["user", "assistant", "user", "assistant"]):
        client.post(f"/api/sessions/{sid}/messages", json_body={"id": f"b{i}-{sid[:6]}", "role": role, "content": f"第{i}条"})

    missing = client.post(f"/api/sessions/{sid}/branch", json_body={})
    assert missing.status == 400
    r = client.post(f"/api/sessions/{sid}/branch", json_body={"message_id": f"b1-{sid[:6]}"})
    assert r.status == 201
    branch = r.json()
    assert branch["title"] == "原对话 · 分支"
    copied = client.get(f"/api/sessions/{branch['id']}").json()["messages"]
    assert [m["content"] for m in copied] == ["第0条", "第1条"]
    assert len(client.get(f"/api/sessions/{sid}").json()["messages"]) == 4


def test_retry_branch_leaves_out_the_question_and_keeps_the_original(client):
    uid = _uid()
    sid = client.post("/api/sessions", json_body={"user_id": uid, "title": "原对话"}).json()["id"]
    for i, role in enumerate(["user", "assistant", "user", "assistant"]):
        client.post(f"/api/sessions/{sid}/messages", json_body={"id": f"r{i}-{sid[:6]}", "role": role, "content": f"第{i}条"})

    r = client.post(f"/api/sessions/{sid}/branch", json_body={"message_id": f"r2-{sid[:6]}", "exclusive": True})
    assert r.status == 201
    branch = r.json()
    assert branch["title"] == "原对话 · 重试"
    copied = client.get(f"/api/sessions/{branch['id']}").json()["messages"]
    assert [m["content"] for m in copied] == ["第0条", "第1条"]
    # 原来那条（可能做了一半的）回答还在原对话里
    assert [m["content"] for m in client.get(f"/api/sessions/{sid}").json()["messages"]] == ["第0条", "第1条", "第2条", "第3条"]


def test_suggestions_skip_empty_input(client):
    r = client.post("/api/chat/suggestions", json_body={"user_message": "", "assistant_message": "x"})
    assert r.status == 200
    assert r.json() == {"suggestions": []}


def test_suggestions_use_service(client, app_module, monkeypatch):
    monkeypatch.setattr(app_module.ai_service, "suggest_followups", lambda q, a: ["再简单点", "举个例子"])
    r = client.post("/api/chat/suggestions", json_body={"user_message": "问", "assistant_message": "答"})
    assert r.json() == {"suggestions": ["再简单点", "举个例子"]}


def test_delete_session_keeps_images_shared_with_branches(client, app_module, monkeypatch):
    from services.storage import StorageService

    monkeypatch.setenv("S3_PUBLIC_URL", "https://bucket.example.com")
    storage = StorageService()
    deleted = []
    monkeypatch.setattr(storage, "delete_object", lambda key: deleted.append(key) or True)
    uid = _uid()
    base = f"users/{uid}/sessions"

    sid = client.post("/api/sessions", json_body={"user_id": uid, "title": "原对话"}).json()["id"]
    shared, own, orphan = (f"{base}/{sid}/images/{name}.png" for name in ("shared", "own", "orphan"))
    monkeypatch.setattr(storage, "list_keys", lambda prefix: {orphan} if prefix == f"{base}/{sid}/" else set())
    monkeypatch.setattr(app_module, "storage_service", storage)

    client.post(f"/api/sessions/{sid}/messages", json_body={
        "id": f"s0-{sid[:6]}", "role": "user", "content": "看图", "images": [f"https://bucket.example.com/{shared}"],
    })
    client.post(f"/api/sessions/{sid}/messages", json_body={
        "id": f"s1-{sid[:6]}", "role": "assistant", "content": f"![](https://bucket.example.com/{own}?x-oss-process=image/blur,r_30,s_30)",
    })
    client.post(f"/api/sessions/{sid}/branch", json_body={"message_id": f"s0-{sid[:6]}"})

    assert client.delete(f"/api/sessions/{sid}").status == 200
    assert sorted(deleted) == sorted([own, orphan])
