"""
图像生成与编辑服务

优先使用 Gemini 原生 generateContent 接口，
并兼容当前项目已有的 S3 上传与 SSE 协议。
"""

import base64
import json
import mimetypes
import os
import re
from math import gcd

import httpx

from .tool_contracts import (
    DEFAULT_IMAGE_ASPECT_RATIO,
    DEFAULT_IMAGE_SIZE,
    IMAGE_ASPECT_RATIOS,
    IMAGE_EDIT_SOURCE_SCOPES,
    IMAGE_PROMPT_FIELDS,
    IMAGE_SIZES,
)

IMAGE_GEN_TIMEOUT = httpx.Timeout(connect=10.0, read=180.0, write=10.0, pool=10.0)


class ImageService:
    """图像生成与编辑服务。"""

    def __init__(self, llm_service, storage_service):
        self.llm = llm_service
        self.storage = storage_service

    def _get_image_model_config(self) -> dict:
        return self.llm.get_model_config("image_generator")

    def build_request_prompt(self, request_or_prompt) -> str:
        request = self._normalize_image_request(request_or_prompt)
        return self._build_image_prompt(request)

    def build_edit_prompt(self, request_or_prompt) -> str:
        request = self._normalize_image_edit_request(request_or_prompt)
        return self._build_image_edit_prompt(request)

    def build_conversation_asset_id(self, origin: str, message_id: str | None, item_index: int) -> str:
        origin_code = {
            "current_upload": "cur",
            "latest_user_upload": "usr",
            "latest_tool_image": "tool",
        }.get(origin, "asset")
        return f"asset_{origin_code}_{self._short_ref(message_id or 'current')}_{item_index}"

    def generate(self, request_or_prompt, user_id: str = None, session_id: str = None) -> dict:
        """生成图片并上传到存储。"""
        image_request = self._normalize_image_request(request_or_prompt)
        prompt = self._build_image_prompt(image_request)
        if not prompt:
            return {"success": False, "error": "缺少绘图描述"}

        print(f"\n[Image] 绘图: {prompt[:80]}...")

        failures: list[str] = []
        for payload_variant in self._iter_generation_payloads(image_request, prompt):
            result, failure = self._request_image(payload_variant)
            if result:
                image_bytes, mime_type = result
                return self._finalize_image_result(
                    image_bytes=image_bytes,
                    mime_type=mime_type,
                    prompt=prompt,
                    user_id=user_id,
                    session_id=session_id,
                )
            if failure:
                failures.append(failure)

        return {
            "success": False,
            "error": self._build_image_failure_message(failures),
        }

    def edit(
        self,
        request_or_prompt,
        user_id: str = None,
        session_id: str = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
    ) -> dict:
        """编辑已有图片并上传到存储。"""
        edit_request = self._normalize_image_edit_request(request_or_prompt)
        if not self._build_image_edit_prompt(edit_request):
            return {"success": False, "error": "缺少图片编辑要求"}

        source_candidate, source_error = self._resolve_edit_source_candidate(
            session_id=session_id,
            edit_request=edit_request,
            current_user_image_urls=current_user_image_urls or [],
            current_user_message_id=current_user_message_id,
        )
        if not source_candidate:
            return {"success": False, "error": source_error or "没有找到可编辑的图片，请先上传或生成图片"}

        source_bytes, source_mime_type = self._download_source_image(source_candidate["url"])
        if not source_bytes:
            return {"success": False, "error": "源图片读取失败，请稍后重试"}
        source_metadata = self._inspect_image_bytes(source_bytes, source_mime_type)
        effective_request, resolved_edit_plan = self._resolve_effective_edit_request(
            edit_request,
            source_metadata,
            source_candidate=source_candidate,
        )
        prompt = self._build_image_edit_prompt(effective_request, source_metadata=source_metadata)
        if not prompt:
            return {"success": False, "error": "缺少图片编辑要求"}

        cfg = self._get_image_model_config()
        image_api_key = self._resolve_image_api_key(cfg)
        api_key = self._resolve_native_gemini_api_key(cfg, fallback_key=image_api_key)
        if not api_key:
            return {"success": False, "error": "API 密钥未配置"}

        payload = self._build_native_gemini_image_edit_payload(
            effective_request,
            source_bytes,
            source_mime_type,
            source_metadata=source_metadata,
        )
        if not payload:
            return {"success": False, "error": "图片编辑参数无效"}

        model_id = cfg["model"]
        url = self._build_native_gemini_image_url(self._resolve_native_gemini_api_base(cfg), model_id)

        print(f"\n[Image] 编辑图片: {prompt[:80]}...")

        try:
            with httpx.Client(timeout=IMAGE_GEN_TIMEOUT) as client:
                resp = client.post(
                    url,
                    headers={"Content-Type": "application/json"},
                    params={"key": api_key},
                    json=payload,
                )
            if resp.status_code != 200:
                error_text = self._format_http_error(resp)
                print(f"[Image] 编辑失败: {error_text}")
                return {"success": False, "error": f"图片编辑服务不可用：{error_text}"}

            extracted = self._extract_native_gemini_image(resp.json())
            if not extracted:
                return {"success": False, "error": "未能生成编辑后的图片，请重试"}

            image_bytes, mime_type = extracted
            result = self._finalize_image_result(
                image_bytes=image_bytes,
                mime_type=mime_type,
                prompt=prompt,
                user_id=user_id,
                session_id=session_id,
            )
            if result.get("success"):
                result["source_image_id"] = source_candidate["assetId"]
                result["source_image_url"] = source_candidate["url"]
                result["source_label"] = source_candidate["label"]
                result["resolved_edit_request"] = effective_request
                result["resolved_edit_plan"] = resolved_edit_plan
                if source_metadata.get("width"):
                    result["source_width"] = source_metadata["width"]
                if source_metadata.get("height"):
                    result["source_height"] = source_metadata["height"]
                if source_metadata.get("aspectRatio"):
                    result["source_aspect_ratio"] = source_metadata["aspectRatio"]
                if source_metadata.get("supportedAspectRatio"):
                    result["source_supported_aspect_ratio"] = source_metadata["supportedAspectRatio"]
            return result
        except httpx.TimeoutException:
            return {"success": False, "error": "图片编辑超时，请重试"}
        except Exception as exc:
            print(f"[Image] 编辑异常: {type(exc).__name__}: {exc}")
            return {"success": False, "error": f"图片编辑失败: {exc}"}

    def build_asset_catalog_message(
        self,
        session_id: str = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
    ) -> str:
        candidates = self._collect_edit_source_candidates(
            session_id,
            current_user_image_urls or [],
            current_user_message_id=current_user_message_id,
        )
        if not candidates:
            return ""

        lines = [
            "会话资源清单：当你需要引用已有图片时，必须优先使用下面的 assetId。",
            "如果要编辑现有图片，edit_image 必须优先填写 sourceImageId；只有目标不明确时才退回 sourceScope/sourceHint/sourceIndex，并在必要时先追问用户。",
            "每个资源条目只代表当前会话内的一项图片资源，assetId 在本会话内稳定可复用。",
        ]
        for candidate in candidates:
            metadata_bits = []
            if candidate.get("originKind"):
                metadata_bits.append(f"origin={candidate['originKind']}")
            if candidate.get("outputWidth") and candidate.get("outputHeight"):
                metadata_bits.append(f"size={candidate['outputWidth']}x{candidate['outputHeight']}")
            if candidate.get("outputAspectRatio"):
                metadata_bits.append(f"ratio={candidate['outputAspectRatio']}")
            tail = f" | {' | '.join(metadata_bits)}" if metadata_bits else ""
            lines.append(
                "- "
                f"assetId={candidate['assetId']} | "
                f"scope={candidate['sourceScope']} | "
                f"label={candidate['label']} | "
                f"summary={candidate['summary']}{tail}"
            )
        return "\n".join(lines)

    def _iter_generation_payloads(self, image_request: dict, prompt: str):
        cfg = self._get_image_model_config()
        image_api_key = self._resolve_image_api_key(cfg)
        native_api_key = self._resolve_native_gemini_api_key(cfg, fallback_key=image_api_key)
        if not native_api_key and not image_api_key:
            return

        model_id = cfg["model"]
        native_payload = self._build_native_gemini_image_payload(image_request)
        if native_api_key and native_payload:
            yield {
                "name": "native_gemini",
                "url": self._build_native_gemini_image_url(self._resolve_native_gemini_api_base(cfg), model_id),
                "headers": {"Content-Type": "application/json"},
                "params": {"key": native_api_key},
                "payload": native_payload,
            }

        chat_base = self._clean_optional_string(cfg.get("api_base"))
        if image_api_key and chat_base and not self._looks_like_google_native_base(chat_base):
            chat_url = self.llm._chat_endpoint(chat_base)
            yield {
                "name": "structured_chat",
                "url": chat_url,
                "headers": {
                    "Authorization": f"Bearer {image_api_key}",
                    "Content-Type": "application/json",
                },
                "params": None,
                "payload": self._build_structured_image_chat_payload(model_id, image_request),
            }
            yield {
                "name": "legacy_chat",
                "url": chat_url,
                "headers": {
                    "Authorization": f"Bearer {image_api_key}",
                    "Content-Type": "application/json",
                },
                "params": None,
                "payload": self._build_legacy_image_chat_payload(model_id, prompt),
            }

    def _request_image(self, payload_variant: dict) -> tuple[tuple[bytes, str] | None, str | None]:
        payload = payload_variant.get("payload")
        if not payload:
            return None, None

        try:
            with httpx.Client(timeout=IMAGE_GEN_TIMEOUT) as client:
                resp = client.post(
                    payload_variant["url"],
                    headers=payload_variant["headers"],
                    params=payload_variant.get("params"),
                    json=payload,
                )
            print(f"[Image] {payload_variant['name']}: HTTP {resp.status_code}")
            if resp.status_code != 200:
                error_text = self._format_http_error(resp)
                print(f"[Image] {payload_variant['name']} 错误: {error_text}")
                return None, f"{payload_variant['name']} {error_text}"

            if payload_variant["name"] == "native_gemini":
                return self._extract_native_gemini_image(resp.json()), None
            return self._extract_chat_image(resp.json()), None
        except Exception as exc:
            print(f"[Image] {payload_variant['name']} 异常: {type(exc).__name__}: {exc}")
            return None, f"{payload_variant['name']} 请求异常: {type(exc).__name__}: {exc}"

    def _finalize_image_result(
        self,
        image_bytes: bytes,
        mime_type: str,
        prompt: str,
        user_id: str = None,
        session_id: str = None,
    ) -> dict:
        image_metadata = self._inspect_image_bytes(image_bytes, mime_type)
        result = self.storage.upload_image(
            image_bytes,
            user_id=user_id,
            session_id=session_id,
            content_type=mime_type or "image/png",
        )
        if result:
            watermark_url = f"{result['url']}?mark=public/watermark.svg&mark-pos=0.95,0.95&mark-pct=0.15&mark-alpha=1"
            return {
                "success": True,
                "image": watermark_url,
                "s3_key": result["s3_key"],
                "image_id": result["id"],
                "prompt": prompt,
                "output_width": image_metadata.get("width"),
                "output_height": image_metadata.get("height"),
                "output_aspect_ratio": image_metadata.get("aspectRatio"),
            }

        b64 = base64.b64encode(image_bytes).decode("utf-8")
        return {
            "success": True,
            "image": f"data:{mime_type or 'image/png'};base64,{b64}",
            "prompt": prompt,
            "output_width": image_metadata.get("width"),
            "output_height": image_metadata.get("height"),
            "output_aspect_ratio": image_metadata.get("aspectRatio"),
        }

    def _normalize_image_request(self, args) -> dict:
        if isinstance(args, str):
            args = {"subject": args}
        if not isinstance(args, dict):
            return {}

        request = {}
        image_config_arg = args.get("imageConfig")
        if not isinstance(image_config_arg, dict):
            image_config_arg = {}

        prompt = self._clean_optional_string(args.get("prompt"))
        subject = self._clean_optional_string(args.get("subject")) or prompt
        if subject:
            request["subject"] = subject

        for field_name, _ in IMAGE_PROMPT_FIELDS:
            value = self._clean_optional_string(args.get(field_name))
            if value:
                request[field_name] = value

        negative_prompt = self._clean_optional_string(args.get("negativePrompt"))
        if negative_prompt:
            request["negativePrompt"] = negative_prompt

        aspect_ratio = (
            self._clean_optional_string(image_config_arg.get("aspectRatio"))
            or self._clean_optional_string(args.get("aspectRatio"))
            or self._legacy_size_to_aspect_ratio(args.get("size"))
        )
        image_size = (
            self._clean_optional_string(image_config_arg.get("imageSize"))
            or self._clean_optional_string(args.get("imageSize"))
        )
        request["imageConfig"] = {
            "aspectRatio": aspect_ratio if aspect_ratio in IMAGE_ASPECT_RATIOS else DEFAULT_IMAGE_ASPECT_RATIO,
            "imageSize": image_size if image_size in IMAGE_SIZES else DEFAULT_IMAGE_SIZE,
        }

        if prompt and prompt != subject:
            request["prompt"] = prompt

        return request

    def _normalize_image_edit_request(self, args) -> dict:
        if isinstance(args, str):
            args = {"instruction": args}
        if not isinstance(args, dict):
            return {}

        request = {}
        image_config_arg = args.get("imageConfig")
        if not isinstance(image_config_arg, dict):
            image_config_arg = {}

        instruction = (
            self._clean_optional_string(args.get("instruction"))
            or self._clean_optional_string(args.get("editPrompt"))
            or self._clean_optional_string(args.get("prompt"))
            or self._clean_optional_string(args.get("changes"))
        )
        if instruction:
            request["instruction"] = instruction

        source_image_id = (
            self._clean_optional_string(args.get("sourceImageId"))
            or self._clean_optional_string(args.get("assetId"))
            or self._clean_optional_string(args.get("imageId"))
        )
        if source_image_id:
            request["sourceImageId"] = source_image_id

        source_scope = self._clean_optional_string(args.get("sourceScope"))
        if source_scope in IMAGE_EDIT_SOURCE_SCOPES:
            request["sourceScope"] = source_scope

        source_hint = (
            self._clean_optional_string(args.get("sourceHint"))
            or self._clean_optional_string(args.get("reference"))
            or self._clean_optional_string(args.get("imageRef"))
        )
        if source_hint:
            request["sourceHint"] = source_hint

        try:
            source_index = int(args.get("sourceIndex"))
        except (TypeError, ValueError):
            source_index = 0
        if source_index > 0:
            request["sourceIndex"] = source_index

        preserve = self._clean_optional_string(args.get("preserve"))
        if preserve:
            request["preserve"] = preserve

        negative_prompt = self._clean_optional_string(args.get("negativePrompt"))
        if negative_prompt:
            request["negativePrompt"] = negative_prompt

        aspect_ratio = (
            self._clean_optional_string(image_config_arg.get("aspectRatio"))
            or self._clean_optional_string(args.get("aspectRatio"))
            or self._legacy_size_to_aspect_ratio(args.get("size"))
        )
        image_size = (
            self._clean_optional_string(image_config_arg.get("imageSize"))
            or self._clean_optional_string(args.get("imageSize"))
        )
        image_config = {}
        if aspect_ratio in IMAGE_ASPECT_RATIOS:
            image_config["aspectRatio"] = aspect_ratio
        if image_size in IMAGE_SIZES:
            image_config["imageSize"] = image_size
        if image_config:
            request["imageConfig"] = image_config

        return request

    def _build_image_prompt(self, image_request: dict) -> str:
        if not isinstance(image_request, dict):
            return ""

        subject = self._clean_optional_string(image_request.get("subject"))
        fallback_prompt = self._clean_optional_string(image_request.get("prompt"))
        primary = subject or fallback_prompt
        if not primary:
            return ""

        lines = [f"Primary subject: {primary}"]
        if fallback_prompt and fallback_prompt != primary:
            lines.append(f"Supplemental prompt: {fallback_prompt}")

        for field_name, label in IMAGE_PROMPT_FIELDS:
            value = self._clean_optional_string(image_request.get(field_name))
            if value:
                lines.append(f"{label}: {value}")

        negative_prompt = self._clean_optional_string(image_request.get("negativePrompt"))
        if negative_prompt:
            lines.append(f"Avoid: {negative_prompt}")

        image_config = image_request.get("imageConfig")
        if isinstance(image_config, dict):
            aspect_ratio = self._clean_optional_string(image_config.get("aspectRatio"))
            image_size = self._clean_optional_string(image_config.get("imageSize"))
            if aspect_ratio:
                lines.append(f"Aspect ratio: {aspect_ratio}")
            if image_size:
                lines.append(f"Image size: {image_size}")

        return "\n".join(lines)

    def _build_image_edit_prompt(self, edit_request: dict, source_metadata: dict | None = None) -> str:
        if not isinstance(edit_request, dict):
            return ""

        instruction = self._clean_optional_string(edit_request.get("instruction"))
        if not instruction:
            return ""

        lines = [
            "Edit the provided source image according to the instruction below.",
            f"Instruction: {instruction}",
            "Preserve the original subject identity, core composition, and unchanged details unless the instruction explicitly modifies them.",
        ]
        if source_metadata and source_metadata.get("width") and source_metadata.get("height"):
            ratio_label = self._clean_optional_string(source_metadata.get("supportedAspectRatio")) or self._clean_optional_string(source_metadata.get("aspectRatio"))
            ratio_note = f" ({ratio_label})" if ratio_label else ""
            lines.append(
                f"Keep the original canvas geometry {source_metadata['width']}x{source_metadata['height']}{ratio_note} unless the instruction explicitly changes it."
            )

        preserve = self._clean_optional_string(edit_request.get("preserve"))
        if preserve:
            lines.append(f"Preserve: {preserve}")

        negative_prompt = self._clean_optional_string(edit_request.get("negativePrompt"))
        if negative_prompt:
            lines.append(f"Avoid: {negative_prompt}")

        image_config = edit_request.get("imageConfig")
        if isinstance(image_config, dict):
            aspect_ratio = self._clean_optional_string(image_config.get("aspectRatio"))
            image_size = self._clean_optional_string(image_config.get("imageSize"))
            if aspect_ratio:
                lines.append(f"Target aspect ratio: {aspect_ratio}")
            if image_size:
                lines.append(f"Target image size: {image_size}")

        return "\n".join(lines)

    def _build_native_gemini_image_url(self, base_url: str, model_id: str) -> str:
        stripped = base_url.rstrip("/")
        if stripped.endswith("/v1"):
            stripped = stripped[:-3]
        return f"{stripped}/v1beta/models/{model_id}:generateContent"

    def _build_native_gemini_image_payload(self, image_request: dict) -> dict | None:
        prompt = self._build_image_prompt(image_request)
        if not prompt:
            return None

        generation_config = {"responseModalities": ["TEXT", "IMAGE"]}
        raw_image_config = image_request.get("imageConfig")
        if isinstance(raw_image_config, dict):
            image_config = {}
            aspect_ratio = self._clean_optional_string(raw_image_config.get("aspectRatio"))
            image_size = self._clean_optional_string(raw_image_config.get("imageSize"))
            if aspect_ratio:
                image_config["aspectRatio"] = aspect_ratio
            if image_size:
                image_config["imageSize"] = image_size
            if image_config:
                generation_config["imageConfig"] = image_config

        return {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ],
            "generationConfig": generation_config,
        }

    def _build_native_gemini_image_edit_payload(
        self,
        edit_request: dict,
        source_bytes: bytes,
        source_mime_type: str,
        source_metadata: dict | None = None,
    ) -> dict | None:
        prompt = self._build_image_edit_prompt(edit_request, source_metadata=source_metadata)
        if not prompt or not source_bytes:
            return None

        generation_config = {"responseModalities": ["TEXT", "IMAGE"]}
        raw_image_config = edit_request.get("imageConfig")
        if isinstance(raw_image_config, dict) and raw_image_config:
            generation_config["imageConfig"] = raw_image_config

        return {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": source_mime_type or "image/png",
                                "data": base64.b64encode(source_bytes).decode("utf-8"),
                            }
                        },
                        {"text": prompt},
                    ],
                }
            ],
            "generationConfig": generation_config,
        }

    def _build_structured_image_chat_payload(self, model_id: str, image_request: dict) -> dict | None:
        prompt = self._build_image_prompt(image_request)
        if not prompt:
            return None

        payload = {
            "model": model_id,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }
        native_payload = self._build_native_gemini_image_payload(image_request)
        if native_payload and native_payload.get("generationConfig"):
            payload["generationConfig"] = native_payload["generationConfig"]
        return payload

    def _build_legacy_image_chat_payload(self, model_id: str, prompt: str) -> dict | None:
        prompt = self._clean_optional_string(prompt)
        if not prompt:
            return None
        return {
            "model": model_id,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }

    def _extract_native_gemini_image(self, data: dict) -> tuple[bytes, str] | None:
        candidates = data.get("candidates") or []
        if not candidates:
            return None

        parts = (candidates[0].get("content") or {}).get("parts") or []
        for part in parts:
            inline_data = part.get("inlineData")
            if isinstance(inline_data, dict):
                mime_type = self._clean_optional_string(inline_data.get("mimeType")) or "image/png"
                b64data = self._clean_optional_string(inline_data.get("data"))
                if not b64data:
                    continue
                return base64.b64decode(b64data), mime_type
        return None

    def _extract_chat_image(self, data: dict) -> tuple[bytes, str] | None:
        choices = data.get("choices") or []
        if not choices:
            return None

        message = choices[0].get("message") or {}
        images = message.get("images") or []
        for image in images:
            image_url = ((image.get("image_url") or {}).get("url") or "").strip()
            if image_url.startswith("data:image/"):
                header, b64data = image_url.split(",", 1)
                mime_type = header.split(";")[0].split(":", 1)[1]
                return base64.b64decode(b64data), mime_type

        content = message.get("content") or ""
        if content:
            match = re.search(r"data:image/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)", content)
            if match:
                return base64.b64decode(match.group(2)), f"image/{match.group(1)}"
        return None

    def _collect_edit_source_candidates(
        self,
        session_id: str = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
    ) -> list[dict]:
        from models import ChatMessage, GeneratedImage

        candidates = []
        seen_urls = set()
        current_user_image_urls = current_user_image_urls or []

        def add_candidate(
            url,
            source_scope,
            label,
            summary,
            asset_id,
            *,
            origin_kind: str = "",
            search_parts: list[str] | None = None,
            output_width: int | None = None,
            output_height: int | None = None,
            output_aspect_ratio: str | None = None,
        ):
            clean_url = self._clean_optional_string(url)
            if not clean_url or clean_url in seen_urls:
                return
            seen_urls.add(clean_url)
            search_blob = " ".join(part for part in (search_parts or [label, summary]) if part).strip().lower()
            candidates.append({
                "assetId": asset_id,
                "url": clean_url,
                "sourceScope": source_scope,
                "originKind": origin_kind,
                "label": label,
                "summary": summary,
                "searchBlob": search_blob,
                "outputWidth": output_width,
                "outputHeight": output_height,
                "outputAspectRatio": output_aspect_ratio,
            })

        for idx, url in enumerate(current_user_image_urls, start=1):
            asset_id = (
                self.build_conversation_asset_id("current_upload", current_user_message_id, idx)
                if current_user_message_id
                else f"asset_cur_current_{idx}"
            )
            add_candidate(
                url=url,
                source_scope="current_upload",
                label=f"当前上传图片 {idx}",
                summary="当前消息上传的图片",
                asset_id=asset_id,
                origin_kind="user_upload",
            )

        if not session_id:
            return candidates

        messages = (
            ChatMessage.query
            .filter_by(session_id=session_id)
            .order_by(ChatMessage.created_at.desc())
            .all()
        )
        for message in messages:
            if message.role == "user":
                message_images = self._load_message_images(message.images)
                for idx, url in reversed(list(enumerate(message_images, start=1))):
                    is_current_upload = bool(current_user_message_id and message.id == current_user_message_id)
                    scope = "current_upload" if is_current_upload else "latest_user_upload"
                    label = f"当前上传图片 {idx}" if is_current_upload else f"历史上传图片 {idx}"
                    summary = self._clean_optional_string(message.content) or label
                    add_candidate(
                        url=url,
                        source_scope=scope,
                        label=label,
                        summary=summary,
                        asset_id=self.build_conversation_asset_id(scope, message.id, idx),
                        origin_kind="user_upload",
                    )
                continue

            trace_records = list(enumerate(self._load_message_tool_trace(message.tool_trace), start=1))
            for idx, item in reversed(trace_records):
                if item.get("kind") != "image_gen":
                    continue
                url = self._clean_optional_string(item.get("url")) or self._clean_optional_string(item.get("previewUrl"))
                request = item.get("request") if isinstance(item.get("request"), dict) else {}
                edit_request = item.get("editRequest") if isinstance(item.get("editRequest"), dict) else {}
                resolved_edit_request = item.get("resolvedEditRequest") if isinstance(item.get("resolvedEditRequest"), dict) else {}
                mode = self._clean_optional_string(item.get("mode")) or "generate"
                label = (
                    self._clean_optional_string(item.get("sourceLabel"))
                    or self._clean_optional_string(item.get("imageTitle"))
                    or self._clean_optional_string(request.get("subject"))
                    or self._clean_optional_string(edit_request.get("instruction"))
                    or ("已编辑图片" if mode == "edit" else "生成图片")
                )
                summary = (
                    self._clean_optional_string(item.get("imageTitle"))
                    or self._clean_optional_string(request.get("subject"))
                    or self._clean_optional_string(edit_request.get("instruction"))
                    or self._clean_optional_string(item.get("prompt"))
                    or label
                )
                add_candidate(
                    url=url,
                    source_scope="latest_tool_image",
                    label=label,
                    summary=summary,
                    asset_id=self._clean_optional_string(item.get("assetId")) or self.build_conversation_asset_id("latest_tool_image", message.id, idx),
                    origin_kind="edited_image" if mode == "edit" else "generated_image",
                    search_parts=[
                        label,
                        summary,
                        self._clean_optional_string(item.get("prompt")),
                        self._clean_optional_string(message.content),
                        self._clean_optional_string(item.get("sourceLabel")),
                    ],
                    output_width=self._coerce_positive_int(item.get("outputWidth")),
                    output_height=self._coerce_positive_int(item.get("outputHeight")),
                    output_aspect_ratio=(
                        self._clean_optional_string(item.get("outputAspectRatio"))
                        or self._clean_optional_string((resolved_edit_request.get("imageConfig") or {}).get("aspectRatio"))
                        or self._clean_optional_string((edit_request.get("imageConfig") or {}).get("aspectRatio"))
                        or self._clean_optional_string((request.get("imageConfig") or {}).get("aspectRatio"))
                    ),
                )

        generated_images = (
            GeneratedImage.query
            .filter_by(session_id=session_id)
            .order_by(GeneratedImage.created_at.desc())
            .all()
        )
        for image in generated_images:
            summary = self._clean_optional_string(image.prompt) or "生成图片"
            add_candidate(
                url=image.url,
                source_scope="latest_tool_image",
                label=summary,
                summary=summary,
                asset_id=self.build_conversation_asset_id("latest_tool_image", image.message_id or image.id, 1),
                origin_kind="legacy_generated_image",
            )

        return candidates

    def _resolve_edit_source_candidate(
        self,
        session_id: str = None,
        edit_request: dict = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
    ) -> tuple[dict | None, str | None]:
        candidates = self._collect_edit_source_candidates(
            session_id,
            current_user_image_urls or [],
            current_user_message_id=current_user_message_id,
        )
        if not candidates:
            return None, "没有找到可编辑的图片，请先上传或生成图片"

        source_image_id = self._clean_optional_string((edit_request or {}).get("sourceImageId"))
        if source_image_id:
            for candidate in candidates:
                if candidate["assetId"] == source_image_id:
                    return candidate, None
            return None, "没有找到该图片资源，请重新指定要编辑的图片"

        requested_scope = self._clean_optional_string((edit_request or {}).get("sourceScope"))
        scope = requested_scope or ("current_upload" if current_user_image_urls else "latest_any")

        if scope == "current_upload":
            scoped = [candidate for candidate in candidates if candidate["sourceScope"] == "current_upload"]
        elif scope == "latest_tool_image":
            scoped = [candidate for candidate in candidates if candidate["sourceScope"] == "latest_tool_image"]
        elif scope == "latest_user_upload":
            scoped = [candidate for candidate in candidates if candidate["sourceScope"] in {"current_upload", "latest_user_upload"}]
        else:
            scoped = candidates

        if not scoped:
            if scope != "latest_any":
                return None, "指定范围内没有可编辑的图片，请换一个目标范围或直接指定图片"
            return None, "没有找到可编辑的图片，请先上传或生成图片"

        source_index = (edit_request or {}).get("sourceIndex")
        if isinstance(source_index, int) and source_index > 0:
            if len(scoped) >= source_index:
                return scoped[source_index - 1], None
            return None, "图片序号超出范围，请重新指定要编辑的图片"

        source_hint = self._clean_optional_string((edit_request or {}).get("sourceHint")).lower()
        if source_hint:
            matched = [
                candidate for candidate in scoped
                if source_hint in candidate["searchBlob"] or source_hint in candidate["label"].lower()
            ]
            if len(matched) == 1:
                return matched[0], None
            if len(matched) > 1:
                return None, "匹配到多张图片，请更具体地说明目标图片，或直接使用 sourceImageId"
            return None, "没有找到与描述匹配的图片，请更具体地说明目标图片"

        if len(scoped) == 1:
            return scoped[0], None

        return None, "当前会话里有多张可编辑图片，请明确指出要修改哪一张"

    def _load_message_tool_trace(self, raw_tool_trace: str | None) -> list[dict]:
        if not raw_tool_trace:
            return []
        try:
            parsed = json.loads(raw_tool_trace)
            return parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError, json.JSONDecodeError):
            return []

    def _download_source_image(self, url: str) -> tuple[bytes | None, str | None]:
        try:
            fetch_url = url.split("?", 1)[0] if "?mark=" in url else url
            with httpx.Client(timeout=IMAGE_GEN_TIMEOUT) as client:
                resp = client.get(fetch_url)
            if resp.status_code != 200:
                return None, None
            content_type = self._clean_optional_string(resp.headers.get("content-type")).split(";", 1)[0]
            mime_type = content_type if content_type.startswith("image/") else ""
            if not mime_type:
                mime_type = mimetypes.guess_type(fetch_url)[0] or "image/png"
            return resp.content, mime_type
        except Exception as exc:
            print(f"[Image] 下载源图片异常: {type(exc).__name__}: {exc}")
            return None, None

    def _load_message_images(self, raw_images: str | None) -> list[str]:
        if not raw_images:
            return []
        try:
            parsed = json.loads(raw_images)
            return parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError, json.JSONDecodeError):
            return []

    def _resolve_effective_edit_request(
        self,
        edit_request: dict,
        source_metadata: dict | None = None,
        *,
        source_candidate: dict | None = None,
    ) -> tuple[dict, dict]:
        resolved = dict(edit_request or {})
        raw_image_config = resolved.get("imageConfig") if isinstance(resolved.get("imageConfig"), dict) else {}
        image_config = dict(raw_image_config)
        supported_aspect_ratio = self._clean_optional_string((source_metadata or {}).get("supportedAspectRatio"))
        preserve_source_canvas = False
        if not self._clean_optional_string(image_config.get("aspectRatio")) and supported_aspect_ratio:
            image_config["aspectRatio"] = supported_aspect_ratio
            preserve_source_canvas = True
        if image_config:
            resolved["imageConfig"] = image_config
        else:
            resolved.pop("imageConfig", None)
        return resolved, {
            "sourceAssetId": (source_candidate or {}).get("assetId"),
            "sourceLabel": (source_candidate or {}).get("label"),
            "sourceWidth": (source_metadata or {}).get("width"),
            "sourceHeight": (source_metadata or {}).get("height"),
            "sourceAspectRatio": (source_metadata or {}).get("aspectRatio"),
            "effectiveAspectRatio": self._clean_optional_string(image_config.get("aspectRatio")),
            "preserveSourceCanvas": preserve_source_canvas,
        }

    def _inspect_image_bytes(self, image_bytes: bytes, mime_type: str | None = None) -> dict:
        width, height = self._extract_image_dimensions(image_bytes, mime_type)
        if not width or not height:
            return {}
        return {
            "width": width,
            "height": height,
            "aspectRatio": self._format_aspect_ratio_label(width, height),
            "supportedAspectRatio": self._closest_supported_aspect_ratio(width, height),
        }

    def _extract_image_dimensions(self, image_bytes: bytes, mime_type: str | None = None) -> tuple[int | None, int | None]:
        if not image_bytes:
            return None, None

        sniffed_mime = self._clean_optional_string(mime_type).lower()
        if sniffed_mime in {"image/png"} or image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            return self._extract_png_dimensions(image_bytes)
        if sniffed_mime in {"image/jpeg", "image/jpg"} or image_bytes.startswith(b"\xff\xd8"):
            return self._extract_jpeg_dimensions(image_bytes)
        if sniffed_mime == "image/gif" or image_bytes[:6] in {b"GIF87a", b"GIF89a"}:
            return self._extract_gif_dimensions(image_bytes)
        if sniffed_mime == "image/webp" or (len(image_bytes) >= 12 and image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP"):
            return self._extract_webp_dimensions(image_bytes)
        return None, None

    def _extract_png_dimensions(self, image_bytes: bytes) -> tuple[int | None, int | None]:
        if len(image_bytes) < 24:
            return None, None
        return int.from_bytes(image_bytes[16:20], "big"), int.from_bytes(image_bytes[20:24], "big")

    def _extract_gif_dimensions(self, image_bytes: bytes) -> tuple[int | None, int | None]:
        if len(image_bytes) < 10:
            return None, None
        return int.from_bytes(image_bytes[6:8], "little"), int.from_bytes(image_bytes[8:10], "little")

    def _extract_jpeg_dimensions(self, image_bytes: bytes) -> tuple[int | None, int | None]:
        if len(image_bytes) < 4 or image_bytes[:2] != b"\xff\xd8":
            return None, None
        idx = 2
        sof_markers = {
            0xC0, 0xC1, 0xC2, 0xC3,
            0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB,
            0xCD, 0xCE, 0xCF,
        }
        while idx + 1 < len(image_bytes):
            if image_bytes[idx] != 0xFF:
                idx += 1
                continue
            while idx < len(image_bytes) and image_bytes[idx] == 0xFF:
                idx += 1
            if idx >= len(image_bytes):
                break
            marker = image_bytes[idx]
            idx += 1
            if marker in {0xD8, 0xD9}:
                continue
            if idx + 1 >= len(image_bytes):
                break
            segment_length = int.from_bytes(image_bytes[idx:idx + 2], "big")
            if segment_length < 2 or idx + segment_length > len(image_bytes):
                break
            if marker in sof_markers and idx + 7 < len(image_bytes):
                height = int.from_bytes(image_bytes[idx + 3:idx + 5], "big")
                width = int.from_bytes(image_bytes[idx + 5:idx + 7], "big")
                return width, height
            idx += segment_length
        return None, None

    def _extract_webp_dimensions(self, image_bytes: bytes) -> tuple[int | None, int | None]:
        if len(image_bytes) < 30 or image_bytes[:4] != b"RIFF" or image_bytes[8:12] != b"WEBP":
            return None, None
        chunk_type = image_bytes[12:16]
        if chunk_type == b"VP8X" and len(image_bytes) >= 30:
            width = 1 + int.from_bytes(image_bytes[24:27], "little")
            height = 1 + int.from_bytes(image_bytes[27:30], "little")
            return width, height
        if chunk_type == b"VP8L" and len(image_bytes) >= 25 and image_bytes[20] == 0x2F:
            bits = int.from_bytes(image_bytes[21:25], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            return width, height
        if chunk_type == b"VP8 " and len(image_bytes) >= 30 and image_bytes[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(image_bytes[26:28], "little") & 0x3FFF
            height = int.from_bytes(image_bytes[28:30], "little") & 0x3FFF
            return width, height
        return None, None

    def _format_aspect_ratio_label(self, width: int, height: int) -> str:
        supported = self._closest_supported_aspect_ratio(width, height)
        if supported:
            actual = width / height
            expected = self._ratio_to_float(supported)
            if expected > 0 and abs(actual - expected) / expected <= 0.03:
                return supported
        divisor = gcd(width, height) or 1
        return f"{width // divisor}:{height // divisor}"

    def _closest_supported_aspect_ratio(self, width: int, height: int) -> str:
        if width <= 0 or height <= 0:
            return ""
        actual = width / height
        closest = ""
        smallest_error = None
        for ratio in IMAGE_ASPECT_RATIOS:
            expected = self._ratio_to_float(ratio)
            if expected <= 0:
                continue
            error = abs(actual - expected)
            if smallest_error is None or error < smallest_error:
                closest = ratio
                smallest_error = error
        return closest

    def _ratio_to_float(self, label: str) -> float:
        cleaned = self._clean_optional_string(label)
        if ":" not in cleaned:
            return 0.0
        left, right = cleaned.split(":", 1)
        try:
            width = float(left)
            height = float(right)
        except (TypeError, ValueError):
            return 0.0
        if width <= 0 or height <= 0:
            return 0.0
        return width / height

    def _coerce_positive_int(self, value) -> int | None:
        try:
            num = int(value)
        except (TypeError, ValueError):
            return None
        return num if num > 0 else None

    def _short_ref(self, value: str) -> str:
        clean = re.sub(r"[^a-zA-Z0-9]", "", self._clean_optional_string(value)).lower()
        return clean[:10] or "unknown"

    def _legacy_size_to_aspect_ratio(self, size) -> str:
        return {
            "1024x1024": "1:1",
            "1536x1024": "3:2",
            "1024x1536": "2:3",
        }.get(self._clean_optional_string(size), "")

    def _resolve_native_gemini_api_base(self, cfg: dict) -> str:
        return (
            self._clean_optional_string(cfg.get("native_api_base"))
            or self._clean_optional_string(os.environ.get("GEMINI_API_BASE"))
            or self._clean_optional_string(cfg.get("api_base"))
            or self.llm.legacy_api_base
        )

    def _resolve_image_api_key(self, cfg: dict) -> str:
        env_name = self._clean_optional_string(cfg.get("image_api_key_env"))
        if env_name and os.environ.get(env_name):
            return self._clean_optional_string(os.environ.get(env_name))

        explicit_key = self._clean_optional_string(cfg.get("image_api_key"))
        if explicit_key:
            return explicit_key

        dedicated_env_key = (
            self._clean_optional_string(os.environ.get("IMAGE_API_KEY"))
            or self._clean_optional_string(os.environ.get("API_KEY_PAPER"))
        )
        if dedicated_env_key:
            return dedicated_env_key

        fallback_key = self.llm.get_api_key(cfg)
        return self._clean_optional_string(fallback_key)

    def _resolve_native_gemini_api_key(self, cfg: dict, fallback_key: str | None = None) -> str:
        env_name = self._clean_optional_string(cfg.get("native_api_key_env"))
        if env_name and os.environ.get(env_name):
            return self._clean_optional_string(os.environ.get(env_name))

        explicit_key = self._clean_optional_string(cfg.get("native_api_key"))
        if explicit_key:
            return explicit_key

        env_key = self._clean_optional_string(os.environ.get("GEMINI_API_KEY"))
        if env_key:
            return env_key

        return self._clean_optional_string(fallback_key)

    def _looks_like_google_native_base(self, base_url: str) -> bool:
        clean = self._clean_optional_string(base_url).lower()
        return "googleapis.com" in clean or "generativelanguage" in clean

    def _format_http_error(self, response: httpx.Response) -> str:
        body = response.text[:300].replace("\n", " ").strip()
        if body:
            return f"HTTP {response.status_code} - {body}"
        return f"HTTP {response.status_code}"

    def _build_image_failure_message(self, failures: list[str]) -> str:
        if not failures:
            return "未能生成图片，请重试"
        if all("HTTP 503" in item for item in failures):
            return "图片服务暂时不可用（上游返回 503），请稍后重试"
        return failures[-1]

    def _clean_optional_string(self, value) -> str:
        if not isinstance(value, str):
            return ""
        return value.strip()
