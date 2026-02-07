"""
Paper 模块 — AI 自动生成学术论文
"""

from .vfs import VirtualFileSystem
from .session import PaperStatus, PaperSession, SessionManager
from .latex import CompileResult, LocalCompiler, RemoteCompiler, get_compiler, extract_errors
from .service import PaperService
from .persist import persist_session, restore_session

__all__ = [
    "VirtualFileSystem",
    "PaperStatus",
    "PaperSession",
    "SessionManager",
    "CompileResult",
    "LocalCompiler",
    "RemoteCompiler",
    "get_compiler",
    "extract_errors",
    "PaperService",
    "persist_session",
    "restore_session",
]
