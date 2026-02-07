"""
标题生成服务
"""

from .prompts import get_title_prompt


class TitleService:
    """对话标题生成服务"""
    
    def __init__(self, llm_service):
        self.llm = llm_service
    
    def generate(self, user_message: str) -> str:
        """根据用户消息生成对话标题"""
        messages = [
            {"role": "system", "content": get_title_prompt()},
            {"role": "user", "content": f"为以下用户消息生成标题：\n\n{user_message[:100]}"}
        ]
        
        print(f"[Title] 生成标题...")
        
        result = self.llm.complete(
            messages, 
            model=self.llm.model_keyword,
            temperature=0.3,
            max_tokens=20
        )
        
        if result:
            title = result.strip().strip('"\'「」『』')
            # 去掉可能的前缀
            for prefix in ['标题：', '标题:', 'Title:', 'Title：']:
                if title.startswith(prefix):
                    title = title[len(prefix):].strip()
            if len(title) > 20:
                title = title[:20] + '...'
            print(f"[Title] 生成: {title}")
            return title
        
        # fallback
        return user_message[:15] + ('...' if len(user_message) > 15 else '')
