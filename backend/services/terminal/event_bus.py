"""
EventBus - Paper 生成过程的事件总线
每个 paper_id 一个事件队列，支持多个订阅者
支持全局订阅（监听所有 paper 的事件）
"""

import time
import threading
from collections import defaultdict
from queue import Queue, Empty


class EventBus:
    """Paper 生成事件总线"""

    def __init__(self, max_history: int = 500):
        self._lock = threading.Lock()
        # paper_id -> list of events (历史)
        self._history: dict[str, list[dict]] = defaultdict(list)
        # paper_id -> list of Queue (活跃订阅者)
        self._subscribers: dict[str, list[Queue]] = defaultdict(list)
        # 全局订阅者（接收所有 paper 的事件）
        self._global_subscribers: list[Queue] = []
        self._max_history = max_history

    def emit(self, paper_id: str, event_type: str, **data):
        """发送事件"""
        event = {
            "type": event_type,
            "ts": time.time(),
            "paper_id": paper_id,
            **data,
        }
        with self._lock:
            history = self._history[paper_id]
            history.append(event)
            # 限制历史长度
            if len(history) > self._max_history:
                self._history[paper_id] = history[-self._max_history:]
            # 推送给 paper 级订阅者
            for q in self._subscribers[paper_id]:
                q.put(event)
            # 推送给全局订阅者
            for q in self._global_subscribers:
                q.put(event)

    def subscribe(self, paper_id: str, include_history: bool = True) -> Queue:
        """订阅某个 paper 的事件流，返回 Queue"""
        q = Queue()
        with self._lock:
            if include_history:
                for event in self._history.get(paper_id, []):
                    q.put(event)
            self._subscribers[paper_id].append(q)
        return q

    def unsubscribe(self, paper_id: str, q: Queue):
        """取消订阅"""
        with self._lock:
            subs = self._subscribers.get(paper_id, [])
            if q in subs:
                subs.remove(q)

    def subscribe_global(self) -> Queue:
        """全局订阅，接收所有 paper 的事件"""
        q = Queue()
        with self._lock:
            self._global_subscribers.append(q)
        return q

    def unsubscribe_global(self, q: Queue):
        """取消全局订阅"""
        with self._lock:
            if q in self._global_subscribers:
                self._global_subscribers.remove(q)

    def get_history(self, paper_id: str) -> list[dict]:
        """获取某个 paper 的事件历史"""
        with self._lock:
            return list(self._history.get(paper_id, []))

    def list_papers(self) -> list[str]:
        """列出所有有事件的 paper_id"""
        with self._lock:
            return list(self._history.keys())

    def clear(self, paper_id: str):
        """清除某个 paper 的事件历史"""
        with self._lock:
            self._history.pop(paper_id, None)


# 全局单例
paper_events = EventBus()
