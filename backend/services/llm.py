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
        self.model_keyword = os.environ.get("MODEL_KEYWORD", "gemini-2.0-flash")
        self.model_image = os.environ.get("MODEL_IMAGE", "gemini-2.0-flash-exp-image-generation")
        self.temperature = float(os.environ.get("AI_TEMPERATURE", "0.7"))
        self.max_tokens = int(os.environ.get("AI_MAX_TOKENS", "8192"))
        
        self._api_keys = self._load_api_keys()
        self._key_index = 0
        
        # Pro 本地模型配置
        self.pro_base_url = os.environ.get("PRO_API_BASE_URL", "http://localhost:8045")
        self.pro_model = os.environ.get("PRO_MODEL", "")
        self.pro_api_key = os.environ.get("PRO_API_KEY", "")
    
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
    
    def stream_pro(self, messages: list) -> Generator[dict, None, None]:
        """流式调用本地 Pro 模型"""
        headers = {"Content-Type": "application/json"}
        
        if self.pro_api_key:
            headers["Authorization"] = f"Bearer {self.pro_api_key}"
        
        payload = {
            "model": self.pro_model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": True
        }
        
        print(f"\n[LLM-Pro] 流式调用本地模型: {self.pro_model}")
        
        try:
            with httpx.Client(timeout=120.0) as client:
                with client.stream(
                    "POST",
                    f"{self.pro_base_url}/v1/chat/completions",
                    headers=headers,
                    json=payload
                ) as response:
                    if response.status_code != 200:
                        error_text = response.read().decode()
                        print(f"[LLM-Pro] 错误: {response.status_code} - {error_text}")
                        yield {"type": "error", "content": f"本地模型请求失败: {response.status_code}"}
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
            yield {"type": "error", "content": "本地模型请求超时"}
        except Exception as e:
            print(f"[LLM-Pro] 异常: {type(e).__name__}: {e}")
            yield {"type": "error", "content": f"本地模型请求失败: {str(e)}"}
    
    def complete(self, messages: list, model: str = None, temperature: float = None, max_tokens: int = None) -> Optional[str]:
        """非流式调用 API"""
        api_key = self._get_api_key()
        if not api_key:
            return None
        
        model = model or self.model_primary
        
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
                    f"{self.base_url}/v1/chat/completions",
                    headers=headers,
                    json=payload
                )
                
                if response.status_code == 200:
                    return response.json()["choices"][0]["message"]["content"]
        except Exception as e:
            print(f"[LLM] 异常: {e}")
        
        return None
