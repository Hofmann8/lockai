"""
回答在后台跑：和浏览器的连接脱钩。

- 每轮回答是一个 Run，在自己的线程里把 ai.chat_stream 跑完，事件按顺序存下来。浏览器连着就实时转发；
  切到别的对话、刷新、关掉页面，回答照样往下做，回来时先把已有的事件重放一遍再接上实时。
- 一个用户同时最多 MAX_PER_USER 条回答在跑。再开新的必须停一条：用户在界面上选，没选就停跑得最久的。
  停之前已经写出来的内容和交付的文件都落库，工作区存好快照（OSS）后才释放沙箱。
- 单条回答最长 MAX_SECONDS，到点停下；全站同时最多 MAX_TOTAL 条，保护这台小机器和上游并发。
- 回答结束后事件再留 KEEP_FINISHED 秒，给刚好这时回来的页面重放。

注册表放在进程内存里：生产环境只有 1 个 worker（gunicorn.conf.py）。要开多个 worker 得换成 Redis 之类的共享存储。
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Iterable

from database import db

MAX_PER_USER = 3
MAX_TOTAL = 20
# 一整套物料这种大任务实测要 25～30 分钟；快到点前会提醒模型收尾（services/ai.py 的 WRAP_UP_*）
MAX_SECONDS = 60 * 60
KEEP_FINISHED = 5 * 60
# 同一段对话刚叫停又发新消息（插话、停止后马上重发）：等上一轮收尾的最长时间
STOP_GRACE = 20

HEARTBEAT = object()


class RunLimit(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


@dataclass
class Run:
    session_id: str
    user_id: str
    title: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    started_at: float = field(default_factory=time.time)
    events: list[dict[str, Any]] = field(default_factory=list)
    done: bool = False
    finished_at: float | None = None
    watchers: int = 0
    last_watched: float = field(default_factory=time.time)
    # user（用户点停止）/ discard（重新生成、编辑前丢弃）/ deleted（会话被删）/ evicted（被新回答挤掉）/ timeout
    stop_reason: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    finished: threading.Event = field(default_factory=threading.Event)

    def push(self, event: dict[str, Any]) -> None:
        with self.lock:
            self.events.append({**event, "ts": int(time.time() * 1000)})
            if event.get("type") == "title_update" and event.get("title"):
                self.title = str(event["title"])

    def finish(self) -> None:
        with self.lock:
            self.done = True
            self.finished_at = time.time()
        self.finished.set()

    def should_stop(self) -> bool:
        if self.stop_reason is None and time.time() - self.started_at > MAX_SECONDS:
            self.stop_reason = "timeout"
        return self.stop_reason is not None

    def request_stop(self, reason: str) -> None:
        if self.stop_reason is None:
            self.stop_reason = reason

    def read(self, cursor: int) -> tuple[list[dict[str, Any]], bool]:
        """cursor 之后的新事件，以及读完这些之后是不是已经结束了"""
        with self.lock:
            return self.events[cursor:], self.done

    @property
    def active(self) -> bool:
        return not self.done


class RunRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._runs: dict[str, Run] = {}  # session_id → 这个会话最近的一轮

    # ------------------------------------------------------------------ 查询

    def _prune(self) -> None:
        now = time.time()
        for session_id, run in list(self._runs.items()):
            if run.done and run.finished_at and now - run.finished_at > KEEP_FINISHED:
                del self._runs[session_id]

    def get(self, session_id: str) -> Run | None:
        with self._lock:
            self._prune()
            return self._runs.get(session_id)

    def running_sessions(self, user_id: str | None = None) -> set[str]:
        with self._lock:
            return {
                run.session_id for run in self._runs.values()
                if run.active and (user_id is None or run.user_id == user_id)
            }

    def running(self, user_id: str) -> list[Run]:
        """这个用户正在跑（没被叫停）的回答，跑得最久的在前"""
        with self._lock:
            mine = [r for r in self._runs.values() if r.active and r.stop_reason is None and r.user_id == user_id]
        return sorted(mine, key=lambda r: r.started_at)

    # ------------------------------------------------------------------ 开始 / 停止

    def start(
        self,
        *,
        session_id: str,
        user_id: str,
        title: str,
        work: Callable[[Run], Iterable[dict[str, Any]]],
        evict: str | None = None,
    ) -> tuple[Run, Run | None]:
        """
        开一轮回答。返回 (新的 run, 被停下的 run)。
        已经有 MAX_PER_USER 条在跑时必须停一条：evict 指定会话（用户在界面上选的），没指定就停跑得最久的。
        """
        stopping = self.get(session_id)
        if stopping and stopping.active and stopping.stop_reason:
            stopping.finished.wait(STOP_GRACE)
        with self._lock:
            self._prune()
            existing = self._runs.get(session_id)
            if existing and existing.active:
                raise RunLimit("这段对话还在回答中，等它结束或先停止")
            active = [r for r in self._runs.values() if r.active and r.stop_reason is None]
            mine = [r for r in active if r.user_id == user_id]
            evicted = None
            if len(mine) >= MAX_PER_USER:
                chosen = [r for r in mine if r.session_id == evict]
                evicted = chosen[0] if chosen else min(mine, key=lambda r: r.started_at)
                evicted.request_stop("evicted")
            if len(active) - (1 if evicted else 0) >= MAX_TOTAL:
                if evicted:
                    evicted.stop_reason = None
                raise RunLimit("现在同时在用的人比较多，稍等一会儿再试")
            run = Run(session_id=session_id, user_id=user_id, title=title)
            self._runs[session_id] = run

        threading.Thread(target=self._work, args=(run, work), name=f"run-{session_id[:8]}", daemon=True).start()
        return run, evicted

    def stop(self, session_id: str, reason: str = "user") -> bool:
        run = self.get(session_id)
        if not run or not run.active:
            return False
        run.request_stop(reason)
        return True

    @staticmethod
    def _work(run: Run, work: Callable[[Run], Iterable[dict[str, Any]]]) -> None:
        with db.scope():
            try:
                for event in work(run):
                    run.push(event)
            except Exception as exc:  # noqa: BLE001 - 原样告诉前端
                print(f"[Run] {run.session_id} 异常: {type(exc).__name__}: {exc}")
                run.push({"type": "error", "message": f"内部异常: {type(exc).__name__}: {exc}"})
            finally:
                run.finish()

    # ------------------------------------------------------------------ 订阅

    async def follow(
        self,
        run: Run,
        *,
        resume: bool = False,
        heartbeat: float = 10.0,
        poll: float = 0.05,
    ) -> AsyncIterator[Any]:
        """
        从头读这一轮的事件，读完已有的就等新的，直到结束。
        resume=True（回到正在回答的对话）时，先发一条 resume（开始时间），已有事件发完后发 replay_done，
        前端据此把重放部分一次性铺出来，不走逐字动画。
        断开只是少了一个观众，回答本身不受影响。
        """
        with self._lock:
            run.watchers += 1
            run.last_watched = time.time()
        cursor = 0
        idle_since = time.monotonic()
        try:
            if resume:
                yield {"type": "resume", "started_at": int(run.started_at * 1000), "now": int(time.time() * 1000)}
                backlog, _ = run.read(0)
                for event in backlog:
                    yield event
                cursor = len(backlog)
                yield {"type": "replay_done"}
            while True:
                events, done = run.read(cursor)
                if events:
                    cursor += len(events)
                    idle_since = time.monotonic()
                    for event in events:
                        yield event
                    continue
                if done:
                    return
                if time.monotonic() - idle_since >= heartbeat:
                    idle_since = time.monotonic()
                    yield HEARTBEAT
                await asyncio.sleep(poll)
        finally:
            with self._lock:
                run.watchers = max(0, run.watchers - 1)
                run.last_watched = time.time()


runs = RunRegistry()
