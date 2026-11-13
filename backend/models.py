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
    sandbox_id = db.Column(db.String(80), nullable=True)  # 当前云沙箱，回收后下次用时重建
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
    files = db.Column(db.Text, nullable=True)  # JSON: 用户附件 [{name, url, size, mime}]
    tool_trace = db.Column(db.Text, nullable=True)  # JSON: 工具调用记录
    reasoning = db.Column(db.Text, nullable=True)  # 模型的思考过程（上游返回时才有）
    reasoning_seconds = db.Column(db.Integer, nullable=True)
    reasoning_tokens = db.Column(db.Integer, nullable=True)
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
        files_list = self.files_list()
        if files_list:
            result['files'] = files_list
        if trace:
            result['tool_trace'] = trace
        elif self.role == 'assistant' and not (normalized_content or '').strip():
            # 存下来的空回答只有一种：模型选择不回复（出错、停下的都带说明或不存）
            result['silent'] = True
        # 思考文字只存不发：界面只显示用时和 token 数
        if self.reasoning_seconds is not None:
            result['reasoning_seconds'] = self.reasoning_seconds
        if self.reasoning_tokens is not None:
            result['reasoning_tokens'] = self.reasoning_tokens
        return result


    def files_list(self) -> list:
        if not self.files:
            return []
        try:
            parsed = json.loads(self.files)
            return parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError, json.JSONDecodeError):
            return []


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


class CampbellQuota(db.Model):
    """每个用户的 Campbell 额度档位和当前周期。

    周期从上一个周期结束后第一次扣费开始，持续 7 天；周期内的用量直接累加在这里，
    不从按天汇总的 campbell_usages 里推算（周期可能从一天的中间开始）。
    """
    __tablename__ = 'campbell_quotas'

    user_id = db.Column(db.String(36), primary_key=True)
    tier = db.Column(db.Integer, nullable=False, default=1)
    window_started_at = db.Column(db.DateTime, nullable=True)  # UTC
    window_units = db.Column(db.Float, nullable=False, default=0.0)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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


class DesktopAuthRequest(db.Model):
    """LockAI Desktop 的一次浏览器授权（PKCE）。

    桌面端发起 → 用户在网页上允许 → 浏览器带一次性授权码跳回本机 → 桌面端用 code_verifier 换设备令牌。
    授权码只存哈希，换过一次就作废。
    """
    __tablename__ = 'desktop_auth_requests'

    id = db.Column(db.String(32), primary_key=True)
    code_challenge = db.Column(db.String(128), nullable=False)
    state = db.Column(db.String(256), nullable=False)
    redirect_uri = db.Column(db.String(300), nullable=False)
    login_source = db.Column(db.String(16), nullable=False, default='desktop')
    # pending → approved → exchanged；或 cancelled
    status = db.Column(db.String(16), nullable=False, default='pending')
    user_id = db.Column(db.String(36), nullable=True)
    user_name = db.Column(db.String(100), nullable=True)
    user_email = db.Column(db.String(200), nullable=True)
    # LockAuth 头像地址（公共桶，不过期），核验登录时拿到
    user_avatar = db.Column(db.Text, nullable=True)
    code_hash = db.Column(db.String(64), nullable=True, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)


class DesktopDevice(db.Model):
    """一台已授权的 LockAI Desktop，对应一个设备令牌。令牌只存哈希，可随时吊销。"""
    __tablename__ = 'desktop_devices'

    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    user_name = db.Column(db.String(100), nullable=True)
    user_email = db.Column(db.String(200), nullable=True)
    user_avatar = db.Column(db.Text, nullable=True)
    token_hash = db.Column(db.String(64), nullable=False, unique=True)
    token_prefix = db.Column(db.String(16), nullable=False)
    device_id = db.Column(db.String(64), nullable=True)
    device_model = db.Column(db.String(100), nullable=True)
    os_version = db.Column(db.String(200), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_used_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)
    revoked_at = db.Column(db.DateTime, nullable=True)


class WatermarkChoice(db.Model):
    """用户开关图片水印的记录，只增不删。

    《人工智能生成合成内容标识办法》：用户要不带显式标识的生成内容时，服务提供者在用户协议里讲明标识义务和
    责任后可以提供，并依法留存提供对象信息等日志不少于六个月。用户在设置里确认关闭时记一条，重新打开也记一条。
    """
    __tablename__ = 'watermark_choices'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    enabled = db.Column(db.Boolean, nullable=False)
    ip = db.Column(db.String(64), nullable=True)
    user_agent = db.Column(db.String(300), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)  # UTC
