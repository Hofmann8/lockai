"""
LockAI Flask Backend
Main application entry point with API routes for chat and paper assistance.
"""

import os
import json
import uuid
from flask import Flask, request, jsonify, Response
from flask_cors import CORS
from dotenv import load_dotenv

from models import db, ChatSession, ChatMessage, GeneratedImage, PaperRecord
from services.ai import AIService
from services.llm import LLMService
from services.storage import StorageService
from services.paper import PaperService, SessionManager, PaperStatus

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
    # 确保 chat_messages 表有 images 列（SQLite 不会自动加新列）
    from sqlalchemy import inspect, text
    inspector = inspect(db.engine)
    columns = [c['name'] for c in inspector.get_columns('chat_messages')]
    if 'images' not in columns:
        db.session.execute(text('ALTER TABLE chat_messages ADD COLUMN images TEXT'))
        db.session.commit()
        print("[DB] 已添加 chat_messages.images 列")

ai_service = AIService()

# Paper generation service
llm_service = LLMService()
storage_service = StorageService()
paper_service = PaperService(llm_service, storage_service, app=app)


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
    data = request.get_json()
    user_id = data.get('user_id')
    if not user_id:
        return jsonify({"error": "缺少 user_id"}), 400
    
    session = ChatSession(
        id=str(uuid.uuid4()),
        user_id=user_id,
        title=data.get('title', '新对话')
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
    
    data = request.get_json()
    if 'title' in data:
        session.title = data['title']
    db.session.commit()
    return jsonify(session.to_dict())


@app.route("/api/sessions/<session_id>/generate-title", methods=["POST"])
def generate_session_title(session_id):
    """用 AI 生成会话标题"""
    session = ChatSession.query.get(session_id)
    if not session:
        return jsonify({"error": "会话不存在"}), 404
    
    data = request.get_json()
    user_message = data.get('user_message', '')
    assistant_message = data.get('assistant_message', '')
    
    if not user_message:
        return jsonify({"error": "缺少消息内容"}), 400
    
    title = ai_service.generate_title(user_message, assistant_message)
    session.title = title
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

    data = request.get_json()
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


@app.route("/api/sessions/<session_id>/messages", methods=["POST"])
def add_message(session_id):
    """添加消息到会话"""
    print(f"[API] 收到添加消息请求: session_id={session_id}")
    session = ChatSession.query.get(session_id)
    if not session:
        print(f"[API] 会话不存在: {session_id}")
        return jsonify({"error": "会话不存在"}), 404
    
    data = request.get_json()
    print(f"[API] 消息数据: role={data.get('role')}, content={data.get('content', '')[:50]}...")
    if not data.get('role') or not data.get('content'):
        return jsonify({"error": "缺少 role 或 content"}), 400
    
    # images 此时已经是 S3 URL 列表
    image_urls = data.get('images')
    images_json = json.dumps(image_urls) if image_urls else None
    
    message = ChatMessage(
        id=data.get('id', str(uuid.uuid4())),
        session_id=session_id,
        role=data['role'],
        content=data['content'],
        images=images_json,
    )
    db.session.add(message)
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
    
    result = ""
    for chunk in ai_service.chat_stream(message, history):
        if chunk["type"] == "error":
            return jsonify({"error": chunk["content"]}), 500
        if chunk["type"] in ["content", "search_result"]:
            result += chunk["content"]
    
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
    ai_role = data.get("ai_role", "xiaosuolaoshi")
    user_id = data.get("user_id")
    session_id = data.get("session_id")
    images = data.get("images")  # S3 公开 URL 列表
    
    def generate():
        for chunk in ai_service.chat_stream(message, history, ai_role, user_id, session_id, images=images):
            event_type = chunk["type"]
            
            if event_type == "content":
                yield f"event: content\ndata: {json.dumps({'content': chunk['content']})}\n\n"
            elif event_type == "searching":
                yield f"event: searching\ndata: {json.dumps({'query': chunk['content']})}\n\n"
            elif event_type == "search_progress":
                yield f"event: search_progress\ndata: {json.dumps({'keywords': chunk['keywords']})}\n\n"
            elif event_type == "search_complete":
                yield f"event: search_complete\ndata: {{}}\n\n"
            elif event_type == "drawing":
                yield f"event: drawing\ndata: {json.dumps({'prompt': chunk['content']})}\n\n"
            elif event_type == "image":
                # 保存图片记录到数据库
                if chunk.get("s3_key") and user_id:
                    try:
                        img = GeneratedImage(
                            id=chunk.get("image_id", str(uuid.uuid4())),
                            user_id=user_id,
                            session_id=session_id,
                            prompt=chunk.get("prompt"),
                            s3_key=chunk["s3_key"],
                            url=chunk["content"]
                        )
                        db.session.add(img)
                        db.session.commit()
                    except Exception as e:
                        print(f"[DB] 保存图片记录失败: {e}")
                
                yield f"event: image\ndata: {json.dumps({'image': chunk['content']})}\n\n"
            elif event_type == "error":
                yield f"event: error\ndata: {json.dumps({'error': chunk['content']})}\n\n"
            elif event_type == "done":
                yield f"event: done\ndata: {{}}\n\n"
    
    return Response(
        generate(),
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
        generate(),
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
