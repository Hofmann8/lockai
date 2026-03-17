"""
AI Service - 主服务入口
整合 LLM、搜索、图像生成等功能
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Generator

from models import db, ChatMessage, ChatSession, GeneratedImage, sanitize_assistant_content, strip_assistant_reasoning

from .campbell import CampbellService
from .image import ImageService
from .llm import LLMService
from .prompts import get_system_prompt
from .search import SearchService
from .storage import StorageService
from .tool_contracts import CHAT_TOOLS
from .title import TitleService


TOOLS = CHAT_TOOLS

TOOL_MARKER_RE = re.compile(r"<!--tool:\d+-->")


class AIService:
    """AI 服务主入口。"""

    def __init__(self):
        self.llm = LLMService()
        self.storage = StorageService()
        self.search = SearchService(self.llm)
        self.image = ImageService(self.llm, self.storage)
        self.campbell = CampbellService(self.llm, self.search, self.image)
        self.title = TitleService(self.llm)
        self.max_tool_rounds = max(1, int(self._safe_env("CHAT_TOOL_MAX_ROUNDS", "6")))

    @property
    def _s3_client(self):
        return self.storage._client

    def available_models(self) -> list[dict[str, Any]]:
        result = []
        for cfg in self.llm.get_chat_models():
            result.append({
                "id": cfg["id"],
                "name": cfg.get("name", cfg["id"]),
                "description": cfg.get("description", ""),
                "available": cfg.get("available", True),
                "is_default": cfg.get("is_default", False),
                "thinking_mode": cfg.get("thinking_mode", "never"),
                "default_thinking": cfg.get("default_thinking", False),
                "tags": cfg.get("tags", []),
            })
        return result

    def get_default_model_id(self) -> str:
        return self.llm.get_default_chat_model_id()

    def normalize_chat_model_id(self, model_id: str | None = None) -> str:
        return self.llm.normalize_chat_model_id(model_id)

    def generate_title(self, user_message: str, assistant_message: str = "") -> str:
        return self.title.generate(user_message)

    def chat_stream(
        self,
        message: str,
        history: list | None = None,
        model_id: str | None = None,
        user_id: str | None = None,
        session_id: str | None = None,
        images: list | None = None,
        thinking: bool | None = None,
        current_message_id: str | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        model_id = self.normalize_chat_model_id(model_id)
        cfg = self.llm.get_model_config(model_id)
        session = ChatSession.query.get(session_id) if session_id else None
        if session_id and not session:
            yield {"type": "error", "message": "会话不存在"}
            return
        if session and session.model_id != model_id:
            session.model_id = model_id
            session.updated_at = datetime.utcnow()
            db.session.commit()

        effective_thinking = self._resolve_thinking(cfg, thinking)
        assistant_message_id = str(uuid.uuid4())
        yield {"type": "message_start", "message_id": assistant_message_id}

        content_parts: list[str] = []
        tool_trace: list[dict[str, Any]] = []
        llm_messages = self._build_messages(
            message=message,
            history=history or [],
            model_id=model_id,
            session_id=session_id,
            images=images or [],
            current_user_message_id=current_message_id,
        )

        try:
            if self._should_stream_chat(cfg):
                completed = yield from self._chat_with_stream(
                    llm_messages=llm_messages,
                    model_id=model_id,
                    effective_thinking=effective_thinking,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=images or [],
                    current_user_message_id=current_message_id,
                    tool_trace=tool_trace,
                    content_parts=content_parts,
                )
            else:
                completed = yield from self._chat_with_complete(
                    llm_messages=llm_messages,
                    model_id=model_id,
                    effective_thinking=effective_thinking,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=images or [],
                    current_user_message_id=current_message_id,
                    tool_trace=tool_trace,
                    content_parts=content_parts,
                )
            if completed is False:
                return

            self._save_assistant_message(
                assistant_message_id=assistant_message_id,
                session=session,
                content="".join(content_parts),
                tool_trace=tool_trace,
            )

            yield {"type": "message_end", "message_id": assistant_message_id}

            if session and session.title == "新对话":
                title = self.title.generate(message)
                if title:
                    session.title = title
                    session.updated_at = datetime.utcnow()
                    db.session.commit()
                    yield {"type": "title_update", "title": title}
        except Exception as exc:
            print(f"[Chat] 异常: {type(exc).__name__}: {exc}")
            db.session.rollback()
            yield {"type": "error", "message": f"聊天失败: {exc}"}

    def _should_stream_chat(self, cfg: dict[str, Any]) -> bool:
        return self.llm.resolve_chat_transport(cfg).startswith("qwen")

    def _should_use_native_gemini_tools(self, cfg: dict[str, Any]) -> bool:
        provider = str(cfg.get("provider") or "").strip().lower()
        model_name = str(cfg.get("model") or "").strip().lower()
        return provider.startswith("gemini") or (provider == "openai-compatible" and "gemini" in model_name)

    def _chat_with_stream(
        self,
        *,
        llm_messages: list[dict[str, Any]],
        model_id: str,
        effective_thinking: bool,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
    ) -> Generator[dict[str, Any], None, None]:
        for _round in range(self.max_tool_rounds):
            round_content = ""
            parsed_calls = []
            tool_call_accumulators: dict[int, dict[str, Any]] = {}

            for chunk in self.llm.stream_chat_completion(
                llm_messages,
                model=model_id,
                tools=TOOLS,
                enable_thinking=effective_thinking,
            ):
                if chunk.get("type") == "error":
                    yield {"type": "error", "message": chunk.get("content", "请求失败")}
                    return False

                delta = chunk.get("delta") or {}
                content = delta.get("content") or ""
                if content:
                    round_content += content
                    content_parts.append(content)
                    yield {"type": "content_delta", "delta": content}

                for tc_delta in delta.get("tool_calls") or []:
                    idx = int(tc_delta.get("index", 0))
                    if idx not in tool_call_accumulators:
                        tool_call_accumulators[idx] = {
                            "id": tc_delta.get("id") or str(uuid.uuid4()),
                            "name": "",
                            "arguments": "",
                        }
                    accumulator = tool_call_accumulators[idx]
                    if tc_delta.get("id"):
                        accumulator["id"] = tc_delta["id"]
                    fn = tc_delta.get("function") or {}
                    if fn.get("name"):
                        accumulator["name"] = fn["name"]
                    if fn.get("arguments"):
                        accumulator["arguments"] += fn["arguments"]

            for idx in sorted(tool_call_accumulators.keys()):
                call = tool_call_accumulators[idx]
                try:
                    arguments = json.loads(call["arguments"]) if call["arguments"] else {}
                except (TypeError, ValueError, json.JSONDecodeError):
                    arguments = {}
                if not isinstance(arguments, dict):
                    arguments = {}
                parsed_calls.append({
                    "id": call["id"],
                    "name": call["name"],
                    "arguments": arguments,
                })

            if not parsed_calls:
                return True

            llm_messages.append({
                "role": "assistant",
                "content": round_content or None,
                "tool_calls": self._build_tool_calls_for_history(parsed_calls),
            })

            for call in parsed_calls:
                yield from self._yield_tool_call_events(
                    call=call,
                    tool_trace=tool_trace,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=current_user_images,
                    current_user_message_id=current_user_message_id,
                    llm_messages=llm_messages,
                    content_parts=content_parts,
                )

        limit_text = "\n\n工具调用轮数已达上限。"
        content_parts.append(limit_text)
        yield {"type": "content_delta", "delta": limit_text}
        return True

    def _chat_with_complete(
        self,
        *,
        llm_messages: list[dict[str, Any]],
        model_id: str,
        effective_thinking: bool,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
    ) -> Generator[dict[str, Any], None, None]:
        runtime = self.llm.provider_runtime.build_state(
            messages=llm_messages,
            model_id=model_id,
            tools=TOOLS,
            enable_thinking=effective_thinking,
        )
        if not runtime:
            yield {"type": "error", "message": "API 密钥未配置"}
            return False

        print(f"[Chat] runtime transport: {runtime.get('kind')} model={model_id}")

        for _round in range(self.max_tool_rounds):
            response = self.llm.provider_runtime.request_turn(runtime)
            if response is None:
                yield {"type": "error", "message": "请求失败"}
                return False

            content_text = strip_assistant_reasoning(response.get("content") or "")
            parsed_calls = response.get("tool_calls") or []

            if content_text:
                content_parts.append(content_text)
                yield {"type": "content_delta", "delta": content_text}

            if not parsed_calls:
                if not content_text.strip():
                    yield {"type": "error", "message": "模型返回空响应，请重试"}
                    return False
                return True

            self.llm.provider_runtime.append_assistant_history(
                runtime,
                response.get("assistant_history_item"),
                parsed_calls=parsed_calls,
                content_text=content_text,
            )

            tool_results: list[dict[str, Any]] = []
            for call in parsed_calls:
                tool_content = yield from self._stream_tool_call_result(
                    call=call,
                    tool_trace=tool_trace,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=current_user_images,
                    current_user_message_id=current_user_message_id,
                    content_parts=content_parts,
                )
                tool_results.append({
                    "id": call["id"],
                    "name": call["name"],
                    "content": tool_content,
                })

            self.llm.provider_runtime.append_tool_results(runtime, tool_results)

        limit_text = "\n\n工具调用轮数已达上限。"
        content_parts.append(limit_text)
        yield {"type": "content_delta", "delta": limit_text}
        return True

    def _chat_with_campbell_native(
        self,
        *,
        llm_messages: list[dict[str, Any]],
        model_id: str,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
    ) -> Generator[dict[str, Any], None, None]:
        for event in self.campbell.chat_stream(
            llm_messages,
            model_id=model_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
            assistant_message_id=assistant_message_id,
        ):
            event_type = str(event.get("type") or "")
            if event_type == "error":
                yield {"type": "error", "message": event.get("message") or "请求失败"}
                return False

            if event_type == "content_delta":
                delta = str(event.get("delta") or "")
                if delta:
                    content_parts.append(delta)
                    yield {"type": "content_delta", "delta": delta}
                continue

            if event_type == "search_start":
                query = str(event.get("query") or "").strip()
                tool_trace.append({
                    "kind": "search",
                    "query": query,
                    "status": "running",
                })
                content_parts.append(f"<!--tool:{len(tool_trace) - 1}-->")
                yield {
                    "type": "search_start",
                    "message_id": assistant_message_id,
                    "query": query,
                }
                continue

            if event_type == "search_end":
                query = str(event.get("query") or "").strip()
                success = bool(event.get("success"))
                for item in reversed(tool_trace):
                    if item.get("kind") == "search" and item.get("status") == "running":
                        item["status"] = "done"
                        item["success"] = success
                        item["query"] = query or item.get("query", "")
                        break
                yield {
                    "type": "search_end",
                    "message_id": assistant_message_id,
                    "query": query,
                    "success": success,
                }
                continue

            if event_type == "image_gen_start":
                trace = {
                    "kind": "image_gen",
                    "assetId": event.get("assetId"),
                    "mode": event.get("mode"),
                    "prompt": event.get("prompt") or "",
                    "status": "running",
                }
                if event.get("request"):
                    trace["request"] = event["request"]
                if event.get("editRequest"):
                    trace["editRequest"] = event["editRequest"]
                tool_trace.append(trace)
                content_parts.append(f"<!--tool:{len(tool_trace) - 1}-->")
                yield {
                    "type": "image_gen_start",
                    "message_id": assistant_message_id,
                    "prompt": event.get("prompt") or "",
                    "mode": event.get("mode"),
                    "assetId": event.get("assetId"),
                    "request": event.get("request"),
                    "editRequest": event.get("editRequest"),
                }
                continue

            if event_type == "image_gen_end":
                success = bool(event.get("success"))
                for item in reversed(tool_trace):
                    if item.get("kind") == "image_gen" and item.get("status") == "running":
                        item["status"] = "done"
                        item["success"] = success
                        item["prompt"] = event.get("prompt") or item.get("prompt", "")
                        item["mode"] = event.get("mode") or item.get("mode")
                        if event.get("url"):
                            item["url"] = event["url"]
                        if event.get("request"):
                            item["request"] = event["request"]
                        if event.get("editRequest"):
                            item["editRequest"] = event["editRequest"]
                        if event.get("sourceImageId"):
                            item["sourceImageId"] = event["sourceImageId"]
                        if event.get("sourceImageUrl"):
                            item["sourceImageUrl"] = event["sourceImageUrl"]
                        if event.get("sourceLabel"):
                            item["sourceLabel"] = event["sourceLabel"]
                        if event.get("resolvedEditRequest"):
                            item["resolvedEditRequest"] = event["resolvedEditRequest"]
                        if event.get("assetId"):
                            item["assetId"] = event["assetId"]
                        if event.get("outputWidth"):
                            item["outputWidth"] = event["outputWidth"]
                        if event.get("outputHeight"):
                            item["outputHeight"] = event["outputHeight"]
                        if event.get("outputAspectRatio"):
                            item["outputAspectRatio"] = event["outputAspectRatio"]
                        break
                yield {
                    "type": "image_gen_end",
                    "message_id": assistant_message_id,
                    "prompt": event.get("prompt") or "",
                    "mode": event.get("mode"),
                    "success": success,
                    "assetId": event.get("assetId"),
                    "url": event.get("url"),
                    "request": event.get("request"),
                    "editRequest": event.get("editRequest"),
                    "resolvedEditRequest": event.get("resolvedEditRequest"),
                    "sourceImageId": event.get("sourceImageId"),
                    "sourceImageUrl": event.get("sourceImageUrl"),
                    "sourceLabel": event.get("sourceLabel"),
                    "outputWidth": event.get("outputWidth"),
                    "outputHeight": event.get("outputHeight"),
                    "outputAspectRatio": event.get("outputAspectRatio"),
                }
                continue

        return True

    def _yield_tool_call_events(
        self,
        *,
        call: dict[str, Any],
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        llm_messages: list[dict[str, Any]],
        content_parts: list[str],
    ) -> Generator[dict[str, Any], None, None]:
        tool_response = self._execute_tool_call(
            call,
            tool_trace=tool_trace,
            assistant_message_id=assistant_message_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
        )
        while True:
            try:
                event = next(tool_response)
                if isinstance(event, dict):
                    marker = event.pop("_append_marker", False)
                    if marker:
                        content_parts.append(f"<!--tool:{len(tool_trace) - 1}-->")
                    yield event
            except StopIteration as stop:
                llm_messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": stop.value or "工具执行完成",
                })
                return

    def _stream_tool_call_result(
        self,
        *,
        call: dict[str, Any],
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        content_parts: list[str],
    ) -> Generator[dict[str, Any], None, str]:
        tool_response = self._execute_tool_call(
            call,
            tool_trace=tool_trace,
            assistant_message_id=assistant_message_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
        )
        while True:
            try:
                event = next(tool_response)
                if not isinstance(event, dict):
                    continue
                marker = event.pop("_append_marker", False)
                if marker:
                    content_parts.append(f"<!--tool:{len(tool_trace) - 1}-->")
                yield event
            except StopIteration as stop:
                return stop.value or "工具执行完成"

    def paper_assist(self, text: str, action: str) -> dict:
        prompts = {
            "explain": f"请详细解释以下学术内容，使用通俗易懂的语言：\n\n{text}",
            "summarize": f"请简洁地总结以下内容的要点：\n\n{text}",
            "translate": f"请将以下内容翻译成中文（如果已是中文则翻译成英文）：\n\n{text}",
        }

        prompt = prompts.get(action)
        if not prompt:
            return {"error": "无效的操作类型", "code": "INVALID_REQUEST"}

        messages = [
            {"role": "system", "content": "你是一个学术助手，帮助用户理解和处理学术论文内容。"},
            {"role": "user", "content": prompt},
        ]

        result = ""
        for chunk in self.llm.stream(messages):
            if chunk["type"] == "error":
                return {"error": chunk["content"], "code": "API_ERROR"}
            if chunk["type"] == "content":
                result += chunk["content"]

        return {"result": strip_assistant_reasoning(result)}

    def _execute_tool_call(
        self,
        call: dict[str, Any],
        *,
        tool_trace: list[dict[str, Any]],
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
    ):
        name = str(call.get("name") or "").strip()
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        print(f"[Chat] tool_call: {name}({json.dumps(arguments, ensure_ascii=False)[:300]})")

        if name == "web_search":
            query = str(arguments.get("query") or "").strip()
            trace = {"kind": "search", "query": query, "status": "running"}
            tool_trace.append(trace)
            yield {
                "_append_marker": True,
                "type": "search_start",
                "message_id": assistant_message_id,
                "query": query,
            }
            result = self.search.search(query) if query else ""
            trace["status"] = "done"
            trace["success"] = bool(result and not result.startswith("搜索失败"))
            yield {
                "type": "search_end",
                "message_id": assistant_message_id,
                "query": query,
                "success": trace["success"],
            }
            return result or "搜索失败，请基于已有知识继续回答。"

        if name == "generate_image":
            request = self.image._normalize_image_request(arguments)
            prompt = self.image.build_request_prompt(arguments) or request.get("subject") or "生成图片"
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id, len(tool_trace) + 1)
            trace = {
                "kind": "image_gen",
                "assetId": asset_id,
                "mode": "generate",
                "prompt": prompt,
                "status": "running",
                "request": request,
            }
            tool_trace.append(trace)
            yield {
                "_append_marker": True,
                "type": "image_gen_start",
                "message_id": assistant_message_id,
                "prompt": prompt,
                "mode": "generate",
                "assetId": asset_id,
                "request": request,
            }
            result = self.image.generate(arguments, user_id=user_id, session_id=session_id)
            success = bool(result.get("success") and result.get("image"))
            trace["status"] = "done"
            trace["success"] = success
            trace["url"] = result.get("image")
            trace["assetId"] = asset_id
            if success and result.get("prompt"):
                trace["prompt"] = result["prompt"]
            if result.get("output_width"):
                trace["outputWidth"] = result["output_width"]
            if result.get("output_height"):
                trace["outputHeight"] = result["output_height"]
            if result.get("output_aspect_ratio"):
                trace["outputAspectRatio"] = result["output_aspect_ratio"]
            if success and result.get("image"):
                self._save_generated_image(
                    result=result,
                    user_id=user_id,
                    session_id=session_id,
                    assistant_message_id=assistant_message_id,
                )
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": trace["prompt"],
                "mode": "generate",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "request": request,
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
            }
            return json.dumps({
                "status": "ok" if success else "error",
                "tool": "generate_image",
                "mode": "generate",
                "assetId": asset_id,
                "prompt": trace["prompt"],
                "url": result.get("image", ""),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "message": (
                    "The image was successfully generated and already shown to the user."
                    if success else (result.get("error") or "图片生成失败，请稍后重试。")
                ),
                "error": "" if success else (result.get("error") or "图片生成失败，请稍后重试。"),
            }, ensure_ascii=False)

        if name == "edit_image":
            request = self.image._normalize_image_edit_request(arguments)
            prompt = self.image.build_edit_prompt(arguments) or request.get("instruction") or "编辑图片"
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id, len(tool_trace) + 1)
            trace = {
                "kind": "image_gen",
                "assetId": asset_id,
                "mode": "edit",
                "prompt": prompt,
                "status": "running",
                "editRequest": request,
            }
            tool_trace.append(trace)
            yield {
                "_append_marker": True,
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
                current_user_image_urls=current_user_images,
                current_user_message_id=current_user_message_id,
            )
            success = bool(result.get("success") and result.get("image"))
            trace["status"] = "done"
            trace["success"] = success
            trace["url"] = result.get("image")
            trace["assetId"] = asset_id
            if result.get("source_image_id"):
                trace["sourceImageId"] = result["source_image_id"]
            if result.get("source_image_url"):
                trace["sourceImageUrl"] = result["source_image_url"]
            if result.get("source_label"):
                trace["sourceLabel"] = result["source_label"]
            if success and result.get("prompt"):
                trace["prompt"] = result["prompt"]
            if result.get("resolved_edit_request"):
                trace["resolvedEditRequest"] = result["resolved_edit_request"]
            if result.get("output_width"):
                trace["outputWidth"] = result["output_width"]
            if result.get("output_height"):
                trace["outputHeight"] = result["output_height"]
            if result.get("output_aspect_ratio"):
                trace["outputAspectRatio"] = result["output_aspect_ratio"]
            if success and result.get("image"):
                self._save_generated_image(
                    result=result,
                    user_id=user_id,
                    session_id=session_id,
                    assistant_message_id=assistant_message_id,
                )
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": trace["prompt"],
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
            return json.dumps({
                "status": "ok" if success else "error",
                "tool": "edit_image",
                "mode": "edit",
                "assetId": asset_id,
                "prompt": trace["prompt"],
                "url": result.get("image", ""),
                "sourceImageId": result.get("source_image_id"),
                "sourceLabel": result.get("source_label"),
                "resolvedEditRequest": result.get("resolved_edit_request"),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "message": (
                    "The image was successfully edited and already shown to the user."
                    if success else (result.get("error") or "图片编辑失败，请稍后重试。")
                ),
                "error": "" if success else (result.get("error") or "图片编辑失败，请稍后重试。"),
            }, ensure_ascii=False)

        return "不支持的工具调用。"

    def _build_messages(
        self,
        *,
        message: str,
        history: list[dict[str, Any]],
        model_id: str,
        session_id: str | None,
        images: list[str],
        current_user_message_id: str | None,
    ) -> list[dict[str, Any]]:
        cfg = self.llm.get_model_config(model_id)
        prompt_id = str(cfg.get("prompt_id") or model_id)
        system_prompt = get_system_prompt(prompt_id)
        asset_catalog = self.image.build_asset_catalog_message(
            session_id,
            images,
            current_user_message_id=current_user_message_id,
        )
        if asset_catalog:
            system_prompt = f"{system_prompt}\n\n{asset_catalog}"

        messages = [{"role": "system", "content": system_prompt}]
        for item in history:
            role = "assistant" if item.get("role") == "assistant" else "user"
            item_images = item.get("images") or []
            tool_trace = item.get("tool_trace") if isinstance(item.get("tool_trace"), list) else []
            if role == "user" and item_images:
                parts = [{"type": "text", "text": item.get("content", "")}]
                for image_url in item_images:
                    if image_url:
                        parts.append({"type": "image_url", "image_url": {"url": image_url}})
                messages.append({"role": "user", "content": parts})
            elif role == "assistant":
                assistant_content = self._strip_tool_markers(str(item.get("content") or ""))
                tool_summary = self._format_tool_trace_summary(tool_trace)
                if tool_summary:
                    assistant_content = (
                        f"{assistant_content}\n\n[工具执行记录]\n{tool_summary}".strip()
                        if assistant_content
                        else f"[工具执行记录]\n{tool_summary}"
                    )
                if assistant_content:
                    messages.append({"role": "assistant", "content": assistant_content})
            else:
                messages.append({"role": role, "content": item.get("content", "")})

        if images:
            parts = [{"type": "text", "text": message}]
            for image_url in images:
                if image_url:
                    parts.append({"type": "image_url", "image_url": {"url": image_url}})
            messages.append({"role": "user", "content": parts})
        else:
            messages.append({"role": "user", "content": message})
        return messages

    def _strip_tool_markers(self, content: str) -> str:
        return TOOL_MARKER_RE.sub("", content or "").strip()

    def _format_tool_trace_summary(self, tool_trace: list[dict[str, Any]]) -> str:
        if not tool_trace:
            return ""

        lines: list[str] = []
        for item in tool_trace:
            kind = item.get("kind")
            status = "成功" if item.get("success", item.get("status") == "done") else "失败"

            if kind == "search":
                query = str(item.get("query") or "").strip()
                summary = f"- web_search(query={json.dumps(query, ensure_ascii=False)}): {status}"
                lines.append(summary)
                continue

            if kind == "image_gen":
                mode = "edit_image" if item.get("mode") == "edit" else "generate_image"
                prompt = str(item.get("prompt") or "").strip()
                extra = []
                if item.get("sourceImageId"):
                    extra.append(f"sourceImageId={item['sourceImageId']}")
                if item.get("assetId"):
                    extra.append(f"assetId={item['assetId']}")
                if item.get("outputAspectRatio"):
                    extra.append(f"outputAspectRatio={item['outputAspectRatio']}")
                if item.get("url"):
                    extra.append("image_ready=true")
                suffix = f" ({', '.join(extra)})" if extra else ""
                lines.append(f"- {mode}(prompt={json.dumps(prompt, ensure_ascii=False)}): {status}{suffix}")

        return "\n".join(lines)

    def _build_tool_calls_for_history(self, parsed_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        tool_calls = []
        for call in parsed_calls:
            tool_calls.append({
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call["arguments"], ensure_ascii=False),
                },
            })
        return tool_calls

    def _resolve_thinking(self, cfg: dict[str, Any], thinking: bool | None) -> bool:
        mode = str(cfg.get("thinking_mode") or "never")
        if mode == "always":
            return True
        if mode == "optional":
            if thinking is None:
                return bool(cfg.get("default_thinking", False))
            return bool(thinking)
        return False

    def _save_assistant_message(
        self,
        *,
        assistant_message_id: str,
        session: ChatSession | None,
        content: str,
        tool_trace: list[dict[str, Any]],
    ) -> None:
        if not session:
            return

        stored_content = sanitize_assistant_content(content, tool_trace)
        assistant_message = ChatMessage(
            id=assistant_message_id,
            session_id=session.id,
            role="assistant",
            content=stored_content,
            tool_trace=json.dumps(tool_trace, ensure_ascii=False) if tool_trace else None,
        )
        db.session.add(assistant_message)
        session.updated_at = datetime.utcnow()
        db.session.commit()

    def _save_generated_image(
        self,
        *,
        result: dict[str, Any],
        user_id: str | None,
        session_id: str | None,
        assistant_message_id: str,
    ) -> None:
        if not user_id or not session_id or not result.get("s3_key") or not result.get("image"):
            return

        image_record = GeneratedImage(
            id=result.get("image_id", uuid.uuid4().hex),
            user_id=user_id,
            session_id=session_id,
            message_id=assistant_message_id,
            prompt=result.get("prompt"),
            s3_key=result["s3_key"],
            url=result["image"],
        )
        db.session.add(image_record)
        db.session.commit()

    def _safe_env(self, name: str, default: str) -> int:
        try:
            return int(os.environ.get(name, default))
        except Exception:
            return int(default)
