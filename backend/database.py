"""数据库层。

替代原来的 flask-sqlalchemy，但保留同样的用法，服务层代码不用改：
    db.Model / db.Column / db.String ...   声明模型
    db.session                             当前作用域的会话
    SomeModel.query.filter_by(...)         旧式查询
    db.create_all() / db.engine            建表与迁移

会话按"作用域"隔离：
    - HTTP 请求：由 app.py 的中间件为每个请求开一个作用域，请求结束（含 SSE 流发完）自动回收。
    - 后台线程（聊天流泵）：线程入口处用 `with db.scope():` 包起来。
    - 都没有时退化为按线程隔离，和 scoped_session 默认行为一致。
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Iterator

import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, relationship, scoped_session, sessionmaker

BACKEND_DIR = Path(__file__).resolve().parent
# flask-sqlalchemy 把相对路径的 SQLite 放在 instance/ 下，生产库就在 instance/lockai.db，这里沿用同一规则
INSTANCE_DIR = BACKEND_DIR / "instance"
DEFAULT_DATABASE_URL = "sqlite:///lockai.db"

_scope_token: ContextVar[object | None] = ContextVar("lockai_db_scope", default=None)


def _scopefunc() -> object:
    token = _scope_token.get()
    return token if token is not None else threading.get_ident()


def resolve_database_url(raw: str | None) -> str:
    """相对路径的 SQLite 解析到 instance/ 目录，其他 URL 原样返回。"""
    url = make_url(raw or DEFAULT_DATABASE_URL)
    if url.get_backend_name() == "sqlite":
        database = url.database or ""
        if database and database != ":memory:" and not database.startswith("file:") and not os.path.isabs(database):
            INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
            url = url.set(database=str(INSTANCE_DIR / database))
    return url.render_as_string(hide_password=False)


class Base(DeclarativeBase):
    """所有模型的基类。"""


class Database:
    # 让 models.py 继续写 db.Column / db.String 这类声明
    Column = sa.Column
    String = sa.String
    Text = sa.Text
    Integer = sa.Integer
    Float = sa.Float
    Boolean = sa.Boolean
    DateTime = sa.DateTime
    ForeignKey = sa.ForeignKey
    UniqueConstraint = sa.UniqueConstraint
    relationship = staticmethod(relationship)

    def __init__(self) -> None:
        self.Model = Base
        self.engine: sa.Engine | None = None
        self._factory = sessionmaker()
        self.session: scoped_session[Session] = scoped_session(self._factory, scopefunc=_scopefunc)
        Base.query = self.session.query_property()

    def init(self, url: str | None = None) -> sa.Engine:
        """按 DATABASE_URL 建引擎。重复调用会先释放旧引擎（测试里换库用）。"""
        resolved = resolve_database_url(url or os.environ.get("DATABASE_URL"))
        kwargs: dict = {}
        if resolved.startswith("sqlite"):
            # 同一个会话会先后在请求线程和流式输出线程里用到（串行，不并发），SQLite 默认会拦
            kwargs["connect_args"] = {"check_same_thread": False}
        if self.engine is not None:
            self.session.remove()
            self.engine.dispose()
        self.engine = sa.create_engine(resolved, **kwargs)
        self._factory.configure(bind=self.engine)
        return self.engine

    def create_all(self) -> None:
        if self.engine is None:
            raise RuntimeError("数据库未初始化，先调用 db.init()")
        self.Model.metadata.create_all(self.engine)

    @contextmanager
    def scope(self) -> Iterator[scoped_session[Session]]:
        """开一个独立的会话作用域，退出时回收会话（未提交的改动会回滚）。"""
        token = _scope_token.set(object())
        try:
            yield self.session
        finally:
            self.session.remove()
            _scope_token.reset(token)


db = Database()
