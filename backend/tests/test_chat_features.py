"""思考过程流、搜索来源、追问解析这些纯逻辑的单元测试。"""

import sys
import types

if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = boto3

from services.ai import AIService
from services.search import SearchService
from services.title import TitleService


class _StreamingLLM:
    def __init__(self, chunks):
        self._chunks = chunks

    def stream_chat_completion(self, *args, **kwargs):
        yield from self._chunks


def _run_stream(chunks):
    service = AIService.__new__(AIService)
    service.llm = _StreamingLLM(chunks)
    service.max_tool_rounds = 1
    state = {"parts": [], "started": None, "ended": None}
    content_parts = []
    events = list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=True, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=content_parts,
        reasoning_state=state,
    ))
    return events, state, content_parts


def test_reasoning_deltas_are_streamed_and_collected():
    events, state, content = _run_stream([
        {"delta": {"reasoning_content": "先想"}},
        {"delta": {"reasoning": "再想"}},
        {"delta": {"content": "结论"}},
    ])
    assert [e["type"] for e in events] == ["reasoning_delta", "reasoning_delta", "content_delta"]
    assert "".join(state["parts"]) == "先想再想"
    assert content == ["结论"]
    assert AIService._reasoning_seconds(state) == 1


def test_no_reasoning_means_no_seconds():
    _, state, _ = _run_stream([{"delta": {"content": "直接回答"}}])
    assert state["parts"] == []
    assert AIService._reasoning_seconds(state) is None


def test_search_sources_are_normalized_and_deduped():
    raw = [
        {"title": "杭州天气", "url": "https://a.com/1", "site_name": "网易", "icon": "https://i/1.png"},
        {"title": "重复", "url": "https://a.com/1", "site_name": "网易"},
        {"title": "没有协议", "url": "a.com/2"},
        {"title": "无站点名", "url": "https://b.org/x"},
    ]
    sources = SearchService._normalize_sources(raw)
    assert [s["url"] for s in sources] == ["https://a.com/1", "https://b.org/x"]
    assert sources[1]["site"] == "b.org"


def test_search_response_parsing_keeps_citations_and_cleans_links():
    data = {"output": [
        {"type": "web_search_call", "status": "completed"},
        {"type": "message", "content": [{
            "type": "output_text",
            "text": "杭州今天多云，最高 31℃（[中国天气网](https://www.weather.com.cn/hz?utm_source=openai)）。",
            "annotations": [{
                "type": "url_citation",
                "url": "https://www.weather.com.cn/hz?utm_source=openai",
                "title": "杭州天气预报",
            }],
        }]},
    ]}
    text, sources = SearchService._parse_response(data)
    assert "（中国天气网（weather.com.cn））" in text and "utm_source" not in text
    assert sources == [{"title": "杭州天气预报", "url": "https://www.weather.com.cn/hz", "site": "weather.com.cn", "icon": "https://www.weather.com.cn/favicon.ico"}]


def test_search_falls_back_to_consulted_pages_when_nothing_is_cited():
    data = {"output": [
        {"type": "web_search_call", "action": {"type": "search", "sources": [
            {"type": "url", "url": "https://news.sciencenet.cn/a.shtm"},
            {"type": "url", "url": "https://www.itsdw.cn/news/1.html?utm_source=openai"},
        ]}},
        {"type": "message", "content": [{"type": "output_text", "text": "本月科技要闻……", "annotations": []}]},
    ]}
    text, sources = SearchService._parse_response(data)
    assert text == "本月科技要闻……"
    assert [s["site"] for s in sources] == ["news.sciencenet.cn", "itsdw.cn"]
    assert sources[1]["url"] == "https://www.itsdw.cn/news/1.html"

    # 有引用时只展示引用过的，不把看过的网页全堆上去
    data["output"][1]["content"][0]["annotations"] = [{"type": "url_citation", "url": "https://a.com/x", "title": "A"}]
    _, sources = SearchService._parse_response(data)
    assert [s["url"] for s in sources] == ["https://a.com/x"]


def test_time_context_uses_beijing_date():
    from datetime import datetime, timezone
    from services.prompts import current_time_context
    text = current_time_context(datetime(2026, 9, 23, 17, 30, tzinfo=timezone.utc))
    assert "2026年9月24日" in text and "星期四" in text and "01:30" in text


def test_followup_parsing_accepts_json_and_lists():
    assert TitleService._parse_followups('好的：["能举个例子吗", "和 popping 有什么区别"]') == ["能举个例子吗", "和 popping 有什么区别"]
    assert TitleService._parse_followups("1. 第一条追问\n2、第二条追问\n- 第三条追问\n4. 第四条") == ["第一条追问", "第二条追问", "第三条追问"]
    assert TitleService._parse_followups("") == []


def test_narration_before_a_tool_call_is_dropped():
    class _NarratingLLM:
        def __init__(self):
            self.rounds = 0

        def stream_chat_completion(self, *args, **kwargs):
            self.rounds += 1
            if self.rounds == 1:
                yield {"delta": {"content": "I'll search for "}}
                yield {"delta": {"content": "the latest news."}}
                yield {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {
                    "name": "web_search", "arguments": '{"query": "科技新闻"}'}}]}}
            else:
                yield {"delta": {"content": "本周两条要闻：……"}}

    service = AIService.__new__(AIService)
    service.llm = _NarratingLLM()
    service.search = _FakeSearch()
    service.max_tool_rounds = 3
    content_parts, messages = [], [{"role": "user", "content": "最近科技新闻"}]
    events = list(service._chat_with_stream(
        llm_messages=messages, model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    streamed = "".join(e["delta"] for e in events if e["type"] == "content_delta")
    assert "search" not in streamed and streamed.endswith("本周两条要闻：……")
    assert "search" not in "".join(content_parts)
    assert messages[1]["role"] == "assistant" and messages[1]["content"] is None


def test_long_text_before_a_tool_call_is_kept():
    class _AnswerThenDrawLLM:
        def __init__(self):
            self.rounds = 0

        def stream_chat_completion(self, *args, **kwargs):
            self.rounds += 1
            if self.rounds == 1:
                yield {"delta": {"content": "好的，先说思路：" + "构图用三分法，主体放在左侧，" * 4}}
                yield {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {
                    "name": "web_search", "arguments": '{"query": "构图"}'}}]}}
            else:
                yield {"delta": {"content": "完成。"}}

    service = AIService.__new__(AIService)
    service.llm = _AnswerThenDrawLLM()
    service.search = _FakeSearch()
    service.max_tool_rounds = 3
    content_parts = []
    list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    assert "".join(content_parts).startswith("好的，先说思路：")


class _ToolHappyLLM:
    """每一轮只要给了工具就要求搜索；不给工具时老老实实回答。"""

    def __init__(self):
        self.tools_per_round = []

    def stream_chat_completion(self, messages, model=None, *, tools=None, **kwargs):
        self.tools_per_round.append(tools)
        if tools:
            n = len(self.tools_per_round)
            yield {"delta": {"tool_calls": [{"index": 0, "id": f"c{n}", "function": {
                "name": "web_search", "arguments": '{"query": "杭州天气 %d"}' % n}}]}}
        else:
            yield {"delta": {"content": "杭州今天多云。"}}


class _FakeSearch:
    def __init__(self):
        self.queries = []

    def search_with_sources(self, query):
        self.queries.append(query)
        return f"{query} 的结果", []


def test_search_budget_and_final_round_force_an_answer():
    service = AIService.__new__(AIService)
    service.llm = _ToolHappyLLM()
    service.search = _FakeSearch()
    service.max_tool_rounds = 6
    content_parts, tool_trace, messages = [], [], [{"role": "user", "content": "今天杭州天气"}]
    events = list(service._chat_with_stream(
        llm_messages=messages, model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=tool_trace, content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    # 最多真的搜 4 次，第 5 次起只回一句"别再搜了"
    assert len(service.search.queries) == 4
    assert sum(1 for e in events if e["type"] == "search_start") == 4
    # 最后一轮不给工具，模型必须作答，不会出现"轮数已达上限"
    assert service.llm.tools_per_round[-1] is None
    assert "".join(p for p in content_parts if not p.startswith("<!--")) == "杭州今天多云。"
    assert "上限" not in "".join(content_parts)
