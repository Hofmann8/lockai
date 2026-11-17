"""
视频：RelayRouter 的 Grok Imagine（models.json 的 video_generator）。文生视频，或给一张图做图生视频。

提交 → 每隔几秒查一次 → 完成后下载转存 OSS（换上 LockAI 的标识）。2026-11 实测（grok-imagine-video-1.5-lite）：
- POST /v1/videos/generations 返回 {"request_id": …}；GET /v1/videos/{request_id} 查，status 是 pending → done / failed，
  带 0~100 的 progress
- 480p / 720p / 1080p 都收（文档只写了前两种）；时长 1~15 秒；画幅 1:1、16:9、9:16
- 图生视频：image: {url}

计费：每秒按分辨率计（billing.per_second），图生视频每张参考图另计一次（billing.per_image）。
提交前先按参数估算，额度不够不提交。
"""

from __future__ import annotations

import posixpath
import re
import uuid
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from .http_client import build_http_client
from .media_label import label_media
from .sandbox import safe_filename

MODEL_ID = "video_generator"
TIMEOUT_SECONDS = 900
POLL_SECONDS = 5

RESOLUTIONS = ("480p", "720p", "1080p")
DEFAULT_RESOLUTION = "720p"
ASPECT_RATIOS = ("16:9", "9:16", "1:1")
DEFAULT_ASPECT = "16:9"
MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS = 1, 15, 6
PROMPT_CHARS = 2000
TITLE_CHARS = 60

DONE = {"done", "completed", "complete", "succeeded", "success"}
FAILED = {"failed", "failure", "error", "expired", "cancelled", "canceled", "rejected"}
SPACE_RE = re.compile(r"\s+")


class VideoError(Exception):
    pass


def normalize_video_args(arguments: dict[str, Any] | None) -> dict[str, Any]:
    args = arguments if isinstance(arguments, dict) else {}
    resolution = str(args.get("resolution") or "").strip().lower()
    aspect = str(args.get("aspect_ratio") or "").strip()
    try:
        seconds = int(round(float(args.get("duration"))))
    except (TypeError, ValueError):
        seconds = DEFAULT_SECONDS
    prompt = str(args.get("prompt") or "").strip()[:PROMPT_CHARS]
    title = SPACE_RE.sub(" ", str(args.get("title") or "")).strip()[:TITLE_CHARS]
    return {
        "prompt": prompt,
        "title": title or SPACE_RE.sub(" ", prompt)[:20] or "视频",
        "resolution": resolution if resolution in RESOLUTIONS else DEFAULT_RESOLUTION,
        "aspect_ratio": aspect if aspect in ASPECT_RATIOS else DEFAULT_ASPECT,
        "duration": max(MIN_SECONDS, min(MAX_SECONDS, seconds)),
        "image": str(args.get("image") or "").strip(),
    }


def build_video_body(request: dict[str, Any], model: str, image_url: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "prompt": request["prompt"],
        "resolution": request["resolution"],
        "aspect_ratio": request["aspect_ratio"],
        "duration": request["duration"],
    }
    if image_url:
        body["image"] = {"url": image_url}
    return body


def _find_url(payload: Any) -> str:
    """成品地址的位置各家不一：video_url、video.url、url、data[0].url 都认"""
    if isinstance(payload, dict):
        for key in ("video_url", "url"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("http"):
                return value
        for key in ("video", "data", "result", "output"):
            found = _find_url(payload.get(key))
            if found:
                return found
    if isinstance(payload, list):
        for item in payload:
            found = _find_url(item)
            if found:
                return found
    return ""


def parse_status(payload: Any) -> dict[str, Any]:
    """GET /v1/videos/{id} → {state: running / success / failed, progress, url, error}"""
    if not isinstance(payload, dict):
        return {"state": "failed", "progress": 0, "url": "", "error": "查询失败"}
    if isinstance(payload.get("error"), dict) and not payload.get("status"):
        return {"state": "failed", "progress": 0, "url": "", "error": str(payload["error"].get("message") or "生成失败")}
    status = str(payload.get("status") or "").strip().lower()
    try:
        progress = max(0, min(100, int(float(payload.get("progress") or 0))))
    except (TypeError, ValueError):
        progress = 0
    url = _find_url(payload)
    if status in FAILED:
        error = payload.get("error")
        message = error.get("message") if isinstance(error, dict) else error
        return {"state": "failed", "progress": progress, "url": "",
                "error": str(message or payload.get("fail_reason") or "生成失败")}
    if status in DONE and url:
        return {"state": "success", "progress": 100, "url": url, "error": ""}
    return {"state": "running", "progress": min(progress, 99), "url": "", "error": ""}


class VideoService:
    def __init__(self, llm_service, storage_service):
        self.llm = llm_service
        self.storage = storage_service

    def config(self) -> dict[str, Any]:
        return self.llm.get_model_config(MODEL_ID)

    @property
    def available(self) -> bool:
        cfg = self.config()
        return bool(cfg.get("id") == MODEL_ID and cfg.get("available", True) and self.llm._collect_api_keys(cfg))

    def model_label(self) -> str:
        return str(self.config().get("name") or "Campbell Video")

    def units_for(self, request: dict[str, Any], with_image: bool) -> float:
        """按参数估算计费量：每秒单价 × 时长，图生视频加一张图的钱"""
        billing = self.config().get("billing") or {}
        per_second = billing.get("per_second") if isinstance(billing.get("per_second"), dict) else {}
        try:
            rate = float(per_second.get(request["resolution"]) or 0)
            image = float(billing.get("per_image") or 0) if with_image else 0.0
        except (TypeError, ValueError):
            return 0.0
        return rate * request["duration"] + image

    def _base(self) -> str:
        base = str(self.config().get("api_base") or self.llm.legacy_api_base).rstrip("/")
        return base if base.endswith("/v1") else f"{base}/v1"

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        cfg = self.config()
        try:
            with build_http_client(httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)) as client:
                resp = client.request(method, f"{self._base()}{path}", json=body,
                                      headers=self.llm._build_headers(self.llm.get_api_key(cfg) or ""))
        except httpx.HTTPError as exc:
            raise VideoError(f"视频服务连不上（{type(exc).__name__}）") from exc
        try:
            data = resp.json()
        except ValueError:
            data = None
        if resp.status_code != 200:
            print(f"[Video] {path} HTTP {resp.status_code}: {resp.text[:300]}")
            if resp.status_code == 429:
                raise VideoError("视频服务繁忙，请稍后再试")
            message = (data.get("error") or {}).get("message") if isinstance(data, dict) and isinstance(data.get("error"), dict) else ""
            if resp.status_code == 400 and message:
                raise VideoError(f"请求被拒绝：{str(message)[:200]}")
            raise VideoError(f"视频服务出错（HTTP {resp.status_code}）")
        return data

    def submit(self, request: dict[str, Any], image_url: str = "") -> str:
        body = build_video_body(request, str(self.config().get("model") or "grok-imagine-video-1.5-lite"), image_url)
        data = self._request("POST", "/videos/generations", body)
        task_id = ""
        if isinstance(data, dict):
            inner = data.get("data") if isinstance(data.get("data"), dict) else {}
            task_id = str(data.get("request_id") or data.get("id") or data.get("task_id") or inner.get("task_id") or "")
        if not task_id:
            print(f"[Video] 提交没拿到任务编号: {str(data)[:300]}")
            raise VideoError("提交失败")
        print(f"[Video] 已提交 {task_id}: {request['resolution']} {request['duration']}s {request['aspect_ratio']}"
              f"{' 图生视频' if image_url else ''}")
        return task_id

    def fetch(self, task_id: str) -> dict[str, Any]:
        return parse_status(self._request("GET", f"/videos/{quote(task_id, safe='')}"))

    def save(self, url: str, request: dict[str, Any], user_id: str | None, session_id: str | None,
             taken: set[str] | None = None) -> dict[str, Any]:
        """下载成品、换上 LockAI 的标识、存 OSS，返回文件卡片。文件名避开会话里已有的"""
        base = safe_filename(request["title"]).rsplit(".", 1)[0].strip() or "视频"
        ext = posixpath.splitext(urlsplit(url).path)[1].lower() or ".mp4"
        if ext not in (".mp4", ".mov", ".webm"):
            ext = ".mp4"
        taken = taken if taken is not None else set()
        name, n = f"{base}{ext}", 2
        while f"videos/{name}" in taken:
            name, n = f"{base}-{n}{ext}", n + 1
        taken.add(f"videos/{name}")
        content_id = uuid.uuid4().hex
        with build_http_client(httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=10.0)) as client:
            resp = client.get(url, follow_redirects=True)
        if resp.status_code != 200 or not resp.content:
            raise VideoError(f"下载成品失败（HTTP {resp.status_code}）")
        content = label_media(resp.content, content_id, title=request["title"])
        mime = {".mov": "video/quicktime", ".webm": "video/webm"}.get(ext, "video/mp4")
        key = f"users/{user_id or 'anonymous'}/sessions/{session_id or 'none'}/videos/{content_id}/{name}"
        if not (self.storage and self.storage.upload_bytes(content, key, content_type=mime)):
            raise VideoError("存储不可用")
        return {"name": name, "path": f"videos/{name}", "size": len(content), "mime": mime,
                "url": f"{self.storage.public_url}/{quote(key)}", "contentId": content_id}
