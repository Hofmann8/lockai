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

from models import (
    db,
    ChatMessage,
    ChatSession,
    GeneratedImage,
    sanitize_assistant_content,
    strip_assistant_reasoning,
)

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
        self.title = TitleService(self.llm)
        from .usage import UsageService
        self.usage = UsageService()
        self.max_tool_rounds = max(1, int(self._safe_env("CHAT_TOOL_MAX_ROUNDS", "6")))

    @property
    def _s3_client(self):
        return self.storage._client

    def available_models(self) -> list[dict[str, Any]]:
        result = []
        for cfg in self.llm.get_chat_models():
            transport = str(cfg.get("transport") or cfg.get("provider") or "").lower()
            result.append({
                "id": cfg["id"],
                "name": cfg.get("name", cfg["id"]),
                "description": cfg.get("description", ""),
                "available": cfg.get("available", True),
                "is_default": cfg.get("is_default", False),
                "thinking_mode": cfg.get("thinking_mode", "never"),
                "default_thinking": cfg.get("default_thinking", False),
                "tags": cfg.get("tags", []),
                "supports_reasoning_effort": transport.startswith("deepseek") or transport.startswith("anthropic"),
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
        reasoning_effort: str | None = None,
        current_message_id: str | None = None,
        image_quality: str | None = None,
    ) -> Generator[dict[str, Any], None, None]:
        requested_model_id = self.normalize_chat_model_id(model_id)
        runtime_model_id = requested_model_id
        session = ChatSession.query.get(session_id) if session_id else None
        if session_id and not session:
            yield {"type": "error", "message": "会话不存在"}
            return
        if session and session.model_id != requested_model_id:
            session.model_id = requested_model_id
            session.updated_at = datetime.utcnow()
            db.session.commit()

        cfg = self.llm.get_model_config(runtime_model_id)

        effective_thinking = self._resolve_thinking(cfg, thinking)
        hd_image = str(image_quality or "").strip().lower() == "hd"
        assistant_message_id = str(uuid.uuid4())

        if self._is_billable_chat(cfg) and user_id:
            ok, scope, quota_msg = self.usage.check(user_id, self.usage.CHAT_COST)
            if not ok:
                yield {"type": "message_start", "message_id": assistant_message_id}
                yield {"type": "error", "code": f"quota_{scope}", "message": quota_msg}
                return

        yield {"type": "message_start", "message_id": assistant_message_id}

        content_parts: list[str] = []
        tool_trace: list[dict[str, Any]] = []
        llm_messages = self._build_messages(
            message=message,
            history=history or [],
            model_id=runtime_model_id,
            session_id=session_id,
            images=images or [],
            current_user_message_id=current_message_id,
        )
        llm_messages = self._preprocess_vision_if_blind(llm_messages, cfg)

        try:
            if self._should_stream_chat(cfg):
                completed = yield from self._chat_with_stream(
                    llm_messages=llm_messages,
                    model_id=runtime_model_id,
                    effective_thinking=effective_thinking,
                    reasoning_effort=reasoning_effort,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=images or [],
                    current_user_message_id=current_message_id,
                    tool_trace=tool_trace,
                    content_parts=content_parts,
                    hd_image=hd_image,
                )
            else:
                completed = yield from self._chat_with_complete(
                    llm_messages=llm_messages,
                    model_id=runtime_model_id,
                    effective_thinking=effective_thinking,
                    reasoning_effort=reasoning_effort,
                    assistant_message_id=assistant_message_id,
                    user_id=user_id,
                    session_id=session_id,
                    current_user_images=images or [],
                    current_user_message_id=current_message_id,
                    tool_trace=tool_trace,
                    content_parts=content_parts,
                    hd_image=hd_image,
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
        transport = str(cfg.get("transport") or cfg.get("provider") or "").strip().lower()
        if transport.startswith("anthropic"):
            return False
        return True

    def _is_billable_chat(self, cfg: dict[str, Any]) -> bool:
        """Campbell（anthropic-native）走计费；其他模型免费。"""
        transport = str(cfg.get("transport") or cfg.get("provider") or "").strip().lower()
        return transport.startswith("anthropic")

    def _chat_with_stream(
        self,
        *,
        llm_messages: list[dict[str, Any]],
        model_id: str,
        effective_thinking: bool,
        reasoning_effort: str | None,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
        hd_image: bool = False,
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
                reasoning_effort=reasoning_effort,
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
                    hd_image=hd_image,
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
        reasoning_effort: str | None,
        assistant_message_id: str,
        user_id: str | None,
        session_id: str | None,
        current_user_images: list[str],
        current_user_message_id: str | None,
        tool_trace: list[dict[str, Any]],
        content_parts: list[str],
        hd_image: bool = False,
    ) -> Generator[dict[str, Any], None, None]:
        runtime = self.llm.provider_runtime.build_state(
            messages=llm_messages,
            model_id=model_id,
            tools=TOOLS,
            enable_thinking=effective_thinking,
            reasoning_effort=reasoning_effort,
        )
        if not runtime:
            yield {"type": "error", "message": "API 密钥未配置"}
            return False

        print(f"[Chat] runtime transport: {runtime.get('kind')} model={model_id}")

        for _round in range(self.max_tool_rounds):
            if _round > 0 and user_id:
                ok, scope, quota_msg = self.usage.check(user_id, self.usage.CHAT_COST)
                if not ok:
                    yield {"type": "error", "code": f"quota_{scope}", "message": quota_msg}
                    return False

            response = self.llm.provider_runtime.request_turn(runtime)
            if response is None:
                yield {"type": "error", "message": "请求失败"}
                return False

            if user_id:
                try:
                    self.usage.record_chat_call(user_id)
                except Exception as exc:
                    print(f"[Usage] record_chat_call failed: {type(exc).__name__}: {exc}")

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
                    hd_image=hd_image,
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
        hd_image: bool = False,
    ) -> Generator[dict[str, Any], None, None]:
        tool_response = self._execute_tool_call(
            call,
            tool_trace=tool_trace,
            assistant_message_id=assistant_message_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
            hd_image=hd_image,
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
        hd_image: bool = False,
    ) -> Generator[dict[str, Any], None, str]:
        tool_response = self._execute_tool_call(
            call,
            tool_trace=tool_trace,
            assistant_message_id=assistant_message_id,
            user_id=user_id,
            session_id=session_id,
            current_user_images=current_user_images,
            current_user_message_id=current_user_message_id,
            hd_image=hd_image,
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
        hd_image: bool = False,
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
            current_model_label = self.image.model_label(hd_image)
            trace = {
                "kind": "image_gen",
                "assetId": asset_id,
                "mode": "generate",
                "prompt": prompt,
                "status": "running",
                "request": request,
                "modelLabel": current_model_label,
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
                "modelLabel": current_model_label,
            }
            if user_id:
                ok, _scope, quota_msg = self.usage.check(user_id, self.usage.IMAGE_COST)
                if not ok:
                    trace["status"] = "done"
                    trace["success"] = False
                    yield {
                        "type": "image_gen_end",
                        "message_id": assistant_message_id,
                        "prompt": prompt,
                        "mode": "generate",
                        "success": False,
                        "assetId": asset_id,
                        "request": request,
                        "modelLabel": current_model_label,
                        "error": quota_msg,
                    }
                    return json.dumps({
                        "status": "error",
                        "tool": "generate_image",
                        "mode": "generate",
                        "assetId": asset_id,
                        "message": quota_msg,
                        "assistantInstruction": "请用中文向用户说明 Campbell 出图额度已用完，建议明天/下月再试，或先用文字回答。不要再尝试调用 generate_image。",
                        "error": quota_msg,
                    }, ensure_ascii=False)
            result = self.image.generate(
                arguments,
                user_id=user_id,
                session_id=session_id,
                current_user_image_urls=current_user_images,
                current_user_message_id=current_user_message_id,
                hd=hd_image,
            )
            success = bool(result.get("success") and result.get("image"))
            trace["status"] = "done"
            trace["success"] = success
            trace["url"] = result.get("image")
            trace["blurredUrl"] = result.get("blurred_image")
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
                if user_id:
                    try:
                        self.usage.record_image_call(user_id)
                    except Exception as exc:
                        print(f"[Usage] record_image_call failed: {type(exc).__name__}: {exc}")
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": trace["prompt"],
                "mode": "generate",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "blurredUrl": result.get("blurred_image"),
                "request": request,
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "modelLabel": current_model_label,
            }
            error_message = result.get("error") or "图片生成失败，请稍后重试。"
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
                    "Image generated successfully and already shown to the user."
                    if success else error_message
                ),
                "assistantInstruction": (
                    "请用中文简短确认图片已生成完成，并提示用户可以继续提出修改要求；不要重复输出原始 URL。"
                    if success else "请用中文简短说明图片生成失败，并询问用户是否要重试或调整提示词。"
                ),
                "error": "" if success else error_message,
            }, ensure_ascii=False)

        if name == "edit_image":
            request = self.image._normalize_image_edit_request(arguments)
            prompt = self.image.build_edit_prompt(arguments) or request.get("instruction") or "编辑图片"
            asset_id = self.image.build_conversation_asset_id("latest_tool_image", assistant_message_id, len(tool_trace) + 1)
            current_model_label = self.image.model_label(hd_image)
            trace = {
                "kind": "image_gen",
                "assetId": asset_id,
                "mode": "edit",
                "prompt": prompt,
                "status": "running",
                "editRequest": request,
                "modelLabel": current_model_label,
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
                "modelLabel": current_model_label,
            }
            if user_id:
                ok, _scope, quota_msg = self.usage.check(user_id, self.usage.IMAGE_COST)
                if not ok:
                    trace["status"] = "done"
                    trace["success"] = False
                    yield {
                        "type": "image_gen_end",
                        "message_id": assistant_message_id,
                        "prompt": prompt,
                        "mode": "edit",
                        "success": False,
                        "assetId": asset_id,
                        "editRequest": request,
                        "modelLabel": current_model_label,
                        "error": quota_msg,
                    }
                    return json.dumps({
                        "status": "error",
                        "tool": "edit_image",
                        "mode": "edit",
                        "assetId": asset_id,
                        "message": quota_msg,
                        "assistantInstruction": "请用中文向用户说明 Campbell 出图额度已用完，建议明天/下月再试。不要再尝试调用 edit_image。",
                        "error": quota_msg,
                    }, ensure_ascii=False)
            result = self.image.edit(
                arguments,
                user_id=user_id,
                session_id=session_id,
                current_user_image_urls=current_user_images,
                current_user_message_id=current_user_message_id,
                hd=hd_image,
            )
            success = bool(result.get("success") and result.get("image"))
            trace["status"] = "done"
            trace["success"] = success
            trace["url"] = result.get("image")
            trace["blurredUrl"] = result.get("blurred_image")
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
                if user_id:
                    try:
                        self.usage.record_image_call(user_id)
                    except Exception as exc:
                        print(f"[Usage] record_image_call failed: {type(exc).__name__}: {exc}")
            yield {
                "type": "image_gen_end",
                "message_id": assistant_message_id,
                "prompt": trace["prompt"],
                "mode": "edit",
                "success": success,
                "assetId": asset_id,
                "url": result.get("image"),
                "blurredUrl": result.get("blurred_image"),
                "editRequest": request,
                "resolvedEditRequest": result.get("resolved_edit_request"),
                "sourceImageId": result.get("source_image_id"),
                "sourceImageUrl": result.get("source_image_url"),
                "sourceLabel": result.get("source_label"),
                "outputWidth": result.get("output_width"),
                "outputHeight": result.get("output_height"),
                "outputAspectRatio": result.get("output_aspect_ratio"),
                "modelLabel": current_model_label,
            }
            error_message = result.get("error") or "图片编辑失败，请稍后重试。"
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
                    "Image edited successfully and already shown to the user."
                    if success else error_message
                ),
                "assistantInstruction": (
                    "请用中文简短确认图片已编辑完成，并提示用户可以继续提出局部修改；不要重复输出原始 URL。"
                    if success else "请用中文简短说明图片编辑失败，并询问用户是否要重试或调整修改要求。"
                ),
                "error": "" if success else error_message,
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

    def _is_vision_blind_transport(self, cfg: dict[str, Any]) -> bool:
        transport = str(cfg.get("transport") or cfg.get("provider") or "").strip().lower()
        return transport.startswith("deepseek")

    def _preprocess_vision_if_blind(
        self,
        messages: list[dict[str, Any]],
        cfg: dict[str, Any],
    ) -> list[dict[str, Any]]:
        if not self._is_vision_blind_transport(cfg):
            return messages
        return self._describe_image_parts(messages)

    def _describe_image_parts(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        transformed: list[dict[str, Any]] = []
        cache: dict[str, str] = {}
        for msg in messages:
            content = msg.get("content")
            if not isinstance(content, list):
                transformed.append(msg)
                continue

            new_parts: list[dict[str, Any]] = []
            for part in content:
                if not isinstance(part, dict) or part.get("type") != "image_url":
                    new_parts.append(part)
                    continue
                image_url = str((part.get("image_url") or {}).get("url") or "").strip()
                if not image_url:
                    continue
                if image_url not in cache:
                    cache[image_url] = self._describe_single_image(image_url)
                new_parts.append({
                    "type": "text",
                    "text": f"[用户上传的图片，由视觉模型识别得到的描述]\n{cache[image_url]}",
                })
            transformed.append({**msg, "content": new_parts})
        return transformed

    def _describe_single_image(self, image_url: str) -> str:
        prompt = (
            "请用中文详细描述这张图片的内容，目标是让一个不支持视觉的语言模型能基于你的描述理解图片。"
            "请涵盖：主体/人物/物体、可见文字、布局结构、风格氛围、关键细节。"
            "直接输出描述，不要前缀。"
        )
        try:
            description = self.llm.complete(
                [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                }],
                model="image_describer",
            )
        except Exception as exc:
            print(f"[vision-preprocess] 描述失败: {type(exc).__name__}: {exc}")
            return "[图片识别失败，请基于用户的文字提问继续回答]"
        text = strip_assistant_reasoning(str(description or "")).strip()
        return text or "[图片识别失败，请基于用户的文字提问继续回答]"

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
