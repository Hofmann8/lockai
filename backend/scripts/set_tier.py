"""
设置用户的 Campbell 额度档位（不是付费等级，由管理员按需要给）。

档位：1 标准（每周 200 credits，默认）、2 加量（1000）、3 畅用（10000），定义在 services/usage.py 的 TIERS。
user_id 是 LockAuth 的用户编号（LockAI 里 users/<id>/ 的那个数）。

用法（在 backend 目录下）：
    python scripts/set_tier.py --db instance/lockai.db --list
    python scripts/set_tier.py --db instance/lockai.db --user 1 --tier 3
"""

import argparse
import sqlite3
import sys

TIER_NAMES = {1: "标准", 2: "加量", 3: "畅用"}

# 和 models.CampbellQuota 一致；后端还没用新代码启动过时表不存在，这里先建上
DDL = """
CREATE TABLE IF NOT EXISTS campbell_quotas (
    user_id VARCHAR(36) NOT NULL PRIMARY KEY,
    tier INTEGER NOT NULL,
    window_started_at DATETIME,
    window_units FLOAT NOT NULL,
    updated_at DATETIME
)
"""


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="设置 Campbell 额度档位")
    parser.add_argument("--db", required=True, help="数据库文件，例如 instance/lockai.db")
    parser.add_argument("--user", help="LockAuth 用户编号")
    parser.add_argument("--tier", type=int, choices=sorted(TIER_NAMES), help="1 标准 / 2 加量 / 3 畅用")
    parser.add_argument("--list", action="store_true", help="列出不是默认档位的用户")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute(DDL)
    if args.user and args.tier:
        conn.execute(
            "INSERT INTO campbell_quotas (user_id, tier, window_units, updated_at) VALUES (?, ?, 0, datetime('now')) "
            "ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, updated_at = datetime('now')",
            (args.user, args.tier),
        )
        conn.commit()
        print(f"用户 {args.user} → {args.tier} {TIER_NAMES[args.tier]}")
    elif not args.list:
        parser.error("要么 --list，要么同时给 --user 和 --tier")
    if args.list or (args.user and args.tier):
        rows = conn.execute("SELECT user_id, tier FROM campbell_quotas WHERE tier != 1 ORDER BY tier DESC, user_id").fetchall()
        print("非默认档位：" + ("、".join(f"{u}（{TIER_NAMES.get(t, t)}）" for u, t in rows) if rows else "无"))
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
