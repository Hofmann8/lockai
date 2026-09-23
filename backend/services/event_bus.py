"""
EventBus - 按频道分发事件的内存总线（实时语音识别用它把识别结果推给 SSE 订阅者）。
每个频道保留一段历史，新订阅者可以先补齐历史再接实时事件。
"""

import time
import threading
from collections import defaultdict
from queue import Queue


class EventBus:
    """按频道分发事件"""

    def __init__(self, max_history: int = 500):
        self._lock = threading.Lock()
        # channel -> list of events (历史)
        self._history: dict[str, list[dict]] = defaultdict(list)
        # channel -> list of Queue (活跃订阅者)
        self._subscribers: dict[str, list[Queue]] = defaultdict(list)
        self._max_history = max_history

    def emit(self, channel: str, event_type: str, **data):
        """发送事件"""
        event = {
            "type": event_type,
            "ts": time.time(),
            "channel": channel,
            **data,
        }
        with self._lock:
            history = self._history[channel]
            history.append(event)
            if len(history) > self._max_history:
                self._history[channel] = history[-self._max_history:]
            for q in self._subscribers[channel]:
                q.put(event)

    def subscribe(self, channel: str, include_history: bool = True) -> Queue:
        """订阅某个频道的事件流，返回 Queue"""
        q = Queue()
        with self._lock:
            if include_history:
                for event in self._history.get(channel, []):
                    q.put(event)
            self._subscribers[channel].append(q)
        return q

    def unsubscribe(self, channel: str, q: Queue):
        """取消订阅"""
        with self._lock:
            subs = self._subscribers.get(channel, [])
            if q in subs:
                subs.remove(q)

    def get_history(self, channel: str) -> list[dict]:
        """获取某个频道的事件历史"""
        with self._lock:
            return list(self._history.get(channel, []))

    def clear(self, channel: str):
        """清除某个频道的事件历史"""
        with self._lock:
            self._history.pop(channel, None)
