"""
Gemini AI Service
Handles communication with Google Gemini API for chat and paper assistance.
"""

import os
from google import genai
from google.genai import types


class GeminiService:
    """Service for interacting with Google Gemini AI model."""
    
    def __init__(self):
        self.model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
        self.temperature = float(os.environ.get("GEMINI_TEMPERATURE", "0.7"))
        self.max_tokens = int(os.environ.get("GEMINI_MAX_TOKENS", "2048"))
    
    def _get_client(self):
        """Get configured Gemini client."""
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return None
        return genai.Client(api_key=api_key)
    
    def _convert_history_to_gemini_format(self, history: list) -> list:
        """Convert frontend chat history to Gemini SDK format."""
        gemini_history = []
        for item in history:
            role = "user" if item["role"] == "user" else "model"
            gemini_history.append(
                types.Content(role=role, parts=[types.Part.from_text(text=item["content"])])
            )
        return gemini_history
    
    def chat(self, message: str, history: list = None) -> dict:
        """
        Send a chat message to Gemini and get a response.
        
        Args:
            message: The user's message
            history: Optional list of previous messages
            
        Returns:
            dict with "message" key on success, or "error" and "code" keys on failure
        """
        client = self._get_client()
        if not client:
            return {
                "error": "Gemini API 密钥未配置",
                "code": "SERVICE_UNAVAILABLE"
            }
        
        config = types.GenerateContentConfig(
            temperature=self.temperature,
            max_output_tokens=self.max_tokens,
        )
        
        gemini_history = []
        if history:
            gemini_history = self._convert_history_to_gemini_format(history)
        
        gemini_history.append(
            types.Content(role="user", parts=[types.Part.from_text(text=message)])
        )
        
        response = client.models.generate_content(
            model=self.model_name,
            contents=gemini_history,
            config=config
        )
        return {"message": response.text}
    
    def paper_assist(self, text: str, action: str) -> dict:
        """
        Get AI assistance for paper content.
        
        Args:
            text: The selected text from the paper
            action: One of "explain", "summarize", "translate"
            
        Returns:
            dict with "result" key on success, or "error" and "code" keys on failure
        """
        client = self._get_client()
        if not client:
            return {
                "error": "Gemini API 密钥未配置",
                "code": "SERVICE_UNAVAILABLE"
            }
        
        prompts = {
            "explain": f"请详细解释以下学术内容，使用通俗易懂的语言：\n\n{text}",
            "summarize": f"请简洁地总结以下内容的要点：\n\n{text}",
            "translate": f"请将以下内容翻译成中文（如果已是中文则翻译成英文）：\n\n{text}"
        }
        
        prompt = prompts.get(action)
        if not prompt:
            return {
                "error": "无效的操作类型",
                "code": "INVALID_REQUEST"
            }
        
        config = types.GenerateContentConfig(
            temperature=self.temperature,
            max_output_tokens=self.max_tokens,
        )
        
        response = client.models.generate_content(
            model=self.model_name,
            contents=prompt,
            config=config
        )
        return {"result": response.text}
