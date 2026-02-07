"""
Session 管理 — PaperStatus, PaperSession, SessionManager
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional

from .vfs import VirtualFileSystem


class PaperStatus(Enum):
    PENDING = "pending"
    RESEARCHING = "researching"
    PLANNING = "planning"
    WRITING = "writing"
    FORMATTING = "formatting"
    COMPILING = "compiling"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class PaperSession:
    id: str
    user_id: str
    topic: str
    status: PaperStatus = PaperStatus.PENDING
    progress_detail: str = ""
    vfs: VirtualFileSystem = field(default_factory=VirtualFileSystem)
    pdf_url: Optional[str] = None
    pdf_s3_key: Optional[str] = None
    vfs_s3_key: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.utcnow)

    # Agent 中间产物
    literature: list = field(default_factory=list)
    literature_summary: str = ""
    file_plan: dict = field(default_factory=dict)
    content: dict = field(default_factory=dict)


class SessionManager:
    """内存中的 Session 存储"""

    _sessions: dict[str, PaperSession] = {}

    @classmethod
    def create(cls, user_id: str, topic: str) -> PaperSession:
        session_id = uuid.uuid4().hex
        session = PaperSession(id=session_id, user_id=user_id, topic=topic)
        cls._sessions[session_id] = session
        return session

    @classmethod
    def get(cls, session_id: str) -> Optional[PaperSession]:
        return cls._sessions.get(session_id)

    @classmethod
    def update_status(
        cls, session_id: str, status: PaperStatus, detail: str = ""
    ) -> None:
        session = cls._sessions.get(session_id)
        if session:
            session.status = status
            if detail:
                session.progress_detail = detail

    @classmethod
    def delete(cls, session_id: str) -> bool:
        return cls._sessions.pop(session_id, None) is not None
