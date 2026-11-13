"""主供应商失败时换回退（models.json 的 fallback）：对话流式和绘图 / 修图。

不打外部服务：单次请求换成桩，只验证什么时候换、换过去用的地址 / key / 模型名。
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from services.image import ImageService
from services.llm import LLMService, should_fall_back

PRIMARY = "https://primary.example/v1"
FALLBACK = "https://fallback.example/v1"


def _llm(monkeypatch, models) -> LLMService:
    models_dir = Path(__file__).resolve().parent / "_tmp_runtime"
    models_dir.mkdir(exist_ok=True)
    path = models_dir / f"models-{uuid.uuid4().hex}.json"
    path.write_text(json.dumps(models, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("MODELS_CONFIG", str(path))
    return LLMService()


def _campbell(primary_key="k-primary"):
    return {
        "id": "campbell", "model": "gpt-6.1-sol", "api_base": PRIMARY, "api_key": primary_key,
        "api_keys": ["k-primary-2"] if primary_key else [],
        "fallback": {"model": "gpt-6-astra", "api_base": FALLBACK, "api_key": "k-fallback"},
        "transport": "openai-compatible", "billable": True, "available": True, "visible": True, "is_default": True,
    }


def _fake_stream(script):
    """script: {model: [events]}；记录每次请求用的 (model, api_base, key)。"""
    calls = []

    def fake(self, cfg, messages, **kwargs):
        calls.append((cfg["model"], cfg["api_base"], self.get_api_key(cfg)))
        for event in script[cfg["model"]]:
            yield dict(event)

    return fake, calls


def _drain(service):
    return list(service.stream_chat_completion([{"role": "user", "content": "hi"}], model="campbell"))


def test_should_fall_back_statuses():
    assert should_fall_back(None)
    for status in (401, 403, 404, 408, 429, 500, 502, 503):
        assert should_fall_back(status)
    for status in (400, 413, 422):
        assert not should_fall_back(status)


def test_fallback_config_replaces_endpoint_as_a_group(monkeypatch):
    service = _llm(monkeypatch, [_campbell()])
    cfg = service.get_model_config("campbell")
    fb = service.fallback_config(cfg)
    assert fb["model"] == "gpt-6-astra" and fb["api_base"] == FALLBACK and fb["is_fallback"]
    # 主供应商的 key 池不能带进回退
    assert "api_keys" not in fb and service._collect_api_keys(fb) == ["k-fallback"]
    assert fb["billable"] is True and "fallback" not in fb
    assert [c["model"] for c in service.chat_candidates(cfg)] == ["gpt-6.1-sol", "gpt-6-astra"]


def test_missing_primary_key_goes_straight_to_fallback(monkeypatch):
    service = _llm(monkeypatch, [_campbell(primary_key="")])
    fake, calls = _fake_stream({"gpt-6-astra": [{"type": "delta", "delta": {"content": "ok"}, "finish_reason": "stop"}]})
    monkeypatch.setattr(LLMService, "_stream_once", fake)
    events = _drain(service)
    assert [c[0] for c in calls] == ["gpt-6-astra"]
    assert events[0]["delta"]["content"] == "ok"


def test_stream_falls_back_when_primary_fails_before_output(monkeypatch):
    service = _llm(monkeypatch, [_campbell()])
    fake, calls = _fake_stream({
        "gpt-6.1-sol": [{"type": "error", "content": "API 请求失败: 502", "status": 502}],
        "gpt-6-astra": [{"type": "delta", "delta": {"content": "pong"}, "finish_reason": "stop"},
                        {"type": "usage", "usage": {"prompt_tokens": 9}}],
    })
    monkeypatch.setattr(LLMService, "_stream_once", fake)
    events = _drain(service)
    assert [(m, base, key) for m, base, key in calls] == [
        ("gpt-6.1-sol", PRIMARY, "k-primary"), ("gpt-6-astra", FALLBACK, "k-fallback"),
    ]
    assert [e["type"] for e in events] == ["delta", "usage"]  # 主供应商的错误不外露


def test_connection_error_falls_back(monkeypatch):
    service = _llm(monkeypatch, [_campbell()])
    fake, calls = _fake_stream({
        "gpt-6.1-sol": [{"type": "error", "content": "请求超时"}],
        "gpt-6-astra": [{"type": "delta", "delta": {"content": "ok"}, "finish_reason": "stop"}],
    })
    monkeypatch.setattr(LLMService, "_stream_once", fake)
    assert _drain(service)[0]["type"] == "delta"
    assert len(calls) == 2


def test_bad_request_is_not_retried_on_fallback(monkeypatch):
    service = _llm(monkeypatch, [_campbell()])
    fake, calls = _fake_stream({"gpt-6.1-sol": [{"type": "error", "content": "API 请求失败: 400", "status": 400}]})
    monkeypatch.setattr(LLMService, "_stream_once", fake)
    events = _drain(service)
    assert len(calls) == 1
    assert events == [{"type": "error", "content": "API 请求失败: 400"}]


def test_failure_after_output_started_is_not_retried(monkeypatch):
    service = _llm(monkeypatch, [_campbell()])
    fake, calls = _fake_stream({"gpt-6.1-sol": [
        {"type": "delta", "delta": {"content": "前半段"}, "finish_reason": None},
        {"type": "error", "content": "请求失败: reset"},
    ]})
    monkeypatch.setattr(LLMService, "_stream_once", fake)
    events = _drain(service)
    assert len(calls) == 1
    assert [e["type"] for e in events] == ["delta", "error"]


def test_both_fail_reports_fallback_error(monkeypatch):
    service = _llm(monkeypatch, [_campbell()])
    fake, calls = _fake_stream({
        "gpt-6.1-sol": [{"type": "error", "content": "API 请求失败: 503", "status": 503}],
        "gpt-6-astra": [{"type": "error", "content": "API 请求失败: 502", "status": 502}],
    })
    monkeypatch.setattr(LLMService, "_stream_once", fake)
    assert _drain(service) == [{"type": "error", "content": "API 请求失败: 502"}]
    assert len(calls) == 2


# ------------------------------------------------------------------
# 绘图 / 修图
# ------------------------------------------------------------------

def _image_service(monkeypatch, *, primary_key="img-primary"):
    if primary_key:
        monkeypatch.setenv("TEST_IMAGE_KEY", primary_key)
    else:
        monkeypatch.delenv("TEST_IMAGE_KEY", raising=False)
    monkeypatch.setenv("TEST_RELAY_KEY", "img-fallback")
    llm = _llm(monkeypatch, [_campbell(), {
        "id": "image_generator", "name": "Campbell 3.0 Image",
        "model": "gpt-image-2.5-sunburst", "edit_model": "gpt-image-2.5-sunburst",
        "api_base": PRIMARY, "image_api_key_env": "TEST_IMAGE_KEY",
        "fallback": {"api_base": FALLBACK, "image_api_key_env": "TEST_RELAY_KEY"},
        "transport": "openai-image", "available": True, "visible": False,
    }])
    return ImageService(llm, storage_service=None)


def _fake_send(statuses):
    """statuses: 依次返回的状态码（200 = 出图成功）；记录每次请求的 (url, key, 模型名)。"""
    calls = []

    def fake(self, url, api_key, label, *, json_body=None, files=None, data=None):
        body = json_body if json_body is not None else data
        calls.append((url, api_key, body["model"]))
        status = statuses[len(calls) - 1]
        if status == 200:
            return (b"png", "image/png"), None, {"output_tokens": 1}, 200
        return None, f"HTTP {status}", None, status

    return fake, calls


def test_image_falls_back_on_upstream_error(monkeypatch):
    service = _image_service(monkeypatch)
    fake, calls = _fake_send([503, 200])
    monkeypatch.setattr(ImageService, "_send_openai_image", fake)
    cfg, key = service._image_candidates(service._get_image_model_config())[0]
    extracted, failure, usage = service._request_openai_image(cfg, key, {"model": "gpt-image-2.5-sunburst", "prompt": "x"})
    assert extracted == (b"png", "image/png") and failure is None
    assert calls == [
        (f"https://primary.example/v1/images/generations", "img-primary", "gpt-image-2.5-sunburst"),
        (f"https://fallback.example/v1/images/generations", "img-fallback", "gpt-image-2.5-sunburst"),
    ]


def test_image_edit_falls_back_and_keeps_files(monkeypatch):
    service = _image_service(monkeypatch)
    fake, calls = _fake_send([429, 200])
    monkeypatch.setattr(ImageService, "_send_openai_image", fake)
    cfg, key = service._image_candidates(service._get_image_model_config())[0]
    extracted, _, _ = service._request_openai_image_edit(
        cfg, key, [("image", ("a.png", b"src", "image/png"))], {"model": "gpt-image-2.5-sunburst", "prompt": "x"},
    )
    assert extracted
    assert [c[0].rsplit("/", 3)[0] for c in calls] == ["https://primary.example", "https://fallback.example"]
    assert all(c[0].endswith("/v1/images/edits") for c in calls)


def test_image_policy_rejection_is_not_retried(monkeypatch):
    service = _image_service(monkeypatch)
    fake, calls = _fake_send([400])
    monkeypatch.setattr(ImageService, "_send_openai_image", fake)
    cfg, key = service._image_candidates(service._get_image_model_config())[0]
    extracted, failure, _ = service._request_openai_image(cfg, key, {"model": "m", "prompt": "x"})
    assert extracted is None and failure == "HTTP 400"
    assert len(calls) == 1


def test_image_without_primary_key_uses_fallback(monkeypatch):
    service = _image_service(monkeypatch, primary_key="")
    candidates = service._image_candidates(service._get_image_model_config())
    assert [(c["api_base"], key) for c, key in candidates] == [(FALLBACK, "img-fallback")]
    assert service.model_label() == "Campbell 3.0 Image"
