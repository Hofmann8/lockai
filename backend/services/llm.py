"""
LLM API 调用服务
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Generator, Optional

import httpx

from .provider_runtime import ProviderRuntime


ENV_SUB_RE = re.compile(r'\$\{(\w+)\}')
RETIRED_CHAT_MODEL_ALIASES = {
    "xiaosuolaoshi": "campbell",
}


class LLMService:
    """LLM API 调用服务。"""

    def __init__(self):
        self.temperature = float(os.environ.get("AI_TEMPERATURE", "0.7"))
        self.max_tokens = int(os.environ.get("AI_MAX_TOKENS", "8192"))
        self.models_config_path = os.environ.get("MODELS_CONFIG", "models.json")
        self._backend_dir = Path(__file__).resolve().parent.parent
        self._models_cache: list[dict[str, Any]] = []
        self._key_index_by_model: dict[str, int] = {}

        # 兼容旧代码的默认配置
        self.legacy_api_base = os.environ.get("API_BASE_URL", "https://api.vectorengine.ai")
        self.qwen_base_url = os.environ.get("QWEN_API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.qwen_api_key = os.environ.get("QWEN_API_KEY", "")
        self.provider_runtime = ProviderRuntime(self)

        self.reload_models()

    def reload_models(self) -> list[dict[str, Any]]:
        self._models_cache = self._load_models()
        self._refresh_compat_fields()
        return self._models_cache

    def list_models(self) -> list[dict[str, Any]]:
        return list(self._models_cache)

    def get_chat_models(self) -> list[dict[str, Any]]:
        return [
            cfg for cfg in self._models_cache
            if cfg.get("visible", True) and cfg.get("available", True)
        ]

    def normalize_chat_model_id(self, model_id: str | None = None) -> str:
        target = str(model_id or "").strip()
        if not target:
            return self.get_default_chat_model_id()

        target = RETIRED_CHAT_MODEL_ALIASES.get(target, target)
        chat_model_ids = {str(cfg.get("id")) for cfg in self.get_chat_models()}
        if target in chat_model_ids:
            return target
        return self.get_default_chat_model_id()

    def get_default_chat_model_id(self) -> str:
        for cfg in self.get_chat_models():
            if cfg.get("is_default"):
                return str(cfg["id"])
        chat_models = self.get_chat_models()
        if chat_models:
            return str(chat_models[0]["id"])
        return "campbell"

    def get_model_config(self, model_id: str | None = None) -> dict[str, Any]:
        target = model_id or self.get_default_chat_model_id()
        for cfg in self._models_cache:
            if cfg.get("id") == target:
                return dict(cfg)
        return self._build_legacy_model_config(target)

    def resolve_chat_transport(self, model: str | dict[str, Any] | None = None) -> str:
        return self.provider_runtime.resolve_transport(model)

    def get_api_key(self, model: str | dict[str, Any] | None = None) -> Optional[str]:
        cfg = model if isinstance(model, dict) else self.get_model_config(model)
        keys = self._collect_api_keys(cfg)
        if not keys:
            return None

        model_id = str(cfg.get("id") or cfg.get("model") or "default")
        idx = self._key_index_by_model.get(model_id, 0)
        self._key_index_by_model[model_id] = (idx + 1) % len(keys)
        return keys[idx]

    def _get_api_key(self, model: str | dict[str, Any] | None = None) -> Optional[str]:
        return self.get_api_key(model or self.get_default_chat_model_id())

    def stream_chat_completion(
        self,
        messages: list,
        model: str | None = None,
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        enable_thinking: bool | None = None,
        reasoning_effort: str | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        cfg = self.get_model_config(model)
        api_key = self.get_api_key(cfg)
        if not api_key:
            yield {"type": "error", "content": "API 密钥未配置"}
            return

        payload = self._build_payload(
            cfg,
            messages,
            stream=True,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
            extra_payload=extra_payload,
        )

        print(f"\n[LLM] 流式调用: {cfg.get('model')} via {cfg.get('id')}")

        try:
            with httpx.Client(timeout=httpx.Timeout(connect=30.0, read=600.0, write=30.0, pool=30.0)) as client:
                with client.stream(
                    "POST",
                    self._chat_endpoint(cfg["api_base"]),
                    headers=self._build_headers(api_key),
                    json=payload,
                ) as response:
                    if response.status_code != 200:
                        error_text = response.read().decode("utf-8", errors="replace")
                        print(f"[LLM] 错误: {response.status_code} - {error_text[:500]}")
                        yield {"type": "error", "content": f"API 请求失败: {response.status_code}"}
                        return

                    for line in response.iter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
                        choices = data.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        yield {
                            "type": "delta",
                            "delta": choice.get("delta", {}),
                            "finish_reason": choice.get("finish_reason"),
                        }
        except httpx.TimeoutException:
            yield {"type": "error", "content": "请求超时"}
        except Exception as exc:
            print(f"[LLM] 异常: {type(exc).__name__}: {exc}")
            yield {"type": "error", "content": f"请求失败: {exc}"}

    def stream(
        self,
        messages: list,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        for chunk in self.stream_chat_completion(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
        ):
            if chunk.get("type") == "error":
                yield chunk
                return
            delta = chunk.get("delta") or {}
            content = delta.get("content") or ""
            if content:
                yield {"type": "content", "content": content}

    def complete_with_tools(
        self,
        messages: list,
        tools: list[dict],
        tool_handler: callable,
        model: str = None,
        temperature: float = None,
        max_tokens: int = None,
        api_key: str = None,
        max_rounds: int = 10,
    ) -> str | None:
        cfg = self._get_runtime_model_config(model, api_key)
        runtime = self.provider_runtime.build_state(
            messages=messages,
            model_config=cfg,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        if not runtime:
            return None

        for round_idx in range(max_rounds):
            print(
                f"\n[LLM] tool_call round {round_idx + 1}: "
                f"model={cfg.get('model')} transport={runtime.get('transport')}"
            )

            response = self.provider_runtime.request_turn(runtime)
            if response is None:
                return None

            finish_reason = str(response.get("finish_reason") or "")
            tool_calls = response.get("tool_calls") or []
            final_content = str(response.get("content") or "")
            print(
                f"[LLM] tool_call round {round_idx + 1} done: "
                f"finish_reason={finish_reason or 'none'} "
                f"content_type={type(response.get('raw_content')).__name__} "
                f"tool_calls={len(tool_calls)}"
            )

            if not tool_calls:
                return final_content

            self.provider_runtime.append_assistant_history(
                runtime,
                response.get("assistant_history_item"),
                parsed_calls=tool_calls,
                content_text=final_content,
            )

            tool_results: list[dict[str, Any]] = []
            for call in tool_calls:
                name = str(call.get("name") or "").strip()
                arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
                print(f"[LLM] tool_call: {name}({json.dumps(arguments, ensure_ascii=False)[:200]})")
                result_str = tool_handler(name, arguments)
                tool_results.append({
                    "id": call["id"],
                    "name": name,
                    "content": result_str,
                })

            self.provider_runtime.append_tool_results(runtime, tool_results)

        print(f"[LLM] tool_call 达到最大轮数 {max_rounds}")
        return None

    def complete_chat_turn(
        self,
        messages: list,
        model: str = None,
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        api_key: str | None = None,
        enable_thinking: bool | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> Optional[dict[str, Any]]:
        cfg = self._get_runtime_model_config(model, api_key)
        runtime = self.provider_runtime.build_state(
            messages=messages,
            model_config=cfg,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=enable_thinking,
            extra_payload=extra_payload,
        )
        if not runtime:
            return None

        print(
            f"\n[LLM] nonstream turn: model={cfg.get('model')} via {cfg.get('id')} "
            f"transport={runtime.get('transport')}"
        )

        response = self.provider_runtime.request_turn(runtime)
        if response is None:
            return None
        print(
            f"[LLM] nonstream done: finish_reason={response.get('finish_reason') or 'none'} "
            f"content_type={type(response.get('raw_content')).__name__} "
            f"tool_calls={len(response.get('tool_calls') or [])}"
        )
        return response

    def complete(
        self,
        messages: list,
        model: str = None,
        temperature: float = None,
        max_tokens: int = None,
        api_key: str = None,
        enable_thinking: bool | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> Optional[str]:
        response = self.complete_message(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            api_key=api_key,
            enable_thinking=enable_thinking,
            extra_payload=extra_payload,
        )
        if response is None:
            return None
        return self._normalize_message_content(response.get("content"))

    def complete_message(
        self,
        messages: list,
        model: str = None,
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        api_key: str | None = None,
        enable_thinking: bool | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> Optional[dict[str, Any]]:
        cfg = self._get_runtime_model_config(model, api_key)
        runtime = self.provider_runtime.build_state(
            messages=messages,
            model_config=cfg,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
            enable_thinking=enable_thinking,
            extra_payload=extra_payload,
        )
        if not runtime:
            return None

        print(
            f"\n[LLM] complete_message: model={cfg.get('model')} via {cfg.get('id')} "
            f"transport={runtime.get('transport')}"
        )

        response = self.provider_runtime.request_turn(runtime)
        if response is None:
            return None
        return {
            "message": response.get("message") or {},
            "finish_reason": response.get("finish_reason", ""),
            "content": response.get("content"),
            "tool_calls": response.get("tool_calls") or [],
        }

    def _normalize_message_content(self, content: Any) -> Optional[str]:
        if content is None:
            return None
        if isinstance(content, str):
            return content or None
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                normalized = self._normalize_message_content(item)
                if normalized:
                    parts.append(normalized)
            if parts:
                return "\n".join(parts)
            try:
                return json.dumps(content, ensure_ascii=False)
            except TypeError:
                return str(content)
        if isinstance(content, dict):
            for key in ("text", "content", "value", "output_text"):
                normalized = self._normalize_message_content(content.get(key))
                if normalized:
                    return normalized
            try:
                return json.dumps(content, ensure_ascii=False)
            except TypeError:
                return str(content)
        return str(content)

    def _get_runtime_model_config(
        self,
        model: str | None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        cfg = self.get_model_config(model)
        if api_key:
            cfg["api_key"] = api_key
            cfg["native_api_key"] = api_key
        return cfg

    def _parse_tool_calls(self, tool_calls: Any) -> list[dict[str, Any]]:
        parsed: list[dict[str, Any]] = []
        for index, tc in enumerate(tool_calls or []):
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            name = str(fn.get("name") or "").strip()
            arguments_raw = fn.get("arguments", "{}")
            try:
                arguments = json.loads(arguments_raw)
                if not isinstance(arguments, dict):
                    arguments = {}
            except (json.JSONDecodeError, TypeError):
                arguments = {}
            parsed.append({
                "id": str(tc.get("id") or f"tool_call_{index}"),
                "name": name,
                "arguments": arguments,
            })
        return parsed

    def _load_models(self) -> list[dict[str, Any]]:
        path = Path(self.models_config_path)
        if not path.is_absolute():
            cwd_candidate = Path(os.getcwd()) / path
            backend_candidate = self._backend_dir / path
            if cwd_candidate.exists():
                path = cwd_candidate
            else:
                path = backend_candidate
        if not path.exists():
            return self._default_models()

        raw = path.read_text(encoding="utf-8")
        raw = ENV_SUB_RE.sub(lambda match: os.environ.get(match.group(1), ""), raw)
        models = json.loads(raw)
        if not isinstance(models, list):
            return self._default_models()
        return [cfg for cfg in models if isinstance(cfg, dict)]

    def _refresh_compat_fields(self) -> None:
        default_cfg = self.get_model_config(self.get_default_chat_model_id())
        self.model_primary = str(default_cfg.get("model") or default_cfg.get("id") or "campbell")
        self.base_url = str(default_cfg.get("api_base") or self.legacy_api_base)
        self.model_search = "search_builtin"
        self.model_keyword = "search_builtin"
        self.model_image = "image_generator"

    def _default_models(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "campbell",
                "name": "Campbell 1.5",
                "description": "深度推理与复杂任务处理",
                "model": "claude-sonnet-4-6",
                "api_base": self.legacy_api_base,
                "api_key": os.environ.get("ANTHROPIC_API_KEY", ""),
                "provider": "anthropic-native",
                "transport": "anthropic-native",
                "native_api_key_env": "ANTHROPIC_API_KEY",
                "thinking_mode": "optional",
                "default_thinking": True,
                "available": True,
                "visible": True,
                "is_default": True,
                "prompt_id": "campbell",
            },
            {
                "id": "scooby",
                "name": "Scooby 2.0",
                "description": "通用助理，适合多数对话与创作任务",
                "model": "deepseek-v4-pro",
                "api_base": os.environ.get("DEEPSEEK_API_BASE_URL", "https://api.deepseek.com"),
                "api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
                "provider": "deepseek-compatible",
                "transport": "deepseek-compatible",
                "thinking_mode": "optional",
                "default_thinking": True,
                "available": True,
                "visible": True,
                "prompt_id": "scooby",
            },
            {
                "id": "leo",
                "name": "Leo 2.0",
                "description": "响应更快，适合日常问答与轻量任务",
                "model": "deepseek-v4-flash",
                "api_base": os.environ.get("DEEPSEEK_API_BASE_URL", "https://api.deepseek.com"),
                "api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
                "provider": "deepseek-compatible",
                "transport": "deepseek-compatible",
                "thinking_mode": "optional",
                "default_thinking": True,
                "available": True,
                "visible": True,
                "prompt_id": "leo",
            },
            {
                "id": "search_builtin",
                "name": "联网搜索",
                "description": "内部搜索执行模型",
                "model": "qwen3.5-flash",
                "api_base": self.qwen_base_url,
                "api_key": self.qwen_api_key,
                "provider": "qwen-compatible",
                "transport": "qwen-compatible",
                "available": True,
                "visible": False,
                "temperature": 0.3,
                "max_tokens": 4096,
            },
            {
                "id": "title_generator",
                "name": "标题生成",
                "description": "内部标题生成模型",
                "model": "qwen-plus",
                "api_base": self.qwen_base_url,
                "api_key": self.qwen_api_key,
                "provider": "qwen-compatible",
                "transport": "qwen-compatible",
                "available": True,
                "visible": False,
                "temperature": 0.3,
                "max_tokens": 32,
            },
            {
                "id": "image_generator",
                "name": "Campbell 1.5 Image",
                "description": "实时绘图（Gemini 3 Pro Image Preview）",
                "model": "gemini-3-pro-image-preview",
                "edit_model": "gemini-3-pro-image-preview",
                "api_base": os.environ.get("GEMINI_API_BASE_URL", self.legacy_api_base),
                "image_api_key_env": "GEMINI_API_KEY",
                "provider": "openai-image",
                "transport": "openai-image",
                "available": True,
                "visible": False,
            },
            {
                "id": "image_generator_hd",
                "name": "Campbell 2.0 Image",
                "description": "高清绘图（gpt-image-2，较慢）",
                "model": "gpt-image-2",
                "edit_model": "gpt-image-2",
                "api_base": self.legacy_api_base,
                "api_key_pool_prefix": "API_KEY_",
                "provider": "openai-image",
                "transport": "openai-image",
                "available": True,
                "visible": False,
            },
        ]

    def _build_legacy_model_config(self, model_name: str) -> dict[str, Any]:
        if (model_name or "").startswith("qwen"):
            return {
                "id": model_name,
                "name": model_name,
                "model": model_name,
                "api_base": self.qwen_base_url,
                "api_key": self.qwen_api_key,
                "provider": "qwen-compatible",
                "transport": "qwen-compatible",
                "thinking_mode": "never",
                "available": True,
                "visible": False,
            }
        if (model_name or "").startswith("deepseek"):
            return {
                "id": model_name,
                "name": model_name,
                "model": model_name,
                "api_base": os.environ.get("DEEPSEEK_API_BASE_URL", "https://api.deepseek.com"),
                "api_key": os.environ.get("DEEPSEEK_API_KEY", ""),
                "provider": "deepseek-compatible",
                "transport": "deepseek-compatible",
                "thinking_mode": "optional",
                "available": True,
                "visible": False,
            }
        return {
            "id": model_name,
            "name": model_name,
            "model": model_name,
            "api_base": self.legacy_api_base,
            "api_key_pool_prefix": "API_KEY_",
            "provider": "openai-compatible",
            "transport": "openai-compatible",
            "thinking_mode": "never",
            "available": True,
            "visible": False,
        }

    def _collect_api_keys(self, cfg: dict[str, Any]) -> list[str]:
        keys: list[str] = []

        inline_key = str(cfg.get("api_key") or "").strip()
        if inline_key:
            keys.append(inline_key)

        for key in cfg.get("api_keys") or []:
            clean = str(key or "").strip()
            if clean:
                keys.append(clean)

        prefix = str(cfg.get("api_key_pool_prefix") or "").strip()
        if prefix:
            idx = 1
            while True:
                env_key = os.environ.get(f"{prefix}{idx}", "").strip()
                if not env_key:
                    break
                keys.append(env_key)
                idx += 1

        unique: list[str] = []
        seen = set()
        for key in keys:
            if key and key not in seen:
                seen.add(key)
                unique.append(key)
        return unique

    def _build_payload(
        self,
        cfg: dict[str, Any],
        messages: list,
        *,
        stream: bool,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        enable_thinking: bool | None = None,
        reasoning_effort: str | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": cfg["model"],
            "messages": messages,
            "stream": stream,
            "temperature": temperature if temperature is not None else cfg.get("temperature", self.temperature),
            "max_tokens": max_tokens if max_tokens is not None else cfg.get("max_tokens", self.max_tokens),
        }
        if tools:
            payload["tools"] = tools

        provider = str(cfg.get("provider") or "")
        transport = str(cfg.get("transport") or provider)
        if enable_thinking is not None and provider.startswith("qwen"):
            payload["enable_thinking"] = bool(enable_thinking)
        elif transport.startswith("deepseek") or provider.startswith("deepseek"):
            thinking_on = True if enable_thinking is None else bool(enable_thinking)
            payload["thinking"] = {"type": "enabled" if thinking_on else "disabled"}
            if thinking_on:
                for banned in ("temperature", "top_p", "presence_penalty", "frequency_penalty"):
                    payload.pop(banned, None)
                effort = (reasoning_effort or "").strip().lower()
                if effort in {"max", "xhigh"}:
                    payload["reasoning_effort"] = "max"
        if extra_payload:
            payload.update(extra_payload)
        return payload

    def _build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def _chat_endpoint(self, api_base: str) -> str:
        base = (api_base or self.legacy_api_base).rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        if base.endswith("/v1"):
            return f"{base}/chat/completions"
        return f"{base}/v1/chat/completions"
