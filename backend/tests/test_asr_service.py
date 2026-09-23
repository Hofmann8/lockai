import sys
import types
from http import HTTPStatus

import pytest

from services.asr import ASRService, ASRServiceError


class _FakeRecognitionCallback:
    """DashScope RecognitionCallback 的替身，真实 SDK 里也是空实现基类。"""

    def on_open(self):
        pass

    def on_complete(self):
        pass

    def on_close(self):
        pass

    def on_error(self, message):
        pass

    def on_event(self, result):
        pass


def _install_fake_dashscope(monkeypatch, recognition_cls):
    dashscope_module = types.ModuleType("dashscope")
    dashscope_module.api_key = ""
    dashscope_module.base_websocket_api_url = ""

    audio_module = types.ModuleType("dashscope.audio")
    asr_module = types.ModuleType("dashscope.audio.asr")
    asr_module.Recognition = recognition_cls
    asr_module.RecognitionCallback = _FakeRecognitionCallback
    audio_module.asr = asr_module

    monkeypatch.setitem(sys.modules, "dashscope", dashscope_module)
    monkeypatch.setitem(sys.modules, "dashscope.audio", audio_module)
    monkeypatch.setitem(sys.modules, "dashscope.audio.asr", asr_module)
    return dashscope_module


def test_transcribe_file_uses_qwen_key_and_returns_metrics(monkeypatch, tmp_path):
    monkeypatch.setenv("QWEN_API_KEY", "qwen-test-key")
    monkeypatch.setenv("MODEL_ASR_REALTIME", "paraformer-v2")
    monkeypatch.setenv("ASR_BASE_WS_URL", "wss://example.com/ws")
    monkeypatch.setenv("ASR_LANGUAGE_HINTS", "zh,en")

    captured: dict[str, object] = {}

    class _FakeResult:
        status_code = HTTPStatus.OK
        message = "ok"

        @staticmethod
        def get_sentence():
            return "你好，LockAI"

    class _FakeRecognition:
        def __init__(self, **kwargs):
            captured["kwargs"] = kwargs

        def call(self, file_path):
            captured["file_path"] = file_path
            return _FakeResult()

        @staticmethod
        def get_last_request_id():
            return "req-1"

        @staticmethod
        def get_first_package_delay():
            return 123

        @staticmethod
        def get_last_package_delay():
            return 456

    dashscope_module = _install_fake_dashscope(monkeypatch, _FakeRecognition)

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"fake wav")

    service = ASRService()
    result = service.transcribe_file(audio_path)

    assert result == {
        "text": "你好，LockAI",
        "request_id": "req-1",
        "first_package_delay_ms": 123,
        "last_package_delay_ms": 456,
        "model": "paraformer-v2",
    }
    assert captured["file_path"] == str(audio_path)
    assert captured["kwargs"] == {
        "model": "paraformer-v2",
        "format": "wav",
        "sample_rate": 16000,
        "language_hints": ["zh", "en"],
        "callback": None,
    }
    assert dashscope_module.api_key == "qwen-test-key"
    assert dashscope_module.base_websocket_api_url == "wss://example.com/ws"


def test_transcribe_file_raises_when_result_is_not_ok(monkeypatch, tmp_path):
    monkeypatch.setenv("QWEN_API_KEY", "qwen-test-key")
    monkeypatch.setenv("MODEL_ASR_REALTIME", "paraformer-v2")

    class _FailedResult:
        status_code = HTTPStatus.BAD_REQUEST
        message = "bad audio"

    class _FakeRecognition:
        def __init__(self, **kwargs):
            pass

        def call(self, file_path):
            return _FailedResult()

    _install_fake_dashscope(monkeypatch, _FakeRecognition)

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"fake wav")

    service = ASRService()

    with pytest.raises(ASRServiceError, match="bad audio"):
        service.transcribe_file(audio_path)


def test_transcribe_file_requires_qwen_key(monkeypatch, tmp_path):
    monkeypatch.delenv("QWEN_API_KEY", raising=False)

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"fake wav")

    service = ASRService()

    with pytest.raises(ASRServiceError, match="QWEN_API_KEY"):
        service.transcribe_file(audio_path)


def test_transcribe_file_realtime_collects_sentences(monkeypatch, tmp_path):
    """线上默认走 fun-asr-realtime 流式分支：分片发送 + 回调收句。"""
    monkeypatch.setenv("QWEN_API_KEY", "qwen-test-key")
    monkeypatch.setenv("MODEL_ASR_REALTIME", "fun-asr-realtime-2026-02-28")

    sent_frames = []

    class _Sentence(dict):
        pass

    class _FakeEvent:
        def __init__(self, text, end):
            self._sentence = {"text": text, "sentence_end": end}

        def get_sentence(self):
            return self._sentence

    class _FakeRealtimeRecognition:
        def __init__(self, **kwargs):
            self.callback = kwargs.get("callback")
            self.kwargs = kwargs

        def start(self):
            pass

        def send_audio_frame(self, data):
            sent_frames.append(data)

        def stop(self):
            self.callback.on_event(_FakeEvent("你好", False))
            self.callback.on_event(_FakeEvent("你好，LockAI", True))
            self.callback.on_complete()

        @staticmethod
        def get_last_request_id():
            return "req-realtime"

        @staticmethod
        def get_first_package_delay():
            return 12

        @staticmethod
        def get_last_package_delay():
            return 34

    _install_fake_dashscope(monkeypatch, _FakeRealtimeRecognition)

    audio_path = tmp_path / "sample.wav"
    audio_path.write_bytes(b"x" * 8000)

    service = ASRService()
    result = service.transcribe_file(audio_path)

    assert result["text"] == "你好，LockAI"
    assert result["request_id"] == "req-realtime"
    assert result["model"] == "fun-asr-realtime-2026-02-28"
    assert sum(len(f) for f in sent_frames) == 8000
