"""
联网搜索服务
"""

from __future__ import annotations

import json

import httpx

from .prompts import get_search_prompt


class SearchService:
    """联网搜索服务。"""

    def __init__(self, llm_service):
        self.llm = llm_service

    def search(self, query: str) -> str:
        result = ""
        for chunk in self.search_stream(query):
            if chunk["type"] == "search_done":
                result = chunk["result"]
        return result

    def search_stream(self, query: str):
        cfg = self.llm.get_model_config("search_builtin")
        api_key = self.llm.get_api_key(cfg)
        if not api_key:
            yield {"type": "search_done", "result": "搜索失败：未配置搜索模型 API Key"}
            return

        payload = {
            "model": cfg["model"],
            "messages": [
                {"role": "system", "content": get_search_prompt()},
                {"role": "user", "content": query},
            ],
            "stream": False,
            "temperature": cfg.get("temperature", 0.3),
            "max_tokens": cfg.get("max_tokens", 4096),
            "enable_search": True,
        }

        print(f"\n[Search] 搜索: {query}")

        try:
            with httpx.Client(timeout=httpx.Timeout(connect=20.0, read=90.0, write=20.0, pool=20.0)) as client:
                response = client.post(
                    self.llm._chat_endpoint(cfg["api_base"]),
                    headers=self.llm._build_headers(api_key),
                    json=payload,
                )
            if response.status_code != 200:
                print(f"[Search] 错误: HTTP {response.status_code} - {response.text[:300]}")
                yield {"type": "search_done", "result": "搜索失败，请稍后重试"}
                return

            data = response.json()
            content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
            if isinstance(content, list):
                content = "\n".join(str(item) for item in content if item)
            content = str(content or "").strip()
            yield {"type": "search_done", "result": content or "搜索失败，请稍后重试"}
        except (httpx.TimeoutException, json.JSONDecodeError, KeyError) as exc:
            print(f"[Search] 异常: {type(exc).__name__}: {exc}")
            yield {"type": "search_done", "result": "搜索失败，请稍后重试"}
