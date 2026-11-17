"""视频：Grok Imagine 返回的解析（数据取自 2026-11-14 的真实返回）、估价和 generate_video 的整条流程。"""

from __future__ import annotations

import sys
import types

if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = boto3

from services.ai import AIService
from services.video import VideoService, build_video_body, normalize_video_args, parse_status

URL = "https://videos.example/xai_video/c12e.mp4?X-Amz-Expires=604800"


def test_parse_status_from_real_responses():
    pending = parse_status({"request_id": "c12e", "status": "pending", "model": "grok-imagine-video-1.5-lite", "progress": 10})
    assert pending == {"state": "running", "progress": 10, "url": "", "error": ""}
    done = parse_status({"status": "done", "progress": 100, "video_url": URL, "url": URL,
                         "video": {"url": URL, "duration": 1, "respect_moderation": True}, "usage": {"cost_in_usd_ticks": 200000000}})
    assert done == {"state": "success", "progress": 100, "url": URL, "error": ""}
    # 只在 video.url 里给地址也认
    assert parse_status({"status": "done", "video": {"url": URL}})["url"] == URL
    assert parse_status({"status": "failed", "error": {"message": "moderation"}})["error"] == "moderation"
    # 写着完成但还没地址：继续等
    assert parse_status({"status": "done", "progress": 100})["state"] == "running"


def test_args_defaults_and_limits():
    req = normalize_video_args({"prompt": "a dancer", "duration": 40, "resolution": "4k", "aspect_ratio": "2:1"})
    assert (req["duration"], req["resolution"], req["aspect_ratio"]) == (15, "720p", "16:9")
    assert normalize_video_args({"prompt": "x"})["duration"] == 6
    body = build_video_body({**req, "duration": 6}, "grok-imagine-video-1.5-lite", "https://oss/a.png")
    assert body == {"model": "grok-imagine-video-1.5-lite", "prompt": "a dancer", "resolution": "720p",
                    "aspect_ratio": "16:9", "duration": 6, "image": {"url": "https://oss/a.png"}}


class _Cfg:
    def get_model_config(self, model_id):
        return {"id": "video_generator", "billing": {"per_image": 10000,
                                                     "per_second": {"480p": 20000, "720p": 29932, "1080p": 140136}}}


def test_units_follow_resolution_duration_and_image():
    service = VideoService(_Cfg(), None)
    req = normalize_video_args({"prompt": "x", "resolution": "720p", "duration": 6})
    assert service.units_for(req, False) == 29932 * 6
    assert service.units_for({**req, "resolution": "480p"}, True) == 20000 * 6 + 10000
    assert service.units_for({**req, "resolution": "1080p", "duration": 1}, False) == 140136


# ------------------------------------------------------------------
# generate_video 工具流程
# ------------------------------------------------------------------

class _FakeVideo(VideoService):
    available = True

    def __init__(self, states):
        super().__init__(_Cfg(), None)
        self.states = list(states)
        self.submitted = []

    def model_label(self):
        return "Campbell Video"

    def submit(self, request, image_url=""):
        self.submitted.append((request, image_url))
        return "req-1"

    def fetch(self, task_id):
        return self.states.pop(0)

    def save(self, url, request, user_id, session_id, taken=None):
        return {"name": f"{request['title']}.mp4", "path": f"videos/{request['title']}.mp4", "size": 9, "mime": "video/mp4",
                "url": "https://oss/v.mp4", "contentId": "c1"}


class _FakeUsage:
    def __init__(self, remaining=200):
        self.remaining = remaining
        self.recorded = []

    @staticmethod
    def credits_of(units):
        return round(units / 5000, 2)

    def check(self, user_id, cost):
        self.checked = cost
        return (True, None, None) if cost <= self.remaining else (False, "weekly", "额度不足")

    def get_summary(self, user_id):
        return {"remaining": {"weekly": self.remaining}}

    def record_fixed_call(self, user_id, units):
        self.recorded.append(units)
        return units / 5000


def _service(states, usage=None):
    service = AIService.__new__(AIService)
    service.video = _FakeVideo(states)
    service.usage = usage or _FakeUsage()
    service.sandbox = None
    service.image = types.SimpleNamespace(_collect_edit_source_candidates=lambda *a, **k: [
        {"assetId": "img-1", "url": "https://oss/a.png?x-oss-process=image/watermark,abc"}])
    return service


def _run(service, args, turn=None):
    events = []
    gen = service._run_video(args, tool_trace=[], assistant_message_id="m1", user_id="u1", session_id=None,
                             turn=turn if turn is not None else {}, current_user_images=[], current_user_message_id=None)
    try:
        while True:
            events.append(next(gen))
    except StopIteration as stop:
        return events, stop.value


def test_video_streams_progress_bills_estimate(monkeypatch):
    monkeypatch.setattr("services.ai.VIDEO_POLL_SECONDS", 0)
    running = {"state": "running", "progress": 40, "url": "", "error": ""}
    done = {"state": "success", "progress": 100, "url": URL, "error": ""}
    service = _service([running, running, done])
    turn = {}
    events, result = _run(service, {"prompt": "a locking dancer", "title": "锁舞", "image": "img-1"}, turn)
    assert [e["type"] for e in events] == ["video_start", "video_progress", "video_progress", "video_end"]
    assert events[-1]["success"] and events[-1]["files"][0]["path"] == "videos/锁舞.mp4"
    # 图生视频用资源清单的原图（去掉水印参数）
    assert service.video.submitted[0][1] == "https://oss/a.png"
    assert service.usage.recorded == [29932 * 6 + 10000]
    assert turn["generated_inputs"][0]["path"] == "videos/锁舞.mp4"
    assert "/home/user/inputs/videos/锁舞.mp4" in result


def test_not_enough_quota_is_reported_without_submitting():
    service = _service([], usage=_FakeUsage(remaining=30))
    events, result = _run(service, {"prompt": "x", "resolution": "1080p", "duration": 6})
    assert service.video.submitted == [] and events[-1]["success"] is False
    assert "约需 168.16 credits" in result and "只剩 30" in result
    # 给出放得下的做法，让模型转告用户
    assert "480p 6 秒约 24 credits" in result and "不要自己换参数重试" in result


def test_failure_and_missing_image_are_not_billed(monkeypatch):
    monkeypatch.setattr("services.ai.VIDEO_POLL_SECONDS", 0)
    service = _service([{"state": "failed", "progress": 30, "url": "", "error": "moderation"}])
    events, result = _run(service, {"prompt": "x"})
    assert "moderation" in result and service.usage.recorded == []
    service = _service([])
    service._music_candidates = lambda *a: []
    events, result = _run(service, {"prompt": "x", "image": "nope"})
    assert "找不到图片 nope" in result and service.video.submitted == []
