"""
标题生成服务
"""

from .prompts import TITLE_SYSTEM_PROMPT


class TitleService:
    """对话标题生成服务"""
    
    def __init__(self, llm_service):
        self.llm = llm_service
    
    def generate(self, user_message: str) -> str:
        """根据用户消息生成对话标题"""
        messages = [
            {"role": "system", "content": TITLE_SYSTEM_PROMPT},
            {"role": "user", "content": user_message[:100]}
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
            if len(title) > 20:
                title = title[:20] + '...'
            print(f"[Title] 生成: {title}")
            return title
        
        # fallback
        return user_message[:15] + ('...' if len(user_message) > 15 else '')
