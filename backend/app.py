"""
LockAI 后端入口（FastAPI）。

开发：python app.py（读取 .env 的 PORT，DEV_RELOAD=true 时热重载）
生产：gunicorn -c gunicorn.conf.py asgi:app
接口文档：/docs
"""

import json
import os
import tempfile
import uuid
from urllib.parse import quote
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, Form, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import inspect, text
from starlette.exceptions import HTTPException as StarletteHTTPException

from database import db
from models import ChatMessage, ChatSession, GeneratedImage
from schemas import (
    AddMessageBody,
    ChatBody,
    CreateSessionBody,
    GenerateTitleBody,
    StopRunBody,
    TruncateBody,
    UpdateSessionBody,
    SuggestionsBody,
    UploadImageBody,
)
from services.ai import AIService
from services.asr import ASRService, ASRServiceError, RealtimeASRSessionManager
from services.sandbox import guess_mime, safe_filename, safe_relpath
from services.storage import StorageService
from sse import HEARTBEAT, StreamFailed, iterate_in_thread, poll_queue, sse_response
from services.runs import HEARTBEAT as RUNS_HEARTBEAT, MAX_PER_USER as RUNS_PER_USER, RunLimit, runs

load_dotenv()

CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3003",
    "http://127.0.0.1:3003",
    "https://ai.funk-and.love",
]


# ============ 数据库初始化与轻量迁移（SQLite 无 migration 工具） ============

def init_database() -> None:
    db.init()
    with db.scope():
        db.create_all()
        inspector = inspect(db.engine)
        message_columns = [c['name'] for c in inspector.get_columns('chat_messages')]
        if 'images' not in message_columns:
            db.session.execute(text('ALTER TABLE chat_messages ADD COLUMN images TEXT'))
            db.session.commit()
            print("[DB] 已添加 chat_messages.images 列")
        if 'tool_trace' not in message_columns:
            db.session.execute(text('ALTER TABLE chat_messages ADD COLUMN tool_trace TEXT'))
            db.session.commit()
            print("[DB] 已添加 chat_messages.tool_trace 列")
        for column, ddl in (
            ('reasoning', 'ALTER TABLE chat_messages ADD COLUMN reasoning TEXT'),
            ('reasoning_seconds', 'ALTER TABLE chat_messages ADD COLUMN reasoning_seconds INTEGER'),
            ('reasoning_tokens', 'ALTER TABLE chat_messages ADD COLUMN reasoning_tokens INTEGER'),
            ('files', 'ALTER TABLE chat_messages ADD COLUMN files TEXT'),
        ):
            if column not in message_columns:
                db.session.execute(text(ddl))
                db.session.commit()
                print(f"[DB] 已添加 chat_messages.{column} 列")
        session_columns = [c['name'] for c in inspector.get_columns('chat_sessions')]
        if 'model_id' not in session_columns:
            db.session.execute(text("ALTER TABLE chat_sessions ADD COLUMN model_id TEXT DEFAULT 'campbell'"))
            db.session.commit()
            print("[DB] 已添加 chat_sessions.model_id 列")
        if 'pinned' not in session_columns:
            db.session.execute(text("ALTER TABLE chat_sessions ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT 0"))
            db.session.commit()
            print("[DB] 已添加 chat_sessions.pinned 列")
        if 'sandbox_id' not in session_columns:
            db.session.execute(text("ALTER TABLE chat_sessions ADD COLUMN sandbox_id TEXT"))
            db.session.commit()
            print("[DB] 已添加 chat_sessions.sandbox_id 列")
        usage_columns = [c['name'] for c in inspector.get_columns('campbell_usages')]
        for column, ddl in (
            ('new_input_units', 'ALTER TABLE campbell_usages ADD COLUMN new_input_units FLOAT DEFAULT 0'),
            ('cached_input_units', 'ALTER TABLE campbell_usages ADD COLUMN cached_input_units FLOAT DEFAULT 0'),
            ('output_units', 'ALTER TABLE campbell_usages ADD COLUMN output_units FLOAT DEFAULT 0'),
            ('floor_units', 'ALTER TABLE campbell_usages ADD COLUMN floor_units FLOAT DEFAULT 0'),
            ('estimated', 'ALTER TABLE campbell_usages ADD COLUMN estimated BOOLEAN DEFAULT 0'),
        ):
            if column not in usage_columns:
                db.session.execute(text(ddl))
                db.session.commit()
                print(f"[DB] 已添加 campbell_usages.{column} 列")

        migrated = db.session.execute(text("UPDATE chat_sessions SET model_id = 'campbell' WHERE model_id = 'xiaosuolaoshi'"))
        db.session.commit()
        if (migrated.rowcount or 0) > 0:
            print(f"[DB] 已迁移 {migrated.rowcount} 条会话模型到 campbell")

        # Leo 已下线，历史会话并入 Scooby
        migrated_leo = db.session.execute(text("UPDATE chat_sessions SET model_id = 'scooby' WHERE model_id = 'leo'"))
        db.session.commit()
        if (migrated_leo.rowcount or 0) > 0:
            print(f"[DB] 已迁移 {migrated_leo.rowcount} 条会话模型到 scooby")


init_database()

ai_service = AIService()
asr_service = ASRService()
asr_session_manager = RealtimeASRSessionManager(asr_service)

storage_service = StorageService()


# ============ 应用与中间件 ============

class DatabaseScopeMiddleware:
    """每个 HTTP 请求一个数据库会话作用域，响应（含 SSE 流）发完后回收。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        with db.scope():
            await self.app(scope, receive, send)


app = FastAPI(title="LockAI API", version="1.0.0")
app.add_middleware(DatabaseScopeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def error(message: str, status: int, **extra) -> JSONResponse:
    """前端统一读 error 字段展示错误。"""
    return JSONResponse({"error": message, **extra}, status_code=status)


@app.exception_handler(RequestValidationError)
async def _on_validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(
        {"error": "请求参数格式不正确", "code": "INVALID_REQUEST", "detail": jsonable_encoder(exc.errors())},
        status_code=400,
    )


@app.exception_handler(StarletteHTTPException)
async def _on_http_error(request: Request, exc: StarletteHTTPException):
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(Exception)
async def _on_unhandled_error(request: Request, exc: Exception):
    print(f"[API] 未处理异常 {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    return JSONResponse({"error": "服务器内部错误"}, status_code=500)


def _empty(body) -> bool:
    return body is None or body.is_empty()


# ============ 模型与配额 ============

@app.get("/api/models")
def get_models():
    """获取可用聊天模型列表"""
    return {"models": ai_service.available_models()}


@app.get("/api/usage")
def get_usage(user_id: str | None = None):
    """获取 Campbell 配额用量"""
    if not user_id:
        return error("缺少 user_id", 400)
    return ai_service.usage.get_summary(user_id)


# ============ Session APIs ============

@app.get("/api/sessions")
def get_sessions(user_id: str | None = None):
    """获取用户的所有会话"""
    if not user_id:
        return error("缺少 user_id", 400)

    sessions = (
        ChatSession.query.filter_by(user_id=user_id)
        .order_by(ChatSession.pinned.desc(), ChatSession.updated_at.desc())
        .limit(50)
        .all()
    )
    running = runs.running_sessions(user_id)
    return [{**s.to_dict(), "running": s.id in running} for s in sessions]


@app.post("/api/sessions")
def create_session(body: CreateSessionBody | None = None):
    """创建新会话"""
    body = body or CreateSessionBody()
    if not body.user_id:
        return error("缺少 user_id", 400)

    session = ChatSession(
        id=str(uuid.uuid4()),
        user_id=body.user_id,
        title=body.title,
        model_id=ai_service.normalize_chat_model_id(body.model_id),
    )
    db.session.add(session)
    db.session.commit()
    return JSONResponse(session.to_dict(), status_code=201)


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    """获取会话详情（包含消息）"""
    session = ChatSession.query.get(session_id)
    if not session:
        return error("会话不存在", 404)

    messages = ChatMessage.query.filter_by(session_id=session_id).order_by(ChatMessage.created_at).all()
    result = session.to_dict()
    result['messages'] = [m.to_dict() for m in messages]
    run = runs.get(session_id)
    result['running'] = bool(run and run.active)
    return result


@app.put("/api/sessions/{session_id}")
def update_session(session_id: str, body: UpdateSessionBody | None = None):
    """更新会话（标题 / 模型）"""
    session = ChatSession.query.get(session_id)
    if not session:
        return error("会话不存在", 404)

    body = body or UpdateSessionBody()
    touched = False
    if 'title' in body.model_fields_set:
        session.title = body.title
        touched = True
    if body.model_id:
        session.model_id = ai_service.normalize_chat_model_id(body.model_id)
        touched = True
    if touched or body.pinned is None:
        session.updated_at = datetime.utcnow()
    db.session.commit()
    if body.pinned is not None:
        # 置顶不算"最近活跃"。updated_at 带 onupdate 钩子，必须在 SET 里显式写回原值才不会被刷新
        ChatSession.query.filter_by(id=session_id).update(
            {ChatSession.pinned: body.pinned, ChatSession.updated_at: ChatSession.updated_at},
            synchronize_session=False,
        )
        db.session.commit()
        db.session.refresh(session)
    return session.to_dict()


@app.post("/api/sessions/{session_id}/generate-title")
def generate_session_title(session_id: str, body: GenerateTitleBody | None = None):
    """用 AI 生成会话标题"""
    session = ChatSession.query.get(session_id)
    if not session:
        return error("会话不存在", 404)

    body = body or GenerateTitleBody()
    if not body.user_message:
        return error("缺少消息内容", 400)

    title = ai_service.generate_title(body.user_message, body.assistant_message or "")
    session.title = title
    session.updated_at = datetime.utcnow()
    db.session.commit()
    return {"title": title}


def _session_only_image_keys(session: ChatSession) -> set[str]:
    """这个会话目录下的图片，加上它消息里引用的图片，去掉仍被其他会话（比如分支）引用的。

    用户上传的图不进 GeneratedImage，只按目录找才不会漏；分支会话直接沿用原会话的图片地址，
    所以删之前要确认没有别的会话在用。
    """
    keys = storage_service.list_keys(f"users/{session.user_id}/sessions/{session.id}/")
    keys |= {img.s3_key for img in GeneratedImage.query.filter_by(session_id=session.id)}
    for message in ChatMessage.query.filter_by(session_id=session.id):
        keys |= storage_service.keys_in(message.images, message.files, message.tool_trace, message.content)

    def used_elsewhere(key: str) -> bool:
        pattern = f"%{quote(key)}%"  # 消息里存的是编码后的地址
        return ChatMessage.query.filter(
            ChatMessage.session_id != session.id,
            (ChatMessage.images.like(pattern)) | (ChatMessage.files.like(pattern))
            | (ChatMessage.tool_trace.like(pattern)) | (ChatMessage.content.like(pattern)),
        ).first() is not None

    return {key for key in keys if not used_elsewhere(key)}


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str):
    """删除会话（同时清理只属于这个会话的图片）"""
    session = ChatSession.query.get(session_id)
    if not session:
        return error("会话不存在", 404)

    try:
        for key in _session_only_image_keys(session):
            storage_service.delete_object(key)
    except Exception as e:
        print(f"[S3] 清理图片失败: {e}")
    # 还在回答的话先叫停，不再往要删掉的会话里写
    runs.stop(session.id, "deleted")
    ai_service.sandbox.forget_session(session.id, session.sandbox_id)

    GeneratedImage.query.filter_by(session_id=session_id).delete()
    db.session.delete(session)
    db.session.commit()
    return {"success": True}


@app.post("/api/sessions/{session_id}/branch")
def branch_session(session_id: str, body: TruncateBody | None = None):
    """
    从某条消息处分叉出一个新会话：复制这条消息及之前的全部消息，原会话不动。
    exclusive 时不含这条消息本身：重试 / 改写重发走这里，原来那条回答（可能做了一半的产物）留在原会话里。
    """
    source = ChatSession.query.get(session_id)
    if not source:
        return error("会话不存在", 404)

    body = body or TruncateBody()
    message_id = body.message_id
    if not message_id:
        return error("缺少 message_id", 400)
    target = ChatMessage.query.get(message_id)
    if not target or target.session_id != session_id:
        return error("消息不存在", 404)

    history = (
        ChatMessage.query.filter(
            ChatMessage.session_id == session_id,
            ChatMessage.created_at < target.created_at if body.exclusive else ChatMessage.created_at <= target.created_at,
        )
        .order_by(ChatMessage.created_at)
        .all()
    )
    branch = ChatSession(
        id=str(uuid.uuid4()),
        user_id=source.user_id,
        title=f"{source.title or '新对话'} · {'重试' if body.exclusive else '分支'}"[:100],
        model_id=source.model_id,
    )
    db.session.add(branch)
    for item in history:
        db.session.add(ChatMessage(
            id=str(uuid.uuid4()),
            session_id=branch.id,
            role=item.role,
            content=item.content,
            images=item.images,
            files=item.files,
            tool_trace=item.tool_trace,
            reasoning=item.reasoning,
            reasoning_seconds=item.reasoning_seconds,
            reasoning_tokens=item.reasoning_tokens,
            created_at=item.created_at,
        ))
    db.session.commit()
    ai_service.sandbox.copy_workspace(source.id, branch.id)
    return JSONResponse(branch.to_dict(), status_code=201)


@app.get("/api/users/{user_id}/images")
def get_user_images(user_id: str):
    """获取用户的所有生成图片"""
    images = GeneratedImage.query.filter_by(user_id=user_id).order_by(GeneratedImage.created_at.desc()).limit(100).all()
    return [img.to_dict() for img in images]


@app.post("/api/sessions/{session_id}/truncate")
def truncate_messages(session_id: str, body: TruncateBody | None = None):
    """截断会话消息：删除指定消息及其之后的所有消息"""
    session = ChatSession.query.get(session_id)
    if not session:
        return error("会话不存在", 404)

    message_id = (body or TruncateBody()).message_id
    if not message_id:
        return error("缺少 message_id", 400)

    target = ChatMessage.query.get(message_id)
    if not target or target.session_id != session_id:
        return error("消息不存在", 404)

    ChatMessage.query.filter(
        ChatMessage.session_id == session_id,
        ChatMessage.created_at >= target.created_at
    ).delete()
    session.updated_at = datetime.utcnow()
    db.session.commit()
    return {"success": True}


# 图片是直接给模型看的：前端会压到 2048px / 4MB 以内，GIF 原样传，这里兜底
UPLOAD_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_UPLOAD_IMAGE_BYTES = 12 * 1024 * 1024
# 每条消息直接进上下文的图片上限（要更多就作为文件上传，放进沙箱按需看）
MAX_MESSAGE_IMAGES = 8
# 附件不限数量，只防误操作把整个硬盘拖进来
MAX_MESSAGE_FILES = 2000


def _clean_images(raw: list | None) -> list[str]:
    return [u for u in (raw or []) if isinstance(u, str) and u.startswith("http")][:MAX_MESSAGE_IMAGES]


@app.post("/api/upload-image")
def upload_image(body: UploadImageBody | None = None):
    """上传图片到 S3，返回公开 URL"""
    import base64

    if _empty(body):
        return error("请求体不能为空", 400)

    image_data_url = body.image
    if not image_data_url or not image_data_url.startswith("data:"):
        return error("无效的图片数据", 400)

    try:
        header, b64_data = image_data_url.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
        image_bytes = base64.b64decode(b64_data)
    except Exception:
        return error("无效的图片数据", 400)
    if mime not in UPLOAD_IMAGE_TYPES:
        return error("只支持 JPG、PNG、GIF、WebP 图片", 400)
    if len(image_bytes) > MAX_UPLOAD_IMAGE_BYTES:
        return error("图片超过 12MB", 413)

    result = storage_service.upload_image(
        image_bytes,
        user_id=body.user_id,
        session_id=body.session_id,
        content_type=mime,
    )
    if not result:
        return error("图片上传失败", 500)
    return {"url": result["url"]}


MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024


@app.post("/api/upload-file")
def upload_file(
    file: UploadFile | None = File(default=None),
    user_id: str | None = Form(default=None),
    session_id: str | None = Form(default=None),
    path: str | None = Form(default=None),
):
    """上传任意附件（文档、表格、音视频……），沙箱里处理用。返回 {name, path, url, size, mime}

    path 是上传文件夹时文件在文件夹里的相对路径（如 活动照片/day1/a.jpg），沙箱里按它还原目录结构。
    """
    if file is None or not file.filename:
        return error("缺少文件", 400)
    name = safe_filename(file.filename)
    if not name:
        return error("文件名无效", 400)
    rel = safe_relpath(path or "") or name
    file.file.seek(0, os.SEEK_END)
    size = file.file.tell()
    file.file.seek(0)
    if size > MAX_UPLOAD_FILE_BYTES:
        return error("文件超过 100MB", 413)
    if not storage_service.available:
        return error("存储未配置", 500)
    mime = file.content_type or guess_mime(name)
    key = f"users/{user_id or 'anonymous'}/sessions/{session_id or 'unsorted'}/uploads/{uuid.uuid4().hex[:10]}/{rel}"
    try:
        storage_service._client.upload_fileobj(
            file.file, storage_service.bucket, key, ExtraArgs={"ContentType": mime},
        )
    except Exception as exc:
        print(f"[S3] 附件上传失败: {exc}")
        return error("文件上传失败", 500)
    result = {"name": name, "url": f"{storage_service.public_url}/{quote(key)}", "size": size, "mime": mime}
    if rel != name:
        result["path"] = rel
    return result


def _clean_attachments(raw: list | None) -> list[dict]:
    """只收本桶里的附件地址，字段收窄到前端需要的几个。"""
    cleaned = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "")
        name = safe_filename(item.get("name") or "")
        if not name or not storage_service.public_url or not url.startswith(storage_service.public_url + "/"):
            continue
        entry = {
            "name": name,
            "url": url,
            "size": int(item.get("size") or 0),
            "mime": str(item.get("mime") or guess_mime(name))[:120],
        }
        rel = safe_relpath(item.get("path") or "")
        if rel and rel != name:
            entry["path"] = rel
        cleaned.append(entry)
    return cleaned[:MAX_MESSAGE_FILES]


# ============ ASR APIs ============

@app.post("/api/asr/transcribe")
def transcribe_audio(audio: UploadFile | None = File(default=None)):
    """上传音频并执行语音转写。"""
    if audio is None:
        return error("缺少 audio 文件", 400)

    audio_bytes = audio.file.read()
    if not audio_bytes:
        return error("音频内容不能为空", 400)

    suffix = Path(audio.filename or "").suffix.lower() or f".{asr_service.audio_format}"
    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name
        return asr_service.transcribe_file(temp_path)
    except ASRServiceError as exc:
        return error(str(exc), 503)
    except Exception as exc:
        print(f"[ASR] 转写失败: {type(exc).__name__}: {exc}")
        return error("语音转写失败", 500)
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


@app.post("/api/asr/sessions")
def create_realtime_asr_session():
    """创建实时 ASR 会话。"""
    try:
        session = asr_session_manager.create()
        return JSONResponse({
            "session_id": session.id,
            "sample_rate": asr_service.sample_rate,
            "format": "pcm",
        }, status_code=201)
    except ASRServiceError as exc:
        return error(str(exc), 503)
    except Exception as exc:
        print(f"[ASR] 创建实时会话失败: {type(exc).__name__}: {exc}")
        return error("创建实时语音会话失败", 500)


@app.post("/api/asr/sessions/{session_id}/audio")
def push_realtime_asr_audio(
    session_id: str,
    audio: bytes = Body(default=b"", media_type="application/octet-stream"),
):
    """向实时 ASR 会话发送 PCM 音频分片（请求体是原始字节）。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return error("语音会话不存在", 404)
    if not audio:
        return error("音频分片不能为空", 400)

    try:
        session.push_audio(audio)
        return {"ok": True}
    except ASRServiceError as exc:
        return error(str(exc), 409)
    except Exception as exc:
        print(f"[ASR] 推送音频失败: {type(exc).__name__}: {exc}")
        return error("推送音频失败", 500)


@app.post("/api/asr/sessions/{session_id}/stop")
def stop_realtime_asr_session(session_id: str):
    """结束实时 ASR 会话。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return error("语音会话不存在", 404)

    session.request_stop()
    return {"ok": True, "text": session.text}


@app.post("/api/asr/sessions/{session_id}/cancel")
def cancel_realtime_asr_session(session_id: str):
    """立即截断并关闭实时 ASR 会话。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return error("语音会话不存在", 404)

    text_so_far = session.text
    asr_session_manager.cancel(session_id)
    return {"ok": True, "text": text_so_far}


@app.get("/api/asr/sessions/{session_id}/stream")
def stream_realtime_asr_session(session_id: str, history: str = "1"):
    """SSE 订阅实时 ASR 文本更新。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return error("语音会话不存在", 404)

    q = session.subscribe(include_history=history == "1")

    async def generate():
        try:
            async for event in poll_queue(q, heartbeat=15.0):
                if event is HEARTBEAT:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("type") in {"complete", "error"}:
                    break
        finally:
            session.unsubscribe(q)
            if session.done_event.is_set():
                asr_session_manager.close(session_id)

    return sse_response(generate())


@app.post("/api/sessions/{session_id}/messages")
def add_message(session_id: str, body: AddMessageBody | None = None):
    """添加消息到会话"""
    print(f"[API] 收到添加消息请求: session_id={session_id}")
    session = ChatSession.query.get(session_id)
    if not session:
        print(f"[API] 会话不存在: {session_id}")
        return error("会话不存在", 404)

    body = body or AddMessageBody()
    print(f"[API] 消息数据: role={body.role}, content={(body.content or '')[:50]}...")
    if not body.role:
        return error("缺少 role", 400)

    # images 此时已经是 S3 URL 列表
    image_urls = _clean_images(body.images) if body.role == "user" else body.images
    tool_trace = body.tool_trace
    content = body.content
    files = _clean_attachments(body.files)
    has_content = isinstance(content, str) and bool(content.strip())
    has_images = isinstance(image_urls, list) and len(image_urls) > 0
    has_tool_trace = isinstance(tool_trace, list) and len(tool_trace) > 0

    if not has_content and not has_images and not has_tool_trace and not files:
        return error("消息内容不能为空", 400)

    message = ChatMessage(
        id=body.id or str(uuid.uuid4()),
        session_id=session_id,
        role=body.role,
        content=content if isinstance(content, str) else '',
        images=json.dumps(image_urls) if has_images else None,
        files=json.dumps(files, ensure_ascii=False) if files else None,
        tool_trace=json.dumps(tool_trace, ensure_ascii=False) if has_tool_trace else None,
        reasoning=body.reasoning or None,
        reasoning_seconds=body.reasoning_seconds,
        reasoning_tokens=body.reasoning_tokens,
    )
    db.session.add(message)
    session.updated_at = datetime.utcnow()
    db.session.commit()
    print(f"[API] 消息保存成功: {message.id}")
    return JSONResponse(message.to_dict(), status_code=201)


# ============ Chat APIs ============

def _chat_kwargs(body: ChatBody) -> dict:
    return {
        "model_id": body.model_id or body.ai_role or ai_service.get_default_model_id(),
        "user_id": body.user_id,
        "session_id": body.session_id,
        "thinking": body.thinking,
        "reasoning_effort": body.reasoning_effort,
        "current_message_id": body.current_message_id,
        "image_quality": body.image_quality,
        "files": _clean_attachments(body.files),
        "delivery": body.delivery,
    }


@app.post("/api/chat")
def chat(body: ChatBody | None = None):
    """POST /api/chat (非流式，保留兼容)"""
    if _empty(body):
        return error("请求体不能为空", 400, code="INVALID_REQUEST")
    if not body.message or not body.message.strip():
        return error("消息内容不能为空", 400, code="INVALID_REQUEST")

    result = ""
    for chunk in ai_service.chat_stream(
        body.message,
        body.history or [],
        images=_clean_images(body.images),
        **_chat_kwargs(body),
    ):
        if chunk["type"] == "error":
            return error(chunk["message"], 500)
        if chunk["type"] == "content_delta":
            result += chunk["delta"]
    return {"message": result}


async def _chat_sse(upstream):
    """上游事件转 SSE。每 10 秒没有事件就发一行注释做心跳，
    防止反向代理（nginx / Cloudflare）在长等待（比如高清出图）期间断开连接。"""
    async for item in iterate_in_thread(upstream, heartbeat=10.0):
        if item is HEARTBEAT:
            yield ": keepalive\n\n"
            continue
        if isinstance(item, StreamFailed):
            item = {"type": "error", "message": f"内部异常: {type(item.exc).__name__}: {item.exc}"}
        yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


async def _run_sse(run, *, resume: bool = False, notice: str | None = None):
    """转发一轮后台回答的事件。断开只是少一个观众，回答继续（见 services/runs.py）。"""
    if notice:
        yield f"data: {json.dumps({'type': 'notice', 'message': notice}, ensure_ascii=False)}\n\n"
    async for item in runs.follow(run, resume=resume):
        if item is RUNS_HEARTBEAT:
            yield ": keepalive\n\n"
            continue
        yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/api/chat/stream")
def chat_stream(body: ChatBody | None = None):
    """POST /api/chat/stream (流式 SSE)。有会话的回答在后台跑，关掉页面也会做完。"""
    if _empty(body):
        return error("请求体不能为空", 400)
    if not body.message or not body.message.strip():
        return error("消息内容不能为空", 400)

    def work(run=None):
        return ai_service.chat_stream(
            body.message,
            body.history or [],
            images=_clean_images(body.images),  # S3 公开 URL 列表
            control=run,
            **_chat_kwargs(body),
        )

    session = ChatSession.query.get(body.session_id) if body.session_id else None
    if not session or not body.user_id:
        return sse_response(_chat_sse(work()))

    try:
        run, evicted = runs.start(
            session_id=session.id, user_id=str(body.user_id), title=session.title or "", work=work, evict=body.evict,
        )
    except RunLimit as exc:
        return error(exc.message, 429)
    notice = None
    if evicted:
        notice = f"「{evicted.title or '新对话'}」已停下，做好的部分和工作区都保存了，回到那段对话发「继续」就能接着做"
    return sse_response(_run_sse(run, notice=notice))


@app.get("/api/chat/runs")
def running_chats(user_id: str | None = None):
    """这个用户正在后台回答的会话（跑得最久的在前），以及同时回答的上限"""
    if not user_id:
        return error("缺少 user_id", 400)
    return {
        "limit": RUNS_PER_USER,
        "runs": [
            {"session_id": r.session_id, "title": r.title, "started_at": int(r.started_at * 1000)}
            for r in runs.running(user_id)
        ],
    }


@app.get("/api/chat/runs/{session_id}/events")
def resume_chat(session_id: str):
    """回到正在回答的会话：先重放已有的事件，再接着推实时的"""
    run = runs.get(session_id)
    if not run:
        return error("这段对话现在没有在回答", 404)
    return sse_response(_run_sse(run, resume=True))


@app.post("/api/chat/runs/{session_id}/stop")
def stop_chat(session_id: str, body: StopRunBody | None = None):
    """停止正在回答的会话。discard=True 时连已写的部分也不保存（重新生成、编辑前用）"""
    reason = "discard" if body and body.discard else "user"
    return {"stopped": runs.stop(session_id, reason)}


@app.post("/api/chat/suggestions")
def chat_suggestions(body: SuggestionsBody | None = None):
    """根据最后一轮问答生成 3 条追问建议（走免费的小模型，失败时返回空列表）"""
    body = body or SuggestionsBody()
    if not (body.user_message or "").strip() or not (body.assistant_message or "").strip():
        return {"suggestions": []}
    return {"suggestions": ai_service.suggest_followups(body.user_message, body.assistant_message)}


@app.get("/health")
def health():
    """Health check endpoint"""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 5003))
    reload = os.environ.get("DEV_RELOAD", os.environ.get("FLASK_DEBUG", "false")).lower() == "true"
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=reload)
