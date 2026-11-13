"""LockAI Desktop 接口：授权登录、设备令牌、网关转发与记账、强制更新策略。

不打任何外部服务：LockAuth 核验和上游模型都换成桩。
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import os
import sys
import tempfile
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

CALLBACK = "http://127.0.0.1:51234/oauth/callback"


@pytest.fixture(scope="module")
def app_module():
    db_path = os.path.join(tempfile.mkdtemp(prefix="lockai_desktop_"), "desktop.db")
    os.environ["DATABASE_URL"] = "sqlite:///" + db_path.replace("\\", "/")
    for name in ("app", "asgi", "desktop_routes"):
        sys.modules.pop(name, None)
    module = importlib.import_module("app")
    yield module
    os.environ.pop("DATABASE_URL", None)


@pytest.fixture(scope="module")
def client(app_module):
    return TestClient(app_module.app)


AVATAR = "https://files.example.com/avatars/u.webp?x-oss-process=style/avatarmd"


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def _login(client, monkeypatch, user_id: str | None = None) -> tuple[str, str]:
    """走完整的授权流程，返回 (设备令牌, 用户 id)。"""
    from services import desktop

    user_id = user_id or f"u-{uuid.uuid4().hex[:6]}"

    async def fake_verify(token):
        assert token == "web-token"
        return {"id": user_id, "name": "测试成员", "email": "member@example.com", "avatar_url": AVATAR}

    monkeypatch.setattr(desktop, "verify_lockauth_token", fake_verify)
    verifier, challenge = _pkce()
    init = client.post("/api/desktop/auth/init", json={
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "st-1",
        "redirect_uri": CALLBACK, "login_source": "desktop",
    })
    assert init.status_code == 200, init.text
    authorize_id = init.json()["authorize_id"]
    assert init.json()["authorize_url"].endswith(f"/desktop/authorize?id={authorize_id}")

    assert client.get(f"/api/desktop/auth/requests/{authorize_id}").json()["status"] == "pending"
    approved = client.post("/api/desktop/auth/approve", json={"authorize_id": authorize_id, "token": "web-token"})
    assert approved.status_code == 200, approved.text
    redirect = httpx.URL(approved.json()["redirect_url"])
    assert str(redirect).startswith(CALLBACK)
    assert redirect.params["state"] == "st-1"

    exchanged = client.post("/api/desktop/auth/exchange", json={
        "code": redirect.params["code"], "code_verifier": verifier, "redirect_uri": CALLBACK,
        "device_id": "dev-1", "device_model": "win32-x64", "os_version": "win32 10",
    })
    assert exchanged.status_code == 200, exchanged.text
    body = exchanged.json()
    assert body["token"].startswith("lkd_")
    assert body["user"]["id"] == user_id
    assert body["user"]["avatar_url"] == AVATAR
    # 授权码只能用一次
    again = client.post("/api/desktop/auth/exchange", json={
        "code": redirect.params["code"], "code_verifier": verifier, "redirect_uri": CALLBACK,
    })
    assert again.status_code == 400
    return body["token"], user_id


# ------------------------------------------------------------------
# 授权登录
# ------------------------------------------------------------------

@pytest.mark.parametrize("uri", [
    "https://127.0.0.1:5000/oauth/callback",
    "http://evil.example.com:5000/oauth/callback",
    "http://127.0.0.1/oauth/callback",
    "http://127.0.0.1:5000/other",
    "http://127.0.0.1:5000/oauth/callback?x=1",
])
def test_init_rejects_non_loopback_callbacks(client, uri):
    _, challenge = _pkce()
    r = client.post("/api/desktop/auth/init", json={
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "s", "redirect_uri": uri,
    })
    assert r.status_code == 400


def test_full_login_flow_and_me(client, monkeypatch):
    token, user_id = _login(client, monkeypatch)
    me = client.get("/api/desktop/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["user"]["id"] == user_id
    assert "remaining" in me.json()["usage"]


def test_exchange_rejects_wrong_verifier(client, monkeypatch):
    from services import desktop

    async def fake_verify(token):
        return {"id": "u-x", "name": "x", "email": ""}

    monkeypatch.setattr(desktop, "verify_lockauth_token", fake_verify)
    _, challenge = _pkce()
    init = client.post("/api/desktop/auth/init", json={
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "s", "redirect_uri": CALLBACK,
    }).json()
    redirect = httpx.URL(client.post("/api/desktop/auth/approve",
                                     json={"authorize_id": init["authorize_id"], "token": "t"}).json()["redirect_url"])
    wrong_verifier, _ = _pkce()
    r = client.post("/api/desktop/auth/exchange", json={
        "code": redirect.params["code"], "code_verifier": wrong_verifier, "redirect_uri": CALLBACK,
    })
    assert r.status_code == 400


def test_approve_twice_conflicts(client, monkeypatch):
    from services import desktop

    async def fake_verify(token):
        return {"id": "u-y", "name": "y", "email": ""}

    monkeypatch.setattr(desktop, "verify_lockauth_token", fake_verify)
    _, challenge = _pkce()
    init = client.post("/api/desktop/auth/init", json={
        "code_challenge": challenge, "code_challenge_method": "S256", "state": "s", "redirect_uri": CALLBACK,
    }).json()
    first = client.post("/api/desktop/auth/approve", json={"authorize_id": init["authorize_id"], "token": "t"})
    second = client.post("/api/desktop/auth/approve", json={"authorize_id": init["authorize_id"], "token": "t"})
    assert first.status_code == 200
    assert second.status_code == 409


def test_logout_revokes_token(client, monkeypatch):
    token, _ = _login(client, monkeypatch)
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/desktop/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/desktop/me", headers=headers).status_code == 401


def test_gateway_requires_token(client):
    r = client.post("/api/desktop/v1/chat/completions", json={"model": "campbell", "messages": []})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_models_list(client, monkeypatch):
    token, _ = _login(client, monkeypatch)
    r = client.get("/api/desktop/v1/models", headers={"Authorization": f"Bearer {token}"})
    ids = [m["id"] for m in r.json()["data"]]
    assert "campbell" in ids and "scooby" in ids


# ------------------------------------------------------------------
# 网关转发与记账
# ------------------------------------------------------------------

def _sse(*chunks: dict) -> bytes:
    return b"".join(f"data: {json.dumps(c)}\n\n".encode() for c in chunks) + b"data: [DONE]\n\n"


@pytest.fixture
def campbell_pinned(app_module, monkeypatch):
    """Campbell 固定成「主供应商 + 回退」，不受本机 .env 里有没有新 key 影响。"""
    llm = app_module.ai_service.llm
    cache = [dict(c) for c in llm._models_cache]
    for cfg in cache:
        if cfg["id"] == "campbell":
            cfg.update(model="gpt-6.1-sol", api_base="https://primary.example/v1", api_key="k-primary",
                       fallback={"model": "gpt-6-astra", "api_base": "https://fallback.example/v1", "api_key": "k-fallback"})
    monkeypatch.setattr(llm, "_models_cache", cache)


def _ok_stream():
    return httpx.Response(200, content=_sse(
        {"choices": [{"index": 0, "delta": {"content": "pong"}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 1}},
    ), headers={"content-type": "text/event-stream"})


def test_campbell_falls_back_when_primary_is_down(client, campbell_pinned, monkeypatch):
    token, _ = _login(client, monkeypatch)
    hits: list[tuple[str, str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append((request.url.host, request.headers["authorization"], json.loads(request.content)["model"]))
        if request.url.host == "primary.example":
            return httpx.Response(503, json={"error": {"message": "No available compatible accounts"}})
        return _ok_stream()

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda retries=0: httpx.MockTransport(handler))
    with client.stream("POST", "/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                       json={"model": "campbell", "stream": True, "messages": [{"role": "user", "content": "ping"}]}) as r:
        assert r.status_code == 200
        assert '"pong"' in "".join(r.iter_text())
    assert hits == [
        ("primary.example", "Bearer k-primary", "gpt-6.1-sol"),
        ("fallback.example", "Bearer k-fallback", "gpt-6-astra"),
    ]


def test_campbell_connection_error_falls_back(client, campbell_pinned, monkeypatch):
    token, _ = _login(client, monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "primary.example":
            raise httpx.ConnectError("blocked", request=request)
        return _ok_stream()

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda retries=0: httpx.MockTransport(handler))
    with client.stream("POST", "/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                       json={"model": "campbell", "stream": True, "messages": [{"role": "user", "content": "ping"}]}) as r:
        assert r.status_code == 200
        assert '"pong"' in "".join(r.iter_text())


def test_campbell_bad_request_is_not_retried(client, campbell_pinned, monkeypatch):
    token, _ = _login(client, monkeypatch)
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        return httpx.Response(400, json={"error": {"message": "context too long"}})

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda retries=0: httpx.MockTransport(handler))
    r = client.post("/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                    json={"model": "campbell", "messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 400
    assert r.json()["error"]["message"] == "context too long"
    assert hosts == ["primary.example"]


def test_stream_relays_and_bills_campbell(client, app_module, campbell_pinned, monkeypatch):
    token, user_id = _login(client, monkeypatch)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        stream = _sse(
            {"choices": [{"index": 0, "delta": {"content": "pong"}, "finish_reason": None}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 50000, "completion_tokens": 1000}},
        )
        return httpx.Response(200, content=stream, headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda retries=0: httpx.MockTransport(handler))
    before = app_module.ai_service.usage.get_today(user_id)["units"]
    with client.stream("POST", "/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                       json={"model": "campbell", "stream": True, "store": True, "user": "x",
                             "messages": [{"role": "user", "content": "ping"}]}) as r:
        assert r.status_code == 200
        text = "".join(r.iter_text())
    assert '"pong"' in text and "data: [DONE]" in text
    assert seen["url"].endswith("/v1/chat/completions")
    assert seen["url"].startswith("https://primary.example/")
    assert seen["body"]["model"] == "gpt-6.1-sol"
    assert seen["body"]["stream_options"] == {"include_usage": True}
    assert "store" not in seen["body"] and "user" not in seen["body"]
    after = app_module.ai_service.usage.get_today(user_id)["units"]
    assert after > before


def test_scooby_is_free_and_rewritten_for_deepseek(client, app_module, monkeypatch):
    token, user_id = _login(client, monkeypatch)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 1},
        })

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", lambda retries=0: httpx.MockTransport(handler))
    r = client.post("/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"}, json={
        "model": "scooby", "max_completion_tokens": 10_000_000,
        "messages": [{"role": "developer", "content": "be brief"}, {"role": "user", "content": "hi"}],
    })
    assert r.status_code == 200
    assert r.json()["choices"][0]["message"]["content"] == "ok"
    assert seen["body"]["model"] == "deepseek-flash"
    assert "max_completion_tokens" not in seen["body"]
    assert seen["body"]["max_tokens"] <= 65536
    assert seen["body"]["messages"][0]["role"] == "system"
    assert app_module.ai_service.usage.get_today(user_id)["units"] == 0


def test_upstream_error_is_reported(client, campbell_pinned, monkeypatch):
    """主供应商和回退都挂了才报错。"""
    token, _ = _login(client, monkeypatch)
    monkeypatch.setattr(httpx, "AsyncHTTPTransport",
                        lambda retries=0: httpx.MockTransport(lambda req: httpx.Response(500, text="boom")))
    r = client.post("/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                    json={"model": "campbell", "messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 502
    assert r.json()["error"]["type"] == "api_error"


def test_unknown_model(client, monkeypatch):
    token, _ = _login(client, monkeypatch)
    r = client.post("/api/desktop/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                    json={"model": "gpt-4o", "messages": []})
    assert r.status_code == 404


# ------------------------------------------------------------------
# 强制更新策略
# ------------------------------------------------------------------

def test_update_policy(client, monkeypatch):
    r = client.get("/api/v0/check_client_update", headers={"x-client-version": "0.2.1-rc.4"})
    assert r.json() == {"code": 0, "data": {"biz_code": 0, "biz_data": None}}
    monkeypatch.setenv("DESKTOP_MIN_VERSION", "0.2.1")
    r = client.get("/api/v0/check_client_update", headers={"x-client-version": "0.2.1-rc.4"})
    assert r.json()["code"] == 40005
    assert r.json()["data"]["desktop_app_link"].startswith("https://")


@pytest.mark.parametrize("version,minimum,below", [
    ("0.2.1-rc.4", "0.2.1", True),
    ("0.2.1", "0.2.1-rc.4", False),
    ("0.2.1-rc.3", "0.2.1-rc.4", True),
    ("0.2.1-rc.10", "0.2.1-rc.4", False),
    ("0.2.1-alpha.5", "0.2.1-rc.1", True),
    ("0.3.0", "0.2.9", False),
    ("garbage", "0.2.1", False),
])
def test_version_below(version, minimum, below):
    from services.desktop import version_below

    assert version_below(version, minimum) is below


def test_me_returns_stored_avatar_without_service_key(client, monkeypatch):
    monkeypatch.delenv("LOCKAUTH_SERVICE_KEY", raising=False)
    token, _user_id = _login(client, monkeypatch)
    me = client.get("/api/desktop/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["user"]["avatar_url"] == AVATAR


def test_avatar_url_rejects_non_http():
    from services import desktop
    assert desktop._avatar_url("javascript:alert(1)") is None
    assert desktop._avatar_url(None) is None
    assert desktop._avatar_url(AVATAR) == AVATAR
