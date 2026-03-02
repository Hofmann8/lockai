"""EmbeddingIndex 测试 — 切分、检索、序列化（不调真实 API）"""

from services.paper.embeddings import EmbeddingIndex, Chunk


class TestChunk:
    def test_to_dict_from_dict(self):
        c = Chunk("chapters/01.tex", "引言", "hello world", 1, 10)
        d = c.to_dict()
        assert d["file_path"] == "chapters/01.tex"
        assert d["section_title"] == "引言"
        c2 = Chunk.from_dict(d)
        assert c2.file_path == c.file_path
        assert c2.content == c.content
        assert c2.line_start == 1
        assert c2.line_end == 10

    def test_location(self):
        c = Chunk("a.tex", "s", "x", 5, 20)
        assert c.location() == "a.tex:5-20"


class TestEmbeddingIndex:
    def _make_index_with_chunks(self) -> EmbeddingIndex:
        """构建一个有 chunk 但无 embedding 的索引（测试 keyword fallback）"""
        idx = EmbeddingIndex()
        idx.chunks = [
            Chunk("chapters/01.tex", "引言", "深度学习在自然语言处理中的应用", 1, 5),
            Chunk("chapters/01.tex", "背景", "Transformer 架构的发展历程", 6, 15),
            Chunk("chapters/02.tex", "方法", "本文提出了一种新的注意力机制", 1, 10),
            Chunk("chapters/03.tex", "实验", "在 GLUE 基准上进行了评估", 1, 8),
            Chunk("refs.bib", "refs", "@misc{ref1, title={BERT}}", 1, 3),
        ]
        return idx

    def test_split_by_section(self):
        idx = EmbeddingIndex()
        content = (
            "\\section{引言}\n"
            "这是引言内容。\n"
            "第二段。\n"
            "\\subsection{背景}\n"
            "背景内容。\n"
            "\\section{方法}\n"
            "方法内容。\n"
        )
        chunks = idx._split_by_section("chapters/01.tex", content)
        assert len(chunks) >= 2
        titles = [c.section_title for c in chunks]
        assert "引言" in titles
        assert "方法" in titles

    def test_split_no_sections(self):
        idx = EmbeddingIndex()
        content = "这是一段没有 section 的内容\n第二行\n第三行"
        chunks = idx._split_by_section("a.tex", content)
        assert len(chunks) == 1
        assert chunks[0].content == content

    def test_keyword_search(self):
        idx = self._make_index_with_chunks()
        results = idx._keyword_search("Transformer 注意力", top_k=2)
        assert len(results) <= 2
        matched_contents = [r.content for r in results]
        assert any("Transformer" in c or "注意力" in c for c in matched_contents)

    def test_keyword_search_no_match(self):
        idx = self._make_index_with_chunks()
        results = idx._keyword_search("量子计算", top_k=3)
        assert len(results) == 0

    def test_search_fallback_to_keyword(self):
        idx = self._make_index_with_chunks()
        results = idx.search("深度学习", top_k=2)
        assert len(results) >= 1
        assert any("深度学习" in r.content for r in results)

    def test_search_empty_index(self):
        idx = EmbeddingIndex()
        assert idx.search("anything") == []

    def test_search_by_error_file_matching(self):
        idx = self._make_index_with_chunks()
        error_log = "! Undefined control sequence.\n./chapters/01.tex:8: \\badcommand"
        results = idx.search_by_error(error_log, top_k=3)
        assert any(r.file_path == "chapters/01.tex" for r in results)

    def test_search_by_error_line_matching(self):
        idx = self._make_index_with_chunks()
        error_log = "! Missing $ inserted.\n./chapters/01.tex\nl.10 some error"
        results = idx.search_by_error(error_log, top_k=3)
        matched = [r for r in results if r.file_path == "chapters/01.tex" and r.line_start <= 10 <= r.line_end]
        assert len(matched) >= 1

    def test_get_file_chunks(self):
        idx = self._make_index_with_chunks()
        ch01 = idx.get_file_chunks("chapters/01.tex")
        assert len(ch01) == 2
        assert all(c.file_path == "chapters/01.tex" for c in ch01)

    def test_index_vfs_skips_non_tex(self):
        idx = EmbeddingIndex()
        idx._api_key = ""
        files = {
            "main.tex": "\\documentclass{article}",
            "refs.bib": "@misc{ref1}",
            "chapters/01.tex": "\\section{A}\ncontent",
        }
        count = idx.index_vfs(files)
        assert count == 2
        paths = [c.file_path for c in idx.chunks]
        assert "refs.bib" not in paths

    def test_serialize_deserialize(self):
        idx = self._make_index_with_chunks()
        idx.chunks[0].embedding = [0.1, 0.2, 0.3]
        raw = idx.serialize()
        idx2 = EmbeddingIndex.deserialize(raw)
        assert len(idx2.chunks) == len(idx.chunks)
        assert idx2.chunks[0].embedding == [0.1, 0.2, 0.3]
        assert idx2.chunks[1].embedding is None
        assert idx2.chunks[0].file_path == "chapters/01.tex"

    def test_cosine_similarity(self):
        assert EmbeddingIndex._cosine_similarity([1, 0], [1, 0]) == 1.0
        assert EmbeddingIndex._cosine_similarity([1, 0], [0, 1]) == 0.0
        assert abs(EmbeddingIndex._cosine_similarity([1, 1], [1, 0]) - 0.7071) < 0.01
        assert EmbeddingIndex._cosine_similarity([0, 0], [1, 1]) == 0.0
