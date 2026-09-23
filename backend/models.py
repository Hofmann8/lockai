"""
Database Models
"""

import json
import re
from datetime import datetime, timezone

from database import db


TOOL_MARKER_RE = re.compile(r'<!--tool:(\d+)-->')
MARKDOWN_IMAGE_RE = re.compile(r'!\[[^\]]*]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)')
THINKING_BLOCK_RE = re.compile(r'<(?:think|thinking|analysis)\b[^>]*>.*?</(?:think|thinking|analysis)>', re.IGNORECASE | re.DOTALL)
SPECIAL_REASONING_TOKEN_RE = re.compile(r'<\|.*?\|>')


def _tool_image_urls(trace):
    urls = set()
    for item in trace or []:
        if item.get('kind') != 'image_gen':
            continue
        image_url = (item.get('url') or '').strip()
        if image_url:
            urls.add(image_url)
        preview_url = (item.get('previewUrl') or '').strip()
        if preview_url:
            urls.add(preview_url)
    return urls


def _inject_legacy_tool_markers(content, trace):
    safe_content = content or ''
    if not trace or TOOL_MARKER_RE.search(safe_content):
        return safe_content

    insertions = []
    for idx, item in enumerate(trace):
        if item.get('kind') != 'image_gen':
            insertions.append((len(safe_content), idx))
            continue
        image_url = (item.get('url') or '').strip()
        if image_url:
            image_md = f"![生成的图片]({image_url})"
            image_pos = safe_content.find(image_md)
            if image_pos >= 0:
                insertions.append((image_pos, idx))
                continue
        insertions.append((len(safe_content), idx))

    patched = safe_content
    for pos, idx in sorted(insertions, reverse=True):
        patched = f"{patched[:pos]}<!--tool:{idx}-->{patched[pos:]}"
    return patched


def strip_assistant_reasoning(content):
    safe_content = str(content or '')
    if not safe_content:
        return ''

    cleaned = THINKING_BLOCK_RE.sub('', safe_content)
    cleaned = SPECIAL_REASONING_TOKEN_RE.sub('', cleaned)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip()


def sanitize_assistant_content(content, trace):
    safe_content = strip_assistant_reasoning(content)
    safe_content = _inject_legacy_tool_markers(safe_content, trace)
    image_urls = _tool_image_urls(trace)
    if not safe_content or not image_urls:
        return safe_content

    kept_lines = []
    for line in safe_content.splitlines():
        stripped = line.strip()
        if stripped:
            match = MARKDOWN_IMAGE_RE.fullmatch(stripped)
            if match and match.group(1) in image_urls:
                continue
        kept_lines.append(line)

    cleaned = '\n'.join(kept_lines)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return strip_assistant_reasoning(cleaned)


def _serialize_utc(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat().replace('+00:00', 'Z')


class ChatSession(db.Model):
    """对话会话"""
    __tablename__ = 'chat_sessions'
    
    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    title = db.Column(db.String(100), default='新对话')
    model_id = db.Column(db.String(100), nullable=False, default='campbell')
    pinned = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    messages = db.relationship('ChatMessage', backref='session', lazy='dynamic', cascade='all, delete-orphan')
    
    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'title': self.title,
            'model_id': self.model_id,
            'pinned': bool(self.pinned),
            'created_at': _serialize_utc(self.created_at),
            'updated_at': _serialize_utc(self.updated_at),
        }


class ChatMessage(db.Model):
    """聊天消息"""
    __tablename__ = 'chat_messages'
    
    id = db.Column(db.String(36), primary_key=True)
    session_id = db.Column(db.String(36), db.ForeignKey('chat_sessions.id'), nullable=False, index=True)
    role = db.Column(db.String(20), nullable=False)  # 'user' or 'assistant'
    content = db.Column(db.Text, nullable=False)
    images = db.Column(db.Text, nullable=True)  # JSON: S3 URL 列表
    tool_trace = db.Column(db.Text, nullable=True)  # JSON: 工具调用记录
    reasoning = db.Column(db.Text, nullable=True)  # 模型的思考过程（上游返回时才有）
    reasoning_seconds = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        images_list = None
        if self.images:
            try:
                images_list = json.loads(self.images)
            except (TypeError, ValueError, json.JSONDecodeError):
                images_list = None
        trace = []
        if self.tool_trace:
            try:
                parsed = json.loads(self.tool_trace)
                if isinstance(parsed, list):
                    trace = parsed
            except (TypeError, ValueError, json.JSONDecodeError):
                trace = []
        normalized_content = sanitize_assistant_content(self.content, trace) if self.role == 'assistant' else self.content
        result = {
            'id': self.id,
            'role': self.role,
            'content': normalized_content,
            'timestamp': _serialize_utc(self.created_at),
        }
        if images_list:
            result['images'] = images_list
        if trace:
            result['tool_trace'] = trace
        if self.reasoning:
            result['reasoning'] = self.reasoning
            if self.reasoning_seconds is not None:
                result['reasoning_seconds'] = self.reasoning_seconds
        return result


class GeneratedImage(db.Model):
    """生成的图片记录"""
    __tablename__ = 'generated_images'
    
    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    session_id = db.Column(db.String(36), db.ForeignKey('chat_sessions.id'), nullable=True, index=True)
    message_id = db.Column(db.String(36), nullable=True)
    prompt = db.Column(db.Text, nullable=True)
    s3_key = db.Column(db.String(255), nullable=False)  # S3 路径
    url = db.Column(db.String(500), nullable=False)  # 公开 URL
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'url': self.url,
            'prompt': self.prompt,
            'created_at': _serialize_utc(self.created_at),
        }


class CallingOutUsage(db.Model):
    """CallingOut 月度用量记录"""
    __tablename__ = 'calling_out_usages'

    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    period_key = db.Column(db.String(7), nullable=False, index=True)  # YYYY-MM
    source_model_id = db.Column(db.String(100), nullable=False, default='campbell')
    target_model_id = db.Column(db.String(100), nullable=False, default='campbell_calling_out')
    session_id = db.Column(db.String(36), nullable=True, index=True)
    message_id = db.Column(db.String(36), nullable=True, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'period_key': self.period_key,
            'source_model_id': self.source_model_id,
            'target_model_id': self.target_model_id,
            'session_id': self.session_id,
            'message_id': self.message_id,
            'created_at': _serialize_utc(self.created_at),
        }


class CampbellUsage(db.Model):
    """Campbell 配额日度用量（按北京时间日聚合）

    存原始 token，不存算好的 credits：计费权重写在 models.json 与 services/usage.py，
    调整权重后历史数据可以整体重算。
    """
    __tablename__ = 'campbell_usages'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    day = db.Column(db.String(10), nullable=False, index=True)  # YYYY-MM-DD (Asia/Shanghai)
    chat_calls = db.Column(db.Integer, nullable=False, default=0)
    image_calls = db.Column(db.Integer, nullable=False, default=0)
    # 计费量单位：以「gpt-6-astra 输入 token」为 1，其余按 models.json 的 billing 权重折算
    new_input_units = db.Column(db.Float, nullable=False, default=0.0)
    cached_input_units = db.Column(db.Float, nullable=False, default=0.0)
    output_units = db.Column(db.Float, nullable=False, default=0.0)
    # 出图下限等与 token 无关的补足计费量
    floor_units = db.Column(db.Float, nullable=False, default=0.0)
    estimated = db.Column(db.Boolean, nullable=False, default=False)  # 历史回填数据标记
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        db.UniqueConstraint('user_id', 'day', name='uq_campbell_usages_user_day'),
    )

    @property
    def billed_units(self) -> float:
        return (
            (self.new_input_units or 0.0)
            + (self.cached_input_units or 0.0)
            + (self.output_units or 0.0)
            + (self.floor_units or 0.0)
        )

    def to_dict(self):
        return {
            'user_id': self.user_id,
            'day': self.day,
            'chat_calls': self.chat_calls,
            'image_calls': self.image_calls,
            'new_input_units': self.new_input_units,
            'cached_input_units': self.cached_input_units,
            'output_units': self.output_units,
            'floor_units': self.floor_units,
            'billed_units': self.billed_units,
            'estimated': bool(self.estimated),
        }
