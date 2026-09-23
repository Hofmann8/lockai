"""
DashScope 语音识别服务。
"""

from __future__ import annotations

import os
import time
import uuid
import threading
from threading import Event
from http import HTTPStatus
from pathlib import Path
from typing import Any

from .event_bus import EventBus


DEFAULT_ASR_MODEL = "fun-asr-realtime-2026-02-28"
DEFAULT_ASR_FORMAT = "wav"
DEFAULT_ASR_SAMPLE_RATE = 16000
DEFAULT_ASR_BASE_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
REALTIME_ASR_FORMAT = "pcm"


class ASRServiceError(RuntimeError):
    """语音识别服务错误。"""


class ASRService:
    """基于 DashScope Recognition 的语音转写服务。"""

    def __init__(self) -> None:
        self.api_key = os.environ.get("QWEN_API_KEY", "").strip()
        self.model = os.environ.get("MODEL_ASR_REALTIME", DEFAULT_ASR_MODEL).strip() or DEFAULT_ASR_MODEL
        self.audio_format = os.environ.get("ASR_AUDIO_FORMAT", DEFAULT_ASR_FORMAT).strip() or DEFAULT_ASR_FORMAT
        self.sample_rate = int(os.environ.get("ASR_SAMPLE_RATE", str(DEFAULT_ASR_SAMPLE_RATE)))
        self.base_ws_url = os.environ.get("ASR_BASE_WS_URL", DEFAULT_ASR_BASE_WS_URL).strip() or DEFAULT_ASR_BASE_WS_URL
        raw_hints = os.environ.get("ASR_LANGUAGE_HINTS", "zh,en")
        self.language_hints = [hint.strip() for hint in raw_hints.split(",") if hint.strip()]

    def _load_sdk(self):
        try:
            import dashscope
            from dashscope.audio.asr import Recognition, RecognitionCallback
        except Exception as exc:  # pragma: no cover - 由单测通过 monkeypatch 覆盖
            raise ASRServiceError("未安装 DashScope SDK，请先执行 pip install -U dashscope") from exc
        return dashscope, Recognition, RecognitionCallback

    def transcribe_file(self, audio_path: str | Path) -> dict[str, Any]:
        if not self.api_key:
            raise ASRServiceError("QWEN_API_KEY 未配置，无法使用语音识别")

        dashscope, Recognition, RecognitionCallback = self._load_sdk()
        dashscope.api_key = self.api_key
        dashscope.base_websocket_api_url = self.base_ws_url

        if self._uses_realtime_streaming():
            text, recognition = self._transcribe_realtime_file(Path(audio_path), Recognition, RecognitionCallback)
        else:
            text, recognition = self._transcribe_batch_file(str(audio_path), Recognition)

        if not text:
            raise ASRServiceError("没有识别到有效语音，请重试")

        return {
            "text": text,
            "request_id": self._safe_call(recognition, "get_last_request_id"),
            "first_package_delay_ms": self._safe_call(recognition, "get_first_package_delay"),
            "last_package_delay_ms": self._safe_call(recognition, "get_last_package_delay"),
            "model": self.model,
        }

    def _uses_realtime_streaming(self) -> bool:
        return self.model.startswith("fun-asr-realtime") or self.model.startswith("fun-asr-flash-8k-realtime")

    def _transcribe_batch_file(self, audio_path: str, Recognition: Any) -> tuple[str, Any]:
        recognition = Recognition(
            model=self.model,
            format=self.audio_format,
            sample_rate=self.sample_rate,
            language_hints=self.language_hints or None,
            callback=None,
        )

        result = recognition.call(audio_path)
        if getattr(result, "status_code", None) != HTTPStatus.OK:
            message = str(getattr(result, "message", "") or "语音识别失败").strip()
            raise ASRServiceError(message)

        text = self._extract_text(result).strip()
        if not text:
            print(f"[ASR] 空 batch 结果: {self._describe_result(result)}")
        return text, recognition

    def _transcribe_realtime_file(self, audio_path: Path, Recognition: Any, RecognitionCallback: Any) -> tuple[str, Any]:
        collector = self._build_realtime_collector(RecognitionCallback)
        recognition = Recognition(
            model=self.model,
            format=self.audio_format,
            sample_rate=self.sample_rate,
            language_hints=self.language_hints or None,
            callback=collector,
        )

        file_buffer = audio_path.read_bytes()
        if not file_buffer:
            raise ASRServiceError("音频内容不能为空")

        try:
            recognition.start()
            chunk_size = 3200
            offset = 0
            while offset < len(file_buffer):
                audio_data = file_buffer[offset:offset + chunk_size]
                recognition.send_audio_frame(audio_data)
                offset += chunk_size
                # 官方示例建议按 100ms 左右的包发送；这里缩短到 20ms，兼顾兼容性与转写速度。
                time.sleep(0.02)
            recognition.stop()

            done_event = getattr(collector, "done_event", None)
            if isinstance(done_event, Event):
                done_event.wait(timeout=15)

            error_message = str(getattr(collector, "error_message", "") or "").strip()
            if error_message:
                raise ASRServiceError(error_message)

            text = str(getattr(collector, "text", "") or "").strip()
            if not text:
                print("[ASR] realtime 回调未收集到文本")
            return text, recognition
        finally:
            duplex_api = getattr(recognition, "get_duplex_api", None)
            if callable(duplex_api):
                try:
                    duplex_api().close(1000, "bye")
                except Exception:
                    pass

            legacy_duplex_api = getattr(recognition, "getDuplexApi", None)
            if callable(legacy_duplex_api):
                try:
                    legacy_duplex_api().close(1000, "bye")
                except Exception:
                    pass

    def _build_realtime_collector(self, RecognitionCallback: Any) -> Any:
        service = self

        class _RealtimeCollector(RecognitionCallback):
            def __init__(self) -> None:
                super().__init__()
                self.done_event = Event()
                self.error_message = ""
                self.final_sentences: list[str] = []
                self.partial_text = ""

            @property
            def text(self) -> str:
                parts = list(self.final_sentences)
                tail = self.partial_text.strip()
                if tail and (not parts or parts[-1] != tail):
                    parts.append(tail)
                return "".join(parts)

            def on_complete(self) -> None:
                self.done_event.set()

            def on_close(self) -> None:
                self.done_event.set()

            def on_error(self, message) -> None:
                self.error_message = str(getattr(message, "message", "") or message or "语音识别失败").strip()
                self.done_event.set()

            def on_event(self, result) -> None:
                sentence = service._extract_sentence_payload(result)
                if not isinstance(sentence, dict):
                    return
                if sentence.get("heartbeat"):
                    return

                text = str(sentence.get("text") or "").strip()
                if not text:
                    return

                self.partial_text = text
                if service._is_sentence_end(result, sentence):
                    if not self.final_sentences or self.final_sentences[-1] != text:
                        self.final_sentences.append(text)
                    self.partial_text = ""

        return _RealtimeCollector()

    def _extract_text(self, result: Any) -> str:
        getter = getattr(result, "get_sentence", None)
        if callable(getter):
            try:
                sentence = getter()
            except Exception:
                sentence = None
            if isinstance(sentence, str):
                return sentence
            if isinstance(sentence, dict):
                text = sentence.get("text")
                if isinstance(text, str) and text.strip():
                    return text

        sentence = self._extract_sentence_payload(result)
        if isinstance(sentence, dict):
            text = sentence.get("text")
            if isinstance(text, str) and text.strip():
                return text

        for key in ("sentence", "text"):
            value = getattr(result, key, None)
            if isinstance(value, str) and value.strip():
                return value

        output = getattr(result, "output", None)
        if isinstance(output, dict):
            for key in ("sentence", "text"):
                value = output.get(key)
                if isinstance(value, str) and value.strip():
                    return value

        return ""

    def _extract_sentence_payload(self, result: Any) -> dict[str, Any] | None:
        try:
            sentence = result.get_sentence()
            if isinstance(sentence, dict):
                return sentence
        except Exception:
            pass

        output = getattr(result, "output", None)
        if isinstance(output, dict):
            sentence = output.get("sentence")
            if isinstance(sentence, dict):
                return sentence
        return None

    def _is_sentence_end(self, result: Any, sentence: dict[str, Any]) -> bool:
        predicate = getattr(type(result), "is_sentence_end", None)
        if callable(predicate):
            try:
                return bool(predicate(sentence))
            except Exception:
                pass

        predicate = getattr(result, "is_sentence_end", None)
        if callable(predicate):
            try:
                return bool(predicate(sentence))
            except Exception:
                pass

        return bool(sentence.get("sentence_end"))

    def _safe_call(self, target: Any, method_name: str) -> Any:
        method = getattr(target, method_name, None)
        if not callable(method):
            return None
        try:
            return method()
        except Exception:
            return None

    def _describe_result(self, result: Any) -> str:
        output = getattr(result, "output", None)
        if isinstance(output, dict):
            keys = ",".join(sorted(str(key) for key in output.keys()))
            return f"output_keys=[{keys}] status={getattr(result, 'status_code', None)}"
        return (
            f"type={type(result).__name__} "
            f"status={getattr(result, 'status_code', None)} "
            f"attrs={','.join(sorted(name for name in dir(result) if not name.startswith('_'))[:20])}"
        )


class RealtimeASRSession:
    """单个实时语音识别会话。"""

    def __init__(self, service: ASRService, Recognition: Any, RecognitionCallback: Any):
        self.service = service
        self.id = uuid.uuid4().hex
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.status = "starting"
        self.error_message = ""
        self.done_event = Event()
        self._lock = threading.Lock()
        self._events = EventBus(max_history=200)
        self._final_sentences: list[str] = []
        self._partial_text = ""
        self._stop_started = False
        self._closed = False
        self._callback = self._build_callback(RecognitionCallback)
        self._recognition = Recognition(
            model=service.model,
            format=REALTIME_ASR_FORMAT,
            sample_rate=service.sample_rate,
            language_hints=service.language_hints or None,
            semantic_punctuation_enabled=False,
            heartbeat=True,
            callback=self._callback,
        )

    @property
    def text(self) -> str:
        with self._lock:
            parts = list(self._final_sentences)
            tail = self._partial_text.strip()
            if tail and (not parts or parts[-1] != tail):
                parts.append(tail)
            return "".join(parts)

    def start(self) -> None:
        self._recognition.start()

    def push_audio(self, audio_bytes: bytes) -> None:
        if self.done_event.is_set() or self._closed:
            raise ASRServiceError("语音会话已结束")
        if not audio_bytes:
            return
        self._recognition.send_audio_frame(audio_bytes)
        self.updated_at = time.time()

    def request_stop(self) -> None:
        with self._lock:
            if self._stop_started or self.done_event.is_set() or self._closed:
                return
            self._stop_started = True

        threading.Thread(target=self._stop_worker, name=f"asr-stop-{self.id}", daemon=True).start()

    def cancel(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self.status = "cancelled"
            self.updated_at = time.time()

        self._emit("complete", text=self.text)
        self.done_event.set()
        self._close_transport()

    def subscribe(self, include_history: bool = True):
        return self._events.subscribe(self.id, include_history=include_history)

    def unsubscribe(self, q) -> None:
        self._events.unsubscribe(self.id, q)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._close_transport()

    def _stop_worker(self) -> None:
        try:
            self._recognition.stop()
            self.done_event.wait(timeout=15)
        except Exception as exc:
            self._emit("error", message=f"停止语音识别失败: {exc}")
            self.error_message = str(exc)
            self.done_event.set()
        finally:
            self._close_transport()

    def _build_callback(self, RecognitionCallback: Any):
        session = self

        class _RealtimeCallback(RecognitionCallback):
            def on_open(self) -> None:
                if session._closed:
                    return
                session.status = "running"
                session._emit("started", text=session.text)

            def on_event(self, result) -> None:
                if session._closed:
                    return
                sentences = session._normalize_sentences(result)
                if not sentences:
                    return

                emitted_final = False
                with session._lock:
                    for sentence in sentences:
                        if sentence.get("heartbeat"):
                            continue

                        text = str(sentence.get("text") or "").strip()
                        if not text:
                            continue

                        session._partial_text = text
                        if session.service._is_sentence_end(result, sentence):
                            if not session._final_sentences or session._final_sentences[-1] != text:
                                session._final_sentences.append(text)
                            session._partial_text = ""
                            emitted_final = True

                session.updated_at = time.time()
                session._emit("final" if emitted_final else "partial", text=session.text)

            def on_complete(self) -> None:
                if session._closed:
                    session.done_event.set()
                    return
                session.status = "done"
                session.updated_at = time.time()
                session._emit("complete", text=session.text)
                session.done_event.set()

            def on_error(self, result) -> None:
                if session._closed:
                    session.done_event.set()
                    return
                session.status = "error"
                session.error_message = str(getattr(result, "message", "") or result or "语音识别失败").strip()
                session.updated_at = time.time()
                session._emit("error", message=session.error_message, text=session.text)
                session.done_event.set()

            def on_close(self) -> None:
                if not session.done_event.is_set():
                    session.done_event.set()

        return _RealtimeCallback()

    def _normalize_sentences(self, result: Any) -> list[dict[str, Any]]:
        try:
            sentence = result.get_sentence()
        except Exception:
            sentence = None

        if isinstance(sentence, dict):
            return [sentence]
        if isinstance(sentence, list):
            return [item for item in sentence if isinstance(item, dict)]

        payload = self.service._extract_sentence_payload(result)
        if isinstance(payload, dict):
            return [payload]
        return []

    def _emit(self, event_type: str, **data) -> None:
        self._events.emit(self.id, event_type, session_id=self.id, **data)

    def _close_transport(self) -> None:
        duplex_api = getattr(self._recognition, "get_duplex_api", None)
        if callable(duplex_api):
            try:
                duplex_api().close(1000, "bye")
            except Exception:
                pass

        legacy_duplex_api = getattr(self._recognition, "getDuplexApi", None)
        if callable(legacy_duplex_api):
            try:
                legacy_duplex_api().close(1000, "bye")
            except Exception:
                pass


class RealtimeASRSessionManager:
    """实时 ASR 会话管理器。"""

    def __init__(self, service: ASRService):
        self.service = service
        self._lock = threading.Lock()
        self._sessions: dict[str, RealtimeASRSession] = {}

    def create(self) -> RealtimeASRSession:
        if not self.service.api_key:
            raise ASRServiceError("QWEN_API_KEY 未配置，无法使用实时语音识别")

        dashscope, Recognition, RecognitionCallback = self.service._load_sdk()
        dashscope.api_key = self.service.api_key
        dashscope.base_websocket_api_url = self.service.base_ws_url

        session = RealtimeASRSession(self.service, Recognition, RecognitionCallback)
        session.start()
        with self._lock:
            self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> RealtimeASRSession | None:
        with self._lock:
            return self._sessions.get(session_id)

    def close(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.close()

    def cancel(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.cancel()
