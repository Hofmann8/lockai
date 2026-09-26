"""思考过程流、搜索来源、追问解析这些纯逻辑的单元测试。"""

import sys
import types

import pytest

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
    state = {"parts": [], "started": None, "ended": None, "seconds": 0.0, "tokens": 0}
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
    assert [e["type"] for e in events] == ["reasoning_delta", "reasoning_delta", "content_delta", "reasoning_stats"]
    assert "".join(state["parts"]) == "先想再想"
    assert content == ["结论"]
    # 上游没报思考 token 时按思考文字数
    assert events[-1]["tokens"] == state["tokens"] > 0
    assert AIService._reasoning_seconds(state) == 1


def test_reasoning_stats_use_upstream_tokens_and_sum_across_rounds():
    llm, events, _ = _run_rounds([
        [
            {"delta": {"reasoning_content": "**Planning**"}},
            {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "nope", "arguments": "{}"}}]}, "finish_reason": "tool_calls"},
            {"type": "usage", "usage": {"prompt_tokens": 10, "completion_tokens": 330, "completion_tokens_details": {"reasoning_tokens": 300}}},
        ],
        [
            {"delta": {"content": "好了"}, "finish_reason": "stop"},
            {"type": "usage", "usage": {"prompt_tokens": 20, "completion_tokens": 140, "completion_tokens_details": {"reasoning_tokens": 120}}},
        ],
    ])
    stats = [e for e in events if e["type"] == "reasoning_stats"]
    assert [s["tokens"] for s in stats] == [300, 420]


def test_no_reasoning_means_no_stats():
    _, events, _ = _run_rounds([[{"delta": {"content": "直接答"}, "finish_reason": "stop"}]])
    assert not [e for e in events if e["type"] == "reasoning_stats"]


def test_thinking_seconds_split_when_relay_buffers_tool_calls():
    usage = {"completion_tokens": 1000, "completion_tokens_details": {"reasoning_tokens": 200}}
    # 工具参数攒到最后一起到：100 秒里按 200/1000 折算成 20 秒
    assert AIService._thinking_seconds(0.0, 100.0, 100.2, usage) == pytest.approx(20.04)
    # 正文是流出来的：到第一段输出的时间就是思考时间
    assert AIService._thinking_seconds(0.0, 12.0, 60.0, usage) == 12.0
    # 上游没报思考 token，就只能按到第一段输出算
    assert AIService._thinking_seconds(0.0, 30.0, 30.1, {"completion_tokens": 500}) == 30.0


def test_writing_time_and_tokens_go_to_the_step_that_was_written():
    calls = [{"raw_arguments": "x" * 300}, {"raw_arguments": "y" * 100}]
    usage = {"completion_tokens": 1200, "completion_tokens_details": {"reasoning_tokens": 200}}
    AIService._attach_prep(calls, seconds=40.0, usage=usage)
    # 除去思考的 1000 个输出 token、40 秒按参数长度 3:1 分
    assert calls[0]["prep"] == {"seconds": 30.0, "tokens": 750}
    assert calls[1]["prep"] == {"seconds": 10.0, "tokens": 250}


def test_writing_tokens_fall_back_to_counting_arguments():
    calls = [{"raw_arguments": '{"command": "echo 你好"}'}]
    AIService._attach_prep(calls, seconds=-1.0, usage=None)
    assert calls[0]["prep"]["seconds"] == 0.0 and calls[0]["prep"]["tokens"] > 0


class _StopAfter:
    """后台运行的控制对象：第 n 次问 should_stop 起返回 True"""

    def __init__(self, n, reason="user"):
        self.calls = 0
        self.n = n
        self.stop_reason = None
        self._reason = reason

    def should_stop(self):
        self.calls += 1
        if self.calls >= self.n:
            self.stop_reason = self._reason
        return self.stop_reason is not None


def test_stop_cuts_the_upstream_and_skips_pending_tool_calls():
    from services.ai import STOPPED
    service = AIService.__new__(AIService)
    service.llm = _ScriptedLLM([[
        {"delta": {"content": "先写一段"}},
        {"delta": {"content": "再写一段"}},
        {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "shell", "arguments": "{}"}}]}},
    ]])
    service.max_tool_rounds = 3
    content = []
    gen = service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=content,
        turn={"pending_images": [], "control": _StopAfter(3)},
    )
    events = []
    try:
        while True:
            events.append(next(gen))
    except StopIteration as done:
        result = done.value
    assert result == STOPPED
    assert "".join(content) == "先写一段"
    assert not [e for e in events if e["type"].startswith("shell")]


def test_evicted_answer_explains_itself_and_marks_running_steps():
    service = AIService.__new__(AIService)
    trace = [{"kind": "shell", "id": "x", "status": "running"}]
    events = list(service._finish_stopped(
        reason="evicted", assistant_message_id="a1", session=None, content_parts=["写到一半"],
        tool_trace=trace, reasoning_state={"parts": [], "tokens": 0},
    ))
    assert events[0]["type"] == "content_delta" and "继续" in events[0]["delta"]
    assert events[-1] == {"type": "message_end", "message_id": "a1", "stopped": "evicted"}
    assert trace[0]["status"] == "done" and trace[0]["success"] is False


class _ScriptedLLM:
    """每轮按顺序吐一组 chunk，并记下每轮的思考开关和消息。"""

    def __init__(self, rounds):
        self._rounds = list(rounds)
        self.calls = []

    def stream_chat_completion(self, messages, *args, enable_thinking=None, **kwargs):
        self.calls.append({"thinking": enable_thinking, "messages": list(messages)})
        yield from self._rounds.pop(0)


def _run_rounds(rounds, max_rounds=5):
    service = AIService.__new__(AIService)
    service.llm = _ScriptedLLM(rounds)
    service.max_tool_rounds = max_rounds
    content_parts = []
    events = list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=True, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None, "seconds": 0.0, "tokens": 0},
    ))
    return service.llm, events, content_parts


def test_length_cut_in_thinking_retries_without_thinking():
    llm, _, content = _run_rounds([
        [{"delta": {"reasoning_content": "打草稿……"}, "finish_reason": "length"}],
        [{"delta": {"content": "正文"}, "finish_reason": "stop"}],
    ])
    assert [c["thinking"] for c in llm.calls] == [True, False]
    assert "".join(content) == "正文"


def test_length_cut_mid_answer_continues_from_where_it_stopped():
    llm, _, content = _run_rounds([
        [{"delta": {"content": "前半段"}, "finish_reason": "length"}],
        [{"delta": {"content": "后半段"}, "finish_reason": "stop"}],
    ])
    assert "".join(content) == "前半段后半段"
    second = llm.calls[1]["messages"]
    assert second[-2] == {"role": "assistant", "content": "前半段"}
    assert second[-1]["role"] == "user"


def test_empty_answer_gets_a_visible_fallback():
    _, _, content = _run_rounds([[{"delta": {"reasoning_content": "想了想"}, "finish_reason": "stop"}]])
    assert "没能生成回答" in "".join(content)


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


def test_preamble_streams_then_moves_into_the_tool_card():
    """工具调用前的一句话照常流出去，工具开始时收进卡片：不进最终正文，挂在 trace 上并随开始事件发给前端。"""
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
    content_parts, tool_trace = [], []
    events = list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=tool_trace, content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    types_ = [e["type"] for e in events]
    assert types_[:3] == ["content_delta", "content_delta", "search_start"]  # 不扣，照常流
    start = events[2]
    assert start["preamble"] == "I'll search for the latest news."
    assert tool_trace[0]["preamble"] == "I'll search for the latest news."
    assert "".join(content_parts) == "<!--tool:0-->本周两条要闻：……"


def test_long_text_before_a_tool_call_is_kept():
    class _AnswerThenDrawLLM:
        def __init__(self):
            self.rounds = 0

        def stream_chat_completion(self, *args, **kwargs):
            self.rounds += 1
            if self.rounds == 1:
                yield {"delta": {"content": "好的，先说思路：\n\n" + "构图用三分法，主体放在左侧，" * 4}}
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
        self.options = []

    def search_with_sources(self, query, **options):
        self.queries.append(query)
        self.options.append(options)
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


# ------------------------------------------------------------------
# CleverSee 联网搜索
# ------------------------------------------------------------------

def _cleversee(monkeypatch, responses):
    """SearchService 走 CleverSee，_post 依次返回给定的响应；记录每次请求体。"""
    monkeypatch.setenv("CLEVERSEE_API_KEY", "test-key")
    service = SearchService(llm_service=None)
    sent = []

    def fake_post(body):
        sent.append({**body, "advancedParams": dict(body.get("advancedParams") or {})})
        return responses.pop(0), 0.3

    monkeypatch.setattr(service, "_post", fake_post)
    return service, sent


def _item(title, link, host="示例站", **extra):
    return {"title": title, "link": link, "hostname": host, "snippet": f"<em>{title}</em> 的摘要", **extra}


def test_search_args_are_normalized():
    from services.search import normalize_search_args
    args = normalize_search_args({"query": " 杭州 ", "engine": "bing", "time_range": "decade", "sites": "a.com， b.com", "full_text": "true"})
    assert args == {"query": "杭州", "engine": "cn_fast", "time_range": "any", "sites": "a.com,b.com", "full_text": True}


def test_cleversee_maps_engine_and_formats_results(monkeypatch):
    service, sent = _cleversee(monkeypatch, [{"pageItems": [
        _item("杭州亚运场馆", "https://www.gov.cn/a?utm_source=x", host="中国政府网", hostLogo="https://logo/gov.png",
              publishedTime="2026-09-20T10:00:00+08:00", mainText="正" * 2000),
        _item("场馆利用", "https://hangzhou.com.cn/b", host=None),
    ]}])
    text, sources = service.search_with_sources("亚运场馆", engine="cn_fast", time_range="week", sites="www.gov.cn", full_text=True)
    body = sent[0]
    assert body["engineType"] == "CNLiteBasic" and body["timeRange"] == "OneWeek"
    assert body["advancedParams"] == {"numResults": "8", "includeSites": "www.gov.cn"}
    assert body["contents"] == {"mainText": True}
    assert "<em>" not in text and "1. 杭州亚运场馆（中国政府网 · 2026-09-20）" in text
    assert "正文节选：" in text and len(text) < 2000  # 正文截断
    assert "hangzhou.com.cn" in text  # 没有站点名时用域名
    assert sources[0] == {"title": "杭州亚运场馆", "url": "https://www.gov.cn/a", "site": "中国政府网", "icon": "https://logo/gov.png"}
    assert sources[1]["icon"] == "https://hangzhou.com.cn/favicon.ico"


def test_cleversee_drops_unsupported_params_and_tells_the_model(monkeypatch):
    service, sent = _cleversee(monkeypatch, [{"pageItems": [_item("x", "https://a.com/1")] * 3}] * 2)
    text, _ = service.search_with_sources("OpenAI news", engine="global", time_range="week")
    assert sent[0]["engineType"] == "GlobalAdvanced" and "timeRange" not in sent[0]
    assert "不支持时间范围" in text
    # cn_news 不支持限定站点 → 换成 cn_fast
    text, _ = service.search_with_sources("个税", engine="cn_news", sites="www.gov.cn")
    assert sent[1]["engineType"] == "CNLiteBasic" and sent[1]["advancedParams"]["includeSites"] == "www.gov.cn"
    assert "已改用 cn_fast" in text


def test_cleversee_widens_site_filter_when_it_finds_nothing(monkeypatch):
    service, sent = _cleversee(monkeypatch, [{"pageItems": []}, {"pageItems": [_item("个税", "https://a.com/1")]}])
    text, sources = service.search_with_sources("个税", sites="gov.cn")
    assert sent[0]["advancedParams"]["includeSites"] == "gov.cn"
    assert "includeSites" not in sent[1]["advancedParams"]
    assert "已放宽为全网" in text and len(sources) == 1
    assert "结果较少" in text


def test_cleversee_weather_scene_becomes_compact_text(monkeypatch):
    import json as _json
    weather = {
        "location": {"city": "杭州市", "district": "杭州市"},
        "realtimeData": {"weather": "多云", "temp": "24", "windDir": "北风", "windLevel": "1", "humidity": "76", "sunRise": "05:48", "sunDown": "17:54"},
        "weatherForecastData": {
            "hourlyForecast": [{"predictHour": f"{h:02d}", "weather": "晴", "temp": "24"} for h in range(25)],
            "dailyForecast": [{"predictDate": f"2026-09-{23 + d}", "weatherDay": "阴", "weatherNight": "多云", "tempLow": "24", "tempHigh": "30",
                               "windDirDay": "东北风", "windLevelDay": "<3级"} for d in range(16)],
        },
    }
    service, sent = _cleversee(monkeypatch, [{"pageItems": [], "sceneItems": [{"type": "weather", "detail": _json.dumps(weather)}]}])
    text, _ = service.search_with_sources("杭州天气", engine="cn_authority", time_range="day")
    assert sent[0]["engineType"] == "Generic" and sent[0]["timeRange"] == "NoLimit"
    assert sent[0]["locationInfo"] == {"city": "杭州市"}
    assert "【天气数据·杭州市】实时：多云 24℃" in text
    assert "2026-09-23：阴转多云 24~30℃" in text
    assert text.count("：阴转多云") == 5  # 只带 5 天
    assert "结果较少" not in text  # 有结构化数据就不催补搜


def test_cleversee_failure_falls_back_to_relay(monkeypatch):
    service, _ = _cleversee(monkeypatch, [None])
    monkeypatch.setattr(service, "_search_relay", lambda query: (f"中转:{query}", []))
    assert service.search_with_sources("杭州天气") == ("中转:杭州天气", [])


def test_web_search_tool_args_reach_the_search_service():
    class _OneSearchLLM:
        def __init__(self):
            self.rounds = 0

        def stream_chat_completion(self, *args, **kwargs):
            self.rounds += 1
            if self.rounds == 1:
                yield {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {
                    "name": "web_search", "arguments": '{"query": "OpenAI news", "engine": "global", "time_range": "week"}'}}]}}
            else:
                yield {"delta": {"content": "好的"}}

    service = AIService.__new__(AIService)
    service.llm = _OneSearchLLM()
    service.search = _FakeSearch()
    service.max_tool_rounds = 3
    tool_trace = []
    events = list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=tool_trace, content_parts=[],
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    assert service.search.options == [{"engine": "global", "time_range": "week", "sites": "", "full_text": False}]
    start = next(e for e in events if e["type"] == "search_start")
    assert start["engine"] == "海外" and tool_trace[0]["engine"] == "海外"


def test_cn_authority_strips_dates_so_scene_data_comes_back(monkeypatch):
    service, sent = _cleversee(monkeypatch, [{"pageItems": [_item("x", "https://a.com/1")] * 3}] * 3)
    service.search_with_sources("杭州 2026年9月24日 天气", engine="cn_authority")
    service.search_with_sources("9月25日 杭州天气", engine="cn_authority")
    service.search_with_sources("OpenAI 2026年9月 发布", engine="cn_fast")
    assert [b["query"] for b in sent] == ["杭州 天气", "杭州天气", "OpenAI 2026年9月 发布"]


def _stream_one_round(first_round_chunks):
    class _LLM:
        def __init__(self):
            self.rounds = 0

        def stream_chat_completion(self, *args, **kwargs):
            self.rounds += 1
            if self.rounds == 1:
                yield from first_round_chunks
            else:
                yield {"delta": {"content": "答案。"}}

    service = AIService.__new__(AIService)
    service.llm = _LLM()
    service.search = _FakeSearch()
    service.max_tool_rounds = 3
    events = list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=[],
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    return "".join(e["delta"] for e in events if e["type"] == "content_delta")


def test_preamble_goes_to_the_first_card_only_and_plain_answers_are_untouched():
    calls = {"delta": {"tool_calls": [
        {"index": 0, "id": "c1", "function": {"name": "web_search", "arguments": '{"query": "汇率"}'}},
        {"index": 1, "id": "c2", "function": {"name": "web_search", "arguments": '{"query": "金价"}'}},
    ]}}
    text = _stream_one_round([{"delta": {"content": "我分别查一下汇率和金价。"}}, calls])
    assert text == "我分别查一下汇率和金价。答案。"  # 流出去的原文，前端收进卡片

    text = _stream_one_round([{"delta": {"content": "我来解释一下递归：函数调用自身，直到基准情形为止。"}}])
    assert text.startswith("我来解释一下递归")


def test_preamble_is_attached_to_the_first_of_several_calls():
    class _LLM:
        def __init__(self):
            self.rounds = 0

        def stream_chat_completion(self, *args, **kwargs):
            self.rounds += 1
            if self.rounds == 1:
                yield {"delta": {"content": "我分别查一下汇率和金价。"}}
                yield {"delta": {"tool_calls": [
                    {"index": 0, "id": "c1", "function": {"name": "web_search", "arguments": '{"query": "汇率"}'}},
                    {"index": 1, "id": "c2", "function": {"name": "web_search", "arguments": '{"query": "金价"}'}},
                ]}}
            else:
                yield {"delta": {"content": "答案。"}}

    service = AIService.__new__(AIService)
    service.llm = _LLM()
    service.search = _FakeSearch()
    service.max_tool_rounds = 3
    tool_trace, content_parts = [], []
    events = list(service._chat_with_stream(
        llm_messages=[], model_id="scooby", effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=tool_trace, content_parts=content_parts,
        reasoning_state={"parts": [], "started": None, "ended": None},
    ))
    starts = [e for e in events if e["type"] == "search_start"]
    assert starts[0]["preamble"] == "我分别查一下汇率和金价。" and "preamble" not in starts[1]
    assert [t.get("preamble") for t in tool_trace] == ["我分别查一下汇率和金价。", None]
    assert "".join(content_parts) == "<!--tool:0--><!--tool:1-->答案。"


def test_long_single_paragraph_before_a_tool_call_stays_in_the_answer():
    long_text = "这张海报的思路是这样的：" + "主体放在左侧三分线上，右侧留白给标题，" * 12
    call = {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "web_search", "arguments": '{"query": "海报"}'}}]}}
    assert len(long_text) > 200
    assert _stream_one_round([{"delta": {"content": long_text}}, call]) == long_text + "答案。"


def test_thinking_levels_map_to_stable_efforts_per_model():
    from services.llm import LLMService
    llm = LLMService.__new__(LLMService)
    llm.temperature, llm.max_tokens = 0.7, 100
    campbell = {"model": "gpt-6-astra", "provider": "openai-compatible", "transport": "openai-compatible",
                "temperature": 0.7, "max_tokens": 100,
                "thinking_levels": {"fast": "low", "standard": "high", "deep": "xhigh"}}
    effort = lambda thinking, level: llm._build_payload(  # noqa: E731
        campbell, [], stream=True, enable_thinking=thinking, reasoning_effort=level).get("reasoning_effort")
    assert effort(False, None) == "low"
    assert effort(True, "high") == "high"
    assert effort(True, "max") == "xhigh"  # 前端的深度思考发 max，Campbell 最高只给 xhigh

    scooby = {"model": "deepseek-flash", "provider": "deepseek-compatible", "transport": "deepseek-compatible",
              "temperature": 0.7, "max_tokens": 100}
    fast = llm._build_payload(scooby, [], stream=True, enable_thinking=False, reasoning_effort=None)
    deep = llm._build_payload(scooby, [], stream=True, enable_thinking=True, reasoning_effort="max")
    assert fast["thinking"] == {"type": "disabled"} and "reasoning_effort" not in fast
    assert deep["thinking"] == {"type": "enabled"} and deep["reasoning_effort"] == "max"


class _EndlessToolLLM:
    """每轮都要再调一次工具，直到不给工具为止；记下每轮收到的消息"""

    def __init__(self):
        self.calls = []

    def get_model_config(self, model_id):
        return {"max_tool_rounds": 9} if model_id == "scooby" else {}

    def stream_chat_completion(self, messages, *args, tools=None, **kwargs):
        self.calls.append(list(messages))
        if tools:
            n = len(self.calls)
            yield {"delta": {"tool_calls": [{"index": 0, "id": f"c{n}", "function": {"name": "nope", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}
        else:
            yield {"delta": {"content": "收尾"}, "finish_reason": "stop"}


def _run_endless(model_id="scooby", control=None):
    service = AIService.__new__(AIService)
    service.llm = _EndlessToolLLM()
    service.max_tool_rounds = 20
    list(service._chat_with_stream(
        llm_messages=[{"role": "user", "content": "做一整套"}], model_id=model_id, effective_thinking=False, reasoning_effort=None,
        assistant_message_id="a1", user_id=None, session_id=None, current_user_images=[],
        current_user_message_id=None, tool_trace=[], content_parts=[],
        reasoning_state={"parts": [], "started": None, "ended": None, "seconds": 0.0, "tokens": 0},
        turn={"pending_images": [], "control": control},
    ))
    return service.llm.calls


def _wrap_up_notes(messages):
    return [m["content"] for m in messages if m["role"] == "system" and "开始收尾" in m["content"]]


def test_round_cap_comes_from_model_config():
    assert len(_run_endless("scooby")) == 9
    assert len(_run_endless("campbell")) == 20


def test_wrap_up_reminder_arrives_once_before_the_round_cap():
    calls = _run_endless("scooby")
    first = next(i for i, msgs in enumerate(calls) if _wrap_up_notes(msgs))
    # 上限 9 轮：第 3 轮开始时还剩 6 次，提醒一次，之后每一轮里都只有这一条
    assert first == 2
    assert "还剩 6 次" in _wrap_up_notes(calls[first])[0]
    assert all(len(_wrap_up_notes(msgs)) == 1 for msgs in calls[first:])
    assert not any(_wrap_up_notes(msgs) for msgs in calls[:first])


def test_wrap_up_reminder_when_time_is_running_out():
    import time as _time
    from services.runs import MAX_SECONDS

    class Control:
        started_at = _time.time() - MAX_SECONDS + 120

        def should_stop(self):
            return False

    calls = _run_endless("campbell", control=Control())
    assert "还剩约 2 分钟" in _wrap_up_notes(calls[1])[0]


class _QuotaUsage:
    """第一次（开始回答前）放行，之后额度用完"""

    CHAT_COST = 1

    def __init__(self):
        self.checks = 0

    def check(self, user_id, cost):
        self.checks += 1
        return (self.checks == 1, "daily", "今日 Campbell 额度已用完")

    def record_chat_call(self, *args, **kwargs):
        return 0


def test_answer_cut_by_quota_keeps_what_was_done(monkeypatch):
    import services.ai as ai_module

    class LLM:
        def normalize_chat_model_id(self, model_id):
            return model_id

        def get_model_config(self, model_id):
            return {"billable": True}

        def stream_chat_completion(self, messages, *args, **kwargs):
            yield {"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "shell", "arguments": '{"title": "做海报", "command": "python poster.py"}'}}]}, "finish_reason": "tool_calls"}

    def fake_shell(self, arguments, *, tool_trace, **_):
        tool_trace.append({"kind": "shell", "id": "s1", "title": arguments["title"], "status": "done", "success": True,
                           "files": [{"name": "poster.png", "url": "https://x/poster.png"}]})
        yield {"_append_marker": True, "type": "shell_start", "id": "s1", "command": arguments["command"]}
        return "exit_code=0"

    session = types.SimpleNamespace(id="s1", title="已有标题", model_id="campbell")
    saved = {}
    service = AIService.__new__(AIService)
    service.llm = LLM()
    service.usage = _QuotaUsage()
    service.tools = [{"type": "function", "function": {"name": "shell", "parameters": {}}}]
    service.max_tool_rounds = 5
    monkeypatch.setattr(ai_module.ChatSession, "query", types.SimpleNamespace(get=lambda _id: session))
    monkeypatch.setattr(ai_module, "db", types.SimpleNamespace(session=types.SimpleNamespace(get=lambda _m, _id: session)))
    monkeypatch.setattr(AIService, "_build_messages", lambda self, **kw: [{"role": "user", "content": kw["message"]}])
    monkeypatch.setattr(AIService, "_preprocess_vision_if_blind", lambda self, msgs, cfg: msgs)
    monkeypatch.setattr(AIService, "_delegate_target", lambda self, cfg: "")
    monkeypatch.setattr(AIService, "_run_shell", fake_shell)
    monkeypatch.setattr(AIService, "_save_assistant_message", lambda self, **kw: saved.update(kw))

    events = list(service.chat_stream("做一整套", model_id="campbell", user_id="u1", session_id="s1"))

    # 第二轮开始前额度用完：报错照发，做过的那一步和产物存下来，末尾说明怎么接着做
    assert events[-1]["type"] == "error" and events[-1]["code"] == "quota_daily"
    assert saved["tool_trace"][0]["files"][0]["name"] == "poster.png"
    assert saved["content"].startswith("<!--tool:0-->") and "额度用完了" in saved["content"] and "继续" in saved["content"]


def test_nothing_done_means_nothing_saved():
    service = AIService.__new__(AIService)
    saved = []
    service._save_assistant_message = lambda **kw: saved.append(kw)
    service._save_partial(
        AIService._fail_note({"message": "请求失败"}), assistant_message_id="a1", session=types.SimpleNamespace(id="s1"),
        content_parts=[], tool_trace=[], reasoning_state={"parts": [], "tokens": 0},
    )
    assert saved == []
    assert "请求失败" in AIService._fail_note({"message": "请求失败"})
