"""
Campbell 配额用量服务

规则：
- Campbell 1.5 (Claude) 主模型一次成功调用 = 1 credit
- Campbell 1.5/2.0 Image 出图成功一次 = 5 credits
- Scooby / Leo 主模型调用 = 免费
- 失败不扣
- 日额 100 credits，0 点（Asia/Shanghai）重置
- 月额 1000 credits，每月 1 号 0 点重置
"""

from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from models import db, CampbellUsage


SHANGHAI_TZ = timezone(timedelta(hours=8))

IMAGE_CREDIT_COST = 5
CHAT_CREDIT_COST = 1

DAILY_LIMIT = int(os.getenv("CAMPBELL_DAILY_LIMIT", "100"))
MONTHLY_LIMIT = int(os.getenv("CAMPBELL_MONTHLY_LIMIT", "1000"))


def _now_sh() -> datetime:
    return datetime.now(SHANGHAI_TZ)


def _today_key() -> str:
    return _now_sh().strftime("%Y-%m-%d")


def _month_prefix() -> str:
    return _now_sh().strftime("%Y-%m")


class QuotaError(Exception):
    def __init__(self, scope: str, message: str):
        super().__init__(message)
        self.scope = scope  # "daily" | "monthly"


class UsageService:
    """配额查询 / 扣减 / 拦截。"""

    DAILY_LIMIT = DAILY_LIMIT
    MONTHLY_LIMIT = MONTHLY_LIMIT
    IMAGE_COST = IMAGE_CREDIT_COST
    CHAT_COST = CHAT_CREDIT_COST

    @staticmethod
    def _credits(chat_calls: int, image_calls: int) -> int:
        return chat_calls * CHAT_CREDIT_COST + image_calls * IMAGE_CREDIT_COST

    def get_today(self, user_id: str) -> dict:
        day = _today_key()
        row = CampbellUsage.query.filter_by(user_id=user_id, day=day).first()
        chat = row.chat_calls if row else 0
        image = row.image_calls if row else 0
        return {
            "day": day,
            "chat_calls": chat,
            "image_calls": image,
            "credits": self._credits(chat, image),
        }

    def get_month(self, user_id: str) -> dict:
        prefix = _month_prefix()
        rows = (
            db.session.query(
                func.coalesce(func.sum(CampbellUsage.chat_calls), 0),
                func.coalesce(func.sum(CampbellUsage.image_calls), 0),
            )
            .filter(CampbellUsage.user_id == user_id)
            .filter(CampbellUsage.day.like(f"{prefix}-%"))
            .first()
        )
        chat = int(rows[0] or 0)
        image = int(rows[1] or 0)
        return {
            "month": prefix,
            "chat_calls": chat,
            "image_calls": image,
            "credits": self._credits(chat, image),
        }

    def get_summary(self, user_id: str) -> dict:
        today = self.get_today(user_id)
        month = self.get_month(user_id)
        return {
            "today": today,
            "month": month,
            "limits": {
                "daily": DAILY_LIMIT,
                "monthly": MONTHLY_LIMIT,
                "chat_cost": CHAT_CREDIT_COST,
                "image_cost": IMAGE_CREDIT_COST,
            },
            "remaining": {
                "daily": max(0, DAILY_LIMIT - today["credits"]),
                "monthly": max(0, MONTHLY_LIMIT - month["credits"]),
            },
        }

    def check(self, user_id: str, cost: int) -> tuple[bool, str | None, str | None]:
        """检查再扣 cost credits 是否会超额。返回 (ok, scope, message)。"""
        if not user_id:
            return True, None, None
        if cost <= 0:
            return True, None, None
        today = self.get_today(user_id)
        month = self.get_month(user_id)
        if today["credits"] + cost > DAILY_LIMIT:
            return False, "daily", (
                f"今日 Campbell 额度已用完（{today['credits']}/{DAILY_LIMIT}），"
                "明早 0 点重置。你可以切换 Scooby 或 Leo 继续使用。"
            )
        if month["credits"] + cost > MONTHLY_LIMIT:
            return False, "monthly", (
                f"本月 Campbell 额度已用完（{month['credits']}/{MONTHLY_LIMIT}），"
                "下月 1 号重置。你可以切换 Scooby 或 Leo 继续使用。"
            )
        return True, None, None

    def _increment(self, user_id: str, chat_delta: int = 0, image_delta: int = 0) -> None:
        if not user_id:
            return
        if chat_delta == 0 and image_delta == 0:
            return
        day = _today_key()
        for _ in range(2):
            row = CampbellUsage.query.filter_by(user_id=user_id, day=day).first()
            if row is None:
                row = CampbellUsage(
                    user_id=user_id,
                    day=day,
                    chat_calls=max(0, chat_delta),
                    image_calls=max(0, image_delta),
                )
                db.session.add(row)
                try:
                    db.session.commit()
                    return
                except IntegrityError:
                    db.session.rollback()
                    continue
            row.chat_calls = (row.chat_calls or 0) + chat_delta
            row.image_calls = (row.image_calls or 0) + image_delta
            db.session.commit()
            return

    def record_chat_call(self, user_id: str) -> None:
        self._increment(user_id, chat_delta=1)

    def record_image_call(self, user_id: str) -> None:
        self._increment(user_id, image_delta=1)
