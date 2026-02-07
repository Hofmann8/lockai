"""
Database Models
"""

from datetime import datetime
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class ChatSession(db.Model):
    """对话会话"""
    __tablename__ = 'chat_sessions'
    
    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    title = db.Column(db.String(100), default='新对话')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    messages = db.relationship('ChatMessage', backref='session', lazy='dynamic', cascade='all, delete-orphan')
    
    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'title': self.title,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
        }


class ChatMessage(db.Model):
    """聊天消息"""
    __tablename__ = 'chat_messages'
    
    id = db.Column(db.String(36), primary_key=True)
    session_id = db.Column(db.String(36), db.ForeignKey('chat_sessions.id'), nullable=False, index=True)
    role = db.Column(db.String(20), nullable=False)  # 'user' or 'assistant'
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'role': self.role,
            'content': self.content,
            'timestamp': self.created_at.isoformat(),
        }


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
            'created_at': self.created_at.isoformat(),
        }


class PaperRecord(db.Model):
    """论文记录（持久化）"""
    __tablename__ = 'paper_records'

    id = db.Column(db.String(36), primary_key=True)
    user_id = db.Column(db.String(36), nullable=False, index=True)
    topic = db.Column(db.String(500), nullable=False)
    status = db.Column(db.String(20), nullable=False)
    vfs_s3_key = db.Column(db.String(255))
    pdf_s3_key = db.Column(db.String(255))
    pdf_url = db.Column(db.String(500))
    outline_json = db.Column(db.Text)
    error = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    completed_at = db.Column(db.DateTime)

    def to_dict(self):
        return {
            'id': self.id,
            'topic': self.topic,
            'status': self.status,
            'pdf_url': self.pdf_url,
            'error': self.error,
            'created_at': self.created_at.isoformat(),
            'completed_at': self.completed_at.isoformat() if self.completed_at else None,
        }
