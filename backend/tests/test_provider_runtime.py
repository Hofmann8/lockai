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


def test_append_provider_tool_results_preserves_native_shapes(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "campbell",
                "model": "gemini-3-pro-preview",
                "api_base": "https://example.com/v1",
                "provider": "gemini-native",
                "transport": "gemini-native",
                "native_api_key": "gemini-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    runtime = service.provider_runtime.build_state(
        model_id="campbell",
        messages=[{"role": "user", "content": "你好"}],
        tools=[],
    )
    assert runtime is not None

    service.provider_runtime.append_assistant_history(
        runtime,
        None,
        parsed_calls=[{"id": "call_1", "name": "web_search", "arguments": {"query": "杭州天气"}}],
        content_text="我先查一下。",
    )
    service.provider_runtime.append_tool_results(
        runtime,
        [{"id": "call_1", "name": "web_search", "content": "晴，23度"}],
    )

    assert runtime["history"][-2] == {
        "role": "model",
        "parts": [
            {"text": "我先查一下。"},
            {
                "functionCall": {
                    "name": "web_search",
                    "id": "call_1",
                    "args": {"query": "杭州天气"},
                }
            },
        ],
    }
    assert runtime["history"][-1] == {
        "role": "user",
        "parts": [
            {
                "functionResponse": {
                    "name": "web_search",
                    "response": {"result": "晴，23度"},
                }
            }
        ],
    }


def test_parse_gemini_response_keeps_visible_text_with_thought_signature(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "campbell",
                "model": "gemini-3.1-pro-preview",
                "api_base": "https://example.com/v1",
                "provider": "gemini-native",
                "transport": "gemini-native",
                "native_api_key": "gemini-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    parsed = service.provider_runtime._parse_gemini_response(
        {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "text": "这是最终可见答案。",
                                "thoughtSignature": "opaque-signature",
                            }
                        ],
                    },
                    "finishReason": "STOP",
                }
            ]
        }
    )

    assert parsed["content"] == "这是最终可见答案。"
    assert parsed["tool_calls"] == []
    assert parsed["message"] == {
        "role": "model",
        "parts": [{
            "thoughtSignature": "opaque-signature",
            "text": "这是最终可见答案。",
        }],
    }


def test_parse_gemini_response_filters_explicit_reasoning_parts(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "campbell",
                "model": "gemini-3.1-pro-preview",
                "api_base": "https://example.com/v1",
                "provider": "gemini-native",
                "transport": "gemini-native",
                "native_api_key": "gemini-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    parsed = service.provider_runtime._parse_gemini_response(
        {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "text": "内部推理",
                                "type": "thinking",
                            },
                            {
                                "text": "最终答案",
                            },
                        ],
                    },
                    "finishReason": "STOP",
                }
            ]
        }
    )

    assert parsed["content"] == "最终答案"
    assert parsed["message"] == {
        "role": "model",
        "parts": [{"text": "最终答案"}],
    }


def test_append_gemini_assistant_history_preserves_function_call_thought_signature(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "campbell",
                "model": "gemini-3.1-pro-preview",
                "api_base": "https://example.com/v1",
                "provider": "gemini-native",
                "transport": "gemini-native",
                "native_api_key": "gemini-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    runtime = service.provider_runtime.build_state(
        model_id="campbell",
        messages=[{"role": "user", "content": "帮我画图"}],
        tools=[],
    )
    assert runtime is not None

    parsed = service.provider_runtime._parse_gemini_response(
        {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "functionCall": {
                                    "name": "generate_image",
                                    "id": "call_1",
                                    "args": {"prompt": "一只猫"},
                                },
                                "thoughtSignature": "tool-signature",
                            }
                        ],
                    },
                    "finishReason": "STOP",
                }
            ]
        }
    )

    service.provider_runtime.append_assistant_history(
        runtime,
        parsed["assistant_history_item"],
        parsed_calls=parsed["tool_calls"],
        content_text=parsed["content"],
    )

    assert runtime["history"][-1] == {
        "role": "model",
        "parts": [
            {
                "thoughtSignature": "tool-signature",
                "functionCall": {
                    "name": "generate_image",
                    "id": "call_1",
                    "args": {"prompt": "一只猫"},
                },
            }
        ],
    }


def test_build_gemini_runtime_keeps_thinking_toggle(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "campbell",
                "model": "gemini-3.1-pro-preview",
                "api_base": "https://example.com/v1",
                "provider": "gemini-native",
                "transport": "gemini-native",
                "native_api_key": "gemini-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    state = service.provider_runtime.build_state(
        model_id="campbell",
        messages=[{"role": "user", "content": "你好"}],
        tools=[],
        enable_thinking=False,
    )

    assert state is not None
    assert state["kind"] == "gemini-native"
    assert state["enable_thinking"] is False
    assert service.provider_runtime._build_gemini_thinking_config("gemini-3.1-pro-preview", False) == {
        "thinkingLevel": "LOW",
    }


def test_gemini_request_payload_uses_model_specific_thinking_config(monkeypatch):
    service = _build_service(
        monkeypatch,
        [
            {
                "id": "campbell",
                "model": "gemini-3-pro-preview",
                "api_base": "https://example.com/v1",
                "provider": "gemini-native",
                "transport": "gemini-native",
                "native_api_key": "gemini-key",
                "available": True,
                "visible": True,
                "is_default": True,
            }
        ],
    )

    captured: dict = {}

    class _DummyResponse:
        status_code = 200

        @staticmethod
        def json():
            return {"candidates": []}

    class _DummyClient:
        def post(self, url, headers=None, params=None, json=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["params"] = params
            captured["json"] = json
            return _DummyResponse()

    state = service.provider_runtime.build_state(
        model_id="campbell",
        messages=[{"role": "user", "content": "你好"}],
        tools=[],
        enable_thinking=True,
    )
    assert state is not None

    service.provider_runtime._request_gemini_turn(_DummyClient(), state)

    assert captured["json"]["generationConfig"]["thinkingConfig"] == {
        "thinkingLevel": "HIGH",
    }
