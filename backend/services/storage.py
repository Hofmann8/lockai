"""
对象存储服务（阿里云 OSS，走 S3 兼容接口）
"""

import base64
import os
import re
import uuid
import boto3
from botocore.config import Config
from datetime import datetime
from typing import Optional
from urllib.parse import unquote


# 水印是桶里的一张白色透明 PNG（OSS 只能用同桶里的位图做水印）
WATERMARK_KEY = "public/watermark.png"
WATERMARK_WIDTH_PCT = 15      # 水印宽度占原图的百分比
WATERMARK_OPACITY = 40
WATERMARK_MARGIN = 0.03       # 距右下角的边距，按原图尺寸的比例
WATERMARK_FALLBACK_MARGIN_PX = 24
BLUR = "r_30,s_30"


def strip_image_processing(url: str) -> str:
    """去掉水印 / 模糊之类的图片处理参数，得到原图地址。"""
    if not url or "?" not in url:
        return url
    base, query = url.split("?", 1)
    return base if "x-oss-process=" in query else url


def _oss_base64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


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
            region_name=os.environ.get("S3_REGION") or None,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            # OSS 只认虚拟主机风格；新版 boto3 默认附带的 CRC 校验头 OSS 不支持
            config=Config(
                s3={"addressing_style": "virtual"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
        )

    @property
    def available(self) -> bool:
        return self._client is not None and self.bucket is not None

    def upload_image(self, image_data: bytes, user_id: str = None, session_id: str = None, content_type: str = "image/png") -> Optional[dict]:
        """上传图片到 S3，返回 URL 和 key"""
        if not self.available:
            return None

        image_id = uuid.uuid4().hex

        # 根据 content_type 确定文件扩展名
        ext_map = {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
        }
        ext = ext_map.get(content_type, ".png")

        if user_id and session_id:
            s3_key = f"users/{user_id}/sessions/{session_id}/images/{image_id}{ext}"
        elif user_id:
            s3_key = f"users/{user_id}/images/{image_id}{ext}"
        else:
            date_prefix = datetime.now().strftime("%Y/%m/%d")
            s3_key = f"ai-images/{date_prefix}/{image_id}{ext}"

        try:
            # 公开读由桶策略按目录放行（users/、public/），对象本身不设 ACL
            self._client.put_object(
                Bucket=self.bucket,
                Key=s3_key,
                Body=image_data,
                ContentType=content_type,
            )
            url = f"{self.public_url}/{s3_key}"
            print(f"[S3] 上传成功: {url}")
            return {"url": url, "s3_key": s3_key, "id": image_id}
        except Exception as e:
            print(f"[S3] 上传失败: {e}")
            return None

    def keys_in(self, *texts: str | None) -> set[str]:
        """从消息正文 / 图片列表 / 工具记录里找出指向本桶的对象 key。"""
        if not self.public_url:
            return set()
        pattern = re.compile(re.escape(self.public_url) + r"/([^\s\"'()?<>\]]+)")
        # 地址里的中文文件名是百分号编码的，对象 key 是原文
        return {unquote(key) for text in texts if text for key in pattern.findall(text)}

    def list_keys(self, prefix: str) -> set[str]:
        if not self.available:
            return set()
        keys = set()
        for page in self._client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            keys.update(item["Key"] for item in page.get("Contents", []))
        return keys

    def watermarked_url(self, url: str, width: int | None = None, height: int | None = None, blur: bool = False) -> str:
        """给图片地址加上水印（可选再模糊），由 OSS 实时处理，原图不变。"""
        mark = _oss_base64(f"{WATERMARK_KEY}?x-oss-process=image/resize,P_{WATERMARK_WIDTH_PCT}")
        margin_x = round(width * WATERMARK_MARGIN) if width else WATERMARK_FALLBACK_MARGIN_PX
        margin_y = round(height * WATERMARK_MARGIN) if height else WATERMARK_FALLBACK_MARGIN_PX
        process = f"image/watermark,image_{mark},g_se,x_{margin_x},y_{margin_y},t_{WATERMARK_OPACITY}"
        if blur:
            process += f"/blur,{BLUR}"
        return f"{strip_image_processing(url)}?x-oss-process={process}"

    def upload_bytes(self, data: bytes, s3_key: str, content_type: str = "application/octet-stream") -> dict | None:
        """Upload raw bytes to S3"""
        if not self.available:
            return None
        self._client.put_object(
            Bucket=self.bucket,
            Key=s3_key,
            Body=data,
            ContentType=content_type,
        )
        url = f"{self.public_url}/{s3_key}"
        return {"url": url, "s3_key": s3_key}

    def download_bytes(self, s3_key: str) -> bytes | None:
        """Download raw bytes from S3"""
        if not self.available:
            return None
        response = self._client.get_object(Bucket=self.bucket, Key=s3_key)
        return response['Body'].read()

    def presign(self, method: str, s3_key: str, expires: int = 900, content_type: str | None = None) -> str | None:
        """临时读写地址：交给沙箱用 curl 直接上传 / 下载，密钥不进沙箱。"""
        if not self.available:
            return None
        operation = {"GET": "get_object", "PUT": "put_object"}[method.upper()]
        params = {"Bucket": self.bucket, "Key": s3_key}
        if content_type:
            params["ContentType"] = content_type
        return self._client.generate_presigned_url(operation, Params=params, ExpiresIn=expires)

    def exists(self, s3_key: str) -> bool:
        if not self.available:
            return False
        try:
            self._client.head_object(Bucket=self.bucket, Key=s3_key)
            return True
        except Exception:
            return False

    def copy_object(self, source_key: str, target_key: str) -> bool:
        if not self.available:
            return False
        try:
            self._client.copy_object(Bucket=self.bucket, Key=target_key, CopySource={"Bucket": self.bucket, "Key": source_key})
            return True
        except Exception as e:
            print(f"[S3] 复制失败: {e}")
            return False

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
