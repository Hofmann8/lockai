"""
Provider runtime helpers for cross-vendor non-stream chat.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import uuid
from typing import Any

import httpx

from models import strip_assistant_reasoning

from .tool_contracts import build_anthropic_tools, build_gemini_function_declarations


class ProviderRuntime:
    """Builds provider-specific request state and parses provider responses."""

    def __init__(self, llm_service):
        self.llm = llm_service
        self.request_timeout = httpx.Timeout(connect=30.0, read=600.0, write=30.0, pool=30.0)
        self.image_fetch_timeout = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)

    def resolve_transport(self, model: str | dict[str, Any] | None = None) -> str:
        cfg = model if isinstance(model, dict) else self.llm.get_model_config(model)
        transport = self._clean_optional_string(cfg.get("transport")).lower()
        if transport:
            return transport

        provider = self._clean_optional_string(cfg.get("provider")).lower()
        if provider:
            return provider

        model_name = self._clean_optional_string(cfg.get("model") or cfg.get("id")).lower()
        if model_name.startswith("claude") or "anthropic" in model_name:
            return "anthropic-native"
        if "gemini" in model_name:
            return "gemini-native"
        if model_name.startswith("qwen"):
            return "qwen-compatible"
        return "openai-compatible"

    def build_state(
        self,
        *,
        messages: list[dict[str, Any]],
        model_config: dict[str, Any] | None = None,
        model_id: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        enable_thinking: bool | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        cfg = dict(model_config) if isinstance(model_config, dict) else self.llm.get_model_config(model_id)
        transport = self.resolve_transport(cfg)
        if transport.startswith("gemini"):
            return self._build_gemini_state(
                cfg,
                messages=messages,
                tools=tools,
                temperature=temperature,
                max_tokens=max_tokens,
                enable_thinking=enable_thinking,
                extra_payload=extra_payload,
            )
        if transport.startswith("anthropic"):
            return self._build_anthropic_state(
                cfg,
                messages=messages,
                tools=tools,
                max_tokens=max_tokens,
            )
        return self._build_openai_state(
            cfg,
            messages=messages,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=enable_thinking,
            extra_payload=extra_payload,
        )

    def request_turn(self, state: dict[str, Any]) -> dict[str, Any] | None:
        if not state:
            return None

        kind = str(state.get("kind") or "openai-compatible")
        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                if kind == "gemini-native":
                    response = self._request_gemini_turn(client, state)
                    return self._parse_gemini_response(response)
                if kind == "anthropic-native":
                    response = self._request_anthropic_turn(client, state)
                    return self._parse_anthropic_response(response)
                response = self._request_openai_turn(client, state)
                return self._parse_openai_response(response)
        except Exception as exc:
            print(f"[LLM] provider turn 异常 ({kind}): {type(exc).__name__}: {exc}")
            return None

    def append_assistant_history(
        self,
        state: dict[str, Any],
        assistant_history_item: Any,
        *,
        parsed_calls: list[dict[str, Any]],
        content_text: str,
    ) -> None:
        kind = str(state.get("kind") or "openai-compatible")
        if kind == "gemini-native":
            if isinstance(assistant_history_item, dict):
                state["history"].append(assistant_history_item)
                return
            parts: list[dict[str, Any]] = []
            if content_text:
                parts.append({"text": content_text})
            for call in parsed_calls:
                parts.append({
                    "functionCall": {
                        "name": call["name"],
                        "id": call["id"],
                        "args": call.get("arguments") or {},
                    }
                })
            if parts:
                state["history"].append({"role": "model", "parts": parts})
            return

        if kind == "anthropic-native":
            if isinstance(assistant_history_item, dict):
                state["history"].append(assistant_history_item)
                return
            blocks: list[dict[str, Any]] = []
            if content_text:
                blocks.append({"type": "text", "text": content_text})
            for call in parsed_calls:
                blocks.append({
                    "type": "tool_use",
                    "id": call["id"],
                    "name": call["name"],
                    "input": call.get("arguments") or {},
                })
            if blocks:
                state["history"].append({"role": "assistant", "content": blocks})
            return

        if isinstance(assistant_history_item, dict):
            state["history"].append(assistant_history_item)
            return
        assistant_message: dict[str, Any] = {"role": "assistant"}
        if content_text:
            assistant_message["content"] = content_text
        if parsed_calls:
            assistant_message["tool_calls"] = self._build_openai_tool_calls(parsed_calls)
        state["history"].append(assistant_message)

    def append_tool_results(self, state: dict[str, Any], tool_results: list[dict[str, Any]]) -> None:
        if not tool_results:
            return

        kind = str(state.get("kind") or "openai-compatible")
        if kind == "gemini-native":
            parts: list[dict[str, Any]] = []
            for result in tool_results:
                parts.append({
                    "functionResponse": {
                        "name": result["name"],
                        "response": {
                            "result": self._normalize_tool_result_content(result.get("content")),
                        },
                    }
                })
            state["history"].append({"role": "user", "parts": parts})
            return

        if kind == "anthropic-native":
            blocks: list[dict[str, Any]] = []
            for result in tool_results:
                blocks.append({
                    "type": "tool_result",
                    "tool_use_id": result["id"],
                    "content": self._normalize_tool_result_content(result.get("content")),
                })
            state["history"].append({"role": "user", "content": blocks})
            return

        for result in tool_results:
            state["history"].append({
                "role": "tool",
                "tool_call_id": result["id"],
                "content": self._normalize_tool_result_content(result.get("content")),
            })

    def _build_openai_state(
        self,
        cfg: dict[str, Any],
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float | None,
        max_tokens: int | None,
        enable_thinking: bool | None,
        extra_payload: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        api_key = self.llm.get_api_key(cfg)
        if not api_key:
            return None
        return {
            "kind": "openai-compatible",
            "transport": self.resolve_transport(cfg),
            "model_id": cfg["model"],
            "url": self.llm._chat_endpoint(cfg["api_base"]),
            "headers": self.llm._build_headers(api_key),
            "history": list(messages),
            "tools": tools or [],
            "temperature": temperature if temperature is not None else cfg.get("temperature", self.llm.temperature),
            "max_tokens": max_tokens if max_tokens is not None else cfg.get("max_tokens", self.llm.max_tokens),
            "enable_thinking": enable_thinking,
            "extra_payload": dict(extra_payload or {}),
        }

    def _build_gemini_state(
        self,
        cfg: dict[str, Any],
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float | None,
        max_tokens: int | None,
        enable_thinking: bool | None,
        extra_payload: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        api_key = self._select_native_api_key(
            cfg,
            env_candidates=("FANGGROUP_GEMINI_API_KEY", "GEMINI_API_KEY"),
            allow_model_api_key_fallback=True,
        )
        if not api_key:
            return None

        system_instruction, history = self._convert_history_to_gemini_contents(messages)
        api_base = (
            self._clean_optional_string(cfg.get("native_api_base"))
            or self._clean_optional_string(os.environ.get("GEMINI_API_BASE"))
            or self._clean_optional_string(cfg.get("api_base"))
            or self.llm.legacy_api_base
        )
        return {
            "kind": "gemini-native",
            "transport": self.resolve_transport(cfg),
            "model_id": cfg["model"],
            "url": self._build_gemini_chat_url(api_base, cfg["model"]),
            "headers": {"Content-Type": "application/json"},
            "params": {"key": api_key},
            "system_instruction": system_instruction,
            "history": history,
            "tools": self._build_gemini_function_declarations(tools),
            "temperature": temperature if temperature is not None else cfg.get("temperature", self.llm.temperature),
            "max_tokens": max_tokens if max_tokens is not None else cfg.get("max_tokens", self.llm.max_tokens),
            "enable_thinking": enable_thinking,
            "extra_payload": dict(extra_payload or {}),
        }

    def _build_anthropic_state(
        self,
        cfg: dict[str, Any],
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        max_tokens: int | None,
    ) -> dict[str, Any] | None:
        api_key = self._select_native_api_key(
            cfg,
            env_candidates=("ANTHROPIC_API_KEY",),
            allow_model_api_key_fallback=True,
        )
        if not api_key:
            return None

        system_instruction, non_system_messages = self._split_history_system_messages(messages)
        history: list[dict[str, Any]] = []
        for item in non_system_messages:
            role = item.get("role")
            if role not in {"user", "assistant"}:
                continue
            blocks = self._convert_history_content_to_anthropic_blocks(item.get("content"))
            if not blocks:
                continue
            history.append({"role": role, "content": blocks})

        api_base = (
            self._clean_optional_string(cfg.get("native_api_base"))
            or self._clean_optional_string(os.environ.get("ANTHROPIC_API_BASE"))
            or "https://api.anthropic.com"
        )
        return {
            "kind": "anthropic-native",
            "transport": self.resolve_transport(cfg),
            "model_id": cfg["model"],
            "url": f"{api_base.rstrip('/')}/v1/messages",
            "headers": {
                "x-api-key": api_key,
                "anthropic-version": os.environ.get("ANTHROPIC_API_VERSION", "2023-06-01"),
                "Content-Type": "application/json",
            },
            "system_instruction": system_instruction,
            "history": history,
            "tools": self._build_anthropic_tools(tools),
            "max_tokens": max_tokens if max_tokens is not None else max(256, int(os.environ.get("ANTHROPIC_MAX_TOKENS", "4096"))),
        }

    def _request_openai_turn(self, client: httpx.Client, state: dict[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": state["model_id"],
            "messages": state["history"],
            "stream": False,
            "temperature": state["temperature"],
            "max_tokens": state["max_tokens"],
        }
        if state.get("tools"):
            payload["tools"] = state["tools"]
        if state.get("enable_thinking") is not None and str(state.get("transport") or "").startswith("qwen"):
            payload["enable_thinking"] = bool(state["enable_thinking"])
        payload.update(state.get("extra_payload") or {})
        response = client.post(state["url"], headers=state["headers"], json=payload)
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code} - {response.text[:500]}")
        return response.json()

    def _request_gemini_turn(self, client: httpx.Client, state: dict[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "contents": state["history"],
            "generationConfig": {
                "temperature": state["temperature"],
                "maxOutputTokens": state["max_tokens"],
            },
        }
        if state.get("enable_thinking") is not None:
            payload["generationConfig"]["thinkingConfig"] = self._build_gemini_thinking_config(
                state["model_id"],
                bool(state["enable_thinking"]),
            )
        if state.get("system_instruction"):
            payload["systemInstruction"] = {"parts": [{"text": state["system_instruction"]}]}
        if state.get("tools"):
            payload["tools"] = [{"functionDeclarations": state["tools"]}]
            payload["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
        payload.update(state.get("extra_payload") or {})
        response = client.post(
            state["url"],
            headers=state["headers"],
            params=state.get("params"),
            json=payload,
        )
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code} - {response.text[:500]}")
        return response.json()

    def _build_gemini_thinking_config(self, model_id: str, enable_thinking: bool) -> dict[str, Any]:
        model_name = self._clean_optional_string(model_id).lower()
        if model_name.startswith("gemini-3"):
            return {
                # Gemini 3 thinking uses qualitative levels rather than an on/off budget.
                "thinkingLevel": "HIGH" if enable_thinking else "LOW",
            }
        return {
            # For 2.5-style models, a zero budget disables thinking while a positive budget enables it.
            "thinkingBudget": 1024 if enable_thinking else 0,
        }

    def _request_anthropic_turn(self, client: httpx.Client, state: dict[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": state["model_id"],
            "max_tokens": state["max_tokens"],
            "messages": state["history"],
        }
        if state.get("system_instruction"):
            payload["system"] = state["system_instruction"]
        if state.get("tools"):
            payload["tools"] = state["tools"]
        response = client.post(state["url"], headers=state["headers"], json=payload)
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code} - {response.text[:500]}")
        return response.json()

    def _parse_openai_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message", {}) or {}
        raw_content = message.get("content")
        visible_content = self._extract_visible_openai_content(raw_content)
        assistant_history_item = self._build_openai_assistant_history_item(
            visible_content,
            self.llm._parse_tool_calls(message.get("tool_calls")),
        )
        return {
            "message": message,
            "raw_content": raw_content,
            "content": visible_content,
            "tool_calls": self.llm._parse_tool_calls(message.get("tool_calls")),
            "finish_reason": choice.get("finish_reason", ""),
            "assistant_history_item": assistant_history_item,
        }

    def _parse_gemini_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        candidates = payload.get("candidates") or []
        if not candidates:
            raise RuntimeError("模型返回空响应，请重试")

        candidate = candidates[0] if isinstance(candidates[0], dict) else {}
        content_obj = candidate.get("content") if isinstance(candidate.get("content"), dict) else {}
        parts = content_obj.get("parts") if isinstance(content_obj.get("parts"), list) else []
        if parts and not self._clean_optional_string(content_obj.get("role")):
            content_obj = {"role": "model", "parts": parts}

        text_fragments: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        visible_parts: list[dict[str, Any]] = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            if self._is_reasoning_part(part):
                continue

            visible_part: dict[str, Any] = {}
            if part.get("thoughtSignature") is not None:
                visible_part["thoughtSignature"] = part.get("thoughtSignature")
            if part.get("thought_signature") is not None:
                visible_part["thought_signature"] = part.get("thought_signature")
            text = strip_assistant_reasoning(self._clean_optional_string(part.get("text")))
            if text:
                text_fragments.append(text)
                visible_part["text"] = text
            function_call = part.get("functionCall") or part.get("function_call")
            if isinstance(function_call, dict):
                name = self._clean_optional_string(function_call.get("name"))
                if name:
                    raw_args = function_call.get("args", {})
                    if isinstance(raw_args, str):
                        try:
                            raw_args = json.loads(raw_args)
                        except json.JSONDecodeError:
                            raw_args = {}
                    if not isinstance(raw_args, dict):
                        raw_args = {}
                    call_id = self._clean_optional_string(function_call.get("id")) or str(uuid.uuid4())
                    tool_calls.append({
                        "id": call_id,
                        "name": name,
                        "arguments": raw_args,
                    })
                    visible_part["functionCall"] = {
                        "name": name,
                        "id": call_id,
                        "args": raw_args,
                    }

            if visible_part:
                visible_parts.append(visible_part)

        return {
            "message": {"role": "model", "parts": visible_parts} if visible_parts else {},
            "raw_content": parts,
            "content": strip_assistant_reasoning("".join(text_fragments).strip()),
            "tool_calls": tool_calls,
            "finish_reason": self._clean_optional_string(candidate.get("finishReason")),
            "assistant_history_item": {"role": "model", "parts": visible_parts} if visible_parts else None,
        }

    def _parse_anthropic_response(self, payload: dict[str, Any]) -> dict[str, Any]:
        blocks = payload.get("content") or []
        if not isinstance(blocks, list):
            blocks = []

        text_fragments: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        visible_blocks: list[dict[str, Any]] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = strip_assistant_reasoning(self._clean_optional_string(block.get("text")))
                if text:
                    text_fragments.append(text)
                    visible_blocks.append({"type": "text", "text": text})
                continue
            if block_type != "tool_use":
                continue
            name = self._clean_optional_string(block.get("name"))
            if not name:
                continue
            raw_args = block.get("input", {})
            if not isinstance(raw_args, dict):
                raw_args = {}
            call_id = self._clean_optional_string(block.get("id")) or str(uuid.uuid4())
            tool_calls.append({
                "id": call_id,
                "name": name,
                "arguments": raw_args,
            })
            visible_blocks.append({
                "type": "tool_use",
                "id": call_id,
                "name": name,
                "input": raw_args,
            })

        return {
            "message": {"role": "assistant", "content": visible_blocks} if visible_blocks else {},
            "raw_content": blocks,
            "content": strip_assistant_reasoning("".join(text_fragments).strip()),
            "tool_calls": tool_calls,
            "finish_reason": self._clean_optional_string(payload.get("stop_reason")),
            "assistant_history_item": {"role": "assistant", "content": visible_blocks} if visible_blocks else None,
        }

    def _build_openai_tool_calls(self, parsed_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []
        for call in parsed_calls:
            calls.append({
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                },
            })
        return calls

    def _split_history_system_messages(self, history: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
        system_parts: list[str] = []
        non_system_messages: list[dict[str, Any]] = []
        for item in history:
            if item.get("role") == "system":
                text = self._extract_message_text_content(item.get("content")).strip()
                if text:
                    system_parts.append(text)
                continue
            non_system_messages.append(item)
        return "\n\n".join(system_parts).strip(), non_system_messages

    def _convert_history_to_gemini_contents(self, history: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
        system_instruction, non_system_messages = self._split_history_system_messages(history)
        contents: list[dict[str, Any]] = []
        for item in non_system_messages:
            role = item.get("role")
            if role not in {"user", "assistant"}:
                continue
            parts = self._convert_history_content_to_gemini_parts(item.get("content"))
            if not parts:
                continue
            contents.append({
                "role": "model" if role == "assistant" else "user",
                "parts": parts,
            })
        return system_instruction, contents

    def _convert_history_content_to_gemini_parts(self, content: Any) -> list[dict[str, Any]]:
        if isinstance(content, str):
            text = content.strip()
            return [{"text": text}] if text else []

        if not isinstance(content, list):
            text = self._extract_message_text_content(content).strip()
            return [{"text": text}] if text else []

        parts: list[dict[str, Any]] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type == "text":
                text = self._clean_optional_string(item.get("text"))
                if text:
                    parts.append({"text": text})
                continue
            if item_type == "image_url":
                image_url = self._clean_optional_string((item.get("image_url") or {}).get("url"))
                if image_url:
                    part = self._encode_image_url_as_gemini_part(image_url)
                    if part:
                        parts.append(part)
        return parts

    def _convert_history_content_to_anthropic_blocks(self, content: Any) -> list[dict[str, Any]]:
        if isinstance(content, str):
            text = content.strip()
            return [{"type": "text", "text": text}] if text else []

        if not isinstance(content, list):
            text = self._extract_message_text_content(content).strip()
            return [{"type": "text", "text": text}] if text else []

        blocks: list[dict[str, Any]] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type == "text":
                text = self._clean_optional_string(item.get("text"))
                if text:
                    blocks.append({"type": "text", "text": text})
                continue
            if item_type == "image_url":
                image_url = self._clean_optional_string((item.get("image_url") or {}).get("url"))
                if image_url:
                    block = self._encode_image_url_as_anthropic_block(image_url)
                    if block:
                        blocks.append(block)
        return blocks

    def _build_gemini_function_declarations(self, tools: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        return build_gemini_function_declarations(tools)

    def _build_anthropic_tools(self, tools: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        return build_anthropic_tools(tools)

    def _build_gemini_chat_url(self, api_base: str, model_id: str) -> str:
        stripped = (api_base or self.llm.legacy_api_base).rstrip("/")
        if stripped.endswith("/v1"):
            stripped = stripped[:-3]
        return f"{stripped}/v1beta/models/{model_id}:generateContent"

    def _encode_image_url_as_gemini_part(self, image_url: str) -> dict[str, Any] | None:
        image_bytes, mime_type = self._download_source_image(image_url)
        if not image_bytes:
            return None
        return {
            "inline_data": {
                "mime_type": mime_type or "image/png",
                "data": base64.b64encode(image_bytes).decode("utf-8"),
            }
        }

    def _encode_image_url_as_anthropic_block(self, image_url: str) -> dict[str, Any] | None:
        image_bytes, mime_type = self._download_source_image(image_url)
        if not image_bytes:
            return None
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime_type or "image/png",
                "data": base64.b64encode(image_bytes).decode("utf-8"),
            },
        }

    def _download_source_image(self, image_url: str) -> tuple[bytes | None, str]:
        if not image_url:
            return None, ""
        try:
            with httpx.Client(timeout=self.image_fetch_timeout) as client:
                response = client.get(image_url)
            if response.status_code != 200:
                return None, ""
            mime_type = self._clean_optional_string(response.headers.get("content-type")).split(";", 1)[0]
            if not mime_type.startswith("image/"):
                mime_type = mimetypes.guess_type(image_url)[0] or "image/png"
            return response.content, mime_type
        except Exception:
            return None, ""

    def _select_native_api_key(
        self,
        cfg: dict[str, Any],
        *,
        env_candidates: tuple[str, ...],
        allow_model_api_key_fallback: bool,
    ) -> str:
        env_name = self._clean_optional_string(cfg.get("native_api_key_env"))
        if env_name and os.environ.get(env_name):
            return self._clean_optional_string(os.environ.get(env_name))

        explicit_key = self._clean_optional_string(cfg.get("native_api_key"))
        if explicit_key:
            return explicit_key

        for candidate in env_candidates:
            if candidate and os.environ.get(candidate):
                return self._clean_optional_string(os.environ.get(candidate))

        if allow_model_api_key_fallback:
            return self.llm.get_api_key(cfg) or ""
        return ""

    def _extract_message_text_content(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text = self._clean_optional_string(item.get("text"))
                    if text:
                        parts.append(text)
            return "".join(parts)
        normalized = self.llm._normalize_message_content(content)
        return normalized or ""

    def _normalize_tool_result_content(self, content: Any) -> str:
        if isinstance(content, str):
            return content or "工具执行完成"
        if content is None:
            return "工具执行完成"
        try:
            return json.dumps(content, ensure_ascii=False)
        except TypeError:
            return str(content)

    def _clean_optional_string(self, value: Any) -> str:
        return str(value or "").strip()

    def _is_reasoning_part(self, part: Any) -> bool:
        if not isinstance(part, dict):
            return False

        part_type = self._clean_optional_string(part.get("type")).lower()
        if part_type in {"reasoning", "thinking", "redacted_thinking", "analysis"}:
            return True

        if bool(part.get("thought")):
            return True

        return False

    def _extract_visible_openai_content(self, content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return strip_assistant_reasoning(content)
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if self._is_reasoning_part(item):
                    continue
                visible = self._extract_visible_openai_content(item)
                if visible:
                    parts.append(visible)
            return strip_assistant_reasoning("\n".join(parts).strip())
        if isinstance(content, dict):
            if self._is_reasoning_part(content):
                return ""
            for key in ("text", "content", "value", "output_text"):
                visible = self._extract_visible_openai_content(content.get(key))
                if visible:
                    return visible
            return ""
        return strip_assistant_reasoning(str(content))

    def _build_openai_assistant_history_item(
        self,
        content_text: str,
        parsed_calls: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        assistant_message: dict[str, Any] = {"role": "assistant"}
        if content_text:
            assistant_message["content"] = content_text
        if parsed_calls:
            assistant_message["tool_calls"] = self._build_openai_tool_calls(parsed_calls)
        return assistant_message if len(assistant_message) > 1 else None
