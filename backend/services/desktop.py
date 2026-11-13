"""
LockAI Desktop 的登录与网关（纯逻辑部分，路由在 desktop_routes.py）

登录（PKCE，授权码只能用一次）：
    1. 桌面端 POST /api/desktop/auth/init，带 code_challenge 和本机回调地址，拿到授权页链接
    2. 用户在浏览器打开授权页（已登录 LockAI 网页），点允许；后端向 LockAuth 核验网页令牌
    3. 浏览器带一次性授权码跳回 http://127.0.0.1:<port>/oauth/callback
    4. 桌面端用 code_verifier 换设备令牌（lkd_ 开头）。令牌只存哈希，网页上可以吊销

网关：设备令牌 → 用户 → 额度检查 → 换成上游模型名和上游 key 转发，流末取 usage 记账。
计费口径和网页端 Campbell 完全一致（同一张 campbell_usages 表，同一套权重）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from models import DesktopAuthRequest, DesktopDevice, db

PUBLIC_URL = os.getenv("LOCKAI_PUBLIC_URL", "https://ai.funk-and.love").rstrip("/")
AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "https://auth.funk-and.love").rstrip("/")

AUTH_REQUEST_TTL = timedelta(minutes=10)
TOKEN_TTL = timedelta(days=int(os.getenv("DESKTOP_TOKEN_DAYS", "90")))
# 每次使用都把有效期往后顺延；为了少写库，离上次记录超过这么久才更新
TOUCH_INTERVAL = timedelta(minutes=10)

TOKEN_PREFIX = "lkd_"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
CALLBACK_PATH = "/oauth/callback"

# 桌面端能用的模型：models.json 里的 id。网关接受 id 本身，也接受它的上游模型名
DESKTOP_MODELS = [m.strip() for m in os.getenv("DESKTOP_MODELS", "campbell,scooby").split(",") if m.strip()]
MAX_OUTPUT_TOKENS = int(os.getenv("DESKTOP_MAX_OUTPUT_TOKENS", "65536"))
MAX_CONCURRENT_PER_USER = int(os.getenv("DESKTOP_MAX_CONCURRENT", "4"))
MAX_SEARCHES_PER_MINUTE = int(os.getenv("DESKTOP_SEARCHES_PER_MINUTE", "20"))

# 不往上游带的字段：不让上游替我们存对话，也不暴露用户标识
DROPPED_FIELDS = {"store", "metadata", "user", "safety_identifier", "service_tier"}


class DesktopError(Exception):
    def __init__(self, status: int, message: str, code: str = "invalid_request"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


# ------------------------------------------------------------------
# 小工具
# ------------------------------------------------------------------

def _now() -> datetime:
    return datetime.utcnow()


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def pkce_matches(verifier: str, challenge: str) -> bool:
    digest = hashlib.sha256(verifier.encode("ascii", errors="ignore")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return hmac.compare_digest(expected, challenge)


def valid_redirect_uri(uri: str) -> bool:
    """只接受本机回环地址上的 /oauth/callback，端口必须写明。"""
    try:
        parts = urlsplit(uri)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "http" or parts.username or parts.password or parts.query or parts.fragment:
        return False
    if (parts.hostname or "").lower() not in LOOPBACK_HOSTS:
        return False
    return port is not None and parts.path == CALLBACK_PATH


_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$")


def _semver_key(version: str):
    match = _SEMVER.match((version or "").strip())
    if not match:
        return None
    major, minor, patch, pre = match.groups()
    # 正式版排在同号预发布之后：用 (1,) 表示「没有预发布」；预发布里数字段排在字母段前面
    if pre is None:
        pre_key: tuple = ((1,),)
    else:
        pre_key = ((0,),) + tuple((0, int(p)) if p.isdigit() else (1, p) for p in pre.split("."))
    return (int(major), int(minor), int(patch)), pre_key


def version_below(version: str, minimum: str) -> bool:
    """version < minimum。认不出的版本号一律不拦。"""
    a, b = _semver_key(version), _semver_key(minimum)
    if a is None or b is None:
        return False
    return a < b


# ------------------------------------------------------------------
# 登录
# ------------------------------------------------------------------

def start_auth(code_challenge: str, method: str, state: str, redirect_uri: str, login_source: str) -> dict[str, Any]:
    if method != "S256":
        raise DesktopError(400, "只支持 S256")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", code_challenge or ""):
        raise DesktopError(400, "code_challenge 格式不对")
    if not state or len(state) > 256:
        raise DesktopError(400, "state 不能为空")
    if not valid_redirect_uri(redirect_uri):
        raise DesktopError(400, "回调地址必须是本机的 /oauth/callback")

    now = _now()
    # 顺手清掉一天前的旧请求
    DesktopAuthRequest.query.filter(DesktopAuthRequest.expires_at < now - timedelta(days=1)).delete()
    request = DesktopAuthRequest(
        id=uuid.uuid4().hex,
        code_challenge=code_challenge,
        state=state,
        redirect_uri=redirect_uri,
        login_source=login_source if login_source in ("desktop", "web") else "desktop",
        status="pending",
        created_at=now,
        expires_at=now + AUTH_REQUEST_TTL,
    )
    db.session.add(request)
    db.session.commit()
    return {
        "authorize_id": request.id,
        "authorize_url": f"{PUBLIC_URL}/desktop/authorize?{urlencode({'id': request.id})}",
        "expires_in": int(AUTH_REQUEST_TTL.total_seconds()),
    }


def _live_request(authorize_id: str) -> DesktopAuthRequest:
    request = db.session.get(DesktopAuthRequest, authorize_id) if authorize_id else None
    if request is None:
        raise DesktopError(404, "授权请求不存在", "not_found")
    if request.expires_at <= _now() and request.status in ("pending", "approved"):
        raise DesktopError(410, "授权请求已过期，请回到 LockAI Desktop 重新登录", "expired")
    return request


def describe_auth(authorize_id: str) -> dict[str, Any]:
    request = db.session.get(DesktopAuthRequest, authorize_id) if authorize_id else None
    if request is None:
        raise DesktopError(404, "授权请求不存在", "not_found")
    status = request.status
    if status in ("pending", "approved") and request.expires_at <= _now():
        status = "expired"
    return {"status": status, "expires_at": request.expires_at.isoformat() + "Z"}


async def verify_lockauth_token(token: str) -> dict[str, Any]:
    """向 LockAuth 核验网页端的登录令牌，返回用户信息。"""
    if not token:
        raise DesktopError(401, "请先登录", "unauthorized")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            response = await client.post(f"{AUTH_SERVICE_URL}/api/auth/verify-token", json={"token": token})
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        print(f"[Desktop] LockAuth 核验失败: {type(exc).__name__}: {exc}")
        raise DesktopError(502, "暂时无法核验登录状态，请稍后重试", "auth_unavailable")
    user = data.get("user") if isinstance(data, dict) else None
    if not (isinstance(data, dict) and data.get("valid") and isinstance(user, dict) and user.get("id") is not None):
        raise DesktopError(401, "登录已失效，请重新登录", "unauthorized")
    return user


def approve_auth(authorize_id: str, user: dict[str, Any]) -> dict[str, Any]:
    request = _live_request(authorize_id)
    if request.status != "pending":
        raise DesktopError(409, "这个授权请求已经处理过了", "conflict")
    code = secrets.token_urlsafe(32)
    request.status = "approved"
    request.user_id = str(user.get("id"))
    request.user_name = str(user.get("name") or "")[:100]
    request.user_email = str(user.get("email") or "")[:200]
    request.user_avatar = _avatar_url(user.get("avatar_url"))
    request.code_hash = sha256_hex(code)
    db.session.commit()
    redirect_url = f"{request.redirect_uri}?{urlencode({'code': code, 'state': request.state})}"
    return {"redirect_url": redirect_url}


def deny_auth(authorize_id: str) -> dict[str, Any]:
    request = _live_request(authorize_id)
    if request.status == "pending":
        request.status = "cancelled"
        db.session.commit()
    return {"status": request.status}


def cancel_auth(authorize_id: str, code_verifier: str) -> None:
    request = db.session.get(DesktopAuthRequest, authorize_id) if authorize_id else None
    if request is None or not pkce_matches(code_verifier or "", request.code_challenge):
        return
    if request.status in ("pending", "approved"):
        request.status = "cancelled"
        db.session.commit()


def exchange_code(code: str, code_verifier: str, redirect_uri: str, device: dict[str, Any]) -> dict[str, Any]:
    if not code or not code_verifier:
        raise DesktopError(400, "缺少授权码")
    request = DesktopAuthRequest.query.filter_by(code_hash=sha256_hex(code)).first()
    if request is None or request.status != "approved":
        raise DesktopError(400, "授权码无效或已经用过", "invalid_grant")
    if request.expires_at <= _now():
        raise DesktopError(400, "授权码已过期", "invalid_grant")
    if request.redirect_uri != redirect_uri or not pkce_matches(code_verifier, request.code_challenge):
        raise DesktopError(400, "授权码校验失败", "invalid_grant")

    token = TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = _now()
    row = DesktopDevice(
        id=str(uuid.uuid4()),
        user_id=request.user_id,
        user_name=request.user_name,
        user_email=request.user_email,
        user_avatar=request.user_avatar,
        token_hash=sha256_hex(token),
        token_prefix=token[:12],
        device_id=str(device.get("device_id") or "")[:64] or None,
        device_model=str(device.get("device_model") or "")[:100] or None,
        os_version=str(device.get("os_version") or "")[:200] or None,
        created_at=now,
        last_used_at=now,
        expires_at=now + TOKEN_TTL,
    )
    request.status = "exchanged"
    request.code_hash = None
    db.session.add(row)
    db.session.commit()
    return {
        "token": token,
        "user": {"id": request.user_id, "name": request.user_name, "email": request.user_email,
                 "avatar_url": request.user_avatar},
        "authorized_url": f"{PUBLIC_URL}/desktop/authorized",
    }


def authenticate(authorization: str | None) -> DesktopDevice:
    """Authorization: Bearer lkd_... → 设备。失败抛 401。"""
    scheme, _, token = (authorization or "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token.startswith(TOKEN_PREFIX):
        raise DesktopError(401, "请先在 LockAI Desktop 里登录", "unauthorized")
    device = DesktopDevice.query.filter_by(token_hash=sha256_hex(token)).first()
    now = _now()
    if device is None or device.revoked_at is not None or device.expires_at <= now:
        raise DesktopError(401, "登录已失效，请重新登录", "unauthorized")
    if device.last_used_at is None or now - device.last_used_at > TOUCH_INTERVAL:
        device.last_used_at = now
        device.expires_at = now + TOKEN_TTL
        db.session.commit()
    return device


def revoke(device: DesktopDevice) -> None:
    device.revoked_at = _now()
    db.session.commit()


def _avatar_url(value: Any) -> str | None:
    """只收 http(s) 地址，其他一律当没有头像。"""
    text = str(value or "").strip()
    return text[:1000] if text.startswith(("https://", "http://")) else None


# 头像跟着 LockAuth 走：配了服务密钥就定期拉一次全部头像（换了头像不用重新登录）；没配就用登录时存下的
AVATAR_REFRESH_SECONDS = 600
_avatar_cache: dict[str, Any] = {"at": 0.0, "by_id": {}}


def _live_avatar(user_id: str) -> str | None | bool:
    """返回 LockAuth 上现在的头像；拿不到时返回 False，由调用方回退到登录时存的。"""
    key = os.getenv("LOCKAUTH_SERVICE_KEY", "").strip()
    if not key:
        return False
    if time.monotonic() - _avatar_cache["at"] > AVATAR_REFRESH_SECONDS:
        try:
            response = httpx.get(f"{AUTH_SERVICE_URL}/api/auth/service/avatars", headers={"X-Service-Key": key},
                                 timeout=httpx.Timeout(5.0))
            users = response.json().get("users") if response.status_code == 200 else None
            if isinstance(users, list):
                _avatar_cache["by_id"] = {str(u.get("id")): _avatar_url(u.get("avatar_url")) for u in users if isinstance(u, dict)}
        except (httpx.HTTPError, ValueError) as exc:
            print(f"[Desktop] 拉取 LockAuth 头像失败: {type(exc).__name__}: {exc}")
        _avatar_cache["at"] = time.monotonic()
    by_id = _avatar_cache["by_id"]
    return by_id[user_id] if user_id in by_id else False


def profile_of(device: DesktopDevice) -> dict[str, Any]:
    live = _live_avatar(device.user_id)
    avatar = device.user_avatar if live is False else live
    return {"id": device.user_id, "name": device.user_name or "", "email": device.user_email or "", "avatar_url": avatar}


# ------------------------------------------------------------------
# 强制更新策略（dsh 桌面端固定请求 /api/v0/check_client_update）
# ------------------------------------------------------------------

def update_policy(client_version: str) -> dict[str, Any]:
    minimum = os.getenv("DESKTOP_MIN_VERSION", "").strip()
    if minimum and version_below(client_version, minimum):
        return {
            "code": 40005,
            "data": {
                "show_content": {
                    "title": "需要更新 LockAI Desktop",
                    "detail": f"当前版本 {client_version} 已停止支持，请下载 {minimum} 或更新的版本。",
                },
                "desktop_app_link": os.getenv("DESKTOP_DOWNLOAD_URL", f"{PUBLIC_URL}/desktop"),
            },
        }
    return {"code": 0, "data": {"biz_code": 0, "biz_data": None}}


# ------------------------------------------------------------------
# 网关：请求改写
# ------------------------------------------------------------------

def resolve_model(llm, requested: str) -> dict[str, Any]:
    """把请求里的模型名（LockAI id 或上游名）解析成 models.json 里的配置。"""
    name = (requested or "").strip()
    for model_id in DESKTOP_MODELS:
        cfg = llm.get_model_config(model_id)
        if not cfg or not cfg.get("available", True):
            continue
        if name in (model_id, cfg.get("model")):
            return cfg
    raise DesktopError(404, f"模型 {name or '（空）'} 不可用", "model_not_found")


def list_models(llm) -> list[dict[str, Any]]:
    data = []
    for model_id in DESKTOP_MODELS:
        cfg = llm.get_model_config(model_id)
        if not cfg or not cfg.get("available", True):
            continue
        data.append({
            "id": model_id,
            "object": "model",
            "owned_by": "lockai",
            "name": cfg.get("name") or model_id,
            "billable": bool(cfg.get("billable")),
        })
    return data


def is_deepseek(cfg: dict[str, Any]) -> bool:
    transport = str(cfg.get("transport") or cfg.get("provider") or "")
    return transport.startswith("deepseek")


def build_upstream_payload(body: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    payload = {k: v for k, v in body.items() if k not in DROPPED_FIELDS}
    payload["model"] = cfg["model"]
    if payload.get("stream"):
        options = dict(payload.get("stream_options") or {})
        options["include_usage"] = True
        payload["stream_options"] = options
    for key in ("max_tokens", "max_completion_tokens"):
        value = payload.get(key)
        if isinstance(value, int) and value > MAX_OUTPUT_TOKENS:
            payload[key] = MAX_OUTPUT_TOKENS
    if is_deepseek(cfg):
        # DeepSeek 只认 max_tokens 和 system 角色
        if "max_completion_tokens" in payload:
            payload["max_tokens"] = payload.pop("max_completion_tokens")
        messages = []
        for message in payload.get("messages") or []:
            if isinstance(message, dict) and message.get("role") == "developer":
                message = {**message, "role": "system"}
            messages.append(message)
        payload["messages"] = messages
    return payload


def collected_text(chunk: dict[str, Any]) -> str:
    """流式块里模型写出来的文字（正文、思考、工具参数），用来在上游不报 usage 时估算输出。"""
    parts: list[str] = []
    for choice in chunk.get("choices") or []:
        delta = choice.get("delta") or choice.get("message") or {}
        for key in ("content", "reasoning_content", "reasoning"):
            value = delta.get(key)
            if isinstance(value, str):
                parts.append(value)
        for call in delta.get("tool_calls") or []:
            fn = call.get("function") or {}
            for key in ("name", "arguments"):
                value = fn.get(key)
                if isinstance(value, str):
                    parts.append(value)
    return "".join(parts)


class ConcurrencyGate:
    """每个用户同时在跑的请求数上限（单进程内存计数，后端固定 1 个 worker）。"""

    def __init__(self, limit: int):
        self.limit = limit
        self.active: dict[str, int] = {}

    def acquire(self, user_id: str) -> bool:
        if self.active.get(user_id, 0) >= self.limit:
            return False
        self.active[user_id] = self.active.get(user_id, 0) + 1
        return True

    def release(self, user_id: str) -> None:
        left = self.active.get(user_id, 0) - 1
        if left > 0:
            self.active[user_id] = left
        else:
            self.active.pop(user_id, None)


class RateWindow:
    """每个用户每分钟的次数上限。"""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self.hits: dict[str, list[float]] = {}

    def allow(self, user_id: str, now: float) -> bool:
        recent = [t for t in self.hits.get(user_id, []) if now - t < 60]
        if len(recent) >= self.per_minute:
            self.hits[user_id] = recent
            return False
        recent.append(now)
        self.hits[user_id] = recent
        return True
