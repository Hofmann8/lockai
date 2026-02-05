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

from models import db, ChatSession, ChatMessage, GeneratedImage
from services.ai import AIService

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

ai_service = AIService()


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
    
    message = ChatMessage(
        id=data.get('id', str(uuid.uuid4())),
        session_id=session_id,
        role=data['role'],
        content=data['content']
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
    
    def generate():
        for chunk in ai_service.chat_stream(message, history, ai_role, user_id, session_id):
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


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5003))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
