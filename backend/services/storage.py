"""
S3 存储服务
"""

import os
import uuid
import boto3
from datetime import datetime
from typing import Optional


class StorageService:
    """S3 兼容存储服务"""
    
    def __init__(self):
        self._client = self._init_client()
        self.bucket = os.environ.get("S3_BUCKET")
        self.public_url = os.environ.get("S3_PUBLIC_URL", "").rstrip("/")
    
    def _init_client(self):
        """初始化 S3 客户端"""
        endpoint = os.environ.get("S3_ENDPOINT")
        access_key = os.environ.get("S3_ACCESS_KEY")
        secret_key = os.environ.get("S3_SECRET_KEY")
        
        if not all([endpoint, access_key, secret_key]):
            print("[S3] 未配置 S3 存储，图片将无法保存")
            return None
        
        return boto3.client(
            's3',
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key
        )
    
    @property
    def available(self) -> bool:
        return self._client is not None and self.bucket is not None
    
    def upload_image(self, image_data: bytes, user_id: str = None, session_id: str = None, content_type: str = "image/png") -> Optional[dict]:
        """上传图片到 S3，返回 URL 和 key"""
        if not self.available:
            return None
        
        image_id = uuid.uuid4().hex
        
        if user_id and session_id:
            s3_key = f"users/{user_id}/sessions/{session_id}/images/{image_id}.png"
        elif user_id:
            s3_key = f"users/{user_id}/images/{image_id}.png"
        else:
            date_prefix = datetime.now().strftime("%Y/%m/%d")
            s3_key = f"ai-images/{date_prefix}/{image_id}.png"
        
        try:
            self._client.put_object(
                Bucket=self.bucket,
                Key=s3_key,
                Body=image_data,
                ContentType=content_type,
                ACL='public-read'
            )
            url = f"{self.public_url}/{s3_key}"
            print(f"[S3] 上传成功: {url}")
            return {"url": url, "s3_key": s3_key, "id": image_id}
        except Exception as e:
            print(f"[S3] 上传失败: {e}")
            return None
    
    def delete_object(self, s3_key: str) -> bool:
        """删除 S3 对象"""
        if not self.available:
            return False
        
        try:
            self._client.delete_object(Bucket=self.bucket, Key=s3_key)
            print(f"[S3] 删除成功: {s3_key}")
            return True
        except Exception as e:
            print(f"[S3] 删除失败: {e}")
            return False
