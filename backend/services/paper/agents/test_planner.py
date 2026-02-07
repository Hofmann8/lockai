"""
PlannerAgent 单元测试
"""

import json
from unittest.mock import MagicMock

from .planner import PlannerAgent
from ..session import PaperSession


MOCK_PLAN = {
    "title": "基于Transformer的图像分类方法综述",
    "files": {
        "main.tex": "入口文件",
        "chapters/01_intro.tex": "引言",
        "chapters/02_related.tex": "相关工作",
        "chapters/03_method.tex": "方法",
        "chapters/04_experiment.tex": "实验",
        "chapters/05_conclusion.tex": "结论",
        "refs.bib": "参考文献",
    },
    "outline": {
        "chapters/01_intro.tex": {
            "title": "引言",
            "sections": ["研究背景", "问题定义", "本文贡献"],
            "key_points": ["CV领域Transformer兴起", "与CNN的对比"],
            "citations": ["ref1", "ref2"],
            "target_words": 800,
        },
        "chapters/02_related.tex": {
            "title": "相关工作",
            "sections": ["传统方法", "CNN方法", "Transformer方法"],
            "key_points": ["SIFT/HOG", "AlexNet到ResNet"],
            "citations": ["ref3", "ref4"],
            "target_words": 1200,
        },
    },
}

MOCK_PLAN_JSON = json.dumps(MOCK_PLAN, ensure_ascii=False)


def _make_session() -> PaperSession:
    session = PaperSession(id="test-001", user_id="user-001", topic="Transformer图像分类")
    session.literature = [
        {"title": "ViT论文", "year": 2020},
        {"title": "DeiT论文", "year": 2021},
        {"title": "Swin Transformer", "year": 2021},
        {"title": "CNN经典综述", "year": 2019},
    ]
    session.literature_summary = "Transformer在CV领域取得了显著进展..."
    return session


def _make_agent(response: str | None = MOCK_PLAN_JSON) -> PlannerAgent:
    llm = MagicMock()
    llm.complete = MagicMock(return_value=response)
    return PlannerAgent(llm)


# --- run() 正常流程 ---


def test_run_yields_progress_and_result():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))

    assert len(events) == 3
    assert events[0] == {"type": "progress", "stage": "planning", "detail": "正在规划论文结构..."}
    assert events[1]["type"] == "progress"
    assert "规划完成" in events[1]["detail"]
    assert events[2]["type"] == "result"


def test_run_populates_session_file_plan():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    assert session.file_plan["title"] == "基于Transformer的图像分类方法综述"
    assert "main.tex" in session.file_plan["files"]
    assert "chapters/01_intro.tex" in session.file_plan["outline"]


def test_run_reports_correct_file_count():
    agent = _make_agent()
    session = _make_session()

    events = list(agent.run(session))

    assert "7 个文件" in events[1]["detail"]


def test_run_calls_llm_with_topic_and_refs():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    calls = agent.llm.complete.call_args_list
    assert len(calls) == 1
    messages = calls[0][0][0]
    assert isinstance(messages, list)
    assert messages[0]["role"] == "user"
    content = messages[0]["content"]
    assert "Transformer图像分类" in content
    assert "ref1" in content
    assert "ViT论文" in content


def test_run_includes_literature_summary_in_prompt():
    agent = _make_agent()
    session = _make_session()

    list(agent.run(session))

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "Transformer在CV领域取得了显著进展" in content


# --- _parse_plan() 容错 ---


def test_parse_plan_with_none():
    agent = _make_agent()
    assert agent._parse_plan(None) == {}


def test_parse_plan_with_empty_string():
    agent = _make_agent()
    assert agent._parse_plan("") == {}


def test_parse_plan_with_valid_json():
    agent = _make_agent()
    result = agent._parse_plan(MOCK_PLAN_JSON)
    assert result["title"] == "基于Transformer的图像分类方法综述"
    assert len(result["files"]) == 7


def test_parse_plan_with_markdown_wrapped_json():
    agent = _make_agent()
    response = f"```json\n{MOCK_PLAN_JSON}\n```"
    result = agent._parse_plan(response)
    assert result["title"] == "基于Transformer的图像分类方法综述"


def test_parse_plan_with_text_before_json():
    agent = _make_agent()
    response = f"以下是规划结果：\n{MOCK_PLAN_JSON}\n希望对你有帮助。"
    result = agent._parse_plan(response)
    assert result["title"] == "基于Transformer的图像分类方法综述"


def test_parse_plan_with_invalid_json():
    agent = _make_agent()
    assert agent._parse_plan("{invalid json content}") == {}


def test_parse_plan_with_no_braces():
    agent = _make_agent()
    assert agent._parse_plan("这里没有JSON数据") == {}


# --- LLM 返回 None 的容错 ---


def test_run_handles_llm_returning_none():
    agent = _make_agent(None)
    session = _make_session()

    events = list(agent.run(session))

    assert session.file_plan == {}
    assert events[1]["detail"] == "规划完成：0 个文件"
    assert events[2]["data"] == {}


# --- 空文献列表 ---


def test_run_with_empty_literature():
    agent = _make_agent()
    session = _make_session()
    session.literature = []
    session.literature_summary = ""

    list(agent.run(session))

    content = agent.llm.complete.call_args[0][0][0]["content"]
    assert "Transformer图像分类" in content
