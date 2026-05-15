"""
图像生成与编辑服务

通过代理 (vectorengine.ai 等) 调用 OpenAI 兼容的图片生成接口：
- Campbell 1.5 Image (默认): gemini-3-pro-image-preview，实时
- Campbell 2.0 Image (hd):  gpt-image-2，高清但较慢
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
IMAGE_GEN_HD_TIMEOUT = httpx.Timeout(connect=10.0, read=900.0, write=10.0, pool=10.0)


class ImageService:
    """图像生成与编辑服务。"""

    def __init__(self, llm_service, storage_service):
        self.llm = llm_service
        self.storage = storage_service

    def _get_image_model_config(self, hd: bool = False) -> dict:
        model_id = "image_generator_hd" if hd else "image_generator"
        return self.llm.get_model_config(model_id)

    @staticmethod
    def model_label(hd: bool) -> str:
        return "Campbell 2.0 Image" if hd else "Campbell 1.5 Image"

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

    def generate(
        self,
        request_or_prompt,
        user_id: str = None,
        session_id: str = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
        hd: bool = False,
    ) -> dict:
        """生成图片并上传到存储。"""
        image_request = self._normalize_image_request(request_or_prompt)
        prompt = self._build_image_prompt(image_request)
        if not prompt:
            return {"success": False, "error": "缺少绘图描述"}

        cfg = self._get_image_model_config(hd=hd)
        api_key = self._resolve_image_api_key(cfg)
        if not api_key:
            return {"success": False, "error": "API 密钥未配置"}

        reference_sources, ref_error = self._resolve_reference_sources(
            image_request.get("referenceImageIds") or [],
            session_id=session_id,
            current_user_image_urls=current_user_image_urls or [],
            current_user_message_id=current_user_message_id,
        )
        if ref_error:
            return {"success": False, "error": ref_error}

        print(f"\n[Image] 绘图({self.model_label(hd)}): {prompt[:80]}...")
        if reference_sources:
            print(f"[Image] 使用参考图 {len(reference_sources)} 张")

        if self._is_gemini_model(cfg.get("model")):
            extracted, failure = self._gemini_generate(
                cfg, api_key, image_request, prompt,
                reference_sources=reference_sources,
                hd=hd,
            )
        else:
            extracted, failure = self._openai_generate(
                cfg, api_key, image_request, prompt,
                reference_sources=reference_sources,
                hd=hd,
            )
        if not extracted:
            return {"success": False, "error": failure or "未能生成图片，请重试"}

        image_bytes, mime_type = extracted
        result = self._finalize_image_result(
            image_bytes=image_bytes,
            mime_type=mime_type,
            prompt=prompt,
            user_id=user_id,
            session_id=session_id,
        )
        if result.get("success"):
            result["model_label"] = self.model_label(hd)
        return result

    def edit(
        self,
        request_or_prompt,
        user_id: str = None,
        session_id: str = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
        hd: bool = False,
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
        source_metadata = self._inspect_image_bytes(source_bytes or b"", source_mime_type) if source_bytes else {}
        effective_request, resolved_edit_plan = self._resolve_effective_edit_request(
            edit_request,
            source_metadata,
            source_candidate=source_candidate,
        )
        prompt = self._build_image_edit_prompt(effective_request, source_metadata=source_metadata)
        if not prompt:
            return {"success": False, "error": "缺少图片编辑要求"}

        cfg = self._get_image_model_config(hd=hd)
        api_key = self._resolve_image_api_key(cfg)
        if not api_key:
            return {"success": False, "error": "API 密钥未配置"}

        source_url_clean = self._strip_watermark_query(source_candidate["url"])

        print(f"\n[Image] 编辑图片({self.model_label(hd)}): {prompt[:80]}...")

        if self._is_gemini_model(cfg.get("edit_model") or cfg.get("model")):
            extracted, failure = self._gemini_edit(
                cfg, api_key, effective_request, prompt,
                source_url=source_url_clean,
                source_bytes=source_bytes,
                source_mime=source_mime_type,
                hd=hd,
            )
        else:
            extracted, failure = self._openai_edit(
                cfg, api_key, effective_request, prompt,
                source_url=source_url_clean,
                source_bytes=source_bytes,
                source_mime=source_mime_type,
                hd=hd,
            )
        if not extracted:
            return {"success": False, "error": failure or "未能生成编辑后的图片，请重试"}

        image_bytes, mime_type = extracted
        result = self._finalize_image_result(
            image_bytes=image_bytes,
            mime_type=mime_type,
            prompt=prompt,
            user_id=user_id,
            session_id=session_id,
        )
        if result.get("success"):
            result["model_label"] = self.model_label(hd)
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
            "如果要让 generate_image 参考已有图片的风格、构图或主体特征来创作新画面，把对应 assetId 填进 referenceImageIds 数组（最多 4 张），并尽量在 referenceUsage 里说明每张图的用途。",
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

    def _build_openai_image_url(self, cfg: dict) -> str:
        base = self._clean_optional_string(cfg.get("api_base")) or self.llm.legacy_api_base
        stripped = base.rstrip("/")
        if stripped.endswith("/v1"):
            stripped = stripped[:-3]
        return f"{stripped}/v1/images/generations"

    def _build_openai_image_edit_url(self, cfg: dict) -> str:
        base = self._clean_optional_string(cfg.get("api_base")) or self.llm.legacy_api_base
        stripped = base.rstrip("/")
        if stripped.endswith("/v1"):
            stripped = stripped[:-3]
        return f"{stripped}/v1/images/edits"

    def _request_openai_image_edit(
        self,
        cfg: dict,
        api_key: str,
        files: list,
        data: dict,
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        url = self._build_openai_image_edit_url(cfg)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        }
        timeout = IMAGE_GEN_HD_TIMEOUT if hd else IMAGE_GEN_TIMEOUT
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, headers=headers, files=files, data=data)
            print(f"[Image] openai_image_edit: HTTP {resp.status_code}")
            if resp.status_code != 200:
                error_text = self._format_http_error(resp)
                print(f"[Image] openai_image_edit 错误: {error_text}")
                return None, self._translate_openai_error(resp.status_code, error_text)
            extracted = self._extract_openai_image(resp.json())
            if not extracted:
                return None, "上游未返回图片数据"
            return extracted, None
        except httpx.TimeoutException:
            return None, "图片服务超时，请稍后重试"
        except Exception as exc:
            print(f"[Image] openai_image_edit 异常: {type(exc).__name__}: {exc}")
            return None, f"图片服务请求异常: {type(exc).__name__}"

    def _request_openai_image(
        self,
        cfg: dict,
        api_key: str,
        payload: dict,
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        url = self._build_openai_image_url(cfg)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        timeout = IMAGE_GEN_HD_TIMEOUT if hd else IMAGE_GEN_TIMEOUT
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, headers=headers, json=payload)
            print(f"[Image] openai_image: HTTP {resp.status_code}")
            if resp.status_code != 200:
                error_text = self._format_http_error(resp)
                print(f"[Image] openai_image 错误: {error_text}")
                return None, self._translate_openai_error(resp.status_code, error_text)

            extracted = self._extract_openai_image(resp.json())
            if not extracted:
                return None, "上游未返回图片数据"
            return extracted, None
        except httpx.TimeoutException:
            return None, "图片服务超时，请稍后重试"
        except Exception as exc:
            print(f"[Image] openai_image 异常: {type(exc).__name__}: {exc}")
            return None, f"图片服务请求异常: {type(exc).__name__}"

    @staticmethod
    def _is_gemini_model(model_id) -> bool:
        if not isinstance(model_id, str):
            return False
        return model_id.strip().lower().startswith("gemini")

    def _build_gemini_image_url(self, cfg: dict, model_id: str) -> str:
        base = self._clean_optional_string(cfg.get("api_base")) or self.llm.legacy_api_base
        stripped = base.rstrip("/")
        if stripped.endswith("/v1"):
            stripped = stripped[:-3]
        if stripped.endswith("/v1beta"):
            stripped = stripped[:-7]
        return f"{stripped}/v1beta/models/{model_id}:generateContent"

    def _gemini_generation_config(self, image_config) -> dict:
        aspect_ratio = DEFAULT_IMAGE_ASPECT_RATIO
        if isinstance(image_config, dict):
            aspect_ratio = self._clean_optional_string(image_config.get("aspectRatio")) or DEFAULT_IMAGE_ASPECT_RATIO
        return {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": aspect_ratio},
        }

    def _openai_generate(
        self,
        cfg: dict,
        api_key: str,
        image_request: dict,
        prompt: str,
        reference_sources: list[dict] | None = None,
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        # gpt-image-2 的 /v1/images/generations 不接受图片输入。
        # 当传了参考图时，统一走 /v1/images/edits 的 multipart 路径，把所有参考图作为 image 字段一起上传。
        if reference_sources:
            return self._openai_generate_with_refs(cfg, api_key, image_request, prompt, reference_sources, hd=hd)
        payload = self._build_openai_image_payload(cfg, image_request, prompt)
        if not payload:
            return None, "缺少绘图描述"
        return self._request_openai_image(cfg, api_key, payload, hd=hd)

    def _openai_generate_with_refs(
        self,
        cfg: dict,
        api_key: str,
        image_request: dict,
        prompt: str,
        reference_sources: list[dict],
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        prompt_clean = self._clean_optional_string(prompt)
        if not prompt_clean:
            return None, "缺少绘图描述"
        if len(prompt_clean) > 1000:
            prompt_clean = prompt_clean[:1000]
        model_id = (
            self._clean_optional_string(cfg.get("edit_model"))
            or self._clean_optional_string(cfg.get("model"))
            or "gpt-image-2"
        )
        size = self._map_openai_size(image_request.get("imageConfig"))
        quality = self._map_openai_quality(image_request.get("imageConfig"))
        files = []
        for idx, ref in enumerate(reference_sources):
            mime = ref.get("mime") or "image/png"
            ext = "png"
            if "/" in mime:
                suffix = mime.split("/", 1)[1].lower().split(";", 1)[0].strip()
                if suffix in {"png", "jpeg", "jpg", "webp"}:
                    ext = "jpg" if suffix == "jpeg" else suffix
            files.append(("image", (f"ref{idx + 1}.{ext}", ref["bytes"], mime)))
        data = {
            "model": model_id,
            "prompt": prompt_clean,
            "n": "1",
            "size": size,
        }
        if not model_id.startswith("gemini"):
            data["quality"] = quality
        return self._request_openai_image_edit(cfg, api_key, files, data, hd=hd)

    def _openai_edit(
        self,
        cfg: dict,
        api_key: str,
        edit_request: dict,
        prompt: str,
        source_url: str | None = None,
        source_bytes: bytes | None = None,
        source_mime: str | None = None,
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        if not source_bytes:
            if not self._clean_optional_string(source_url):
                return None, "缺少源图地址"
            source_bytes, fetched_mime = self._download_source_image(source_url)
            if not source_bytes:
                return None, "源图下载失败"
            source_mime = source_mime or fetched_mime
        prompt_clean = self._clean_optional_string(prompt)
        if not prompt_clean:
            return None, "缺少绘图描述"
        if len(prompt_clean) > 1000:
            prompt_clean = prompt_clean[:1000]
        model_id = self._clean_optional_string(cfg.get("edit_model")) or "gpt-image-2"
        size = self._map_openai_size(edit_request.get("imageConfig"))
        quality = self._map_openai_quality(edit_request.get("imageConfig"))
        mime = source_mime or "image/png"
        ext = "png"
        if "/" in mime:
            suffix = mime.split("/", 1)[1].lower().split(";", 1)[0].strip()
            if suffix in {"png", "jpeg", "jpg", "webp"}:
                ext = "jpg" if suffix == "jpeg" else suffix
        files = [("image", (f"source.{ext}", source_bytes, mime))]
        data = {
            "model": model_id,
            "prompt": prompt_clean,
            "n": "1",
            "size": size,
        }
        if not model_id.startswith("gemini"):
            data["quality"] = quality
        return self._request_openai_image_edit(cfg, api_key, files, data, hd=hd)

    def _gemini_generate(
        self,
        cfg: dict,
        api_key: str,
        image_request: dict,
        prompt: str,
        reference_sources: list[dict] | None = None,
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        model_id = self._clean_optional_string(cfg.get("model")) or "gemini-3-pro-image-preview"
        parts: list[dict] = [{"text": prompt[:4000]}]
        for ref in reference_sources or []:
            mime = ref.get("mime") or "image/png"
            url = self._clean_optional_string(ref.get("url"))
            if url:
                parts.append({"file_data": {"mime_type": mime, "file_uri": url}})
            elif ref.get("bytes"):
                b64 = base64.b64encode(ref["bytes"]).decode("utf-8")
                parts.append({"inline_data": {"mime_type": mime, "data": b64}})
        body = {
            "contents": [{"parts": parts}],
            "generationConfig": self._gemini_generation_config(image_request.get("imageConfig")),
        }
        return self._post_gemini_generate(cfg, api_key, model_id, body)

    def _gemini_edit(
        self,
        cfg: dict,
        api_key: str,
        edit_request: dict,
        prompt: str,
        source_url: str | None = None,
        source_bytes: bytes | None = None,
        source_mime: str | None = None,
        hd: bool = False,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        model_id = self._clean_optional_string(cfg.get("edit_model")) or self._clean_optional_string(cfg.get("model")) or "gemini-3-pro-image-preview"
        mime = source_mime or "image/png"
        if self._clean_optional_string(source_url):
            image_part = {"file_data": {"mime_type": mime, "file_uri": source_url.strip()}}
        elif source_bytes:
            b64 = base64.b64encode(source_bytes).decode("utf-8")
            image_part = {"inline_data": {"mime_type": mime, "data": b64}}
        else:
            return None, "缺少源图数据"
        body = {
            "contents": [{
                "parts": [
                    {"text": prompt[:4000]},
                    image_part,
                ],
            }],
            "generationConfig": self._gemini_generation_config(edit_request.get("imageConfig")),
        }
        return self._post_gemini_generate(cfg, api_key, model_id, body)

    def _post_gemini_generate(
        self,
        cfg: dict,
        api_key: str,
        model_id: str,
        body: dict,
    ) -> tuple[tuple[bytes, str] | None, str | None]:
        url = self._build_gemini_image_url(cfg, model_id)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        params = {"key": api_key}
        try:
            with httpx.Client(timeout=IMAGE_GEN_TIMEOUT) as client:
                resp = client.post(url, headers=headers, params=params, json=body)
            print(f"[Image] gemini_image: HTTP {resp.status_code}")
            if resp.status_code != 200:
                error_text = self._format_http_error(resp)
                print(f"[Image] gemini_image 错误: {error_text}")
                return None, self._translate_openai_error(resp.status_code, error_text)
            extracted = self._extract_gemini_image(resp.json())
            if not extracted:
                return None, "上游未返回图片数据"
            return extracted, None
        except httpx.TimeoutException:
            return None, "图片服务超时，请稍后重试"
        except Exception as exc:
            print(f"[Image] gemini_image 异常: {type(exc).__name__}: {exc}")
            return None, f"图片服务请求异常: {type(exc).__name__}"

    def _extract_gemini_image(self, data: dict) -> tuple[bytes, str] | None:
        candidates = data.get("candidates") or []
        for cand in candidates:
            content = cand.get("content") or {}
            for part in content.get("parts") or []:
                inline = part.get("inline_data") or part.get("inlineData")
                if not isinstance(inline, dict):
                    continue
                b64data = self._clean_optional_string(inline.get("data"))
                if not b64data:
                    continue
                try:
                    image_bytes = base64.b64decode(b64data)
                except Exception:
                    continue
                mime = self._clean_optional_string(inline.get("mime_type") or inline.get("mimeType")) or "image/png"
                return image_bytes, mime
        return None

    def _translate_openai_error(self, status_code: int, error_text: str) -> str:
        body_lower = error_text.lower()
        if status_code == 429:
            return "图片生成频次受限，请稍后重试"
        if status_code in (401, 403):
            if "verified" in body_lower or "organization" in body_lower:
                return "上游账号未完成组织验证"
            return "图片服务鉴权失败"
        if status_code == 400 and ("moderation" in body_lower or "safety" in body_lower or "policy" in body_lower):
            return "图片生成请求被内容策略拒绝"
        if status_code >= 500:
            return f"图片服务暂时不可用（HTTP {status_code}）"
        return f"图片服务不可用：{error_text}"

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
            # 水印按图片实际尺寸的比例贴（mark-pct），由前端容器负责缩放整张图
            watermark_url = (
                f"{result['url']}?mark=public/watermark2.svg"
                f"&mark-pos=0.97,0.97&mark-pct=0.15&mark-alpha=0.4"
            )
            blurred_url = f"{watermark_url}&blur=30"
            return {
                "success": True,
                "image": watermark_url,
                "blurred_image": blurred_url,
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

        ref_ids_raw = args.get("referenceImageIds")
        if isinstance(ref_ids_raw, str):
            ref_ids_raw = [ref_ids_raw]
        if isinstance(ref_ids_raw, list):
            cleaned_ids: list[str] = []
            for item in ref_ids_raw:
                cleaned = self._clean_optional_string(item)
                if cleaned and cleaned not in cleaned_ids:
                    cleaned_ids.append(cleaned)
            if cleaned_ids:
                request["referenceImageIds"] = cleaned_ids[:4]

        ref_usage = self._clean_optional_string(args.get("referenceUsage"))
        if ref_usage:
            request["referenceUsage"] = ref_usage

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

        ref_ids = image_request.get("referenceImageIds")
        if isinstance(ref_ids, list) and ref_ids:
            lines.append(
                f"Reference images provided: {len(ref_ids)}. "
                "Use them only as references for style/composition/subject traits. "
                "Do NOT reproduce or copy them verbatim — compose a new image."
            )
            ref_usage = self._clean_optional_string(image_request.get("referenceUsage"))
            if ref_usage:
                lines.append(f"Reference usage: {ref_usage}")

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

    def _build_openai_image_payload(self, cfg: dict, image_request: dict, prompt: str) -> dict | None:
        prompt = self._clean_optional_string(prompt)
        if not prompt:
            return None
        # 上游限制 1000 字符
        if len(prompt) > 1000:
            prompt = prompt[:1000]

        size = self._map_openai_size(image_request.get("imageConfig"))
        quality = self._map_openai_quality(image_request.get("imageConfig"))
        model_id = self._clean_optional_string(cfg.get("model")) or "gpt-image-2"

        payload: dict = {
            "model": model_id,
            "prompt": prompt,
            "n": 1,
            "size": size,
        }
        if not model_id.startswith("gemini"):
            payload["quality"] = quality
            payload["format"] = "png"
        return payload

    def _build_openai_image_edit_payload(
        self,
        cfg: dict,
        edit_request: dict,
        prompt: str,
        image_urls: list[str],
    ) -> dict | None:
        prompt = self._clean_optional_string(prompt)
        if not prompt or not image_urls:
            return None
        if len(prompt) > 1000:
            prompt = prompt[:1000]

        size = self._map_openai_size(edit_request.get("imageConfig"))
        quality = self._map_openai_quality(edit_request.get("imageConfig"))
        model_id = self._clean_optional_string(cfg.get("edit_model")) or "gpt-image-2"

        payload: dict = {
            "model": model_id,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "image": image_urls[:5],
        }
        if not model_id.startswith("gemini"):
            payload["quality"] = quality
        return payload

    def _map_openai_size(self, image_config) -> str:
        if not isinstance(image_config, dict):
            return "1024x1024"
        aspect_ratio = self._clean_optional_string(image_config.get("aspectRatio")) or DEFAULT_IMAGE_ASPECT_RATIO
        image_size = self._clean_optional_string(image_config.get("imageSize")) or DEFAULT_IMAGE_SIZE

        # 代理 (vectorengine) 支持的固定枚举尺寸
        tier_map = {
            "0.5K": {
                "1:1": "1024x1024",
                "16:9": "1536x1024", "3:2": "1536x1024", "4:3": "1536x1024",
                "9:16": "1024x1536", "2:3": "1024x1536", "3:4": "1024x1536",
            },
            "1K": {
                "1:1": "1024x1024",
                "16:9": "1536x1024", "3:2": "1536x1024", "4:3": "1536x1024",
                "9:16": "1024x1536", "2:3": "1024x1536", "3:4": "1024x1536",
            },
            "2K": {
                "1:1": "2048x2048",
                "16:9": "2048x1152", "3:2": "2048x1152", "4:3": "2048x1152",
                "9:16": "1024x1536", "2:3": "1024x1536", "3:4": "1024x1536",
            },
            "4K": {
                "1:1": "2048x2048",
                "16:9": "3840x2160", "3:2": "3840x2160", "4:3": "3840x2160",
                "9:16": "2160x3840", "2:3": "2160x3840", "3:4": "2160x3840",
            },
        }
        return tier_map.get(image_size, tier_map["2K"]).get(aspect_ratio, "1024x1024")

    def _map_openai_quality(self, image_config) -> str:
        if not isinstance(image_config, dict):
            return "high"
        image_size = self._clean_optional_string(image_config.get("imageSize")) or DEFAULT_IMAGE_SIZE
        return {"0.5K": "low", "1K": "medium", "2K": "high", "4K": "high"}.get(image_size, "high")

    def _extract_openai_image(self, data: dict) -> tuple[bytes, str] | None:
        items = data.get("data") or []
        if not items:
            return None
        item = items[0]
        b64data = self._clean_optional_string(item.get("b64_json"))
        if b64data:
            try:
                return base64.b64decode(b64data), "image/png"
            except Exception:
                return None
        url = self._clean_optional_string(item.get("url"))
        if url:
            image_bytes, mime_type = self._download_source_image(url)
            if image_bytes:
                return image_bytes, mime_type or "image/png"
        return None

    def _strip_watermark_query(self, url: str) -> str:
        clean = self._clean_optional_string(url)
        if not clean:
            return clean
        if "?mark=" in clean:
            return clean.split("?", 1)[0]
        return clean

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

    def _resolve_reference_sources(
        self,
        reference_image_ids: list[str],
        session_id: str = None,
        current_user_image_urls: list[str] = None,
        current_user_message_id: str = None,
    ) -> tuple[list[dict], str | None]:
        if not reference_image_ids:
            return [], None
        candidates = self._collect_edit_source_candidates(
            session_id,
            current_user_image_urls or [],
            current_user_message_id=current_user_message_id,
        )
        if not candidates:
            return [], "没有找到可作为参考的图片"
        by_id = {c["assetId"]: c for c in candidates}
        resolved: list[dict] = []
        for asset_id in reference_image_ids[:4]:
            candidate = by_id.get(asset_id)
            if not candidate:
                return [], f"找不到参考图 {asset_id}，请重新选择"
            url_clean = self._strip_watermark_query(candidate["url"])
            ref_bytes, ref_mime = self._download_source_image(url_clean)
            if not ref_bytes:
                return [], f"参考图下载失败 ({asset_id})"
            resolved.append({
                "assetId": candidate["assetId"],
                "url": url_clean,
                "bytes": ref_bytes,
                "mime": ref_mime or "image/png",
                "label": candidate.get("label"),
            })
        return resolved, None

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

    def _format_http_error(self, response: httpx.Response) -> str:
        body = response.text[:300].replace("\n", " ").strip()
        if body:
            return f"HTTP {response.status_code} - {body}"
        return f"HTTP {response.status_code}"

    def _clean_optional_string(self, value) -> str:
        if not isinstance(value, str):
            return ""
        return value.strip()
