"""
FormatterAgent 单元测试
"""

from unittest.mock import MagicMock

from .formatter import FormatterAgent
from ..session import PaperSession


MOCK_OUTLINE = {
    "chapters/01_intro.tex": {
        "title": "引言",
        "sections": ["研究背景", "问题定义"],
        "key_points": ["CV领域Transformer兴起"],
        "citations": ["ref1", "ref2"],
        "target_words": 800,
    },
    "chapters/02_related.tex": {
        "title": "相关工作",
        "sections": ["传统方法", "CNN方法"],
        "key_points": ["SIFT/HOG", "AlexNet到ResNet"],
        "citations": ["ref3"],
        "target_words": 1200,
    },
}

MOCK_LITERATURE = [
    {"title": "ViT论文", "authors": "Dosovitskiy et al.", "year": "2020"},
    {"title": "DeiT论文", "authors": "Touvron et al.", "year": "2021"},
    {"title": "Swin Transformer", "authors": "Liu et al.", "year": "2021"},
]

MOCK_CONTENT = {
    "chapters/01_intro.tex": "Transformer在计算机视觉领域取得了显著进展[ref1]。",
    "chapters/02_related.tex": "传统方法依赖手工特征[ref3]。",
}


def _make_session() -> PaperSession:
    session = PaperSession(id="test-001", user_id="user-001", topic="Transformer图像分类")
    session.literature = MOCK_LITERATURE
    session.file_plan = {"title": "基于Transformer的图像分类综述", "outline": MOCK_OUTLINE}
    session.content = dict(MOCK_CONTENT)
    return session


def _make_agent(latex_response: str = "\\section{引言}\n\n这是LaTeX内容。") -> FormatterAgent:
    llm = MagicMock()
    llm.complete = MagicMock(return_value=latex_response)
    return FormatterAgent(llm)


# --- run() 正常流程 ---


def test_run_yields_progress_and_result():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))

    progress_events = [e for e in events if e["type"] == "progress"]
    result_events = [e for e in events if e["type"] == "result"]
    # 1 initial + 1 main.tex + 2 chapters + 1 refs.bib = 5 progress
    assert len(progress_events) == 5
    assert len(result_events) == 1


def test_run_writes_main_tex_to_vfs():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    assert session.vfs.exists("main.tex")
    main_content = session.vfs.read("main.tex")
    assert "\\documentclass" in main_content
    assert "\\usepackage{ctex}" in main_content


def test_run_writes_chapter_files_to_vfs():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    assert session.vfs.exists("chapters/01_intro.tex")
    assert session.vfs.exists("chapters/02_related.tex")


def test_run_writes_refs_bib_to_vfs():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    assert session.vfs.exists("refs.bib")
    bib_content = session.vfs.read("refs.bib")
    assert "ref1" in bib_content
    assert "ViT论文" in bib_content


def test_run_result_contains_all_file_paths():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))
    result = [e for e in events if e["type"] == "result"][0]

    assert "main.tex" in result["data"]
    assert "chapters/01_intro.tex" in result["data"]
    assert "chapters/02_related.tex" in result["data"]
    assert "refs.bib" in result["data"]


def test_run_progress_messages():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))
    progress_events = [e for e in events if e["type"] == "progress"]

    assert "正在生成 LaTeX 文件" in progress_events[0]["detail"]
    assert "main.tex" in progress_events[1]["detail"]
    assert "chapters/01_intro.tex" in progress_events[2]["detail"]
    assert "chapters/02_related.tex" in progress_events[3]["detail"]
    assert "refs.bib" in progress_events[4]["detail"]


# --- _generate_main() ---


def test_generate_main_includes_title():
    agent = _make_agent()
    plan = {"title": "测试论文标题", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\title{测试论文标题}" in result


def test_generate_main_includes_ctex_and_fontspec():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\usepackage{ctex}" in result
    assert "\\usepackage{fontspec}" in result


def test_generate_main_includes_chapter_inputs():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\input{chapters/01_intro}" in result
    assert "\\input{chapters/02_related}" in result


def test_generate_main_includes_bibliography():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\bibliographystyle{plainnat}" in result
    assert "\\bibliography{refs}" in result


def test_generate_main_has_document_structure():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\begin{document}" in result
    assert "\\end{document}" in result
    assert "\\maketitle" in result


def test_generate_main_includes_geometry():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\usepackage{geometry}" in result
    assert "left=2.5cm" in result


def test_generate_main_chapters_sorted():
    agent = _make_agent()
    outline = {
        "chapters/03_conclusion.tex": {"title": "结论"},
        "chapters/01_intro.tex": {"title": "引言"},
        "chapters/02_method.tex": {"title": "方法"},
    }
    plan = {"title": "测试", "outline": outline}

    result = agent._generate_main(plan)

    pos_01 = result.index("chapters/01_intro")
    pos_02 = result.index("chapters/02_method")
    pos_03 = result.index("chapters/03_conclusion")
    assert pos_01 < pos_02 < pos_03


def test_generate_main_default_title():
    agent = _make_agent()
    plan = {"outline": {}}

    result = agent._generate_main(plan)

    assert "\\title{Untitled}" in result


def test_generate_main_no_item_structures():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    result = agent._generate_main(plan)

    assert "\\begin{itemize}" not in result
    assert "\\begin{enumerate}" not in result
    assert "\\item" not in result


def test_generate_main_does_not_call_llm():
    agent = _make_agent()
    plan = {"title": "测试", "outline": MOCK_OUTLINE}

    agent._generate_main(plan)

    agent.llm.complete.assert_not_called()


# --- _to_latex() ---


def test_to_latex_calls_llm():
    agent = _make_agent()

    agent._to_latex("引言", "纯文本内容", ["研究背景", "问题定义"])

    agent.llm.complete.assert_called_once()


def test_to_latex_prompt_contains_title():
    agent = _make_agent()

    agent._to_latex("引言", "纯文本内容", ["研究背景"])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "引言" in content


def test_to_latex_prompt_contains_sections():
    agent = _make_agent()

    agent._to_latex("引言", "纯文本内容", ["研究背景", "问题定义"])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "研究背景" in content
    assert "问题定义" in content


def test_to_latex_prompt_forbids_item():
    agent = _make_agent()

    agent._to_latex("引言", "纯文本内容", ["研究背景"])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "itemize" in content
    assert "enumerate" in content
    assert "item" in content
    assert "绝对不使用" in content


def test_to_latex_prompt_requires_section_header():
    agent = _make_agent()

    agent._to_latex("引言", "纯文本内容", ["研究背景"])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "\\section{引言}" in content


def test_to_latex_prompt_requires_cite_conversion():
    agent = _make_agent()

    agent._to_latex("引言", "纯文本内容", ["研究背景"])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "\\cite" in content


def test_to_latex_returns_empty_on_none():
    llm = MagicMock()
    llm.complete = MagicMock(return_value=None)
    agent = FormatterAgent(llm)

    result = agent._to_latex("引言", "内容", ["研究背景"])

    assert result == ""


# --- _generate_bib() ---


def test_generate_bib_creates_entries():
    agent = _make_agent()

    result = agent._generate_bib(MOCK_LITERATURE)

    assert "@article{ref1," in result
    assert "@article{ref2," in result
    assert "@article{ref3," in result


def test_generate_bib_includes_title():
    agent = _make_agent()

    result = agent._generate_bib(MOCK_LITERATURE)

    assert "ViT论文" in result
    assert "DeiT论文" in result
    assert "Swin Transformer" in result


def test_generate_bib_includes_authors():
    agent = _make_agent()

    result = agent._generate_bib(MOCK_LITERATURE)

    assert "Dosovitskiy et al." in result
    assert "Touvron et al." in result
    assert "Liu et al." in result


def test_generate_bib_includes_year():
    agent = _make_agent()

    result = agent._generate_bib(MOCK_LITERATURE)

    assert "2020" in result
    assert "2021" in result


def test_generate_bib_default_authors():
    agent = _make_agent()
    lit = [{"title": "无作者论文", "year": "2024"}]

    result = agent._generate_bib(lit)

    assert "Unknown" in result


def test_generate_bib_default_year():
    agent = _make_agent()
    lit = [{"title": "无年份论文", "authors": "Test Author"}]

    result = agent._generate_bib(lit)

    assert "2024" in result


def test_generate_bib_empty_literature():
    agent = _make_agent()

    result = agent._generate_bib([])

    assert result == ""


def test_generate_bib_does_not_call_llm():
    agent = _make_agent()

    agent._generate_bib(MOCK_LITERATURE)

    agent.llm.complete.assert_not_called()


# --- 边界情况 ---


def test_run_with_empty_outline():
    agent = _make_agent()
    session = _make_session()
    session.file_plan = {"title": "空论文", "outline": {}}

    events = list(agent.run(session))

    # main.tex + refs.bib should still be written
    assert session.vfs.exists("main.tex")
    assert session.vfs.exists("refs.bib")
    result = [e for e in events if e["type"] == "result"][0]
    assert "main.tex" in result["data"]
    assert "refs.bib" in result["data"]


def test_run_with_empty_literature():
    agent = _make_agent()
    session = _make_session()
    session.literature = []

    list(agent.run(session))

    bib_content = session.vfs.read("refs.bib")
    assert bib_content == ""


def test_run_with_missing_content():
    """If session.content is missing a chapter, _to_latex gets empty string"""
    agent = _make_agent()
    session = _make_session()
    session.content = {}  # No content written by WriterAgent

    list(agent.run(session))

    # Should still write files (LLM gets empty content)
    assert session.vfs.exists("chapters/01_intro.tex")
    assert session.vfs.exists("chapters/02_related.tex")


def test_run_chapters_processed_in_sorted_order():
    """Chapters should be formatted in sorted order by file path"""
    call_order = []
    llm = MagicMock()

    def track_calls(msgs, **kwargs):
        content = msgs[0]["content"]
        if "章节标题:" in content:
            for line in content.split("\n"):
                if line.startswith("章节标题:"):
                    call_order.append(line.split(":")[1].strip())
                    break
        return "\\section{test}"

    llm.complete = MagicMock(side_effect=track_calls)
    agent = FormatterAgent(llm)
    session = _make_session()

    list(agent.run(session))

    assert call_order == ["引言", "相关工作"]
