"""
Campbell 配额用量服务

计费口径（2026-09 起）：按上游真实 token 用量折算，不再按调用次数。

计费量（units）以「gpt-6-astra 的输入 token」为 1 单位，各模型权重写在 models.json
的 billing 字段里，与上游价目表成正比：

    gpt-6-astra        输入 1    缓存输入 0.1   输出 5    （$10 / $1 / $50 每百万）
    gpt-image-2.5-*    输入 0.5  输出 3                   （$5 / $30 每百万）

    credits = units / TOKENS_PER_CREDIT

规则：
- 1 credit = 5000 units，普通一问一答约 1 credit
- 出图不足 IMAGE_MIN_CREDITS 的按下限计，因为一张图要占住 worker 数十秒
- Scooby 免费（models.json 未标 billable）
- 失败不扣
- 只有周额，按档位：标准 200（默认）、加量 1000、畅用 10000 credits，由管理员设置，见 scripts/set_tier.py
- 周期滚动计算：上一个周期结束后第一次扣费时开始，7 天后重置
"""

from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from models import db, CampbellQuota, CampbellUsage


SHANGHAI_TZ = timezone(timedelta(hours=8))

TOKENS_PER_CREDIT = float(os.getenv("CREDIT_TOKEN_SCALE", "5000"))
IMAGE_MIN_CREDITS = float(os.getenv("IMAGE_MIN_CREDITS", "2"))

# 档位：等级 → 名字和每周额度（credits）
TIERS: dict[int, dict] = {
    1: {"name": "标准", "weekly": 200},
    2: {"name": "加量", "weekly": 1000},
    3: {"name": "畅用", "weekly": 10000},
}
DEFAULT_TIER = 1
WINDOW = timedelta(days=7)

# models.json 未配置 billing 时的兜底权重（按 gpt-6-astra）
DEFAULT_WEIGHTS = {"input": 1.0, "cached_input": 0.1, "output": 5.0}


def _now_sh() -> datetime:
    return datetime.now(SHANGHAI_TZ)


def _today_key() -> str:
    return _now_sh().strftime("%Y-%m-%d")


def _month_prefix() -> str:
    return _now_sh().strftime("%Y-%m")


def _iso_utc(value: datetime | None) -> str | None:
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _reset_label(resets_at: datetime) -> str:
    """给用户看的重置时间（北京时间）：11月20日 14:05"""
    local = resets_at.replace(tzinfo=timezone.utc).astimezone(SHANGHAI_TZ)
    return f"{local.month}月{local.day}日 {local:%H:%M}"


def tier_of(level: int | None) -> dict:
    level = level if level in TIERS else DEFAULT_TIER
    return {"level": level, **TIERS[level]}


def parse_usage(raw: dict | None) -> dict[str, int]:
    """把上游返回的 usage 拆成 新增输入 / 缓存输入 / 输出 三段。"""
    if not isinstance(raw, dict):
        return {"new_input": 0, "cached_input": 0, "output": 0}
    prompt = int(raw.get("prompt_tokens") or raw.get("input_tokens") or 0)
    details = raw.get("prompt_tokens_details") or raw.get("input_tokens_details") or {}
    cached = int(details.get("cached_tokens") or 0) if isinstance(details, dict) else 0
    # Anthropic 原生把缓存命中放在顶层 cache_read_input_tokens
    cached = cached or int(raw.get("cache_read_input_tokens") or 0)
    cached = max(0, min(cached, prompt))
    output = int(raw.get("completion_tokens") or raw.get("output_tokens") or 0)
    return {"new_input": prompt - cached, "cached_input": cached, "output": output}


def weights_of(model_cfg: dict | None) -> dict[str, float]:
    billing = (model_cfg or {}).get("billing")
    if not isinstance(billing, dict):
        return dict(DEFAULT_WEIGHTS)
    return {
        "input": float(billing.get("input", DEFAULT_WEIGHTS["input"])),
        "cached_input": float(billing.get("cached_input", 0.0)),
        "output": float(billing.get("output", DEFAULT_WEIGHTS["output"])),
    }


def units_of(usage: dict[str, int], weights: dict[str, float]) -> dict[str, float]:
    return {
        "new_input_units": usage["new_input"] * weights["input"],
        "cached_input_units": usage["cached_input"] * weights["cached_input"],
        "output_units": usage["output"] * weights["output"],
    }


class QuotaError(Exception):
    def __init__(self, scope: str, message: str):
        super().__init__(message)
        self.scope = scope  # "weekly"


class UsageService:
    """配额查询 / 扣减 / 拦截。"""

    TOKENS_PER_CREDIT = TOKENS_PER_CREDIT
    IMAGE_MIN_CREDITS = IMAGE_MIN_CREDITS
    # 预检时假定的最小开销：聊天按一轮中位值，出图按下限
    CHAT_COST = 1.0
    IMAGE_COST = IMAGE_MIN_CREDITS

    @staticmethod
    def credits_of(units: float) -> float:
        return round((units or 0.0) / TOKENS_PER_CREDIT, 2)

    def _day_row(self, user_id: str, day: str):
        return CampbellUsage.query.filter_by(user_id=user_id, day=day).first()

    def get_today(self, user_id: str) -> dict:
        day = _today_key()
        row = self._day_row(user_id, day)
        units = row.billed_units if row else 0.0
        return {
            "day": day,
            "chat_calls": row.chat_calls if row else 0,
            "image_calls": row.image_calls if row else 0,
            "units": round(units, 1),
            "credits": self.credits_of(units),
        }

    def get_month(self, user_id: str) -> dict:
        prefix = _month_prefix()
        row = (
            db.session.query(
                func.coalesce(func.sum(CampbellUsage.chat_calls), 0),
                func.coalesce(func.sum(CampbellUsage.image_calls), 0),
                func.coalesce(func.sum(CampbellUsage.new_input_units), 0.0),
                func.coalesce(func.sum(CampbellUsage.cached_input_units), 0.0),
                func.coalesce(func.sum(CampbellUsage.output_units), 0.0),
                func.coalesce(func.sum(CampbellUsage.floor_units), 0.0),
            )
            .filter(CampbellUsage.user_id == user_id)
            .filter(CampbellUsage.day.like(f"{prefix}-%"))
            .first()
        )
        units = float(row[2] or 0) + float(row[3] or 0) + float(row[4] or 0) + float(row[5] or 0)
        return {
            "month": prefix,
            "chat_calls": int(row[0] or 0),
            "image_calls": int(row[1] or 0),
            "units": round(units, 1),
            "credits": self.credits_of(units),
        }

    # ---------------- 周期额度 ----------------

    @staticmethod
    def _quota_row(user_id: str):
        return db.session.get(CampbellQuota, user_id)

    @staticmethod
    def _active_window(row, now: datetime) -> tuple[datetime | None, float]:
        """当前周期的开始时间和已用量；没有进行中的周期返回 (None, 0)"""
        if row is None or row.window_started_at is None or now >= row.window_started_at + WINDOW:
            return None, 0.0
        return row.window_started_at, float(row.window_units or 0.0)

    def get_tier(self, user_id: str) -> dict:
        row = self._quota_row(user_id) if user_id else None
        return tier_of(row.tier if row else None)

    def get_week(self, user_id: str) -> dict:
        row = self._quota_row(user_id) if user_id else None
        started, units = self._active_window(row, datetime.utcnow())
        resets_at = started + WINDOW if started else None
        return {
            "units": round(units, 1),
            "credits": self.credits_of(units),
            "started_at": _iso_utc(started),
            "resets_at": _iso_utc(resets_at),
        }

    def set_tier(self, user_id: str, level: int) -> dict:
        if level not in TIERS:
            raise ValueError(f"档位只能是 {sorted(TIERS)}")
        row = self._quota_row(user_id)
        if row is None:
            row = CampbellQuota(user_id=user_id, tier=level, window_units=0.0)
            db.session.add(row)
        else:
            row.tier = level
        db.session.commit()
        return tier_of(level)

    def get_summary(self, user_id: str) -> dict:
        tier = self.get_tier(user_id)
        week = self.get_week(user_id)
        limit = tier["weekly"]
        remaining = max(0.0, round(limit - week["credits"], 2))
        return {
            "tier": tier,
            "week": week,
            "today": self.get_today(user_id),
            "month": self.get_month(user_id),
            "limits": {
                "weekly": limit,
                # 旧版客户端（LockAI Desktop）还按日额 / 月额读：都给周额，免得报错
                "daily": limit,
                "monthly": limit,
                "tokens_per_credit": TOKENS_PER_CREDIT,
                "image_min_credits": IMAGE_MIN_CREDITS,
            },
            "remaining": {"weekly": remaining, "daily": remaining, "monthly": remaining},
            "resets_at": week["resets_at"],
        }

    def check(self, user_id: str, cost: float = 0.0) -> tuple[bool, str | None, str | None]:
        """检查再花 cost credits 是否会超额。返回 (ok, scope, message)。"""
        if not user_id:
            return True, None, None
        row = self._quota_row(user_id)
        limit = tier_of(row.tier if row else None)["weekly"]
        started, units = self._active_window(row, datetime.utcnow())
        used = self.credits_of(units)
        if used + cost > limit:
            when = f"{_reset_label(started + WINDOW)} 重置" if started else "额度不足"
            return False, "weekly", (
                f"本周 Campbell 额度已用完（{used:g}/{limit}），{when}。你可以切换 Scooby 继续使用。"
            )
        return True, None, None

    def _charge_window(self, user_id: str, units: float) -> None:
        """记进当前周期；上一个周期已经结束（或从没开始）就从现在开始新周期"""
        if units <= 0:
            return
        now = datetime.utcnow()
        row = self._quota_row(user_id)
        if row is None:
            row = CampbellQuota(user_id=user_id, tier=DEFAULT_TIER, window_units=0.0)
            db.session.add(row)
        if self._active_window(row, now)[0] is None:
            row.window_started_at = now
            row.window_units = 0.0
        row.window_units = (row.window_units or 0.0) + units

    def _accumulate(
        self,
        user_id: str,
        *,
        chat_delta: int = 0,
        image_delta: int = 0,
        new_input_units: float = 0.0,
        cached_input_units: float = 0.0,
        output_units: float = 0.0,
        floor_units: float = 0.0,
    ) -> None:
        if not user_id:
            return
        total = new_input_units + cached_input_units + output_units + floor_units
        day = _today_key()
        for _ in range(2):
            # 周期用量和日汇总在同一次提交里；插入日汇总冲突回滚时两者一起撤销，重试时一起重记
            self._charge_window(user_id, total)
            row = self._day_row(user_id, day)
            if row is None:
                row = CampbellUsage(
                    user_id=user_id,
                    day=day,
                    chat_calls=max(0, chat_delta),
                    image_calls=max(0, image_delta),
                    new_input_units=new_input_units,
                    cached_input_units=cached_input_units,
                    output_units=output_units,
                    floor_units=floor_units,
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
            row.new_input_units = (row.new_input_units or 0.0) + new_input_units
            row.cached_input_units = (row.cached_input_units or 0.0) + cached_input_units
            row.output_units = (row.output_units or 0.0) + output_units
            row.floor_units = (row.floor_units or 0.0) + floor_units
            db.session.commit()
            return

    def record_chat_call(self, user_id: str, raw_usage: dict | None = None,
                         model_cfg: dict | None = None) -> float:
        """记一次计费聊天请求，返回本次消耗的 credits。"""
        units = units_of(parse_usage(raw_usage), weights_of(model_cfg))
        self._accumulate(user_id, chat_delta=1, **units)
        return self.credits_of(sum(units.values()))

    def record_fixed_call(self, user_id: str, units: float) -> float:
        """按次计价的调用（作曲）：固定计费量记在 floor_units，不占新表字段。返回本次消耗的 credits。"""
        units = max(0.0, float(units or 0))
        self._accumulate(user_id, floor_units=units)
        return self.credits_of(units)

    def record_image_call(self, user_id: str, raw_usage: dict | None = None,
                          model_cfg: dict | None = None) -> float:
        """记一次出图，不足下限的按下限补足，返回本次消耗的 credits。"""
        units = units_of(parse_usage(raw_usage), weights_of(model_cfg))
        total = sum(units.values())
        floor_units = max(0.0, IMAGE_MIN_CREDITS * TOKENS_PER_CREDIT - total)
        self._accumulate(user_id, image_delta=1, floor_units=floor_units, **units)
        return self.credits_of(total + floor_units)
