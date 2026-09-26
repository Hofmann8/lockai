"""请求体模型。

字段都给了默认值，业务上的必填校验仍在路由里做，这样错误提示和原来保持一致（前端直接展示 error 字段）。
类型不对的请求由 app.py 里的校验处理器统一转成 400 + error。
这些模型同时生成 /docs 里的接口文档。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class Body(BaseModel):
    def is_empty(self) -> bool:
        """对应原来的 `if not data`：请求体里一个字段都没给。"""
        return not self.model_fields_set


# ---------- 会话 ----------

class CreateSessionBody(Body):
    user_id: str | None = None
    title: str | None = "新对话"
    model_id: str | None = None


class UpdateSessionBody(Body):
    title: str | None = None
    model_id: str | None = None
    pinned: bool | None = None


class GenerateTitleBody(Body):
    user_message: str | None = ""
    assistant_message: str | None = ""


class TruncateBody(Body):
    message_id: str | None = None
    # 分支：True 时不含这条消息本身（重试 / 改写重发：从这条用户消息之前分出去，再重新发）
    exclusive: bool = False


class StopRunBody(Body):
    discard: bool = False


class AddMessageBody(Body):
    id: str | None = None
    role: str | None = None
    content: str | None = None
    images: list[Any] | None = None
    files: list[Any] | None = None
    tool_trace: list[Any] | None = None
    reasoning: str | None = None
    reasoning_seconds: int | None = None
    reasoning_tokens: int | None = None


class UploadImageBody(Body):
    image: str | None = None
    user_id: str | None = None
    session_id: str | None = None


# ---------- 聊天 ----------

class ChatBody(Body):
    message: str | None = None
    history: list[dict[str, Any]] | None = None
    model_id: str | None = None
    ai_role: str | None = None  # 旧字段名，兼容保留
    user_id: str | None = None
    session_id: str | None = None
    images: list[str] | None = None
    thinking: bool | None = None
    reasoning_effort: str | None = None
    current_message_id: str | None = None
    image_quality: str | None = None
    files: list[dict[str, Any]] | None = None  # 当前这条消息的附件
    delivery: str | None = None  # 交付偏好：quality（排版质量优先）/ editable（方便编辑优先）
    evict: str | None = None  # 同时回答已满时，用户选了要停下的那段对话（不填就停跑得最久的）


class SuggestionsBody(Body):
    user_message: str | None = ""
    assistant_message: str | None = ""
