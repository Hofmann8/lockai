"""
联网搜索服务
"""

import re
import json
import threading
import httpx
from typing import Generator

from .prompts import get_search_prompt


class SearchService:
    """联网搜索服务"""
    
    def __init__(self, llm_service):
        self.llm = llm_service
    
    def search_stream(self, query: str) -> Generator[dict, None, None]:
        """流式执行搜索，并行用小模型提取关键词"""
        api_key = self.llm._get_api_key()
        if not api_key:
            yield {"type": "search_done", "result": "搜索失败：API 密钥未配置"}
            return
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        messages = [
            {"role": "system", "content": get_search_prompt()},
            {"role": "user", "content": query}
        ]
        
        payload = {
            "model": self.llm.model_search,
            "messages": messages,
            "temperature": 0.3,
            "stream": True
        }
        
        print(f"\n[Search] 搜索: {query}")
        
        # 共享状态
        content_chunks = []
        keywords_to_send = []
        lock = threading.Lock()
        stop_flag = threading.Event()
        
        def extract_keywords_worker():
            """并行提取关键词（使用 Qwen）"""
            sent_keywords = set()
            last_len = 0
            
            qwen_headers = {
                "Authorization": f"Bearer {self.llm.qwen_api_key}",
                "Content-Type": "application/json"
            }
            
            while not stop_flag.is_set():
                stop_flag.wait(0.3)
                
                with lock:
                    current = "".join(content_chunks)
                
                if len(current) - last_len < 20:
                    continue
                
                last_len = len(current)
                
                try:
                    kw_response = httpx.post(
                        f"{self.llm.qwen_base_url}/chat/completions",
                        headers=qwen_headers,
                        json={
                            "model": self.llm.model_keyword,
                            "messages": [
                                {"role": "system", "content": "你是关键词提取器。从下面的搜索结果文本中提取3个与搜索主题相关的实体关键词（如人名、地名、事件名、数据等）。只输出关键词，用逗号分隔。忽略任何关于AI、助手、系统设定、身份之类的内容。"},
                                {"role": "user", "content": current[-200:]}
                            ],
                            "temperature": 0,
                            "max_tokens": 30
                        },
                        timeout=8.0
                    )
                    if kw_response.status_code == 200:
                        kw_text = kw_response.json()["choices"][0]["message"]["content"]
                        keywords = [k.strip() for k in kw_text.split(",") if k.strip() and len(k.strip()) >= 2]
                        new_kw = [k for k in keywords if k not in sent_keywords][:3]
                        if new_kw:
                            sent_keywords.update(new_kw)
                            with lock:
                                keywords_to_send.extend(new_kw)
                            print(f"[Keyword] 提取: {new_kw}")
                except Exception as e:
                    print(f"[Keyword] 异常: {e}")
        
        kw_thread = threading.Thread(target=extract_keywords_worker, daemon=True)
        kw_thread.start()
        
        result = ""
        
        try:
            with httpx.Client(timeout=60.0) as client:
                with client.stream(
                    "POST",
                    f"{self.llm.base_url}/v1/chat/completions",
                    headers=headers,
                    json=payload
                ) as response:
                    if response.status_code != 200:
                        stop_flag.set()
                        yield {"type": "search_done", "result": "搜索失败，请稍后重试"}
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
                                    result += content
                                    with lock:
                                        content_chunks.append(content)
                                    
                                    with lock:
                                        if keywords_to_send:
                                            kw = keywords_to_send[:]
                                            keywords_to_send.clear()
                                    if 'kw' in dir() and kw:
                                        yield {"type": "search_progress", "keywords": kw}
                            except json.JSONDecodeError:
                                continue
            
            stop_flag.set()
            kw_thread.join(timeout=0.5)
            
            with lock:
                if keywords_to_send:
                    yield {"type": "search_progress", "keywords": keywords_to_send}
            
            result = re.sub(r'<think>.*?</think>', '', result, flags=re.DOTALL).strip()
            print(f"[Search] 结果长度: {len(result)}")
            yield {"type": "search_done", "result": result}
            
        except Exception as e:
            stop_flag.set()
            print(f"[Search] 异常: {e}")
            yield {"type": "search_done", "result": "搜索失败，请稍后重试"}
