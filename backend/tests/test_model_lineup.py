"""模型阵容与身份保护的回归测试。

0.8 起前台只保留 Campbell 和 Scooby，Leo 下线。
身份提示词单放在开头压不住上游通道注入的产品人设，必须在消息列表末尾再锚一次。
"""

import json
import os
import sys
import types

if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = boto3

from services.ai import AIService
from services.llm import RETIRED_CHAT_MODEL_ALIASES, LLMService
from services.prompts import get_identity_reminder, get_system_prompt

_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _models_json():
    with open(os.path.join(_BACKEND_DIR, "models.json"), encoding="utf-8") as fp:
        return {entry["id"]: entry for entry in json.load(fp)}


def test_models_json_keeps_only_campbell_and_scooby_visible():
    registry = _models_json()
    visible = [mid for mid, cfg in registry.items() if cfg.get("visible")]
    assert sorted(visible) == ["campbell", "scooby"]
    assert "leo" not in registry


def test_models_json_backend_models():
    registry = _models_json()
    assert registry["campbell"]["model"] == "gpt-6-astra"
    assert registry["scooby"]["model"] == "deepseek-flash"
    assert registry["title_generator"]["model"] == "deepseek-flash"
    assert registry["image_generator"]["model"] == "gpt-image-2.5-flare"
    assert registry["image_generator_hd"]["model"] == "gpt-image-2.5-sunburst"


def test_retired_leo_falls_back_to_scooby():
    assert RETIRED_CHAT_MODEL_ALIASES["leo"] == "scooby"
    service = LLMService()
    assert service.normalize_chat_model_id("leo") == "scooby"
    assert service.normalize_chat_model_id("不存在的模型") == service.get_default_chat_model_id()


def test_leo_prompt_is_gone():
    assert "Leo" not in get_system_prompt("leo")


def test_identity_guard_appends_trailing_reminder():
    """开头的身份提示词会被上游人设压过去，末尾这条是实测唯一挡得住英文越权的。"""
    service = AIService.__new__(AIService)
    service.llm = types.SimpleNamespace(
        get_model_config=lambda model_id: {
            "id": model_id,
            "prompt_id": "campbell",
            "identity_guard": True,
        }
    )
    service.image = types.SimpleNamespace(build_asset_catalog_message=lambda *a, **k: "")

    messages = service._build_messages(
        message="你是谁？",
        history=[],
        model_id="campbell",
        session_id=None,
        images=[],
        current_user_message_id=None,
    )

    assert messages[-1]["role"] == "system"
    assert messages[-1]["content"] == get_identity_reminder("Campbell")
    assert messages[-2] == {"role": "user", "content": "你是谁？"}


def test_models_without_identity_guard_get_no_reminder():
    """标题生成这类内部模型只准输出标题，塞身份提醒会污染结果。"""
    service = AIService.__new__(AIService)
    service.llm = types.SimpleNamespace(
        get_model_config=lambda model_id: {"id": model_id, "prompt_id": "title_generator"}
    )
    service.image = types.SimpleNamespace(build_asset_catalog_message=lambda *a, **k: "")

    messages = service._build_messages(
        message="随便一句",
        history=[],
        model_id="title_generator",
        session_id=None,
        images=[],
        current_user_message_id=None,
    )

    assert messages[-1]["role"] == "user"
    assert all(msg["role"] != "system" for msg in messages[1:])
