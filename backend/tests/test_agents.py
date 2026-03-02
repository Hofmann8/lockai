"""Agent 测试 — Researcher / Planner / Writer / Formatter + GateResult"""

import json
import pytest

from helpers import MockLLMService
from services.paper.session import PaperSession, PaperStatus
from services.paper.agents.base import BaseAgent, GateResult
from services.paper.agents.researcher import ResearcherAgent
from services.paper.agents.planner import PlannerAgent
from services.paper.agents.writer import WriterAgent
from services.paper.agents.formatter import FormatterAgent


def _make_session(topic="AI测试") -> PaperSession:
    return PaperSession(id="test123", user_id="u1", topic=topic)


# ---- GateResult ----

class TestGateResult:
    def test_defaults(self):
        g = GateResult()
        assert g.ok is True
        assert g.retry is False
        assert g.reason == ""

    def test_fail_with_retry(self):
        g = GateResult(ok=False, retry=True, reason="缺少章节")
        assert not g.ok
        assert g.retry
        assert "缺少" in g.reason

    def test_repr(self):
        g = GateResult(ok=True)
        assert "ok=True" in repr(g)


# ---- ResearcherAgent ----

class TestResearcherAgent:
    def test_run_parses_literature(self):
        llm = MockLLMService()
        lit_data = [
            {"title": "Paper A", "authors": "Author1", "year": "2024", "abstract": "abs1"},
            {"title": "Paper B", "authors": "Author2", "year": "2023", "abstract": "abs2"},
        ]
        llm.responses = [json.dumps(lit_data), "这是文献综述摘要。"]
        agent = ResearcherAgent(llm)
        session = _make_session()

        events = list(agent.run(session))
        assert len(session.literature) == 2
        assert session.literature[0]["title"] == "Paper A"
        assert "文献综述" in session.literature_summary
        assert any(e.get("type") == "result" for e in events)

    def test_run_empty_response(self):
        llm = MockLLMService(default_response="")
        agent = ResearcherAgent(llm)
        session = _make_session()
        list(agent.run(session))
        assert session.literature == []

    def test_parse_literature_with_markdown(self):
        llm = MockLLMService()
        agent = ResearcherAgent(llm)
        response = '```json\n[{"title": "X", "year": "2024"}]\n```'
        result = agent._parse_literature(response)
        assert len(result) == 1

    def test_parse_literature_invalid_json(self):
        llm = MockLLMService()
        agent = ResearcherAgent(llm)
        assert agent._parse_literature("not json at all") == []
        assert agent._parse_literature(None) == []

    def test_gate_snapshot(self):
        llm = MockLLMService()
        agent = ResearcherAgent(llm)
        session = _make_session()
        session.literature = [{"title": "A", "year": "2024"}]
        session.literature_summary = "summary text"
        snap = agent._build_gate_snapshot(session)
        assert "AI测试" in snap
        assert "文献数量: 1" in snap

    def test_design_context_included(self):
        llm = MockLLMService()
        llm.responses = ["[]", "summary"]
        agent = ResearcherAgent(llm)
        session = _make_session()
        session.design_context = "用户要求关注 Transformer"
        list(agent.run(session))
        first_call = llm.call_log[0]
        prompt_text = first_call["messages"][0]["content"]
        assert "Transformer" in prompt_text


# ---- PlannerAgent ----

class TestPlannerAgent:
    def _valid_plan(self) -> str:
        plan = {
            "title": "AI论文",
            "citation_style": "GB/T 7714",
            "include_abstract": True,
            "include_toc": True,
            "language": "中文",
            "global_requirements": "学术风格",
            "abstract_requirements": "200字",
            "files": {"main.tex": "入口", "chapters/01_intro.tex": "引言", "refs.bib": "参考文献"},
            "outline": {
                "chapters/01_intro.tex": {
                    "title": "引言", "sections": ["背景", "动机"],
                    "key_points": ["AI发展"], "citations": ["ref1"],
                    "target_words": 800, "requirements": "介绍背景",
                },
                "chapters/02_method.tex": {
                    "title": "方法", "sections": ["模型", "训练"],
                    "key_points": ["新方法"], "citations": ["ref2"],
                    "target_words": 1000, "requirements": "",
                },
            },
        }
        return json.dumps(plan, ensure_ascii=False)

    def test_run_success(self):
        llm = MockLLMService(default_response=self._valid_plan())
        agent = PlannerAgent(llm)
        session = _make_session()
        session.literature = [{"title": "A", "year": "2024"}]
        session.literature_summary = "summary"
        events = list(agent.run(session))
        assert session.file_plan.get("title") == "AI论文"
        assert "chapters/01_intro.tex" in session.file_plan["outline"]
        assert any(e.get("type") == "result" for e in events)

    def test_run_retries_on_empty_outline(self):
        llm = MockLLMService()
        empty_plan = json.dumps({"title": "X", "outline": {}})
        llm.responses = [empty_plan, empty_plan, self._valid_plan()]
        agent = PlannerAgent(llm)
        session = _make_session()
        session.literature = []
        session.literature_summary = ""
        events = list(agent.run(session))
        assert len(session.file_plan.get("outline", {})) >= 2
        assert len(llm.call_log) == 3

    def test_run_all_retries_fail(self):
        llm = MockLLMService(default_response=json.dumps({"title": "X", "outline": {}}))
        agent = PlannerAgent(llm)
        session = _make_session()
        session.literature = []
        session.literature_summary = ""
        with pytest.raises(RuntimeError, match="规划失败"):
            list(agent.run(session))

    def test_parse_plan_with_thinking_tags(self):
        llm = MockLLMService()
        agent = PlannerAgent(llm)
        raw = '<thinking>some thought</thinking>\n{"title": "X", "outline": {}}'
        result = agent._parse_plan(raw)
        assert result.get("title") == "X"

    def test_parse_plan_with_code_fences(self):
        llm = MockLLMService()
        agent = PlannerAgent(llm)
        raw = '```json\n{"title": "Y", "outline": {}}\n```'
        result = agent._parse_plan(raw)
        assert result.get("title") == "Y"

    def test_parse_plan_invalid(self):
        llm = MockLLMService()
        agent = PlannerAgent(llm)
        assert agent._parse_plan(None) == {}
        assert agent._parse_plan("no json here") == {}

    def test_defaults_set(self):
        plan = {
            "title": "X",
            "outline": {
                "chapters/01.tex": {
                    "title": "A", "sections": [], "key_points": [],
                    "citations": [], "target_words": 500,
                }
            },
        }
        llm = MockLLMService(default_response=json.dumps(plan))
        agent = PlannerAgent(llm)
        session = _make_session()
        session.literature = []
        session.literature_summary = ""
        list(agent.run(session))
        assert session.file_plan["include_abstract"] is True
        assert session.file_plan["include_toc"] is True
        assert session.file_plan["citation_style"] == "plainnat"

    def test_gate_snapshot(self):
        llm = MockLLMService()
        agent = PlannerAgent(llm)
        session = _make_session()
        session.file_plan = {"title": "Test", "outline": {"chapters/01.tex": {}}}
        snap = agent._build_gate_snapshot(session)
        assert "Test" in snap


# ---- WriterAgent ----

class TestWriterAgent:
    def _setup_session(self) -> PaperSession:
        session = _make_session()
        session.literature = [
            {"title": "Paper A", "authors": "Auth1", "year": "2024", "abstract": "abs"},
        ]
        session.file_plan = {
            "title": "AI论文",
            "include_abstract": True,
            "abstract_requirements": "200字",
            "global_requirements": "学术风格",
            "outline": {
                "chapters/01_intro.tex": {
                    "title": "引言", "sections": ["背景"],
                    "key_points": ["AI"], "citations": ["ref1"],
                    "target_words": 500, "requirements": "介绍背景",
                },
            },
        }
        return session

    def test_run_writes_abstract_and_chapter(self):
        llm = MockLLMService()
        llm.responses = ["这是摘要内容。", "这是引言章节内容。", "章节摘要。"]
        agent = WriterAgent(llm)
        session = self._setup_session()
        events = list(agent.run(session))
        assert "__abstract__" in session.content
        assert "chapters/01_intro.tex" in session.content
        assert any(e.get("type") == "result" for e in events)

    def test_run_no_abstract(self):
        llm = MockLLMService()
        llm.responses = ["章节内容。", "摘要。"]
        agent = WriterAgent(llm)
        session = self._setup_session()
        session.file_plan["include_abstract"] = False
        list(agent.run(session))
        assert "__abstract__" not in session.content
        assert "chapters/01_intro.tex" in session.content

    def test_run_empty_outline_raises(self):
        llm = MockLLMService()
        agent = WriterAgent(llm)
        session = _make_session()
        session.file_plan = {"outline": {}}
        with pytest.raises(RuntimeError, match="没有章节"):
            list(agent.run(session))

    def test_gate_snapshot(self):
        llm = MockLLMService()
        agent = WriterAgent(llm)
        session = _make_session()
        session.content = {"chapters/01.tex": "一些内容" * 50}
        snap = agent._build_gate_snapshot(session)
        assert "AI测试" in snap
        assert "章节数: 1" in snap


# ---- FormatterAgent ----

class TestFormatterAgent:
    def _setup_session(self) -> PaperSession:
        session = _make_session()
        session.literature = [
            {"title": "Paper A", "authors": "Auth1", "year": "2024", "abstract": "abs"},
        ]
        session.content = {
            "__abstract__": "摘要文本",
            "chapters/01_intro.tex": "引言纯文本内容",
        }
        session.file_plan = {
            "title": "AI论文",
            "include_abstract": True,
            "include_toc": True,
            "citation_style": "plainnat",
            "global_requirements": "",
            "outline": {
                "chapters/01_intro.tex": {
                    "title": "引言", "sections": ["背景"],
                    "key_points": ["AI"], "citations": ["ref1"],
                    "target_words": 500, "requirements": "",
                },
            },
        }
        return session

    def test_generate_main(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        session = self._setup_session()
        main_tex = agent._generate_main(session.file_plan, session)
        assert "\\documentclass" in main_tex
        assert "\\begin{document}" in main_tex
        assert "\\maketitle" in main_tex
        assert "\\bibliography{refs}" in main_tex
        assert "\\tableofcontents" in main_tex
        assert "\\input{chapters/01_intro}" in main_tex

    def test_generate_main_no_toc(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        session = self._setup_session()
        session.file_plan["include_toc"] = False
        main_tex = agent._generate_main(session.file_plan, session)
        assert "\\tableofcontents" not in main_tex

    def test_generate_main_no_abstract(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        session = self._setup_session()
        session.file_plan["include_abstract"] = False
        main_tex = agent._generate_main(session.file_plan, session)
        assert "\\begin{abstract}" not in main_tex

    def test_generate_bib(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        lit = [
            {"title": "Paper A", "authors": "Auth1", "year": "2024", "abstract": "abs1"},
            {"title": "Paper B", "authors": "Auth2", "year": "2023", "abstract": "abs2"},
        ]
        bib = agent._generate_bib(lit)
        assert "@misc{ref1," in bib
        assert "@misc{ref2," in bib
        assert "Paper A" in bib
        assert "Paper B" in bib

    def test_strip_code_fences(self):
        assert FormatterAgent._strip_code_fences("```latex\ncontent\n```") == "content"
        assert FormatterAgent._strip_code_fences("```\ncontent\n```") == "content"
        assert FormatterAgent._strip_code_fences("no fences") == "no fences"
        assert FormatterAgent._strip_code_fences("```json\n{}\n```") == "{}"

    def test_run_produces_vfs_files(self):
        llm = MockLLMService()
        llm.responses = [
            "LaTeX 摘要内容",
            "\\section{引言}\nLaTeX 引言内容",
            "\\section{引言}\nLaTeX 引言内容",
            "\\documentclass{article}\\begin{document}ok\\end{document}",
        ]
        agent = FormatterAgent(llm)
        session = self._setup_session()
        events = list(agent.run(session))
        assert session.vfs.exists("main.tex")
        assert session.vfs.exists("chapters/01_intro.tex")
        assert session.vfs.exists("refs.bib")
        assert any(e.get("type") == "result" for e in events)

    def test_bibstyle_mapping(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        session = self._setup_session()
        session.file_plan["citation_style"] = "IEEE"
        main_tex = agent._generate_main(session.file_plan, session)
        assert "\\bibliographystyle{ieeetr}" in main_tex

    def test_gate_snapshot(self):
        llm = MockLLMService()
        agent = FormatterAgent(llm)
        session = self._setup_session()
        session.vfs.write("main.tex", "\\documentclass{article}")
        session.vfs.write("chapters/01.tex", "\\section{A}")
        snap = agent._build_gate_snapshot(session)
        assert "main.tex" in snap
        assert "\\documentclass" in snap
