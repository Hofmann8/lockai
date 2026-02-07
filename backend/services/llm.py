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
    
    def stream_qwen(self, messages: list, model: str = "qwen-plus", enable_search: bool = True, enable_thinking: bool = False) -> Generator[dict, None, None]:
        """流式调用 Qwen API（用于 Leo/Scooby 模式）"""
        if not self.qwen_api_key:
            yield {"type": "error", "content": "Qwen API 密钥未配置"}
            return
        
        headers = {
            "Authorization": f"Bearer {self.qwen_api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": True,
            "enable_search": enable_search,
            "stream_options": {"include_usage": True}
        }
        
        # Qwen3 系列支持思考模式
        if enable_thinking:
            payload["enable_thinking"] = True
        
        print(f"\n[LLM-Qwen] 流式调用: {model} (search={enable_search}, thinking={enable_thinking})")
        
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
                                choices = data.get("choices", [])
                                if not choices:
                                    continue
                                
                                delta = choices[0].get("delta", {})
                                
                                # 回复内容（忽略 reasoning_content）
                                content = delta.get("content")
                                if content:
                                    yield {"type": "content", "content": content}
                            except json.JSONDecodeError:
                                continue
        except httpx.TimeoutException:
            yield {"type": "error", "content": "Qwen 请求超时"}
        except Exception as e:
            print(f"[LLM-Qwen] 异常: {type(e).__name__}: {e}")
            yield {"type": "error", "content": f"Qwen 请求失败: {str(e)}"}
    
    def complete_with_tools(
        self,
        messages: list,
        tools: list[dict],
        tool_handler: callable,
        model: str = None,
        temperature: float = None,
        max_tokens: int = None,
        api_key: str = None,
        max_rounds: int = 10,
    ) -> str | None:
        """
        带 function calling 的多轮对话。

        LLM 可以调用 tools 中定义的函数，由 tool_handler 执行后把结果
        喂回 LLM，循环直到 LLM 输出纯文本或达到 max_rounds。

        参数:
            tools: OpenAI 格式的 tool 定义列表
            tool_handler: callable(name, arguments) -> str，执行工具并返回结果字符串
            max_rounds: 最大工具调用轮数，防止死循环
        返回:
            最终的纯文本回复，或 None
        """
        model = model or self.model_primary
        use_qwen = model.startswith("qwen")

        if use_qwen:
            api_key = api_key or self.qwen_api_key
            base_url = self.qwen_base_url
        else:
            api_key = api_key or self._get_api_key()
            base_url = self.base_url
        endpoint = f"{base_url.rstrip('/')}/chat/completions" if use_qwen else f"{base_url.rstrip('/')}/v1/chat/completions"

        if not api_key:
            return None

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        msgs = list(messages)  # 不修改原始列表

        for round_idx in range(max_rounds):
            payload = {
                "model": model,
                "messages": msgs,
                "tools": tools,
                "temperature": temperature if temperature is not None else self.temperature,
                "max_tokens": max_tokens or self.max_tokens,
            }

            print(f"\n[LLM] tool_call round {round_idx + 1}: model={model}")

            try:
                with httpx.Client(
                    timeout=httpx.Timeout(connect=30.0, read=600.0, write=30.0, pool=30.0)
                ) as client:
                    resp = client.post(
                        endpoint,
                        headers=headers,
                        json=payload,
                    )

                if resp.status_code != 200:
                    print(f"[LLM] tool_call 错误: HTTP {resp.status_code} - {resp.text[:500]}")
                    return None

                data = resp.json()
                choice = data.get("choices", [{}])[0]
                message = choice.get("message", {})
                finish_reason = choice.get("finish_reason", "")

                # 如果没有 tool_calls → 返回纯文本
                tool_calls = message.get("tool_calls")
                if not tool_calls:
                    return message.get("content") or None

                # 把 assistant 的 tool_calls 消息加入历史
                msgs.append(message)

                # 逐个执行 tool_call，把结果加入历史
                for tc in tool_calls:
                    fn = tc.get("function", {})
                    name = fn.get("name", "")
                    try:
                        arguments = json.loads(fn.get("arguments", "{}"))
                    except json.JSONDecodeError:
                        arguments = {}

                    print(f"[LLM] tool_call: {name}({json.dumps(arguments, ensure_ascii=False)[:200]})")
                    result_str = tool_handler(name, arguments)

                    msgs.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": result_str,
                    })

                # 如果 finish_reason 不是 tool_calls，也退出
                if finish_reason != "tool_calls" and finish_reason != "stop":
                    return message.get("content") or None

            except Exception as e:
                print(f"[LLM] tool_call 异常: {type(e).__name__}: {e}")
                return None

        print(f"[LLM] tool_call 达到最大轮数 {max_rounds}")
        return None

    def complete(self, messages: list, model: str = None, temperature: float = None, max_tokens: int = None, api_key: str = None) -> Optional[str]:
        """
        非流式语义的 API 调用（内部用 stream 接收，避免长文本超时）。
        api_key 可覆盖默认 key。
        """
        model = model or self.model_primary
        
        # 判断是否使用 Qwen
        use_qwen = model.startswith("qwen")
        
        if use_qwen:
            api_key = api_key or self.qwen_api_key
            base_url = self.qwen_base_url
        else:
            api_key = api_key or self._get_api_key()
            base_url = self.base_url
        endpoint = f"{base_url.rstrip('/')}/chat/completions" if use_qwen else f"{base_url.rstrip('/')}/v1/chat/completions"
        
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
            "max_tokens": max_tokens or self.max_tokens,
            "stream": True,
        }
        
        print(f"\n[LLM] complete(stream): model={model}, key=...{api_key[-6:] if api_key else 'None'}")
        
        try:
            chunks: list[str] = []
            with httpx.Client(timeout=httpx.Timeout(connect=30.0, read=600.0, write=30.0, pool=30.0)) as client:
                with client.stream(
                    "POST",
                    endpoint,
                    headers=headers,
                    json=payload,
                ) as response:
                    if response.status_code != 200:
                        error_text = response.read().decode()
                        print(f"[LLM] 错误: HTTP {response.status_code} - {error_text[:500]}")
                        return None
                    
                    for line in response.iter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                chunks.append(content)
                        except json.JSONDecodeError:
                            continue
            
            result = "".join(chunks)
            print(f"[LLM] 成功: {len(result)} 字符")
            return result if result else None
        except Exception as e:
            print(f"[LLM] 异常: {type(e).__name__}: {e}")
        
        return None
