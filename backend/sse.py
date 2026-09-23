"""SSE（服务端推送）工具。

服务层都是同步生成器（httpx 同步客户端、SQLAlchemy 同步会话）。这里把它们放到后台线程里跑，
事件循环只负责转发，不会被一次十几分钟的高清出图卡住。
客户端断开时会通知后台线程停下，不再继续消耗上游 token。
"""

from __future__ import annotations

import asyncio
import threading
from queue import Empty, Queue
from typing import Any, AsyncIterator, Iterable

from fastapi.responses import StreamingResponse

from database import db

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

HEARTBEAT = object()
"""iterate_in_thread / poll_queue 在空闲超时时产出的哨兵，调用方据此写心跳帧。"""


class StreamFailed:
    """后台线程里的源生成器抛了异常。"""

    def __init__(self, exc: BaseException):
        self.exc = exc


def sse_response(body: AsyncIterator[str]) -> StreamingResponse:
    return StreamingResponse(body, media_type="text/event-stream", headers=SSE_HEADERS)


async def iterate_in_thread(source: Iterable[Any], *, heartbeat: float | None = None) -> AsyncIterator[Any]:
    """在后台线程里迭代同步生成器，逐个产出元素。

    - 空闲超过 heartbeat 秒产出 HEARTBEAT。
    - 源抛异常时产出一个 StreamFailed，然后结束。
    - 消费方提前退出（客户端断开）时，后台线程在拿到下一个元素后停下并关闭源生成器。
    - 后台线程自带数据库作用域，结束时回收会话。
    """
    loop = asyncio.get_running_loop()
    inbox: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()
    done = object()

    def emit(item: Any) -> None:
        try:
            loop.call_soon_threadsafe(inbox.put_nowait, item)
        except RuntimeError:
            pass  # 事件循环已关闭（进程退出中）

    def pump() -> None:
        iterator = iter(source)
        with db.scope():
            try:
                for item in iterator:
                    if stop.is_set():
                        break
                    emit(item)
            except Exception as exc:  # noqa: BLE001 - 原样转给调用方决定怎么展示
                emit(StreamFailed(exc))
            finally:
                if stop.is_set():
                    close = getattr(iterator, "close", None)
                    if close:
                        close()
                emit(done)

    threading.Thread(target=pump, name="sse-pump", daemon=True).start()
    try:
        while True:
            try:
                if heartbeat:
                    item = await asyncio.wait_for(inbox.get(), timeout=heartbeat)
                else:
                    item = await inbox.get()
            except asyncio.TimeoutError:
                yield HEARTBEAT
                continue
            if item is done:
                return
            yield item
            if isinstance(item, StreamFailed):
                return
    finally:
        stop.set()


async def poll_queue(q: Queue, *, heartbeat: float, interval: float = 0.05) -> AsyncIterator[Any]:
    """异步读取一个线程安全队列（语音识别、论文监控的订阅队列），空闲超时产出 HEARTBEAT。

    用短间隔轮询而不是占一个线程阻塞等待，断开时不留悬挂线程。
    """
    loop = asyncio.get_running_loop()
    last = loop.time()
    while True:
        try:
            item = q.get_nowait()
        except Empty:
            if loop.time() - last >= heartbeat:
                last = loop.time()
                yield HEARTBEAT
            await asyncio.sleep(interval)
            continue
        last = loop.time()
        yield item
