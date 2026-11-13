"""
LockAI Desktop 的接口：浏览器授权登录、OpenAI 兼容网关、联网搜索、强制更新策略。

逻辑在 services/desktop.py。这里的网关是异步透传：上游的流式输出原样转给桌面端，
只在旁边读出 usage 记账，不占用后端唯一的 worker。
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse

from services import desktop
from services.desktop import DesktopError
from services.llm import should_fall_back
from services.tokens import count_prompt, count_text, strip_injected

UPSTREAM_TIMEOUT = httpx.Timeout(connect=20.0, read=600.0, write=60.0, pool=20.0)
UPSTREAM_RETRIES = 2


def _auth_error(exc: DesktopError) -> JSONResponse:
    return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status)


def _openai_error(status: int, message: str, code: str, kind: str = "invalid_request_error") -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": kind, "code": code}}, status_code=status)


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise DesktopError(400, "请求体不是合法的 JSON")
    if not isinstance(body, dict):
        raise DesktopError(400, "请求体必须是 JSON 对象")
    return body


def _upstream_message(raw: bytes) -> str:
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])[:500]
        if isinstance(error, str):
            return error[:500]
    except (ValueError, AttributeError):
        pass
    return ""


def create_desktop_router(ai_service) -> APIRouter:
    llm = ai_service.llm
    usage = ai_service.usage
    search = ai_service.search
    gate = desktop.ConcurrencyGate(desktop.MAX_CONCURRENT_PER_USER)
    search_window = desktop.RateWindow(desktop.MAX_SEARCHES_PER_MINUTE)
    router = APIRouter()

    # ------------------------------------------------------------------
    # 授权登录
    # ------------------------------------------------------------------

    @router.post("/api/desktop/auth/init")
    async def auth_init(request: Request):
        try:
            body = await _json_body(request)
            return desktop.start_auth(
                str(body.get("code_challenge") or ""),
                str(body.get("code_challenge_method") or ""),
                str(body.get("state") or ""),
                str(body.get("redirect_uri") or ""),
                str(body.get("login_source") or "desktop"),
            )
        except DesktopError as exc:
            return _auth_error(exc)

    @router.get("/api/desktop/auth/requests/{authorize_id}")
    def auth_describe(authorize_id: str):
        try:
            return desktop.describe_auth(authorize_id)
        except DesktopError as exc:
            return _auth_error(exc)

    @router.post("/api/desktop/auth/approve")
    async def auth_approve(request: Request):
        try:
            body = await _json_body(request)
            user = await desktop.verify_lockauth_token(str(body.get("token") or ""))
            return desktop.approve_auth(str(body.get("authorize_id") or ""), user)
        except DesktopError as exc:
            return _auth_error(exc)

    @router.post("/api/desktop/auth/deny")
    async def auth_deny(request: Request):
        try:
            body = await _json_body(request)
            return desktop.deny_auth(str(body.get("authorize_id") or ""))
        except DesktopError as exc:
            return _auth_error(exc)

    @router.post("/api/desktop/auth/exchange")
    async def auth_exchange(request: Request):
        try:
            body = await _json_body(request)
            return desktop.exchange_code(
                str(body.get("code") or ""),
                str(body.get("code_verifier") or ""),
                str(body.get("redirect_uri") or ""),
                body,
            )
        except DesktopError as exc:
            return _auth_error(exc)

    @router.post("/api/desktop/auth/cancel")
    async def auth_cancel(request: Request):
        try:
            body = await _json_body(request)
        except DesktopError as exc:
            return _auth_error(exc)
        desktop.cancel_auth(str(body.get("authorize_id") or ""), str(body.get("code_verifier") or ""))
        return {"ok": True}

    @router.post("/api/desktop/auth/logout")
    def auth_logout(request: Request):
        try:
            device = desktop.authenticate(request.headers.get("authorization"))
        except DesktopError:
            # 已经失效的令牌，登出照样算成功
            return {"ok": True}
        desktop.revoke(device)
        return {"ok": True}

    @router.get("/api/desktop/me")
    def me(request: Request):
        try:
            device = desktop.authenticate(request.headers.get("authorization"))
        except DesktopError as exc:
            return _auth_error(exc)
        return {"user": desktop.profile_of(device), "usage": usage.get_summary(device.user_id)}

    # ------------------------------------------------------------------
    # 强制更新策略：dsh 桌面端固定请求这个地址
    # ------------------------------------------------------------------

    @router.get("/api/v0/check_client_update")
    def check_client_update(request: Request):
        return desktop.update_policy(request.headers.get("x-client-version") or "")

    # ------------------------------------------------------------------
    # OpenAI 兼容网关
    # ------------------------------------------------------------------

    @router.get("/api/desktop/v1/models")
    def models(request: Request):
        try:
            desktop.authenticate(request.headers.get("authorization"))
        except DesktopError as exc:
            return _openai_error(exc.status, exc.message, exc.code)
        return {"object": "list", "data": desktop.list_models(llm)}

    @router.post("/api/desktop/v1/chat/completions")
    async def chat_completions(request: Request):
        try:
            device = desktop.authenticate(request.headers.get("authorization"))
            body = await _json_body(request)
            cfg = desktop.resolve_model(llm, str(body.get("model") or ""))
        except DesktopError as exc:
            return _openai_error(exc.status, exc.message, exc.code)

        user_id = device.user_id
        billable = bool(cfg.get("billable"))
        if billable:
            ok, scope, message = usage.check(user_id, usage.CHAT_COST)
            if not ok:
                return _openai_error(429, message, f"quota_{scope}", "insufficient_quota")
        if not gate.acquire(user_id):
            return _openai_error(429, "同时进行的请求太多，请等前面的回答完成", "too_many_requests", "rate_limit_exceeded")

        candidates = llm.chat_candidates(cfg)
        if not candidates:
            gate.release(user_id)
            return _openai_error(502, "模型服务暂时连不上，请稍后重试", "upstream_unavailable", "api_error")
        payload = desktop.build_upstream_payload(body, candidates[0])
        own_prompt = count_prompt(payload.get("messages") or [], payload.get("tools")) if billable else None

        def record(raw_usage: dict[str, Any] | None, written: str) -> None:
            if not billable:
                return
            try:
                raw = raw_usage or {"prompt_tokens": own_prompt or 0, "completion_tokens": count_text(written)}
                spent = usage.record_chat_call(user_id, strip_injected(raw, own_prompt), cfg)
                estimated = "（上游没报用量，按本地估算）" if not raw_usage else ""
                print(f"[Desktop] {cfg.get('id')} 用户 {user_id} 扣 {spent:g} credits{estimated}")
            except Exception as exc:  # 记账失败不影响已经返回的回答
                print(f"[Desktop] 记账失败: {type(exc).__name__}: {exc}")

        client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT,
                                   transport=httpx.AsyncHTTPTransport(retries=UPSTREAM_RETRIES))
        # 主供应商连不上或返回 should_fall_back 的状态码时换回退（还没往客户端写任何东西，可以安全重发）
        upstream = None
        raw = b""
        for index, attempt in enumerate(candidates):
            last = index == len(candidates) - 1
            attempt_payload = payload if index == 0 else desktop.build_upstream_payload(body, attempt)
            try:
                upstream = await client.send(
                    client.build_request("POST", llm._chat_endpoint(attempt["api_base"]),
                                         headers=llm._build_headers(llm.get_api_key(attempt) or ""), json=attempt_payload),
                    stream=True,
                )
            except httpx.HTTPError as exc:
                print(f"[Desktop] 上游连接失败 {attempt.get('model')}: {type(exc).__name__}: {exc}")
                upstream = None
                if not last:
                    continue
                await client.aclose()
                gate.release(user_id)
                return _openai_error(502, "模型服务暂时连不上，请稍后重试", "upstream_unavailable", "api_error")
            if upstream.status_code == 200:
                break
            raw = await upstream.aread()
            await upstream.aclose()
            print(f"[Desktop] 上游 HTTP {upstream.status_code} {attempt.get('model')}: {raw[:300]!r}")
            if last or not should_fall_back(upstream.status_code):
                break

        if upstream.status_code != 200:
            await client.aclose()
            gate.release(user_id)
            if upstream.status_code in (400, 413, 422):
                detail = _upstream_message(raw) or "请求被模型服务拒绝"
                return _openai_error(upstream.status_code, detail, "upstream_rejected")
            if upstream.status_code == 429:
                return _openai_error(429, "模型服务繁忙，请稍后重试", "upstream_busy", "rate_limit_exceeded")
            return _openai_error(502, f"模型服务出错（HTTP {upstream.status_code}）", "upstream_error", "api_error")

        if not payload.get("stream"):
            try:
                raw = await upstream.aread()
            finally:
                await upstream.aclose()
                await client.aclose()
                gate.release(user_id)
            try:
                data = json.loads(raw)
            except ValueError:
                return _openai_error(502, "模型服务返回了无法解析的内容", "upstream_error", "api_error")
            record(data.get("usage") if isinstance(data, dict) else None,
                   desktop.collected_text(data) if isinstance(data, dict) else "")
            return JSONResponse(data)

        async def relay():
            seen_usage: dict[str, Any] | None = None
            written: list[str] = []
            try:
                async for line in upstream.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:].strip()
                        if data and data != "[DONE]":
                            try:
                                chunk = json.loads(data)
                            except ValueError:
                                chunk = None
                            if isinstance(chunk, dict):
                                if chunk.get("usage"):
                                    seen_usage = chunk["usage"]
                                if billable:
                                    written.append(desktop.collected_text(chunk))
                    yield (line + "\n").encode("utf-8")
            finally:
                # 客户端中途断开也会走到这里：已经生成的部分照样记账
                record(seen_usage, "".join(written))
                gate.release(user_id)
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(relay(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ------------------------------------------------------------------
    # 联网搜索（桌面端的 web_search 工具走这里）
    # ------------------------------------------------------------------

    @router.post("/api/desktop/v1/search")
    async def web_search(request: Request):
        try:
            device = desktop.authenticate(request.headers.get("authorization"))
            body = await _json_body(request)
        except DesktopError as exc:
            return _openai_error(exc.status, exc.message, exc.code)
        query = str(body.get("query") or "").strip()
        if not query:
            return _openai_error(400, "搜索内容不能为空", "invalid_request")
        if not search_window.allow(device.user_id, time.monotonic()):
            return _openai_error(429, "搜索太频繁，请稍后再试", "too_many_requests", "rate_limit_exceeded")
        text, sources = await run_in_threadpool(search.search_with_sources, query)
        if not sources and text == search.FAILED:
            return _openai_error(502, "联网搜索暂时不可用", "search_unavailable", "api_error")
        limit = body.get("max_results")
        if isinstance(limit, int) and limit > 0:
            sources = sources[:limit]
        return {"content": text, "sources": sources}

    return router
