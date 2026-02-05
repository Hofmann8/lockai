"""
AI Service - 主服务入口
整合 LLM、搜索、图像生成等功能
"""

from typing import Generator

from .prompts import get_system_prompt
from .llm import LLMService
from .storage import StorageService
from .search import SearchService
from .image import ImageService
from .title import TitleService


class AIService:
    """AI 服务主入口"""
    
    def __init__(self):
        self.llm = LLMService()
        self.storage = StorageService()
        self.search = SearchService(self.llm)
        self.image = ImageService(self.llm, self.storage)
        self.title = TitleService(self.llm)
    
    @property
    def _s3_client(self):
        """兼容旧代码"""
        return self.storage._client
    
    def generate_title(self, user_message: str, assistant_message: str = "") -> str:
        """生成对话标题"""
        return self.title.generate(user_message)
    
    def chat_stream(self, message: str, history: list = None, ai_role: str = 'xiaosuolaoshi', user_id: str = None, session_id: str = None) -> Generator[dict, None, None]:
        """
        流式聊天接口
        
        事件类型：
        - content: 普通文本内容
        - searching: 开始搜索
        - search_progress: 搜索进度（关键词）
        - search_complete: 搜索完成
        - drawing: 开始绘图
        - image: 图片生成完成
        - error: 错误
        - done: 完成
        """
        print(f"\n{'#'*50}")
        print(f"[Chat] 角色: {ai_role}")
        print(f"[Chat] 收到消息: {message[:50]}..." if len(message) > 50 else f"[Chat] 收到消息: {message}")
        
        system_prompt = get_system_prompt(ai_role)
        messages = [{"role": "system", "content": system_prompt}]
        
        if history:
            for item in history:
                role = "assistant" if item["role"] == "assistant" else "user"
                messages.append({"role": role, "content": item["content"]})
        
        messages.append({"role": "user", "content": message})
        
        # Leo 模式：使用 Qwen，简单直接，不支持搜索和绘图
        if ai_role == 'leo':
            for chunk in self.llm.stream_qwen(messages):
                yield chunk
            yield {"type": "done", "content": ""}
            return
        
        # 标准模式：支持搜索和绘图
        yield from self._chat_with_tools(messages, user_id, session_id)
    
    def _chat_with_tools(self, messages: list, user_id: str, session_id: str) -> Generator[dict, None, None]:
        """带工具调用的聊天"""
        buffer = ""
        output_buffer = ""
        search_pattern = "[SEARCH:"
        draw_pattern = "[DRAW:"
        search_results = {}
        
        for chunk in self.llm.stream(messages):
            if chunk["type"] == "error":
                yield chunk
                return
            
            if chunk["type"] == "content":
                buffer += chunk["content"]
                
                while search_pattern in buffer or draw_pattern in buffer:
                    search_idx = buffer.find(search_pattern)
                    draw_idx = buffer.find(draw_pattern)
                    
                    if search_idx >= 0 and (draw_idx < 0 or search_idx < draw_idx):
                        start_idx, pattern, is_search = search_idx, search_pattern, True
                    elif draw_idx >= 0:
                        start_idx, pattern, is_search = draw_idx, draw_pattern, False
                    else:
                        break
                    
                    end_idx = buffer.find("]", start_idx)
                    
                    if end_idx == -1:
                        if start_idx > 0:
                            text = buffer[:start_idx]
                            yield {"type": "content", "content": text}
                            output_buffer += text
                        buffer = buffer[start_idx:]
                        break
                    
                    if start_idx > 0:
                        text = buffer[:start_idx]
                        yield {"type": "content", "content": text}
                        output_buffer += text
                    
                    query_or_prompt = buffer[start_idx + len(pattern):end_idx]
                    buffer = buffer[end_idx + 1:]
                    
                    if is_search:
                        yield {"type": "searching", "content": query_or_prompt}
                        search_result = ""
                        for search_chunk in self.search.search_stream(query_or_prompt):
                            if search_chunk["type"] == "search_progress":
                                yield {"type": "search_progress", "keywords": search_chunk["keywords"]}
                            elif search_chunk["type"] == "search_done":
                                search_result = search_chunk["result"]
                        search_results[query_or_prompt] = search_result
                    else:
                        yield {"type": "drawing", "content": query_or_prompt}
                        draw_result = self.image.generate(query_or_prompt, user_id, session_id)
                        if draw_result["success"]:
                            yield {
                                "type": "image", 
                                "content": draw_result["image"],
                                "s3_key": draw_result.get("s3_key"),
                                "image_id": draw_result.get("image_id"),
                                "prompt": draw_result.get("prompt")
                            }
                        else:
                            yield {"type": "content", "content": f"\n\n*{draw_result['error']}*\n\n"}
                else:
                    potential_start = -1
                    for p in [search_pattern, draw_pattern]:
                        for i in range(1, len(p)):
                            if buffer.endswith(p[:i]):
                                pos = len(buffer) - i
                                if potential_start < 0 or pos < potential_start:
                                    potential_start = pos
                                break
                    
                    if potential_start >= 0:
                        if potential_start > 0:
                            text = buffer[:potential_start]
                            yield {"type": "content", "content": text}
                            output_buffer += text
                        buffer = buffer[potential_start:]
                    else:
                        yield {"type": "content", "content": buffer}
                        output_buffer += buffer
                        buffer = ""
        
        if buffer and not buffer.startswith("[SEARCH:") and not buffer.startswith("[DRAW:"):
            yield {"type": "content", "content": buffer}
            output_buffer += buffer
        
        # 有搜索结果时继续生成
        if search_results:
            print(f"[Chat] 有 {len(search_results)} 个搜索结果，继续生成回复")
            
            search_context = "\n\n".join([
                f"【搜索：{q}】\n{r}" for q, r in search_results.items()
            ])
            
            continue_messages = messages.copy()
            continue_messages.append({"role": "assistant", "content": output_buffer.rstrip()})
            continue_messages.append({
                "role": "user",
                "content": f"以下是搜索到的实时信息，请基于这些信息继续回复，不要重复之前说过的话：\n\n{search_context}"
            })
            
            yield {"type": "search_complete", "content": ""}
            
            for chunk in self.llm.stream(continue_messages):
                if chunk["type"] == "error":
                    yield chunk
                    return
                if chunk["type"] == "content":
                    yield chunk
        
        yield {"type": "done", "content": ""}
    
    def paper_assist(self, text: str, action: str) -> dict:
        """论文辅助功能"""
        prompts = {
            "explain": f"请详细解释以下学术内容，使用通俗易懂的语言：\n\n{text}",
            "summarize": f"请简洁地总结以下内容的要点：\n\n{text}",
            "translate": f"请将以下内容翻译成中文（如果已是中文则翻译成英文）：\n\n{text}"
        }
        
        prompt = prompts.get(action)
        if not prompt:
            return {"error": "无效的操作类型", "code": "INVALID_REQUEST"}
        
        messages = [
            {"role": "system", "content": "你是一个学术助手，帮助用户理解和处理学术论文内容。"},
            {"role": "user", "content": prompt}
        ]
        
        result = ""
        for chunk in self.llm.stream(messages):
            if chunk["type"] == "error":
                return {"error": chunk["content"], "code": "API_ERROR"}
            if chunk["type"] == "content":
                result += chunk["content"]
        
        return {"result": result}
