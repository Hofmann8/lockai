"""
LockAI Flask Backend
Main application entry point with API routes for chat and paper assistance.
"""

import os
import json
import uuid
import tempfile
from datetime import datetime
from pathlib import Path
from queue import Empty
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from dotenv import load_dotenv

from models import db, ChatSession, ChatMessage, GeneratedImage, PaperRecord
from services.ai import AIService
from services.asr import ASRService, ASRServiceError, RealtimeASRSessionManager
from services.llm import LLMService
from services.storage import StorageService
from services.paper import PaperService, SessionManager, PaperStatus
from services.terminal import paper_events

load_dotenv()

app = Flask(__name__)
CORS(app, origins=[
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3003", 
    "http://127.0.0.1:3003",
    "https://ai.funk-and.love"
])

# Database configuration
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///lockai.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db.init_app(app)

# Create tables
with app.app_context():
    db.create_all()
    # 轻量 schema backfill（SQLite 无 migration）
    from sqlalchemy import inspect, text
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
    session_columns = [c['name'] for c in inspector.get_columns('chat_sessions')]
    if 'model_id' not in session_columns:
        db.session.execute(text("ALTER TABLE chat_sessions ADD COLUMN model_id TEXT DEFAULT 'campbell'"))
        db.session.commit()
        print("[DB] 已添加 chat_sessions.model_id 列")
    migrated = db.session.execute(text("UPDATE chat_sessions SET model_id = 'campbell' WHERE model_id = 'xiaosuolaoshi'"))
    db.session.commit()
    if (migrated.rowcount or 0) > 0:
        print(f"[DB] 已迁移 {migrated.rowcount} 条会话模型到 campbell")

ai_service = AIService()
asr_service = ASRService()
asr_session_manager = RealtimeASRSessionManager(asr_service)

# Paper generation service
llm_service = LLMService()
storage_service = StorageService()
paper_service = PaperService(llm_service, storage_service, app=app)

# Dev terminal (调试用，不暴露在主页面)
from dev_routes import dev_bp
app.register_blueprint(dev_bp)


@app.route("/api/models", methods=["GET"])
def get_models():
    """获取可用聊天模型列表"""
    return jsonify({"models": ai_service.available_models()})


# ============ Session APIs ============

@app.route("/api/sessions", methods=["GET"])
def get_sessions():
    """获取用户的所有会话"""
    user_id = request.args.get('user_id')
    if not user_id:
        return jsonify({"error": "缺少 user_id"}), 400
    
    sessions = ChatSession.query.filter_by(user_id=user_id).order_by(ChatSession.updated_at.desc()).limit(50).all()
    return jsonify([s.to_dict() for s in sessions])


@app.route("/api/sessions", methods=["POST"])
def create_session():
    """创建新会话"""
    data = request.get_json() or {}
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({"error": "缺少 user_id"}), 400

    model_id = ai_service.normalize_chat_model_id(data.get('model_id'))
    
    session = ChatSession(
        id=str(uuid.uuid4()),
        user_id=user_id,
        title=data.get('title', '新对话'),
        model_id=model_id,
    )
    db.session.add(session)
    db.session.commit()
    return jsonify(session.to_dict()), 201


@app.route("/api/sessions/<session_id>", methods=["GET"])
def get_session(session_id):
    """获取会话详情（包含消息）"""
    session = ChatSession.query.get(session_id)
    if not session:
        return jsonify({"error": "会话不存在"}), 404
    
    messages = ChatMessage.query.filter_by(session_id=session_id).order_by(ChatMessage.created_at).all()
    result = session.to_dict()
    result['messages'] = [m.to_dict() for m in messages]
    return jsonify(result)


@app.route("/api/sessions/<session_id>", methods=["PUT"])
def update_session(session_id):
    """更新会话（标题）"""
    session = ChatSession.query.get(session_id)
    if not session:
        return jsonify({"error": "会话不存在"}), 404
    
    data = request.get_json() or {}
    if 'title' in data:
        session.title = data['title']
    if data.get('model_id'):
        session.model_id = ai_service.normalize_chat_model_id(data['model_id'])
    session.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(session.to_dict())


@app.route("/api/sessions/<session_id>/generate-title", methods=["POST"])
def generate_session_title(session_id):
    """用 AI 生成会话标题"""
    session = ChatSession.query.get(session_id)
    if not session:
        return jsonify({"error": "会话不存在"}), 404
    
    data = request.get_json() or {}
    user_message = data.get('user_message', '')
    assistant_message = data.get('assistant_message', '')
    
    if not user_message:
        return jsonify({"error": "缺少消息内容"}), 400
    
    title = ai_service.generate_title(user_message, assistant_message)
    session.title = title
    session.updated_at = datetime.utcnow()
    db.session.commit()
    
    return jsonify({"title": title})


@app.route("/api/sessions/<session_id>", methods=["DELETE"])
def delete_session(session_id):
    """删除会话（同时清理 S3 图片）"""
    session = ChatSession.query.get(session_id)
    if not session:
        return jsonify({"error": "会话不存在"}), 404
    
    # 获取该会话的所有图片记录
    images = GeneratedImage.query.filter_by(session_id=session_id).all()
    
    # 删除 S3 上的图片
    if images:
        try:
            s3_client = ai_service._s3_client
            bucket = os.environ.get("S3_BUCKET")
            if s3_client and bucket:
                for img in images:
                    try:
                        s3_client.delete_object(Bucket=bucket, Key=img.s3_key)
                        print(f"[S3] 删除图片: {img.s3_key}")
                    except Exception as e:
                        print(f"[S3] 删除图片失败: {e}")
        except Exception as e:
            print(f"[S3] 清理图片失败: {e}")
    
    # 删除图片记录
    GeneratedImage.query.filter_by(session_id=session_id).delete()
    
    # 删除会话
    db.session.delete(session)
    db.session.commit()
    return jsonify({"success": True})


@app.route("/api/users/<user_id>/images", methods=["GET"])
def get_user_images(user_id):
    """获取用户的所有生成图片"""
    images = GeneratedImage.query.filter_by(user_id=user_id).order_by(GeneratedImage.created_at.desc()).limit(100).all()
    return jsonify([img.to_dict() for img in images])


@app.route("/api/sessions/<session_id>/truncate", methods=["POST"])
def truncate_messages(session_id):
    """截断会话消息：删除指定消息及其之后的所有消息"""
    session = ChatSession.query.get(session_id)
    if not session:
        return jsonify({"error": "会话不存在"}), 404

    data = request.get_json() or {}
    message_id = data.get("message_id")
    if not message_id:
        return jsonify({"error": "缺少 message_id"}), 400

    target = ChatMessage.query.get(message_id)
    if not target or target.session_id != session_id:
        return jsonify({"error": "消息不存在"}), 404

    # 删除该消息及之后的所有消息
    ChatMessage.query.filter(
        ChatMessage.session_id == session_id,
        ChatMessage.created_at >= target.created_at
    ).delete()
    session.updated_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"success": True})


@app.route("/api/upload-image", methods=["POST"])
def upload_image():
    """上传图片到 S3，返回公开 URL"""
    import base64
    data = request.get_json()
    if not data:
        return jsonify({"error": "请求体不能为空"}), 400

    image_data_url = data.get("image")
    user_id = data.get("user_id")
    session_id = data.get("session_id")

    if not image_data_url or not image_data_url.startswith("data:"):
        return jsonify({"error": "无效的图片数据"}), 400

    header, b64_data = image_data_url.split(",", 1)
    mime = header.split(":")[1].split(";")[0]
    image_bytes = base64.b64decode(b64_data)

    result = storage_service.upload_image(
        image_bytes,
        user_id=user_id,
        session_id=session_id,
        content_type=mime,
    )
    if not result:
        return jsonify({"error": "图片上传失败"}), 500

    return jsonify({"url": result["url"]})


@app.route("/api/asr/transcribe", methods=["POST"])
def transcribe_audio():
    """上传音频并执行语音转写。"""
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "缺少 audio 文件"}), 400

    audio_bytes = audio.read()
    if not audio_bytes:
        return jsonify({"error": "音频内容不能为空"}), 400

    suffix = Path(audio.filename or "").suffix.lower() or f".{asr_service.audio_format}"
    temp_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_file.write(audio_bytes)
            temp_path = temp_file.name

        result = asr_service.transcribe_file(temp_path)
        return jsonify(result)
    except ASRServiceError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        print(f"[ASR] 转写失败: {type(exc).__name__}: {exc}")
        return jsonify({"error": "语音转写失败"}), 500
    finally:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass


@app.route("/api/asr/sessions", methods=["POST"])
def create_realtime_asr_session():
    """创建实时 ASR 会话。"""
    try:
        session = asr_session_manager.create()
        return jsonify({
            "session_id": session.id,
            "sample_rate": asr_service.sample_rate,
            "format": "pcm",
        }), 201
    except ASRServiceError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        print(f"[ASR] 创建实时会话失败: {type(exc).__name__}: {exc}")
        return jsonify({"error": "创建实时语音会话失败"}), 500


@app.route("/api/asr/sessions/<session_id>/audio", methods=["POST"])
def push_realtime_asr_audio(session_id):
    """向实时 ASR 会话发送 PCM 音频分片。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return jsonify({"error": "语音会话不存在"}), 404

    audio_bytes = request.get_data(cache=False)
    if not audio_bytes:
        return jsonify({"error": "音频分片不能为空"}), 400

    try:
        session.push_audio(audio_bytes)
        return jsonify({"ok": True})
    except ASRServiceError as exc:
        return jsonify({"error": str(exc)}), 409
    except Exception as exc:
        print(f"[ASR] 推送音频失败: {type(exc).__name__}: {exc}")
        return jsonify({"error": "推送音频失败"}), 500


@app.route("/api/asr/sessions/<session_id>/stop", methods=["POST"])
def stop_realtime_asr_session(session_id):
    """结束实时 ASR 会话。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return jsonify({"error": "语音会话不存在"}), 404

    session.request_stop()
    return jsonify({"ok": True, "text": session.text})


@app.route("/api/asr/sessions/<session_id>/cancel", methods=["POST"])
def cancel_realtime_asr_session(session_id):
    """立即截断并关闭实时 ASR 会话。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return jsonify({"error": "语音会话不存在"}), 404

    text = session.text
    asr_session_manager.cancel(session_id)
    return jsonify({"ok": True, "text": text})


@app.route("/api/asr/sessions/<session_id>/stream", methods=["GET"])
def stream_realtime_asr_session(session_id):
    """SSE 订阅实时 ASR 文本更新。"""
    session = asr_session_manager.get(session_id)
    if not session:
        return jsonify({"error": "语音会话不存在"}), 404

    include_history = request.args.get("history", "1") == "1"
    q = session.subscribe(include_history=include_history)

    def generate():
        try:
            while True:
                try:
                    event = q.get(timeout=15)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    if event.get("type") in {"complete", "error"}:
                        break
                except Empty:
                    yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
        except GeneratorExit:
            pass
        finally:
            session.unsubscribe(q)
            if session.done_event.is_set():
                asr_session_manager.close(session_id)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/sessions/<session_id>/messages", methods=["POST"])
def add_message(session_id):
    """添加消息到会话"""
    print(f"[API] 收到添加消息请求: session_id={session_id}")
    session = ChatSession.query.get(session_id)
    if not session:
        print(f"[API] 会话不存在: {session_id}")
        return jsonify({"error": "会话不存在"}), 404
    
    data = request.get_json() or {}
    print(f"[API] 消息数据: role={data.get('role')}, content={data.get('content', '')[:50]}...")
    if not data.get('role'):
        return jsonify({"error": "缺少 role"}), 400
    
    # images 此时已经是 S3 URL 列表
    image_urls = data.get('images')
    tool_trace = data.get('tool_trace')
    content = data.get('content')
    has_content = isinstance(content, str) and bool(content.strip())
    has_images = isinstance(image_urls, list) and len(image_urls) > 0
    has_tool_trace = isinstance(tool_trace, list) and len(tool_trace) > 0

    if not has_content and not has_images and not has_tool_trace:
        return jsonify({"error": "消息内容不能为空"}), 400

    images_json = json.dumps(image_urls) if has_images else None
    tool_trace_json = json.dumps(tool_trace, ensure_ascii=False) if isinstance(tool_trace, list) and tool_trace else None
    
    message = ChatMessage(
        id=data.get('id', str(uuid.uuid4())),
        session_id=session_id,
        role=data['role'],
        content=content if isinstance(content, str) else '',
        images=images_json,
        tool_trace=tool_trace_json,
    )
    db.session.add(message)
    session.updated_at = datetime.utcnow()
    db.session.commit()
    print(f"[API] 消息保存成功: {message.id}")
    return jsonify(message.to_dict()), 201


# ============ Chat APIs ============

@app.route("/api/chat", methods=["POST"])
def chat():
    """POST /api/chat (非流式，保留兼容)"""
    data = request.get_json()
    
    if not data:
        return jsonify({"error": "请求体不能为空", "code": "INVALID_REQUEST"}), 400
    
    message = data.get("message")
    if not message or not isinstance(message, str) or not message.strip():
        return jsonify({"error": "消息内容不能为空", "code": "INVALID_REQUEST"}), 400
    
    history = data.get("history", [])
    model_id = data.get("model_id") or data.get("ai_role") or ai_service.get_default_model_id()
    user_id = data.get("user_id")
    session_id = data.get("session_id")
    images = data.get("images") or []
    thinking = data.get("thinking")
    current_message_id = data.get("current_message_id")
    
    result = ""
    for chunk in ai_service.chat_stream(
        message,
        history,
        model_id=model_id,
        user_id=user_id,
        session_id=session_id,
        images=images,
        thinking=thinking,
        current_message_id=current_message_id,
    ):
        if chunk["type"] == "error":
            return jsonify({"error": chunk["message"]}), 500
        if chunk["type"] == "content_delta":
            result += chunk["delta"]
    
    return jsonify({"message": result})


@app.route("/api/chat/stream", methods=["POST"])
def chat_stream():
    """POST /api/chat/stream (流式 SSE)"""
    data = request.get_json()
    
    if not data:
        return jsonify({"error": "请求体不能为空"}), 400
    
    message = data.get("message")
    if not message or not isinstance(message, str) or not message.strip():
        return jsonify({"error": "消息内容不能为空"}), 400
    
    history = data.get("history", [])
    model_id = data.get("model_id") or data.get("ai_role") or ai_service.get_default_model_id()
    user_id = data.get("user_id")
    session_id = data.get("session_id")
    images = data.get("images")  # S3 公开 URL 列表
    thinking = data.get("thinking")
    current_message_id = data.get("current_message_id")
    
    def generate():
        for chunk in ai_service.chat_stream(
            message,
            history,
            model_id=model_id,
            user_id=user_id,
            session_id=session_id,
            images=images,
            thinking=thinking,
            current_message_id=current_message_id,
        ):
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
    
    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@app.route("/api/paper/assist", methods=["POST"])
def paper_assist():
    """POST /api/paper/assist"""
    data = request.get_json()
    
    if not data:
        return jsonify({"error": "请求体不能为空", "code": "INVALID_REQUEST"}), 400
    
    text = data.get("text")
    if not text or not isinstance(text, str) or not text.strip():
        return jsonify({"error": "文本内容不能为空", "code": "INVALID_REQUEST"}), 400
    
    action = data.get("action")
    valid_actions = ["explain", "summarize", "translate"]
    if not action or action not in valid_actions:
        return jsonify({
            "error": f"操作类型无效，必须是: {', '.join(valid_actions)}",
            "code": "INVALID_REQUEST"
        }), 400
    
    result = ai_service.paper_assist(text, action)
    
    if "error" in result:
        error_code = result.get("code", "INTERNAL_ERROR")
        status_code = 429 if error_code == "RATE_LIMITED" else 503 if error_code == "SERVICE_UNAVAILABLE" else 500
        return jsonify(result), status_code
    
    return jsonify(result)


# ============ Paper Generation APIs ============

PAPER_PLAN_SYSTEM_PROMPT = """你是 LockAI 的学术论文规划助手。你的任务是和用户讨论论文主题，帮助他们明确研究方向、论文结构、格式规范和关键内容。

当用户提出研究主题后，你需要完成以下工作：

1. 分析主题的可行性和研究价值，给出简要评估
2. 根据用户的研究方向，推荐合适的引用格式（如 IEEE、APA、GB/T 7714 等），并说明推荐理由
3. 确认论文的基本格式要素（默认全部包含，除非用户明确不需要）：
   - 摘要（中英文）
   - 关键词
   - 目录
   - 参考文献列表
   - 致谢（可选）
4. 提出论文的建议结构（章节安排、每章重点、预估篇幅）
5. 讨论可能的研究方法、关键论点、参考方向
6. 根据用户反馈不断调整方案

回复风格：
- 简洁专业，不啰嗦
- 用 Markdown 格式组织内容，方便阅读
- 每次回复末尾用一个简短的「当前方案摘要」总结已确定的要点（主题、结构、引用格式、格式要素等）
- 如果用户的想法不够具体，主动提问引导
- 对于格式要素，如果用户没有特别说明，默认包含摘要和目录，不需要反复确认

注意：你只负责规划和讨论，不要生成 LaTeX 代码。用户确认方案后会进入自动生成流程。"""


@app.route("/api/paper/create", methods=["POST"])
def paper_create():
    """POST /api/paper/create — 创建论文规划记录（planning_chat 状态）"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "请求体不能为空"}), 400

    topic = data.get("topic", "").strip()
    if not topic:
        return jsonify({"error": "主题不能为空"}), 400

    user_id = data.get("user_id", "anonymous")
    paper_id = str(uuid.uuid4().hex)

    record = PaperRecord(
        id=paper_id,
        user_id=user_id,
        topic=topic,
        status="planning_chat",
        progress_detail="规划讨论中...",
    )
    db.session.add(record)
    db.session.commit()

    paper_events.emit(paper_id, "created", topic=topic, user_id=user_id)

    return jsonify({"paper_id": paper_id}), 201


@app.route("/api/paper/<paper_id>/planning-messages", methods=["PUT"])
def paper_save_planning_messages(paper_id):
    """PUT /api/paper/<paper_id>/planning-messages — 保存规划对话消息"""
    record = PaperRecord.query.get(paper_id)
    if not record:
        return jsonify({"error": "论文不存在"}), 404

    data = request.get_json()
    messages = data.get("messages", [])
    record.planning_messages = json.dumps(messages, ensure_ascii=False)
    # 用第一条用户消息更新 topic
    first_user = next((m for m in messages if m.get("role") == "user"), None)
    if first_user:
        record.topic = first_user["content"][:500]
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/paper/<paper_id>/planning-messages", methods=["GET"])
def paper_get_planning_messages(paper_id):
    """GET /api/paper/<paper_id>/planning-messages — 获取规划对话消息"""
    record = PaperRecord.query.get(paper_id)
    if not record:
        return jsonify({"error": "论文不存在"}), 404

    messages = []
    if record.planning_messages:
        messages = json.loads(record.planning_messages)
    return jsonify({"messages": messages})


@app.route("/api/paper/plan/chat", methods=["POST"])
def paper_plan_chat():
    """POST /api/paper/plan/chat — 论文规划对话（流式 SSE）"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "请求体不能为空"}), 400

    messages = data.get("messages", [])
    if not messages:
        return jsonify({"error": "消息不能为空"}), 400

    # 构建 LLM 消息
    llm_messages = [{"role": "system", "content": PAPER_PLAN_SYSTEM_PROMPT}]
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role in ("user", "assistant") and content:
            llm_messages.append({"role": role, "content": content})

    paper_model = os.environ.get("MODEL_PAPER_PLANNER") or llm_service.model_primary

    def generate():
        for chunk in llm_service.stream(llm_messages, model=paper_model):
            if chunk.get("type") == "content":
                yield f"event: content\ndata: {json.dumps({'content': chunk['content']})}\n\n"
            elif chunk.get("type") == "error":
                yield f"event: error\ndata: {json.dumps({'error': chunk['content']})}\n\n"
        yield f"event: done\ndata: {{}}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/paper/generate", methods=["POST"])
def paper_generate():
    """POST /api/paper/generate — 提交论文生成任务（后台执行）"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "请求体不能为空"}), 400

    topic = data.get("topic")
    if not topic or not isinstance(topic, str) or not topic.strip():
        return jsonify({"error": "研究主题不能为空"}), 400

    user_id = data.get("user_id", "anonymous")
    design_context = data.get("design_context", "")
    paper_id = data.get("paper_id")  # 可选：从规划阶段传入已有 paper_id

    result_id = paper_service.start_generate(
        user_id, topic.strip(),
        design_context=design_context,
        paper_id=paper_id,
    )

    paper_events.emit(result_id, "generate_start", topic=topic.strip(), user_id=user_id)

    return jsonify({"paper_id": result_id}), 202


@app.route("/api/paper/<paper_id>/status", methods=["GET"])
def paper_status(paper_id):
    """GET /api/paper/<paper_id>/status — 查询论文生成状态"""
    # 先查内存中的活跃 session
    session = SessionManager.get(paper_id)
    if session:
        return jsonify({
            "id": session.id,
            "topic": session.topic,
            "status": session.status.value,
            "progress_detail": session.progress_detail,
            "pdf_url": session.pdf_url,
            "error": session.error,
        })

    # 再查数据库
    record = PaperRecord.query.get(paper_id)
    if not record:
        return jsonify({"error": "论文不存在"}), 404

    # 兜底：DB 里是进行中状态，但内存 session 不存在，说明任务已中断。
    terminal_statuses = {PaperStatus.COMPLETED.value, PaperStatus.FAILED.value, PaperStatus.PLANNING_CHAT.value}
    if record.status not in terminal_statuses:
        record.status = PaperStatus.FAILED.value
        if not record.error:
            record.error = "任务已中断（服务重启或连接断开），请重新生成"
        db.session.commit()

    return jsonify(record.to_dict())


@app.route("/api/paper/<paper_id>/download", methods=["GET"])
def paper_download(paper_id):
    """GET /api/paper/<paper_id>/download — 获取 PDF 下载链接"""
    record = PaperRecord.query.get(paper_id)
    if not record:
        return jsonify({"error": "论文不存在"}), 404
    if not record.pdf_url:
        return jsonify({"error": "PDF 尚未生成"}), 404

    return jsonify({"pdf_url": record.pdf_url})


@app.route("/api/paper/<paper_id>/pdf", methods=["GET"])
def paper_pdf_proxy(paper_id):
    """GET /api/paper/<paper_id>/pdf — 代理 PDF 内容（预览用 inline，下载用 attachment）"""
    record = PaperRecord.query.get(paper_id)
    if not record:
        return jsonify({"error": "论文不存在"}), 404
    if not record.pdf_s3_key:
        return jsonify({"error": "PDF 尚未生成"}), 404

    pdf_bytes = storage_service.download_bytes(record.pdf_s3_key)
    if not pdf_bytes:
        return jsonify({"error": "PDF 下载失败"}), 502

    is_download = request.args.get("download") == "1"
    disposition = "attachment; filename=paper.pdf" if is_download else "inline"

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "public, max-age=3600",
        },
    )


@app.route("/api/paper/<paper_id>", methods=["DELETE"])
def paper_delete(paper_id):
    """DELETE /api/paper/<paper_id> — 删除论文（DB 记录 + S3 文件）"""
    record = PaperRecord.query.get(paper_id)
    if not record:
        return jsonify({"error": "论文不存在"}), 404

    # 删除 S3 上的 PDF 和 VFS 快照
    deleted_keys = []
    for key in [record.pdf_s3_key, record.vfs_s3_key]:
        if key:
            if storage_service.delete_object(key):
                deleted_keys.append(key)

    # 删除数据库记录
    db.session.delete(record)
    db.session.commit()

    print(f"[Paper] 已删除论文 {paper_id}，清理 S3: {deleted_keys}")
    return jsonify({"success": True, "deleted_s3_keys": deleted_keys})


@app.route("/api/paper/<paper_id>/files", methods=["GET"])
def paper_files(paper_id):
    """GET /api/paper/<paper_id>/files — 获取论文 VFS 文件列表"""
    from services.paper import restore_session
    session = restore_session(paper_id, storage_service, db)
    if not session:
        return jsonify({"error": "论文不存在或数据已丢失"}), 404

    return jsonify({
        "id": session.id,
        "topic": session.topic,
        "files": session.vfs.list_files(),
    })


@app.route("/api/paper/<paper_id>/files/<path:file_path>", methods=["GET"])
def paper_file_content(paper_id, file_path):
    """GET /api/paper/<paper_id>/files/<path> — 读取论文 VFS 中的单个文件"""
    from services.paper import restore_session
    session = restore_session(paper_id, storage_service, db)
    if not session:
        return jsonify({"error": "论文不存在或数据已丢失"}), 404

    content = session.vfs.read(file_path)
    if content is None:
        return jsonify({"error": f"文件 {file_path} 不存在"}), 404

    return jsonify({"path": file_path, "content": content})


@app.route("/api/paper/<paper_id>/revise", methods=["POST"])
def paper_revise(paper_id):
    """POST /api/paper/<paper_id>/revise — 提交论文修订任务（后台执行）"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "请求体不能为空"}), 400

    instruction = data.get("instruction")
    if not instruction or not isinstance(instruction, str) or not instruction.strip():
        return jsonify({"error": "修改指令不能为空"}), 400

    ok = paper_service.start_revise(paper_id, instruction.strip())
    if not ok:
        return jsonify({"error": "论文不存在或数据已丢失"}), 404

    return jsonify({"paper_id": paper_id}), 202


@app.route("/api/paper/<paper_id>/retry", methods=["POST"])
def paper_retry(paper_id):
    """POST /api/paper/<paper_id>/retry — 从失败阶段恢复生成"""
    ok = paper_service.start_retry(paper_id)
    if not ok:
        return jsonify({"error": "论文不存在或无法恢复，请重新生成"}), 404

    return jsonify({"paper_id": paper_id}), 202


@app.route("/api/papers", methods=["GET"])
def list_papers():
    """GET /api/papers — 列出用户的所有论文"""
    user_id = request.args.get("user_id")
    if not user_id:
        return jsonify({"error": "缺少 user_id"}), 400

    papers = (
        PaperRecord.query.filter_by(user_id=user_id)
        .order_by(PaperRecord.created_at.desc())
        .limit(50)
        .all()
    )
    return jsonify([p.to_dict() for p in papers])


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5003))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
