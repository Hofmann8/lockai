"""
WriterAgent 单元测试
"""

from unittest.mock import MagicMock, call

from .writer import WriterAgent
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
    "chapters/03_conclusion.tex": {
        "title": "结论",
        "sections": ["总结", "展望"],
        "key_points": ["研究贡献", "未来方向"],
        "citations": [],
        "target_words": 500,
    },
}

MOCK_LITERATURE = [
    {"title": "ViT论文", "year": 2020},
    {"title": "DeiT论文", "year": 2021},
    {"title": "Swin Transformer", "year": 2021},
]


def _make_session() -> PaperSession:
    session = PaperSession(id="test-001", user_id="user-001", topic="Transformer图像分类")
    session.literature = MOCK_LITERATURE
    session.file_plan = {"title": "测试论文", "outline": MOCK_OUTLINE}
    return session


def _make_agent(chapter_text: str = "这是章节内容。", summary_text: str = "这是摘要。") -> WriterAgent:
    llm = MagicMock()
    llm.complete = MagicMock(side_effect=lambda msgs, **kwargs: chapter_text if "撰写学术论文章节" in msgs[0]["content"] else summary_text)
    return WriterAgent(llm)


# --- run() 正常流程 ---


def test_run_yields_progress_and_result():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))

    # 1 initial + 3 chapters = 4 progress events + 1 result
    progress_events = [e for e in events if e["type"] == "progress"]
    result_events = [e for e in events if e["type"] == "result"]
    assert len(progress_events) == 4
    assert len(result_events) == 1


def test_run_populates_session_content():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    assert len(session.content) == 3
    assert "chapters/01_intro.tex" in session.content
    assert "chapters/02_related.tex" in session.content
    assert "chapters/03_conclusion.tex" in session.content


def test_run_result_contains_all_file_paths():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))
    result = [e for e in events if e["type"] == "result"][0]

    assert sorted(result["data"]) == sorted([
        "chapters/01_intro.tex",
        "chapters/02_related.tex",
        "chapters/03_conclusion.tex",
    ])


def test_run_progress_shows_chapter_numbers():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))
    progress_events = [e for e in events if e["type"] == "progress"]

    assert "开始撰写论文" in progress_events[0]["detail"]
    assert "1/3" in progress_events[1]["detail"]
    assert "引言" in progress_events[1]["detail"]
    assert "2/3" in progress_events[2]["detail"]
    assert "3/3" in progress_events[3]["detail"]


# --- _write_chapter() ---


def test_write_chapter_includes_topic_in_prompt():
    agent = _make_agent()
    session = _make_session()

    agent._write_chapter(session, "chapters/01_intro.tex", MOCK_OUTLINE["chapters/01_intro.tex"], [])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "Transformer图像分类" in content


def test_write_chapter_includes_citations():
    agent = _make_agent()
    session = _make_session()

    agent._write_chapter(session, "chapters/01_intro.tex", MOCK_OUTLINE["chapters/01_intro.tex"], [])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "[ref1]" in content
    assert "ViT论文" in content
    assert "[ref2]" in content
    assert "DeiT论文" in content


def test_write_chapter_first_chapter_shows_first_chapter_context():
    agent = _make_agent()
    session = _make_session()

    agent._write_chapter(session, "chapters/01_intro.tex", MOCK_OUTLINE["chapters/01_intro.tex"], [])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "这是第一章" in content


def test_write_chapter_passes_previous_summaries():
    agent = _make_agent()
    session = _make_session()
    prev = ["【引言】这是引言摘要"]

    agent._write_chapter(session, "chapters/02_related.tex", MOCK_OUTLINE["chapters/02_related.tex"], prev)

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "引言" in content
    assert "这是引言摘要" in content


def test_write_chapter_limits_to_last_3_summaries():
    agent = _make_agent()
    session = _make_session()
    prev = [f"【第{i}章】摘要{i}" for i in range(5)]

    agent._write_chapter(session, "chapters/03_conclusion.tex", MOCK_OUTLINE["chapters/03_conclusion.tex"], prev)

    content = agent.llm.complete.call_args[0][0][0]["content"]
    # Should only contain last 3 (index 2, 3, 4)
    assert "摘要2" in content
    assert "摘要3" in content
    assert "摘要4" in content
    assert "摘要0" not in content
    assert "摘要1" not in content


def test_write_chapter_handles_out_of_range_citation():
    agent = _make_agent()
    session = _make_session()
    plan_with_bad_ref = {
        "title": "测试",
        "sections": [],
        "key_points": [],
        "citations": ["ref99"],
        "target_words": 500,
    }

    # Should not raise
    agent._write_chapter(session, "chapters/01_intro.tex", plan_with_bad_ref, [])

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "[ref99]" not in content  # ref99 is out of range, not included


def test_write_chapter_returns_empty_string_on_none():
    llm = MagicMock()
    llm.complete = MagicMock(return_value=None)
    agent = WriterAgent(llm)
    session = _make_session()

    result = agent._write_chapter(session, "chapters/01_intro.tex", MOCK_OUTLINE["chapters/01_intro.tex"], [])

    assert result == ""


# --- _summarize_chapter() ---


def test_summarize_chapter_calls_llm():
    agent = _make_agent()

    result = agent._summarize_chapter("引言", "这是一段很长的章节内容...")

    agent.llm.complete.assert_called_once()
    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "概括" in content


def test_summarize_chapter_truncates_long_content():
    agent = _make_agent()
    long_content = "A" * 3000

    agent._summarize_chapter("引言", long_content)

    content = agent.llm.complete.call_args[0][0][0]["content"]
    # Content should be truncated to 1500 chars
    assert len(content) < 3000


def test_summarize_chapter_returns_empty_on_none():
    llm = MagicMock()
    llm.complete = MagicMock(return_value=None)
    agent = WriterAgent(llm)

    result = agent._summarize_chapter("引言", "内容")

    assert result == ""


# --- 边界情况 ---


def test_run_with_empty_outline():
    agent = _make_agent()
    session = _make_session()
    session.file_plan = {"title": "空论文", "outline": {}}

    events = list(agent.run(session))

    assert len(session.content) == 0
    result = [e for e in events if e["type"] == "result"][0]
    assert result["data"] == []


def test_run_with_empty_literature():
    agent = _make_agent()
    session = _make_session()
    session.literature = []

    list(agent.run(session))

    # Should still work, just no citation info in prompt
    assert len(session.content) == 3


def test_run_chapters_sorted_by_filename():
    """Chapters should be written in sorted order by file path"""
    call_order = []
    llm = MagicMock()

    def track_calls(msgs, **kwargs):
        content = msgs[0]["content"]
        if "撰写学术论文章节" in content:
            # Extract chapter title from prompt
            for line in content.split("\n"):
                if line.startswith("章节标题:"):
                    call_order.append(line.split(":")[1].strip())
                    break
        return "内容"

    llm.complete = MagicMock(side_effect=track_calls)
    agent = WriterAgent(llm)
    session = _make_session()

    list(agent.run(session))

    assert call_order == ["引言", "相关工作", "结论"]
