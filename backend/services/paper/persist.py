"""
持久化 — persist_session + restore_session
将 VFS 快照 + PDF 持久化到 S3，元数据写入数据库
"""

import gzip
import json
from datetime import datetime

from .session import PaperSession, PaperStatus
from .vfs import VirtualFileSystem


def persist_session(session: PaperSession, storage, db, upsert: bool = False):
    """将 VFS 快照 + PDF 持久化到 S3 + 数据库"""
    from models import PaperRecord

    # 1. Upload PDF to S3
    pdf_key = f"users/{session.user_id}/papers/{session.id}/paper.pdf"
    result = storage.upload_pdf(session.pdf_data, pdf_key)
    session.pdf_s3_key = pdf_key
    session.pdf_url = result["url"] if result else None

    # 2. VFS → gzip JSON → S3
    vfs_json = session.vfs.serialize().encode("utf-8")
    vfs_gz = gzip.compress(vfs_json)
    vfs_key = f"users/{session.user_id}/papers/{session.id}/vfs.json.gz"
    storage.upload_bytes(vfs_gz, vfs_key, "application/gzip")
    session.vfs_s3_key = vfs_key

    # 3. Write / update PaperRecord in database
    record = None
    if upsert:
        record = PaperRecord.query.get(session.id)

    if record:
        record.user_id = session.user_id
        record.topic = session.topic
        record.status = session.status.value
        record.vfs_s3_key = vfs_key
        record.pdf_s3_key = pdf_key
        record.pdf_url = session.pdf_url
        record.outline_json = json.dumps(session.file_plan, ensure_ascii=False)
        record.completed_at = datetime.utcnow()
        record.error = None
    else:
        record = PaperRecord(
            id=session.id,
            user_id=session.user_id,
            topic=session.topic,
            status=session.status.value,
            vfs_s3_key=vfs_key,
            pdf_s3_key=pdf_key,
            pdf_url=session.pdf_url,
            outline_json=json.dumps(session.file_plan, ensure_ascii=False),
            completed_at=datetime.utcnow(),
        )
        db.session.add(record)

    db.session.commit()


def restore_session(paper_id: str, storage, db) -> PaperSession | None:
    """从 S3 + 数据库恢复会话"""
    from models import PaperRecord

    record = PaperRecord.query.get(paper_id)
    if not record:
        return None

    # Download and decompress VFS
    vfs = VirtualFileSystem()
    if record.vfs_s3_key:
        vfs_gz = storage.download_bytes(record.vfs_s3_key)
        if vfs_gz:
            vfs_json = gzip.decompress(vfs_gz).decode("utf-8")
            vfs = VirtualFileSystem.deserialize(vfs_json)

    session = PaperSession(
        id=record.id,
        user_id=record.user_id,
        topic=record.topic,
        status=PaperStatus(record.status),
        vfs=vfs,
        pdf_url=record.pdf_url,
        pdf_s3_key=record.pdf_s3_key,
        vfs_s3_key=record.vfs_s3_key,
        file_plan=json.loads(record.outline_json) if record.outline_json else {},
    )
    return session
