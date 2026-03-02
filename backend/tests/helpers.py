"""共享 mock 类 — 供测试文件直接 import"""


class MockLLMService:
    """
    可编程的 LLM mock。
    - 默认返回 default_response
    - 可通过 responses 队列按顺序返回不同内容
    - 记录所有调用到 call_log
    """

    def __init__(self, default_response: str = "OK"):
        self.default_response = default_response
        self.responses: list[str] = []
        self.call_log: list[dict] = []
        self._call_idx = 0

    def _next_response(self) -> str:
        if self._call_idx < len(self.responses):
            resp = self.responses[self._call_idx]
            self._call_idx += 1
            return resp
        return self.default_response

    def complete(self, messages, model=None, temperature=None,
                 max_tokens=None, api_key=None):
        self.call_log.append({
            "method": "complete",
            "messages": messages,
            "model": model,
        })
        return self._next_response()

    def complete_with_tools(self, messages, tools, tool_handler,
                            model=None, temperature=None, max_tokens=None,
                            api_key=None, max_rounds=10):
        self.call_log.append({
            "method": "complete_with_tools",
            "messages": messages,
            "tools": [t["function"]["name"] for t in tools],
            "model": model,
        })
        return self._next_response()

    def stream(self, messages, model=None):
        resp = self._next_response()
        for ch in resp:
            yield {"type": "content", "content": ch}


class MockStorageService:
    """内存 S3 mock"""

    def __init__(self):
        self.store: dict[str, bytes] = {}
        self.upload_log: list[dict] = []

    def upload_pdf(self, data: bytes, key: str):
        self.store[key] = data
        self.upload_log.append({"method": "upload_pdf", "key": key})
        return {"url": f"https://mock-s3/{key}"}

    def upload_bytes(self, data: bytes, key: str, content_type: str = ""):
        self.store[key] = data
        self.upload_log.append({"method": "upload_bytes", "key": key})

    def download_bytes(self, key: str) -> bytes | None:
        return self.store.get(key)
