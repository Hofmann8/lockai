"""
LLM API 调用服务
"""

import os
import json
import httpx
from typing import Generator, Optional


class LLMService:
    """LLM API 调用服务"""
    
    def __init__(self):
        self.base_url = os.environ.get("API_BASE_URL", "https://api.vectorengine.ai")
        self.model_primary = os.environ.get("MODEL_PRIMARY", "gemini-3-pro-preview")
        self.model_search = os.environ.get("MODEL_SEARCH", "gemini-2.5-pro-all")
        self.model_keyword = os.environ.get("MODEL_KEYWORD", "qwen-plus")
        self.model_image = os.environ.get("MODEL_IMAGE", "gemini-2.0-flash-exp-image-generation")
        self.temperature = float(os.environ.get("AI_TEMPERATURE", "0.7"))
        self.max_tokens = int(os.environ.get("AI_MAX_TOKENS", "8192"))
        
        self._api_keys = self._load_api_keys()
        self._key_index = 0
        
        # Qwen 配置（用于 keyword 提取和标题生成）
        self.qwen_base_url = os.environ.get("QWEN_API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        self.qwen_api_key = os.environ.get("QWEN_API_KEY", "")
    
    def _load_api_keys(self) -> list:
        """加载所有 API Keys"""
        keys = []
        i = 1
        while True:
            key = os.environ.get(f"API_KEY_{i}")
            if key:
                keys.append(key)
                i += 1
            else:
                break
        return keys
    
    def _get_api_key(self) -> Optional[str]:
        """轮询获取 API Key"""
        if not self._api_keys:
            return None
        key = self._api_keys[self._key_index % len(self._api_keys)]
        self._key_index += 1
        return key
    
    def stream(self, messages: list, model: str = None) -> Generator[dict, None, None]:
        """流式调用 API"""
        api_key = self._get_api_key()
        if not api_key:
            yield {"type": "error", "content": "API 密钥未配置"}
            return
        
        model = model or self.model_primary
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": True
        }
        
        print(f"\n[LLM] 流式调用: {model}")
        
        try:
            with httpx.Client(timeout=120.0) as client:
                with client.stream(
                    "POST",
                    f"{self.base_url}/v1/chat/completions",
                    headers=headers,
                    json=payload
                ) as response:
                    if response.status_code != 200:
                        error_text = response.read().decode()
                        print(f"[LLM] 错误: {response.status_code} - {error_text}")
                        yield {"type": "error", "content": f"API 请求失败: {response.status_code}"}
                        return
                    
                    for line in response.iter_lines():
                        if not line:
                            continue
                        if line.startswith("data: "):
                            data_str = line[6:]
                            if data_str == "[DONE]":
                                break
                            try:
                                data = json.loads(data_str)
                                delta = data.get("choices", [{}])[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    yield {"type": "content", "content": content}
                            except json.JSONDecodeError:
                                continue
        except httpx.TimeoutException:
            yield {"type": "error", "content": "请求超时"}
        except Exception as e:
            print(f"[LLM] 异常: {type(e).__name__}: {e}")
            yield {"type": "error", "content": f"请求失败: {str(e)}"}
    
    def stream_qwen(self, messages: list, enable_search: bool = True) -> Generator[dict, None, None]:
        """流式调用 Qwen API（用于 Leo 模式）"""
        if not self.qwen_api_key:
            yield {"type": "error", "content": "Qwen API 密钥未配置"}
            return
        
        headers = {
            "Authorization": f"Bearer {self.qwen_api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": "qwen-plus",
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": True,
            "enable_search": enable_search
        }
        
        print(f"\n[LLM-Qwen] 流式调用: qwen-plus (search={enable_search})")
        
        try:
            with httpx.Client(timeout=120.0) as client:
                with client.stream(
                    "POST",
                    f"{self.qwen_base_url}/chat/completions",
                    headers=headers,
                    json=payload
                ) as response:
                    if response.status_code != 200:
                        error_text = response.read().decode()
                        print(f"[LLM-Qwen] 错误: {response.status_code} - {error_text}")
                        yield {"type": "error", "content": f"Qwen 请求失败: {response.status_code}"}
                        return
                    
                    for line in response.iter_lines():
                        if not line:
                            continue
                        if line.startswith("data: "):
                            data_str = line[6:]
                            if data_str == "[DONE]":
                                break
                            try:
                                data = json.loads(data_str)
                                delta = data.get("choices", [{}])[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    yield {"type": "content", "content": content}
                            except json.JSONDecodeError:
                                continue
        except httpx.TimeoutException:
            yield {"type": "error", "content": "Qwen 请求超时"}
        except Exception as e:
            print(f"[LLM-Qwen] 异常: {type(e).__name__}: {e}")
            yield {"type": "error", "content": f"Qwen 请求失败: {str(e)}"}
    
    def complete(self, messages: list, model: str = None, temperature: float = None, max_tokens: int = None) -> Optional[str]:
        """非流式调用 API"""
        model = model or self.model_primary
        
        # 判断是否使用 Qwen
        use_qwen = model.startswith("qwen")
        
        if use_qwen:
            api_key = self.qwen_api_key
            base_url = self.qwen_base_url
        else:
            api_key = self._get_api_key()
            base_url = self.base_url
        
        if not api_key:
            return None
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature if temperature is not None else self.temperature,
            "max_tokens": max_tokens or self.max_tokens
        }
        
        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.post(
                    f"{base_url}/chat/completions",
                    headers=headers,
                    json=payload
                )
                
                if response.status_code == 200:
                    return response.json()["choices"][0]["message"]["content"]
        except Exception as e:
            print(f"[LLM] 异常: {e}")
        
        return None
