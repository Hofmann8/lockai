"""
图像生成服务
"""

import re
import base64
import httpx


class ImageService:
    """图像生成服务"""
    
    def __init__(self, llm_service, storage_service):
        self.llm = llm_service
        self.storage = storage_service
    
    def generate(self, prompt: str, user_id: str = None, session_id: str = None) -> dict:
        """调用图像生成模型，上传到 S3 返回 URL"""
        api_key = self.llm._get_api_key()
        if not api_key:
            return {"success": False, "error": "API 密钥未配置"}
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": self.llm.model_image,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.8,
            "max_tokens": 4096
        }
        
        print(f"\n[Image] 绘图: {prompt[:50]}...")
        
        try:
            with httpx.Client(timeout=120.0) as client:
                response = client.post(
                    f"{self.llm.base_url}/v1/chat/completions",
                    headers=headers,
                    json=payload
                )
                
                if response.status_code != 200:
                    print(f"[Image] 错误: {response.status_code}")
                    return {"success": False, "error": f"绘图失败: {response.status_code}"}
                
                data = response.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                
                image_bytes = self._extract_image(content)
                
                if not image_bytes:
                    print(f"[Image] 未能提取图片，返回内容: {content[:100]}...")
                    return {"success": False, "error": "未能生成图片，请重试"}
                
                print(f"[Image] 成功生成图片，大小: {len(image_bytes)} bytes")
                
                result = self.storage.upload_image(image_bytes, user_id, session_id)
                if result:
                    return {
                        "success": True, 
                        "image": result["url"],
                        "s3_key": result["s3_key"],
                        "image_id": result["id"],
                        "prompt": prompt
                    }
                else:
                    b64 = base64.b64encode(image_bytes).decode()
                    return {"success": True, "image": f"data:image/png;base64,{b64}"}
                
        except httpx.TimeoutException:
            return {"success": False, "error": "绘图超时，请重试"}
        except Exception as e:
            print(f"[Image] 异常: {type(e).__name__}: {e}")
            return {"success": False, "error": f"绘图失败: {str(e)}"}
    
    def _extract_image(self, content: str) -> bytes:
        """从响应内容中提取图片数据"""
        # 格式1: markdown 格式 ![](data:image/png;base64,xxx)
        if "](data:image" in content:
            match = re.search(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', content)
            if match:
                return base64.b64decode(match.group(1))
        
        # 格式2: 直接 data:image 开头
        if content.startswith("data:image"):
            match = re.search(r'base64,([A-Za-z0-9+/=]+)', content)
            if match:
                return base64.b64decode(match.group(1))
        
        # 格式3: 纯 base64
        if len(content) > 1000:
            clean = content.replace('\n', '').replace(' ', '')
            if re.match(r'^[A-Za-z0-9+/=]+$', clean):
                return base64.b64decode(clean)
        
        return None
