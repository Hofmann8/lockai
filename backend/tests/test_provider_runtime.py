import json
import uuid
from pathlib import Path

from services.llm import LLMService


def _build_service(monkeypatch, models):
    models_dir = Path(__file__).resolve().parent / "_tmp_runtime"
    models_dir.mkdir(exist_ok=True)
    models_path = models_dir / f"models-{uuid.uuid4().hex}.json"
    models_path.write_text(json.dumps(models, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("MODELS_CONFIG", str(models_path))
    return LLMService()


def test_resolve_chat_transport_prefers_explicit_transport(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "claude",
                "model": "claude-3-7-sonnet",
                "api_base": "https://example.com/v1",
                "api_key": "test-key",
                "provider": "openai-compatible",
                "transport": "anthropic-native",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    assert service.resolve_chat_transport("claude") == "anthropic-native"


def test_build_anthropic_runtime_splits_system_and_messages(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "claude",
                "model": "claude-3-7-sonnet",
                "api_base": "https://example.com/v1",
                "provider": "anthropic-native",
                "transport": "anthropic-native",
                "native_api_key": "anthropic-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    state = service.provider_runtime.build_state(
        model_id="claude",
        messages=[
            {"role": "system", "content": "system one"},
            {"role": "system", "content": "system two"},
            {"role": "user", "content": "hello"},
        ],
        tools=[],
    )

    assert state is not None
    assert state["kind"] == "anthropic-native"
    assert state["system_instruction"] == "system one\n\nsystem two"
    assert state["history"] == [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]


def test_build_anthropic_runtime_strips_v1_suffix_from_api_base(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "claude",
                "model": "claude-sonnet-4-6",
                "api_base": "https://vectorengine.ai/v1",
                "provider": "anthropic-native",
                "transport": "anthropic-native",
                "native_api_key": "anthropic-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    state = service.provider_runtime.build_state(
        model_id="claude",
        messages=[{"role": "user", "content": "hello"}],
        tools=[],
    )

    assert state is not None
    assert state["url"] == "https://vectorengine.ai/v1/messages"


def test_parse_anthropic_response_extracts_tool_calls(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "claude",
                "model": "claude-3-7-sonnet",
                "api_base": "https://example.com/v1",
                "provider": "anthropic-native",
                "transport": "anthropic-native",
                "native_api_key": "anthropic-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    parsed = service.provider_runtime._parse_anthropic_response(
        {
            "content": [
                {"type": "text", "text": "先查一下。"},
                {
                    "type": "tool_use",
                    "id": "tool_1",
                    "name": "web_search",
                    "input": {"query": "今天杭州天气"},
                },
            ],
            "stop_reason": "tool_use",
        }
    )

    assert parsed["content"] == "先查一下。"
    assert parsed["finish_reason"] == "tool_use"
    assert parsed["tool_calls"] == [
        {
            "id": "tool_1",
            "name": "web_search",
            "arguments": {"query": "今天杭州天气"},
        }
    ]

