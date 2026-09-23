"""
联网搜索服务

走中转站的 Responses API + 内置 web_search 工具（models.json 里的 search_builtin）。
DeepSeek 没有联网能力，DashScope 已经不再用于对话链路，所以搜索单独交给一个带搜索工具的小模型：
它负责"搜 + 摘要 + 给出引用"，主模型只拿摘要继续推理。
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

import httpx

from .http_client import build_http_client
from .prompts import get_search_prompt

MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")
# 搜索模型经常在链接后面加上 ?utm_source=openai 之类的追踪参数
TRACKING_PARAM_RE = re.compile(r"[?&]utm_[a-z]+=[^&#\s)]*")


class SearchService:
    """联网搜索服务。"""

    MAX_SOURCES = 8
    FAILED = "搜索失败，请基于已有知识继续回答，并告诉用户没能联网查到最新信息。"

    def __init__(self, llm_service):
        self.llm = llm_service

    def search(self, query: str) -> str:
        return self.search_with_sources(query)[0]

    def search_with_sources(self, query: str) -> tuple[str, list[dict[str, str]]]:
        """返回 (给主模型看的搜索摘要, 给前端展示的来源列表)。失败时摘要以"搜索失败"开头。"""
        query = (query or "").strip()
        if not query:
            return self.FAILED, []
        cfg = self.llm.get_model_config("search_builtin")
        api_key = self.llm.get_api_key(cfg)
        if not api_key:
            print("[Search] 未配置搜索模型的 API Key")
            return self.FAILED, []

        payload = {
            "model": cfg["model"],
            "instructions": get_search_prompt(),
            "input": query,
            "tools": [{
                "type": "web_search",
                "search_context_size": "medium",
                "user_location": {
                    "type": "approximate",
                    "country": "CN",
                    "city": "Hangzhou",
                    "timezone": "Asia/Shanghai",
                },
            }],
            "tool_choice": "required",
            # 模型不一定每次都在正文里引用；把实际看过的网页也要回来，引用为空时拿它兜底
            "include": ["web_search_call.action.sources"],
            "max_output_tokens": cfg.get("max_tokens", 1200),
        }
        endpoint = self._responses_endpoint(str(cfg.get("api_base") or ""))
        print(f"\n[Search] 搜索: {query}")
        try:
            with build_http_client(httpx.Timeout(connect=20.0, read=90.0, write=20.0, pool=20.0)) as client:
                response = client.post(endpoint, headers=self.llm._build_headers(api_key), json=payload)
            if response.status_code != 200:
                print(f"[Search] HTTP {response.status_code}: {response.text[:200]}")
                return self.FAILED, []
            text, sources = self._parse_response(response.json())
        except (httpx.HTTPError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            print(f"[Search] 异常 {type(exc).__name__}: {exc}")
            return self.FAILED, []
        if not text:
            return self.FAILED, []
        return text, sources

    @staticmethod
    def _responses_endpoint(api_base: str) -> str:
        base = api_base.rstrip("/")
        if not base.endswith("/v1"):
            base = f"{base}/v1"
        return f"{base}/responses"

    @classmethod
    def _parse_response(cls, data: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
        texts: list[str] = []
        raw_sources: list[dict[str, str]] = []
        consulted: list[dict[str, str]] = []
        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "web_search_call":
                for src in (item.get("action") or {}).get("sources") or []:
                    if isinstance(src, dict) and src.get("url"):
                        consulted.append({"url": src.get("url"), "title": src.get("title")})
                continue
            if item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if not isinstance(part, dict):
                    continue
                text = str(part.get("text") or "")
                if text:
                    texts.append(text)
                for ann in part.get("annotations") or []:
                    if isinstance(ann, dict) and ann.get("type") == "url_citation":
                        raw_sources.append({"url": ann.get("url"), "title": ann.get("title")})
        text = "\n".join(texts).strip()
        # 正文里的 markdown 链接也算来源（有的上游不给 annotations）
        for title, url in MARKDOWN_LINK_RE.findall(text):
            raw_sources.append({"url": url, "title": title})
        sources = cls._normalize_sources(raw_sources) or cls._normalize_sources(consulted)
        return cls._clean_text(text), sources

    @staticmethod
    def _clean_text(text: str) -> str:
        """给主模型的摘要：链接换成"标题（域名）"，省 token，也避免主模型把追踪参数原样抄给用户。"""
        def replace(match: re.Match) -> str:
            host = urlparse(match.group(2)).netloc.removeprefix("www.")
            return f"{match.group(1)}（{host}）" if host else match.group(1)
        return MARKDOWN_LINK_RE.sub(replace, text).strip()

    @classmethod
    def _normalize_sources(cls, raw) -> list[dict[str, str]]:
        sources: list[dict[str, str]] = []
        seen: set[str] = set()
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            url = TRACKING_PARAM_RE.sub("", str(item.get("url") or "").strip()).rstrip("?&")
            if not url.startswith(("http://", "https://")):
                continue
            host = urlparse(url).netloc.removeprefix("www.")
            key = url.split("#")[0]
            if key in seen:
                continue
            seen.add(key)
            site = str(item.get("site_name") or "").strip()
            # 搜索接口不给图标，直接用站点自己的 favicon；加载失败时前端退回首字母
            icon = str(item.get("icon") or "").strip() or f"{urlparse(url).scheme}://{urlparse(url).netloc}/favicon.ico"
            sources.append({
                "title": (str(item.get("title") or "").strip() or host)[:120],
                "url": url,
                "site": (site if site and site != "无" else host)[:40],
                "icon": icon,
            })
            if len(sources) >= cls.MAX_SOURCES:
                break
        return sources
