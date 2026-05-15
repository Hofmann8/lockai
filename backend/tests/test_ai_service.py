import sys
import types
import json


if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = boto3


from services.ai import AIService


class _DummyProviderRuntime:
    def __init__(self):
        self.build_state_kwargs = None

    def build_state(self, **kwargs):
        self.build_state_kwargs = kwargs
        return {"kind": "anthropic-native"}

    def request_turn(self, runtime):
        return {
            "content": "可见回复",
            "tool_calls": [],
        }


class _DummyLLM:
    def __init__(self, provider_runtime):
        self.provider_runtime = provider_runtime

    def get_model_config(self, model_id):
        return {
            "id": model_id,
            "thinking_mode": "never",
            "provider": "openai-compatible",
        }


class _DummyImageService:
    def _normalize_image_request(self, arguments):
        return {"subject": arguments.get("subject", "")}

    def build_request_prompt(self, arguments):
        return arguments.get("subject", "")

    def build_conversation_asset_id(self, scope, assistant_message_id, index):
        return f"{scope}:{assistant_message_id}:{index}"

    def generate(self, arguments, user_id=None, session_id=None):
        return {
            "success": True,
            "image": "https://example.com/generated.png",
            "prompt": arguments.get("subject", ""),
            "output_width": 1024,
            "output_height": 1024,
            "output_aspect_ratio": "1:1",
        }


def test_chat_with_complete_forwards_thinking_toggle():
    provider_runtime = _DummyProviderRuntime()
    service = AIService.__new__(AIService)
    service.llm = _DummyLLM(provider_runtime)
    service.max_tool_rounds = 1

    events = list(
        service._chat_with_complete(
            llm_messages=[{"role": "user", "content": "你好"}],
            model_id="campbell",
            effective_thinking=False,
            reasoning_effort=None,
            assistant_message_id="assistant-1",
            user_id="u1",
            session_id="s1",
            current_user_images=[],
            current_user_message_id="user-1",
            tool_trace=[],
            content_parts=[],
        )
    )

    assert provider_runtime.build_state_kwargs is not None
    assert provider_runtime.build_state_kwargs["enable_thinking"] is False
    assert events == [{"type": "content_delta", "delta": "可见回复"}]


def test_execute_tool_call_image_result_marks_image_as_already_shown():
    service = AIService.__new__(AIService)
    service.image = _DummyImageService()
    service._save_generated_image = lambda **kwargs: None

    tool_trace = []
    generator = service._execute_tool_call(
        {"name": "generate_image", "arguments": {"subject": "一只猫"}},
        tool_trace=tool_trace,
        assistant_message_id="assistant-1",
        user_id="u1",
        session_id="s1",
        current_user_images=[],
        current_user_message_id="user-1",
    )

    events = []
    try:
        while True:
            events.append(next(generator))
    except StopIteration as stop:
        tool_result = stop.value

    payload = json.loads(tool_result)
    assert [event["type"] for event in events] == ["image_gen_start", "image_gen_end"]
    assert payload["status"] == "ok"
    assert payload["tool"] == "generate_image"
    assert payload["url"] == "https://example.com/generated.png"
    assert "already shown to the user" in payload["message"]
    assert "assistantInstruction" in payload
    assert "图片已生成完成" in payload["assistantInstruction"]
    assert "image_url" not in payload


