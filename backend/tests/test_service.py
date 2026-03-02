"""
PaperService 测试 — pipeline 阶段、工具回调、重试诊断逻辑
不启动 Flask/DB，直接测试各方法的逻辑
"""

import json

from helpers import MockLLMService, MockStorageService
from services.paper.session import PaperSession, PaperStatus, SessionManager
from services.paper.vfs import VirtualFileSystem
from services.paper.embeddings import EmbeddingIndex, Chunk
from services.paper.service import PaperService
from services.paper.agents.formatter import FormatterAgent


def _make_session(topic="测试主题") -> PaperSession:
    s = PaperSession(id="svc_test_001", user_id="u1", topic=topic)
    SessionManager._sessions[s.id] = s
    return s


def _make_service() -> tuple[PaperService, MockLLMService, MockStorageService]:
    llm = MockLLMService()
    storage = MockStorageService()
    svc = PaperService(llm, storage, app=None)
    return svc, llm, storage


class TestBuildRetryDiagnosis:
    """_build_retry_diagnosis 构建诊断指令"""

    def test_includes_error_message(self):
        svc, _, _ = _make_service()
        session = _make_session()
        diag = svc._build_retry_diagnosis(session, "编译失败: xelatex error")
        assert "编译失败" in diag
        assert "xelatex error" in diag

    def test_no_error(self):
        svc, _, _ = _make_service()
        session = _make_session()
        diag = svc._build_retry_diagnosis(session, None)
        assert "自动重试诊断" in diag
        assert "错误信息" not in diag

    def test_empty_vfs(self):
        svc, _, _ = _make_service()
        session = _make_session()
        diag = svc._build_retry_diagnosis(session, "some error")
        assert "没有任何文件" in diag

    def test_lists_vfs_files(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("main.tex", "\\documentclass{article}\n\\begin{document}\n\\end{document}")
        session.vfs.write("chapters/01.tex", "\\section{A}\ncontent here")
        diag = svc._build_retry_diagnosis(session, "error")
        assert "main.tex" in diag
        assert "chapters/01.tex" in diag

    def test_warns_invalid_main_tex(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("main.tex", "\\section{引言}\n这是正文内容")
        diag = svc._build_retry_diagnosis(session, "error")
        assert "regenerate_main_tex" in diag
        assert "不是有效的文档框架" in diag

    def test_warns_missing_main_tex(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("chapters/01.tex", "\\section{A}")
        diag = svc._build_retry_diagnosis(session, "error")
        assert "regenerate_main_tex" in diag
        assert "不存在" in diag

    def test_warns_empty_refs_bib(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("refs.bib", "")
        diag = svc._build_retry_diagnosis(session, "error")
        assert "regenerate_refs_bib" in diag

    def test_valid_main_no_warning(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("main.tex", "\\documentclass{article}\n\\begin{document}\n\\end{document}")
        session.vfs.write("refs.bib", "@misc{ref1, title={A}}")
        diag = svc._build_retry_diagnosis(session, "error")
        assert "regenerate_main_tex" not in diag
        assert "regenerate_refs_bib" not in diag


class TestBuildEmbeddingIndex:
    def test_builds_index_from_vfs(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("main.tex", "\\documentclass{article}")
        session.vfs.write("chapters/01.tex", "\\section{引言}\n内容")
        session.embedding_index = EmbeddingIndex()
        session.embedding_index._api_key = ""
        svc._build_embedding_index(session)
        assert len(session.embedding_index.chunks) >= 1

    def test_skips_meta_files(self):
        svc, _, _ = _make_service()
        session = _make_session()
        session.vfs.write("__meta__/lit.json", "{}")
        session.vfs.write("chapters/01.tex", "\\section{A}\ncontent")
        session.embedding_index = EmbeddingIndex()
        session.embedding_index._api_key = ""
        svc._build_embedding_index(session)
        paths = [c.file_path for c in session.embedding_index.chunks]
        assert "__meta__/lit.json" not in paths


class TestReviseToolCallbacks:
    """_run_revise 中的 tool_handler 回调测试"""

    def _setup(self):
        svc, llm, storage = _make_service()
        session = _make_session()
        session.vfs.write("main.tex", "\\documentclass{article}")
        session.vfs.write("chapters/01.tex", "\\section{引言}\n旧内容")
        session.vfs.write("refs.bib", "@misc{ref1, title={A}}")
        session.embedding_index = EmbeddingIndex()
        session.embedding_index._api_key = ""
        vfs_files = {f: session.vfs.read(f) for f in session.vfs.list_files()}
        session.embedding_index.index_vfs(vfs_files)
        return svc, session

    def test_search_chunks_tool(self):
        svc, session = self._setup()
        idx = session.embedding_index
        results = idx.search("引言", top_k=5)
        assert any("chapters/01.tex" in r.file_path for r in results)

    def test_search_chunks_empty_query(self):
        _, session = self._setup()
        results = session.embedding_index.search("", top_k=3)
        assert isinstance(results, list)

    def test_list_files_tool(self):
        _, session = self._setup()
        files = [f for f in session.vfs.list_files() if not f.startswith("__meta__/")]
        assert "main.tex" in files
        assert "chapters/01.tex" in files
        assert "refs.bib" in files

    def test_read_file_tool(self):
        _, session = self._setup()
        content = session.vfs.read("chapters/01.tex")
        assert "旧内容" in content
        assert session.vfs.read("nonexistent.tex") is None

    def test_write_file_tool(self):
        _, session = self._setup()
        new_content = "\\section{引言}\n新内容"
        session.vfs.write("chapters/01.tex", new_content)
        assert session.vfs.read("chapters/01.tex") == new_content

    def test_replan_sets_design_context(self):
        _, session = self._setup()
        session.design_context = "原始讨论"
        reason = "需要增加实验章节"
        session.design_context += f"\n\n【修订要求】{reason}"
        assert "修订要求" in session.design_context
        assert reason in session.design_context


class TestRegenerateToolCallbacks:
    """regenerate_main_tex / regenerate_refs_bib 工具回调测试"""

    def _setup(self):
        svc, llm, storage = _make_service()
        session = _make_session()
        session.file_plan = {
            "title": "测试论文",
            "outline": {
                "chapters/01_intro.tex": {"title": "引言", "sections": ["背景"], "key_points": [], "citations": ["ref1"]},
                "chapters/02_method.tex": {"title": "方法", "sections": ["实验"], "key_points": [], "citations": []},
            },
            "include_abstract": False,
            "include_toc": True,
            "citation_style": "plainnat",
        }
        session.literature = [
            {"title": "Paper A", "authors": "Author A", "year": "2024", "abstract": "Abstract A"},
            {"title": "Paper B", "authors": "Author B", "year": "2023", "abstract": "Abstract B"},
        ]
        session.content = {"__abstract__": "摘要内容"}
        return svc, session

    def test_regenerate_main_tex(self):
        svc, session = self._setup()
        new_main = svc.formatter._generate_main(session.file_plan, session)
        assert "\\documentclass" in new_main
        assert "\\begin{document}" in new_main
        assert "chapters/01_intro" in new_main
        assert "chapters/02_method" in new_main

    def test_regenerate_main_tex_no_plan(self):
        svc, session = self._setup()
        session.file_plan = {}
        # 即使 plan 为空也不应崩溃
        new_main = svc.formatter._generate_main(session.file_plan, session)
        assert "\\documentclass" in new_main

    def test_regenerate_refs_bib(self):
        svc, session = self._setup()
        new_bib = svc.formatter._generate_bib(session.literature)
        assert "ref1" in new_bib
        assert "ref2" in new_bib
        assert "Paper A" in new_bib
        assert "Paper B" in new_bib

    def test_regenerate_refs_bib_empty_literature(self):
        svc, session = self._setup()
        new_bib = svc.formatter._generate_bib([])
        assert new_bib == ""

    def test_regenerate_overwrites_vfs(self):
        svc, session = self._setup()
        session.vfs.write("main.tex", "broken content")
        session.vfs.write("refs.bib", "")
        new_main = svc.formatter._generate_main(session.file_plan, session)
        session.vfs.write("main.tex", new_main)
        assert "\\documentclass" in session.vfs.read("main.tex")
        new_bib = svc.formatter._generate_bib(session.literature)
        session.vfs.write("refs.bib", new_bib)
        assert "ref1" in session.vfs.read("refs.bib")


class TestRepairToolCallbacks:
    """FormatterAgent.repair 中的 tool_handler 回调测试"""

    def _setup(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        session = _make_session()
        session.vfs.write("main.tex", "\\documentclass{article}")
        session.vfs.write("chapters/01.tex", "\\section{A}\n\\badcommand")
        session.vfs.write("refs.bib", "@misc{ref1}")
        session.embedding_index = EmbeddingIndex()
        session.embedding_index._api_key = ""
        vfs_files = {f: session.vfs.read(f) for f in session.vfs.list_files()}
        session.embedding_index.index_vfs(vfs_files)
        return agent, session

    def test_search_chunks_in_repair(self):
        _, session = self._setup()
        results = session.embedding_index.search("badcommand", top_k=3)
        assert len(results) >= 1

    def test_read_file_in_repair(self):
        _, session = self._setup()
        content = session.vfs.read("chapters/01.tex")
        assert "\\badcommand" in content

    def test_write_file_in_repair(self):
        _, session = self._setup()
        fixed = "\\section{A}\nfixed content"
        session.vfs.write("chapters/01.tex", fixed)
        assert session.vfs.read("chapters/01.tex") == fixed

    def test_repair_empty_index_fallback(self):
        _, session = self._setup()
        session.embedding_index = EmbeddingIndex()
        assert session.embedding_index.search("test", top_k=3) == []


class TestPipelineOrder:
    def test_pipeline_order(self):
        svc, _, _ = _make_service()
        assert svc._PIPELINE_ORDER == [
            "researching", "planning", "writing", "formatting", "compiling"
        ]


class TestReviseToolDefinitions:
    def test_all_tools_present(self):
        tool_names = [t["function"]["name"] for t in PaperService._REVISE_TOOLS]
        assert "search_chunks" in tool_names
        assert "list_files" in tool_names
        assert "read_file" in tool_names
        assert "write_file" in tool_names
        assert "regenerate_main_tex" in tool_names
        assert "regenerate_refs_bib" in tool_names
        assert "rewrite_chapter" in tool_names
        assert "replan_and_rewrite" in tool_names

    def test_tool_schemas_valid(self):
        for tool in PaperService._REVISE_TOOLS:
            assert tool["type"] == "function"
            fn = tool["function"]
            assert "name" in fn
            assert "description" in fn
            assert "parameters" in fn
            assert fn["parameters"]["type"] == "object"

    def test_search_chunks_has_query_required(self):
        sc = next(t for t in PaperService._REVISE_TOOLS
                  if t["function"]["name"] == "search_chunks")
        assert "query" in sc["function"]["parameters"]["required"]

    def test_write_file_has_path_content_required(self):
        wf = next(t for t in PaperService._REVISE_TOOLS
                  if t["function"]["name"] == "write_file")
        assert "path" in wf["function"]["parameters"]["required"]
        assert "content" in wf["function"]["parameters"]["required"]

    def test_regenerate_tools_no_required_params(self):
        for name in ["regenerate_main_tex", "regenerate_refs_bib"]:
            tool = next(t for t in PaperService._REVISE_TOOLS
                        if t["function"]["name"] == name)
            assert tool["function"]["parameters"]["required"] == []


class TestRepairToolDefinitions:
    def test_all_tools_present(self):
        tool_names = [t["function"]["name"] for t in FormatterAgent.REPAIR_TOOLS]
        assert "search_chunks" in tool_names
        assert "read_file" in tool_names
        assert "write_file" in tool_names

    def test_search_chunks_has_query_required(self):
        sc = next(t for t in FormatterAgent.REPAIR_TOOLS
                  if t["function"]["name"] == "search_chunks")
        assert "query" in sc["function"]["parameters"]["required"]


class TestReviseSystemPrompt:
    def test_mentions_search_chunks(self):
        assert "search_chunks" in PaperService._REVISE_SYSTEM_PROMPT

    def test_mentions_no_itemize(self):
        assert "itemize" in PaperService._REVISE_SYSTEM_PROMPT

    def test_mentions_regenerate_tools(self):
        assert "regenerate_main_tex" in PaperService._REVISE_SYSTEM_PROMPT
        assert "regenerate_refs_bib" in PaperService._REVISE_SYSTEM_PROMPT

    def test_mentions_tool_hierarchy(self):
        prompt = PaperService._REVISE_SYSTEM_PROMPT
        idx_search = prompt.index("search_chunks")
        idx_read = prompt.index("read_file")
        idx_regen_main = prompt.index("regenerate_main_tex")
        idx_regen_bib = prompt.index("regenerate_refs_bib")
        idx_rewrite = prompt.index("rewrite_chapter")
        idx_replan = prompt.index("replan_and_rewrite")
        assert idx_search < idx_read < idx_regen_main < idx_regen_bib < idx_rewrite < idx_replan
