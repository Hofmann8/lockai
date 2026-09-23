"""
历史配额回填：把 2026-09 之前按「调用次数」记的配额换算成 token 计费量。

旧表只有 chat_calls / image_calls，没有 token。这里从 chat_messages 里重建每一天
每个用户的真实上下文规模，按与线上一致的权重折算成 units，写回 campbell_usages，
并把 estimated 标记为 1，表示这批数据是估算值而非上游回传。

估算口径：
- 中文约 0.9 token / 字符（对照上游 usage 实测）
- 每轮输入 = 该会话此前全部消息长度；其中上一轮已发过的部分算缓存命中
- 出图按下限 IMAGE_MIN_CREDITS 计，历史没有图像 token 记录

用法：
    python scripts/backfill_usage_units.py --db instance/lockai.db [--apply]
默认只试算并打印对比，加 --apply 才写库。
"""

import argparse
import os
import sqlite3
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CHARS_PER_TOKEN = 0.9
W_INPUT = 1.0
W_CACHED = 0.1
W_OUTPUT = 5.0
TOKENS_PER_CREDIT = float(os.getenv("CREDIT_TOKEN_SCALE", "5000"))
IMAGE_MIN_CREDITS = float(os.getenv("IMAGE_MIN_CREDITS", "2"))


def estimate_units(conn):
    """按 (user_id, 日期) 汇总 Campbell 对话的计费量。"""
    rows = conn.execute(
        """
        select s.id, s.user_id, m.role, m.content, coalesce(m.tool_trace, ''), m.created_at
        from chat_messages m join chat_sessions s on m.session_id = s.id
        where s.model_id = 'campbell'
        order by s.id, m.created_at
        """
    ).fetchall()

    acc = defaultdict(lambda: {"new": 0.0, "cached": 0.0, "out": 0.0, "turns": 0})
    session = None
    ctx = prev = 0
    pending = None
    for sid, uid, role, content, trace, created in rows:
        if sid != session:
            session, ctx, prev, pending = sid, 0, 0, None
        size = len(content or "") + len(trace or "")
        if role == "user":
            ctx += size
            pending = (uid, (created or "")[:10], ctx - prev, prev)
        elif pending:
            uid, day, new_chars, cached_chars = pending
            bucket = acc[(uid, day)]
            bucket["new"] += new_chars * CHARS_PER_TOKEN * W_INPUT
            bucket["cached"] += cached_chars * CHARS_PER_TOKEN * W_CACHED
            bucket["out"] += size * CHARS_PER_TOKEN * W_OUTPUT
            bucket["turns"] += 1
            ctx += size
            prev = ctx
            pending = None
    return acc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="instance/lockai.db")
    parser.add_argument("--apply", action="store_true", help="写库；不加则只试算")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.text_factory = str
    columns = [r[1] for r in conn.execute("pragma table_info('campbell_usages')")]
    missing = [c for c in ("new_input_units", "cached_input_units", "output_units",
                           "floor_units", "estimated") if c not in columns]
    if missing:
        print(f"表还没迁移，缺少列：{missing}。先启动一次 app.py 让它建列。")
        return 1

    estimates = estimate_units(conn)
    targets = conn.execute(
        "select id, user_id, day, chat_calls, image_calls from campbell_usages "
        "where coalesce(new_input_units,0)=0 and coalesce(output_units,0)=0"
    ).fetchall()

    print(f"待回填行数：{len(targets)}；历史估算覆盖 {len(estimates)} 个「人-天」\n")
    print(f"{'用户':>6} {'日期':>12} {'旧credits':>10} {'新credits':>10} {'匹配到对话':>10}")
    updates = []
    matched = unmatched = 0
    for row_id, uid, day, chat_calls, image_calls in targets:
        est = estimates.get((uid, day))
        image_units = (image_calls or 0) * IMAGE_MIN_CREDITS * TOKENS_PER_CREDIT
        if est:
            matched += 1
            new_u, cached_u, out_u = est["new"], est["cached"], est["out"]
        else:
            # 没找到对应消息（会话已删），按旧口径等价折算，保证额度不凭空消失
            unmatched += 1
            new_u = (chat_calls or 0) * TOKENS_PER_CREDIT
            cached_u = out_u = 0.0
        old_credits = (chat_calls or 0) + 5 * (image_calls or 0)
        new_credits = (new_u + cached_u + out_u + image_units) / TOKENS_PER_CREDIT
        updates.append((new_u, cached_u, out_u, image_units, row_id))
        if len(updates) <= 12:
            print(f"{uid:>6} {day:>12} {old_credits:>10} {new_credits:>10.1f} {'是' if est else '否':>10}")

    total_old = sum((r[3] or 0) + 5 * (r[4] or 0) for r in targets)
    total_new = sum((u[0] + u[1] + u[2] + u[3]) / TOKENS_PER_CREDIT for u in updates)
    print(f"\n合计：旧口径 {total_old:.0f} credits -> 新口径 {total_new:.1f} credits")
    print(f"匹配到历史对话 {matched} 行，未匹配 {unmatched} 行（按旧口径等价折算）")

    if not args.apply:
        print("\n试算模式，未写库。确认无误后加 --apply。")
        return 0

    conn.executemany(
        "update campbell_usages set new_input_units=?, cached_input_units=?, "
        "output_units=?, floor_units=?, estimated=1 where id=?",
        updates,
    )
    conn.commit()
    print(f"\n已写入 {len(updates)} 行，estimated 标记为 1。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
