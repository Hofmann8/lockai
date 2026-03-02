"""persist / restore 测试（纯内存 mock，不需要 Flask/DB）"""

import gzip
import json

from helpers import MockStorageService
from services.paper.session import PaperSession, PaperStatus
from services.paper.vfs import VirtualFileSystem
from services.paper.embeddings import EmbeddingIndex, Chunk


class TestVFSSnapshotRoundtrip:
    def test_vfs_gzip_roundtrip(self):
        vfs = VirtualFileSystem()
        vfs.write("main.tex", "\\documentclass{article}")
        vfs.write("chapters/01.tex", "\\section{A}")
        vfs.write("refs.bib", "@misc{ref1}")

        vfs_json = vfs.serialize().encode("utf-8")
        vfs_gz = gzip.compress(vfs_json)

        restored_json = gzip.decompress(vfs_gz).decode("utf-8")
        vfs2 = VirtualFileSystem.deserialize(restored_json)

        assert vfs2.read("main.tex") == "\\documentclass{article}"
        assert vfs2.read("chapters/01.tex") == "\\section{A}"
        assert vfs2.read("refs.bib") == "@misc{ref1}"

    def test_meta_files_roundtrip(self):
        vfs = VirtualFileSystem()
        vfs.write("main.tex", "content")

        literature = [{"title": "A", "year": "2024"}]
        content = {"chapters/01.tex": "text"}
        design_context = "用户讨论内容"

        vfs.write("__meta__/literature.json", json.dumps(literature, ensure_ascii=False))
        vfs.write("__meta__/content.json", json.dumps(content, ensure_ascii=False))
        vfs.write("__meta__/design_context.txt", design_context)

        raw = vfs.serialize()
        vfs2 = VirtualFileSystem.deserialize(raw)

        lit2 = json.loads(vfs2.read("__meta__/literature.json"))
        assert lit2[0]["title"] == "A"

        content2 = json.loads(vfs2.read("__meta__/content.json"))
        assert content2["chapters/01.tex"] == "text"

        dc2 = vfs2.read("__meta__/design_context.txt")
        assert dc2 == "用户讨论内容"

        for f in list(vfs2.list_files()):
            if f.startswith("__meta__/"):
                vfs2.delete(f)
        assert not any(f.startswith("__meta__/") for f in vfs2.list_files())

    def test_embedding_meta_roundtrip(self):
        idx = EmbeddingIndex()
        idx.chunks = [Chunk("chapters/01.tex", "引言", "内容", 1, 10)]
        idx.chunks[0].embedding = [0.1, 0.2, 0.3]

        raw = idx.serialize()
        idx2 = EmbeddingIndex.deserialize(raw)
        assert len(idx2.chunks) == 1
        assert idx2.chunks[0].embedding == [0.1, 0.2, 0.3]

    def test_storage_upload_download(self):
        storage = MockStorageService()
        data = b"test pdf data"
        storage.upload_bytes(data, "papers/test/vfs.json.gz", "application/gzip")
        assert storage.download_bytes("papers/test/vfs.json.gz") == data
        assert storage.download_bytes("nonexistent") is None
