"""Campbell 周额：按档位给额度，周期从上个周期结束后第一次扣费开始滚动 7 天。"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta

import pytest

from database import db
from models import CampbellQuota
from services import usage as usage_module
from services.usage import TIERS, UsageService

UNITS_PER_CREDIT = usage_module.TOKENS_PER_CREDIT


@pytest.fixture()
def service():
    path = os.path.join(tempfile.mkdtemp(prefix="lockai_quota_"), "quota.db")
    db.init("sqlite:///" + path.replace("\\", "/"))
    db.create_all()
    with db.scope():
        yield UsageService()


def _spend(service, user, credits):
    service.record_fixed_call(user, credits * UNITS_PER_CREDIT)


def test_tiers_are_200_1000_10000():
    assert [(TIERS[k]["name"], TIERS[k]["weekly"]) for k in (1, 2, 3)] == [("标准", 200), ("加量", 1000), ("畅用", 10000)]


def test_no_window_until_first_charge(service):
    summary = service.get_summary("u1")
    assert summary["tier"] == {"level": 1, "name": "标准", "weekly": 200}
    assert summary["week"]["credits"] == 0 and summary["resets_at"] is None
    assert summary["remaining"]["weekly"] == 200
    # 旧客户端读的字段还在
    assert summary["limits"]["daily"] == summary["limits"]["monthly"] == 200


def test_first_charge_starts_a_seven_day_window(service):
    before = datetime.utcnow()
    _spend(service, "u1", 30)
    row = db.session.get(CampbellQuota, "u1")
    assert before <= row.window_started_at <= datetime.utcnow()
    week = service.get_week("u1")
    assert week["credits"] == 30
    resets = datetime.fromisoformat(week["resets_at"].replace("Z", ""))
    assert abs((resets - row.window_started_at) - timedelta(days=7)) < timedelta(seconds=1)
    # 同一周期内继续累加，开始时间不变
    started = row.window_started_at
    _spend(service, "u1", 20)
    assert service.get_week("u1")["credits"] == 50
    assert db.session.get(CampbellQuota, "u1").window_started_at == started


def test_limit_blocks_and_names_the_reset_time(service):
    _spend(service, "u1", 199)
    assert service.check("u1", 1)[0] is True
    ok, scope, message = service.check("u1", 2)
    assert not ok and scope == "weekly"
    assert "本周 Campbell 额度已用完（199/200）" in message and "重置" in message


def test_expired_window_resets_on_next_charge(service):
    _spend(service, "u1", 200)
    assert service.check("u1", 1)[0] is False
    row = db.session.get(CampbellQuota, "u1")
    row.window_started_at = datetime.utcnow() - timedelta(days=7, seconds=1)
    db.session.commit()
    # 周期过了：额度恢复，但新周期要等下一次扣费才开始
    assert service.check("u1", 1)[0] is True
    assert service.get_week("u1")["resets_at"] is None
    _spend(service, "u1", 5)
    assert service.get_week("u1")["credits"] == 5
    assert db.session.get(CampbellQuota, "u1").window_started_at > datetime.utcnow() - timedelta(minutes=1)


def test_tier_raises_the_limit(service):
    _spend(service, "admin", 500)
    assert service.check("admin", 1)[0] is False
    assert service.set_tier("admin", 3)["name"] == "畅用"
    assert service.check("admin", 1)[0] is True
    assert service.get_summary("admin")["remaining"]["weekly"] == 9500
    with pytest.raises(ValueError):
        service.set_tier("admin", 4)


def test_failed_calls_and_zero_units_do_not_start_a_window(service):
    service.record_fixed_call("u1", 0)
    assert service.get_week("u1")["resets_at"] is None
