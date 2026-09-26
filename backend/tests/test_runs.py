"""后台回答：离开页面继续跑、重放、上限和挤掉最久没人看的那条"""

import asyncio
import threading
import time

import pytest

from services import runs as runs_module
from services.runs import RunLimit, RunRegistry


def _wait(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _slow_work(gate: threading.Event):
    """先吐一条，然后等 gate 或者被叫停"""
    def work(run):
        yield {"type": "message_start", "message_id": "m1"}
        while not gate.is_set():
            if run.should_stop():
                yield {"type": "message_end", "message_id": "m1", "stopped": run.stop_reason}
                return
            time.sleep(0.01)
        yield {"type": "content_delta", "delta": "好了"}
        yield {"type": "message_end", "message_id": "m1"}
    return work


async def _collect(registry, run, **kwargs):
    out = []
    async for item in registry.follow(run, heartbeat=5, poll=0.01, **kwargs):
        out.append(item)
    return out


def test_answer_keeps_running_without_viewers_and_replays_on_return():
    registry = RunRegistry()
    gate = threading.Event()
    run, evicted = registry.start(session_id="s1", user_id="u", title="t", work=_slow_work(gate))
    assert evicted is None
    assert registry.running_sessions("u") == {"s1"}
    gate.set()
    assert _wait(lambda: run.done)
    events = asyncio.run(_collect(registry, run, resume=True))
    types = [e["type"] for e in events]
    assert types == ["resume", "message_start", "content_delta", "message_end", "replay_done"]
    assert all("ts" in e for e in events if e["type"] not in ("resume", "replay_done"))
    assert registry.running_sessions("u") == set()


def test_same_session_cannot_run_twice():
    registry = RunRegistry()
    gate = threading.Event()
    registry.start(session_id="s1", user_id="u", title="", work=_slow_work(gate))
    with pytest.raises(RunLimit):
        registry.start(session_id="s1", user_id="u", title="", work=_slow_work(gate))
    gate.set()


def test_over_the_limit_the_longest_running_is_stopped_by_default(monkeypatch):
    monkeypatch.setattr(runs_module, "MAX_PER_USER", 2)
    registry = RunRegistry()
    gate = threading.Event()
    first, _ = registry.start(session_id="a", user_id="u", title="最早", work=_slow_work(gate))
    second, _ = registry.start(session_id="b", user_id="u", title="", work=_slow_work(gate))
    first.started_at, second.started_at = time.time() - 100, time.time() - 50
    # 有人在看也照样停：第四个要开，就得有一个让位
    first.watchers = 1
    third, evicted = registry.start(session_id="c", user_id="u", title="", work=_slow_work(gate))
    assert evicted is first and first.stop_reason == "evicted"
    assert _wait(lambda: first.done)
    assert second.stop_reason is None and third.stop_reason is None
    assert [r.session_id for r in registry.running("u")] == ["b", "c"]
    gate.set()


def test_user_can_choose_which_one_to_stop(monkeypatch):
    monkeypatch.setattr(runs_module, "MAX_PER_USER", 2)
    registry = RunRegistry()
    gate = threading.Event()
    first, _ = registry.start(session_id="a", user_id="u", title="", work=_slow_work(gate))
    second, _ = registry.start(session_id="b", user_id="u", title="", work=_slow_work(gate))
    first.started_at, second.started_at = time.time() - 100, time.time() - 50
    _, evicted = registry.start(session_id="c", user_id="u", title="", work=_slow_work(gate), evict="b")
    assert evicted is second and first.stop_reason is None
    gate.set()


def test_other_users_do_not_count(monkeypatch):
    monkeypatch.setattr(runs_module, "MAX_PER_USER", 1)
    registry = RunRegistry()
    gate = threading.Event()
    registry.start(session_id="a", user_id="u1", title="", work=_slow_work(gate))
    _, evicted = registry.start(session_id="b", user_id="u2", title="", work=_slow_work(gate))
    assert evicted is None
    gate.set()


def test_stop_reaches_the_work_loop():
    registry = RunRegistry()
    gate = threading.Event()
    run, _ = registry.start(session_id="s", user_id="u", title="", work=_slow_work(gate))
    assert registry.stop("s", "user")
    assert _wait(lambda: run.done)
    assert run.events[-1]["stopped"] == "user"
    assert not registry.stop("s")


def test_runs_time_out(monkeypatch):
    registry = RunRegistry()
    gate = threading.Event()
    run, _ = registry.start(session_id="s", user_id="u", title="", work=_slow_work(gate))
    run.started_at -= runs_module.MAX_SECONDS + 1
    assert _wait(lambda: run.done)
    assert run.stop_reason == "timeout"
    gate.set()


def test_new_message_waits_for_the_stopped_turn_to_wrap_up():
    registry = RunRegistry()
    gate = threading.Event()
    first, _ = registry.start(session_id="s", user_id="u", title="", work=_slow_work(gate))
    registry.stop("s", "user")
    second, _ = registry.start(session_id="s", user_id="u", title="", work=_slow_work(gate))
    assert first.done and second is not first
    gate.set()
