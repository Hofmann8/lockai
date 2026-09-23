"""
标题与追问建议生成服务（都走免费的小模型）
"""

import json
import re

from .prompts import get_followup_prompt, get_title_prompt


class TitleService:
    """对话标题生成服务"""
    
    def __init__(self, llm_service):
        self.llm = llm_service
    
    def generate(self, user_message: str) -> str:
        """根据用户消息生成对话标题"""
        # 截取并清理用户消息，用分隔符隔离防止 prompt injection
        sanitized = user_message[:100].replace('\n', ' ')
        messages = [
            {"role": "system", "content": get_title_prompt()},
            {"role": "user", "content": f"提取以下文本的主题作为标题：\n---\n{sanitized}\n---"}
        ]
        
        print(f"[Title] 生成标题...")
        
        result = self.llm.complete(
            messages,
            model="title_generator",
            temperature=0.3,
            max_tokens=20,
            enable_thinking=False,
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

    def suggest_followups(self, user_message: str, assistant_message: str) -> list[str]:
        """根据最后一轮问答生成至多 3 条追问。失败时返回空列表，前端就不显示。"""
        question = user_message.strip()[:600]
        answer = assistant_message.strip()[:1800]
        messages = [
            {"role": "system", "content": get_followup_prompt()},
            {"role": "user", "content": f"【用户的问题】\n{question}\n\n【助手的回答】\n{answer}"},
        ]
        result = self.llm.complete(
            messages,
            model="title_generator",
            temperature=0.6,
            max_tokens=160,
            enable_thinking=False,
        )
        return self._parse_followups(result or "")

    @staticmethod
    def _parse_followups(raw: str) -> list[str]:
        text = raw.strip()
        items: list[str] = []
        match = re.search(r"\[.*\]", text, re.S)
        if match:
            try:
                parsed = json.loads(match.group(0))
                if isinstance(parsed, list):
                    items = [str(item) for item in parsed]
            except (TypeError, ValueError):
                items = []
        if not items:
            items = [line for line in text.splitlines() if line.strip()]
        cleaned: list[str] = []
        for item in items:
            item = re.sub(r"^\s*(?:[-*•]|\d+[.、)])\s*", "", item).strip().strip("\"'「」")
            if 2 <= len(item) <= 40 and item not in cleaned:
                cleaned.append(item)
        return cleaned[:3]
