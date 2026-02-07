"""
ResearcherAgent 单元测试
"""

import json
from unittest.mock import MagicMock

from .researcher import ResearcherAgent
from ..session import PaperSession, PaperStatus


MOCK_LITERATURE_JSON = json.dumps([
    {
        "title": "Deep Learning for NLP",
        "authors": "Zhang Wei, Li Ming",
        "year": 2023,
        "abstract": "本文综述了深度学习在自然语言处理中的最新进展。"
    },
    {
        "title": "Transformer Architecture Survey",
        "authors": "Wang Fang",
        "year": 2024,
        "abstract": "对Transformer架构及其变体的全面调查。"
    },
], ensure_ascii=False)

MOCK_SUMMARY = "深度学习在NLP领域取得了显著进展，Transformer架构成为主流方法。研究趋势表明..."


def _make_session(topic: str = "深度学习在自然语言处理中的应用") -> PaperSession:
    return PaperSession(id="test-001", user_id="user-001", topic=topic)


def _make_agent(literature_response: str | None = None, summary_response: str | None = None) -> ResearcherAgent:
    """创建带 mock LLM 的 ResearcherAgent"""
    llm = MagicMock()
    llm.complete = MagicMock(side_effect=[literature_response, summary_response])
    return ResearcherAgent(llm)


# --- run() 正常流程 ---

def test_run_yields_progress_and_result():
    agent = _make_agent(MOCK_LITERATURE_JSON, MOCK_SUMMARY)
    session = _make_session()

    events = list(agent.run(session))

    assert len(events) == 3
    assert events[0] == {"type": "progress", "stage": "researching", "detail": "正在检索相关文献..."}
    assert events[1] == {"type": "progress", "stage": "researching", "detail": "正在综合分析文献..."}
    assert events[2]["type"] == "result"
    assert isinstance(events[2]["data"], list)


def test_run_populates_session_literature():
    agent = _make_agent(MOCK_LITERATURE_JSON, MOCK_SUMMARY)
    session = _make_session()

    list(agent.run(session))

    assert len(session.literature) == 2
    assert session.literature[0]["title"] == "Deep Learning for NLP"
    assert session.literature[1]["year"] == 2024


def test_run_populates_session_summary():
    agent = _make_agent(MOCK_LITERATURE_JSON, MOCK_SUMMARY)
    session = _make_session()

    list(agent.run(session))

    assert session.literature_summary == MOCK_SUMMARY


def test_run_calls_llm_with_correct_message_format():
    agent = _make_agent(MOCK_LITERATURE_JSON, MOCK_SUMMARY)
    session = _make_session("量子计算")

    list(agent.run(session))

    calls = agent.llm.complete.call_args_list
    assert len(calls) == 2
    # 第一次调用：生成文献
    first_messages = calls[0][0][0]
    assert isinstance(first_messages, list)
    assert first_messages[0]["role"] == "user"
    assert "量子计算" in first_messages[0]["content"]
    # 第二次调用：生成摘要
    second_messages = calls[1][0][0]
    assert isinstance(second_messages, list)
    assert "量子计算" in second_messages[0]["content"]


# --- _parse_literature() 边界情况 ---

def test_parse_literature_with_none_response():
    agent = _make_agent()
    assert agent._parse_literature(None) == []


def test_parse_literature_with_empty_string():
    agent = _make_agent()
    assert agent._parse_literature("") == []


def test_parse_literature_with_markdown_wrapped_json():
    agent = _make_agent()
    response = '```json\n[{"title": "Test Paper", "authors": "A", "year": 2024, "abstract": "test"}]\n```'
    result = agent._parse_literature(response)
    assert len(result) == 1
    assert result[0]["title"] == "Test Paper"


def test_parse_literature_with_invalid_json():
    agent = _make_agent()
    assert agent._parse_literature("[{invalid json}]") == []


def test_parse_literature_with_no_brackets():
    agent = _make_agent()
    assert agent._parse_literature("这里没有JSON数据") == []


# --- LLM 返回 None 的容错 ---

def test_run_handles_llm_returning_none_for_literature():
    agent = _make_agent(None, MOCK_SUMMARY)
    session = _make_session()

    events = list(agent.run(session))

    assert session.literature == []
    assert session.literature_summary == MOCK_SUMMARY
    assert events[-1]["data"] == []


def test_run_handles_llm_returning_none_for_summary():
    agent = _make_agent(MOCK_LITERATURE_JSON, None)
    session = _make_session()

    list(agent.run(session))

    assert len(session.literature) == 2
    assert session.literature_summary == ""
