"""
存储迁移：缤纷云 S3 → 阿里云 OSS。

都可重复执行：
1. copy：把旧桶里还有用的图片按原 key 拷到新桶。库里没人引用的死数据（会话早删了但图还在、
   论文模块遗留、旧 SVG 水印）不拷。新桶里已存在且大小一致的跳过，切换前再跑一遍就能补齐新图。
2. prune：删掉新桶里的死数据（之前没按死数据过滤拷过去的那批），旧桶不动。
3. rewrite-db：把库里所有指向旧桶的地址换成新桶地址，
   缤纷云的水印 / 模糊参数（?mark=…&blur=…）换成 OSS 的 x-oss-process。

死数据按 --db 指定的库判断，用最新的线上库；copy / prune 只读这个库，rewrite-db 会写它，先在副本上跑。
.env 里旧桶配置用 BITIFUL_S3_*，新桶用 S3_*（和线上服务同一套变量）。

用法：
    python scripts/migrate_bitiful_to_oss.py copy --db <库> [--apply]
    python scripts/migrate_bitiful_to_oss.py prune --db <库> [--apply]
    python scripts/migrate_bitiful_to_oss.py rewrite-db --db <库文件副本> [--apply]
默认只试算并打印，加 --apply 才真正拷贝 / 删除 / 写库。
"""

import argparse
import os
import re
import sqlite3
import sys

import boto3
from dotenv import load_dotenv

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)
load_dotenv(os.path.join(BACKEND_DIR, ".env"))

from services.image import ImageService  # noqa: E402
from services.storage import StorageService  # noqa: E402


def source_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["BITIFUL_S3_ENDPOINT"],
        aws_access_key_id=os.environ["BITIFUL_S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["BITIFUL_S3_SECRET_KEY"],
    )


def list_objects(client, bucket):
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        yield from page.get("Contents", [])


def find_dead_keys(db_path: str, objects: list[dict]) -> dict[str, str]:
    """旧桶里库中已经没人引用的对象 → 原因。

    只看早于库里最后一条消息的对象，库快照之后才上传的图一律当活的，宁可多留。
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    texts = []
    for (table,) in conn.execute("select name from sqlite_master where type='table'"):
        for column in [r[1] for r in conn.execute(f'pragma table_info("{table}")')]:
            texts.extend(v for (v,) in conn.execute(
                f'select cast("{column}" as text) from "{table}" where cast("{column}" as text) like ?', ("%users/%",)
            ))
    sessions = {r[0] for r in conn.execute("select id from chat_sessions")}
    snapshot = conn.execute("select max(created_at) from chat_messages").fetchone()[0] or ""
    conn.close()

    referenced = "\n".join(texts)
    dead = {}
    for o in objects:
        key = o["Key"]
        if o["LastModified"].strftime("%Y-%m-%d %H:%M:%S") >= snapshot[:19] or key in referenced:
            continue
        if "/papers/" in key:
            dead[key] = "论文模块已下线"
        elif (m := re.match(r"users/[^/]+/sessions/([^/]+)/", key)) and m.group(1) not in sessions:
            dead[key] = "会话已删除"
        else:
            dead[key] = "没有消息引用"
    return dead


def copy_objects(db_path: str, apply: bool):
    src, src_bucket = source_client(), os.environ["BITIFUL_S3_BUCKET"]
    dest = StorageService()
    existing = {o["Key"]: o["Size"] for o in list_objects(dest._client, dest.bucket)}
    objects = list(list_objects(src, src_bucket))
    dead = find_dead_keys(db_path, objects)

    todo = [
        o for o in objects
        if "/images/" in o["Key"] and o["Key"] not in dead and existing.get(o["Key"]) != o["Size"]
    ]
    print(f"旧桶 {len(objects)} 个对象，其中死数据 {len(dead)} 个不拷")
    total = sum(o["Size"] for o in todo)
    print(f"待拷贝 {len(todo)} 个对象，共 {total / 1e6:.1f} MB（新桶已有 {len(existing)} 个）")
    if not apply:
        for o in todo[:10]:
            print("  ", o["Key"])
        print("试算完毕，加 --apply 执行拷贝")
        return

    for i, o in enumerate(todo, 1):
        obj = src.get_object(Bucket=src_bucket, Key=o["Key"])
        dest._client.put_object(
            Bucket=dest.bucket,
            Key=o["Key"],
            Body=obj["Body"].read(),
            ContentType=obj.get("ContentType") or "application/octet-stream",
        )
        print(f"[{i}/{len(todo)}] {o['Key']}")
    print("拷贝完成")


def prune_objects(db_path: str, apply: bool):
    """删掉已经拷进新桶的死数据（只删新桶，旧桶不动）。"""
    src, src_bucket = source_client(), os.environ["BITIFUL_S3_BUCKET"]
    dest = StorageService()
    existing = {o["Key"]: o["Size"] for o in list_objects(dest._client, dest.bucket)}
    dead = find_dead_keys(db_path, list(list_objects(src, src_bucket)))

    todo = sorted(k for k in dead if k in existing)
    total = sum(existing[k] for k in todo)
    print(f"新桶里有 {len(todo)} 个死数据，共 {total / 1e6:.1f} MB")
    for key in todo:
        print(f"  [{dead[key]}] {key}  {existing[key] / 1e6:.2f} MB")
    if not apply:
        print("试算完毕，加 --apply 从新桶删除")
        return
    for key in todo:
        dest._client.delete_object(Bucket=dest.bucket, Key=key)
    print(f"已从新桶删除 {len(todo)} 个对象")


class _NoLLM:
    def get_model_config(self, _model_id):
        return {}


def rewrite_db(db_path: str, apply: bool):
    old_base = os.environ["BITIFUL_S3_PUBLIC_URL"].rstrip("/")
    storage = StorageService()
    pattern = re.compile(re.escape(old_base) + r"/([^\s\"'()?<>\]]+)(\?[^\s\"'()<>\]]*)?")

    src, src_bucket = source_client(), os.environ["BITIFUL_S3_BUCKET"]
    inspector = ImageService(_NoLLM(), storage)
    sizes: dict[str, tuple] = {}

    def image_size(key):
        # 水印边距按原图尺寸算，从旧桶读图拿宽高
        if key not in sizes:
            try:
                data = src.get_object(Bucket=src_bucket, Key=key)["Body"].read()
                meta = inspector._inspect_image_bytes(data, "")
                sizes[key] = (meta.get("width"), meta.get("height"))
            except Exception as exc:
                print(f"  读不到 {key} 的尺寸（{exc}），水印用默认边距")
                sizes[key] = (None, None)
        return sizes[key]

    def replace(match):
        key, query = match.group(1), match.group(2) or ""
        url = f"{storage.public_url}/{key}"
        if "mark=" in query:
            return storage.watermarked_url(url, *image_size(key), blur="blur=" in query)
        return url + query

    conn = sqlite3.connect(db_path)
    tables = [r[0] for r in conn.execute("select name from sqlite_master where type='table'")]
    changed = 0
    for table in tables:
        columns = [r[1] for r in conn.execute(f'pragma table_info("{table}")') if r[2].upper() in ("TEXT", "") or "CHAR" in r[2].upper()]
        for column in columns:
            rows = conn.execute(
                f'select rowid, "{column}" from "{table}" where "{column}" like ?', (f"%{old_base}%",)
            ).fetchall()
            for rowid, value in rows:
                new_value = pattern.sub(replace, value)
                if new_value != value:
                    changed += 1
                    if apply:
                        conn.execute(f'update "{table}" set "{column}" = ? where rowid = ?', (new_value, rowid))
            if rows:
                print(f"{table}.{column}: {len(rows)} 行含旧地址")

    left = 0
    if apply:
        conn.commit()
        for table in tables:
            for column in [r[1] for r in conn.execute(f'pragma table_info("{table}")')]:
                left += conn.execute(
                    f'select count(*) from "{table}" where cast("{column}" as text) like ?', (f"%{old_base}%",)
                ).fetchone()[0]
    conn.close()
    print(f"{'已改写' if apply else '将改写'} {changed} 个字段" + (f"，残留旧地址 {left} 处" if apply else "，加 --apply 写库"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("copy", "prune", "rewrite-db"):
        command = sub.add_parser(name)
        command.add_argument("--db", required=True)
        command.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if args.command == "copy":
        copy_objects(args.db, args.apply)
    elif args.command == "prune":
        prune_objects(args.db, args.apply)
    else:
        rewrite_db(args.db, args.apply)


if __name__ == "__main__":
    main()
