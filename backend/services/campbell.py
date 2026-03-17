"""
Campbell 聊天服务

使用 Gemini 原生 generateContent 接口执行 function calling，
并保持现有 SSE 事件协议不变。
"""

import base64
import json
import mimetypes
import os
from typing import Generator

import httpx

from .tool_contracts import build_gemini_tools


GEMINI_TOOLS = build_gemini_tools()


class CampbellService:
    """Campbell 模型的 Gemini 原生 function calling 服务。"""

    def __init__(self, llm_service, search_service, image_service):
        self.llm = llm_service
        self.search = search_service
        self.image = image_service
        self.max_rounds = int(os.environ.get("CAMPBELL_TOOL_MAX_ROUNDS", "6"))
        self.request_timeout = httpx.Timeout(
            connect=30.0,
            read=180.0,
            write=30.0,
            pool=30.0,
        )
        self.image_fetch_timeout = httpx.Timeout(
            connect=10.0,
            read=30.0,
            write=10.0,
            pool=10.0,
        )

    def chat_stream(
        self,
        messages: list,
        model_id: str = None,
        user_id: str = None,
        session_id: str = None,
        current_user_images: list[str] = None,
        current_user_message_id: str = None,
        assistant_message_id: str = None,
    ) -> Generator[dict, None, None]:
        """执行 Campbell 多轮工具对话。"""
        cfg = self.llm.get_model_config(model_id or "campbell")
        api_key = self.llm.get_api_key(cfg)
        if not api_key:
            yield {"type": "error", "message": "API 密钥未配置"}
            return

        system_prompt = self._extract_system_prompt(messages)
        asset_catalog = self.image.build_asset_catalog_message(
            session_id,
            current_user_images or [],
            current_user_message_id=current_user_message_id,
        )
        if asset_catalog:
            system_prompt = f"{system_prompt}\n\n{asset_catalog}"

        contents = self._convert_messages_to_contents(messages)

        for round_idx in range(self.max_rounds):
            response_data, error = self._generate_content(
                api_key=api_key,
                api_base=cfg["api_base"],
                model=cfg["model"],
                system_prompt=system_prompt,
                contents=contents,
            )
            if error:
                yield {"type": "error", "message": error}
                return

            candidate = (response_data.get("candidates") or [{}])[0]
            response_content = candidate.get("content") or {}
            parts = response_content.get("parts") or []

            text_parts = []
            tool_calls = []
            for part in parts:
                text = part.get("text")
                if text:
                    text_parts.append(text)
                function_call = part.get("functionCall") or part.get("function_call")
                if function_call:
                    tool_calls.append(self._parse_function_call(function_call))

            for text in text_parts:
                if text:
                    yield {"type": "content_delta", "delta": text}

            if not tool_calls:
                return

            contents.append({
                "role": "model",
                "parts": parts,
            })

            for tool_index, tool_call in enumerate(tool_calls, start=1):
                function_response = yield from self._execute_tool_call(
                    tool_call,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=current_user_images or [],
                    current_user_message_id=current_user_message_id,
                    tool_call_index=tool_index,
                )
                contents.append({
                    "role": "user",
                    "parts": [function_response],
                })

            if round_idx == self.max_rounds - 1:
                yield {"type": "content_delta", "delta": "\n\n工具调用轮数已达上限。"}

    def _generate_content(self, api_key: str, api_base: str, model: str, system_prompt: str, contents: list) -> tuple[dict | None, str | None]:
        url = self._build_generate_url(api_base, model)
        payload = {
            "systemInstruction": {
                "parts": [{"text": system_prompt}],
            },
            "contents": contents,
            "tools": GEMINI_TOOLS,
            "toolConfig": {
                "functionCallingConfig": {
                    "mode": "AUTO",
                }
            },
            "generationConfig": {
                "temperature": self.llm.temperature,
                "maxOutputTokens": self.llm.max_tokens,
            },
        }

        print(f"\n[Campbell] generateContent: {model}")

        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                resp = client.post(
                    url,
                    headers={"Content-Type": "application/json"},
                    params={"key": api_key},
                    json=payload,
                )
            if resp.status_code != 200:
                print(f"[Campbell] 错误: HTTP {resp.status_code} - {resp.text[:500]}")
                return None, f"Campbell 请求失败: {resp.status_code}"
            return resp.json(), None
        except httpx.TimeoutException:
            return None, "Campbell 请求超时"
        except Exception as exc:
            print(f"[Campbell] 异常: {type(exc).__name__}: {exc}")
            return None, f"Campbell 请求失败: {exc}"

    def _execute_tool_call(
        self,
        tool_call: dict,
        assistant_message_id: str = None,
        user_id: str = None,
        session_id: str = None,
        current_user_images: list[str] = None,
        current_user_message_id: str = None,
        tool_call_index: int = 1,
    ) -> Generator[dict, None, dict]:
        name = tool_call.get("name", "")
        arguments = tool_call.get("arguments") or {}
        print(f"[Campbell] tool_call: {name}({json.dumps(arguments, ensure_ascii=False)[:300]})")

        if name == "web_search":
            query = str(arguments.get("query", "")).strip()
            if not query:
                return {
                    "functionResponse": {
                        "name": name,
                        "response": {
                            "query": "",
                            "result": "",
                            "success": False,
                            "error": "缺少搜索关键词",
                        },
                    }
                }
            yield {
                "type": "search_start",
                "message_id": assistant_message_id,
                "query": query,
            }
            result = ""
            for chunk in self.search.search_stream(query):
                if chunk["type"] == "search_done":
                    result = chunk["result"]
            success = bool(result and not result.startswith("搜索失败"))
            yield {
                "type": "search_end",
                "message_id": assistant_message_id,
                "query": query,
                "success": success,
            }
            return {
                "functionResponse": {
                    "name": name,
                    "response": {
                        "query": query,
                        "result": result or "",
                        "success": success,
                    },
                }
            }

        if name == "generate_image":
            prompt = self.image.build_request_prompt(arguments) or "正在生成图片"
            request = self.image._normalize_image_request(arguments)
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id or "assistant", tool_call_index)
            yield {
                "type": "image_gen_start",
                "message_id": assistant_message_id,
                "prompt": prompt,
                "mode": "generate",
                "assetId": asset_id,
                "request": request,
            }
            result = self.image.generate(arguments, user_id=user_id, session_id=session_id)
            success = bool(result.get("success") and result.get("image"))
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": result.get("prompt") or prompt,
                "mode": "generate",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "request": request,
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
            }
            return {
                "functionResponse": {
                    "name": name,
                    "response": {
                        "status": "ok" if success else "error",
                        "tool": "generate_image",
                        "mode": "generate",
                        "assetId": asset_id,
                        "prompt": result.get("prompt") or prompt,
                        "url": result.get("image", ""),
                        "outputWidth": result.get("output_width"),
                        "outputHeight": result.get("output_height"),
                        "outputAspectRatio": result.get("output_aspect_ratio"),
                        "message": (
                            "The image was successfully generated and already shown to the user."
                            if success else (result.get("error") or "图片生成失败，请稍后重试。")
                        ),
                        "error": result.get("error", ""),
                    },
                }
            }

        if name == "edit_image":
            prompt = self.image.build_edit_prompt(arguments) or "正在编辑图片"
            request = self.image._normalize_image_edit_request(arguments)
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id or "assistant", tool_call_index)
            yield {
                "type": "image_gen_start",
                "message_id": assistant_message_id,
                "prompt": prompt,
                "mode": "edit",
                "assetId": asset_id,
                "editRequest": request,
            }
            result = self.image.edit(
                arguments,
                user_id=user_id,
                session_id=session_id,
                current_user_image_urls=current_user_images or [],
                current_user_message_id=current_user_message_id,
            )
            success = bool(result.get("success") and result.get("image"))
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": result.get("prompt") or prompt,
                "mode": "edit",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "editRequest": request,
                "resolvedEditRequest": result.get("resolved_edit_request"),
                "sourceImageId": result.get("source_image_id"),
                "sourceImageUrl": result.get("source_image_url"),
                "sourceLabel": result.get("source_label"),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
            }
            return {
                "functionResponse": {
                    "name": name,
                    "response": {
                        "status": "ok" if success else "error",
                        "tool": "edit_image",
                        "mode": "edit",
                        "assetId": asset_id,
                        "prompt": result.get("prompt") or prompt,
                        "url": result.get("image", ""),
                        "source_image_id": result.get("source_image_id", ""),
                        "source_label": result.get("source_label", ""),
                        "resolvedEditRequest": result.get("resolved_edit_request"),
                        "outputWidth": result.get("output_width"),
                        "outputHeight": result.get("output_height"),
                        "outputAspectRatio": result.get("output_aspect_ratio"),
                        "message": (
                            "The image was successfully edited and already shown to the user."
                            if success else (result.get("error") or "图片编辑失败，请稍后重试。")
                        ),
                        "error": result.get("error", ""),
                    },
                }
            }

        return {
            "functionResponse": {
                "name": name,
                "response": {
                    "success": False,
                    "error": f"不支持的工具: {name}",
                },
            }
        }

    def _extract_system_prompt(self, messages: list) -> str:
        if messages and messages[0].get("role") == "system":
            return str(messages[0].get("content") or "")
        return ""

    def _convert_messages_to_contents(self, messages: list) -> list:
        contents = []
        for message in messages:
            role = message.get("role")
            if role == "system":
                continue
            mapped_role = "model" if role == "assistant" else "user"
            parts = self._convert_content_to_parts(message.get("content"))
            if parts:
                contents.append({"role": mapped_role, "parts": parts})
        return contents

    def _convert_content_to_parts(self, content) -> list:
        if isinstance(content, str):
            return [{"text": content}] if content else []

        if not isinstance(content, list):
            return [{"text": str(content)}] if content else []

        parts = []
        for item in content:
            item_type = item.get("type")
            if item_type == "text":
                text = item.get("text") or ""
                if text:
                    parts.append({"text": text})
            elif item_type == "image_url":
                image_url = ((item.get("image_url") or {}).get("url") or "").strip()
                image_part = self._download_image_as_inline_part(image_url)
                if image_part:
                    parts.append(image_part)
        return parts

    def _download_image_as_inline_part(self, image_url: str) -> dict | None:
        if not image_url:
            return None
        try:
            with httpx.Client(timeout=self.image_fetch_timeout) as client:
                resp = client.get(image_url)
            if resp.status_code != 200:
                print(f"[Campbell] 图片下载失败: {resp.status_code} {image_url}")
                return None
            mime_type = (resp.headers.get("content-type") or "").split(";", 1)[0]
            if not mime_type.startswith("image/"):
                mime_type = mimetypes.guess_type(image_url)[0] or "image/png"
            return {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": base64.b64encode(resp.content).decode("utf-8"),
                }
            }
        except Exception as exc:
            print(f"[Campbell] 图片下载异常: {type(exc).__name__}: {exc}")
            return None

    def _parse_function_call(self, function_call: dict) -> dict:
        raw_args = function_call.get("args", {})
        if isinstance(raw_args, str):
            try:
                raw_args = json.loads(raw_args)
            except json.JSONDecodeError:
                raw_args = {}
        if not isinstance(raw_args, dict):
            raw_args = {}
        return {
            "name": function_call.get("name", ""),
            "arguments": raw_args,
        }

    def _build_generate_url(self, base_url: str, model: str) -> str:
        stripped = base_url.rstrip("/")
        if stripped.endswith("/v1"):
            stripped = stripped[:-3]
        return f"{stripped}/v1beta/models/{model}:generateContent"
