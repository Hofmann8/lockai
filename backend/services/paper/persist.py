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

    # 2. VFS → gzip JSON → S3（包含 __meta__ 中间产物）
    if session.literature:
        session.vfs.write("__meta__/literature.json", json.dumps(session.literature, ensure_ascii=False))
    if session.content:
        session.vfs.write("__meta__/content.json", json.dumps(session.content, ensure_ascii=False))
    if session.design_context:
        session.vfs.write("__meta__/design_context.txt", session.design_context)
    if session.embedding_index and session.embedding_index.chunks:
        session.vfs.write("__meta__/embeddings.json", session.embedding_index.serialize())

    vfs_json = session.vfs.serialize().encode("utf-8")

    # 序列化完成后清理 __meta__ 文件
    for f in list(session.vfs.list_files()):
        if f.startswith("__meta__/"):
            session.vfs.delete(f)
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

    # 从 VFS 的 __meta__ 命名空间恢复 session 中间产物
    literature = []
    content = {}
    design_context = ""

    meta_lit = vfs.read("__meta__/literature.json")
    if meta_lit:
        literature = json.loads(meta_lit)
        vfs.delete("__meta__/literature.json")

    meta_content = vfs.read("__meta__/content.json")
    if meta_content:
        content = json.loads(meta_content)
        vfs.delete("__meta__/content.json")

    meta_dc = vfs.read("__meta__/design_context.txt")
    if meta_dc:
        design_context = meta_dc
        vfs.delete("__meta__/design_context.txt")

    # 恢复 embedding 索引
    from .embeddings import EmbeddingIndex
    embedding_index = EmbeddingIndex()
    meta_emb = vfs.read("__meta__/embeddings.json")
    if meta_emb:
        embedding_index = EmbeddingIndex.deserialize(meta_emb)
        vfs.delete("__meta__/embeddings.json")

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
        literature=literature,
        content=content,
        design_context=design_context,
        embedding_index=embedding_index,
    )
    return session
