"""作曲：Suno 返回的解析（数据取自 2026-11-13 的真实返回）和 generate_music 工具的整条流程。

不打外部服务：MusicService 换成桩。
"""

from __future__ import annotations

import sys
import types

if "boto3" not in sys.modules:
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    sys.modules["boto3"] = boto3

from services import music as music_module
from services.ai import AIService
from services.music import (
    build_edit_body,
    build_submit_body,
    clip_from_url,
    full_stems,
    normalize_edit_args,
    normalize_music_args,
    notes_to_midi,
    parse_fetch,
    stem_label,
)


def _clip(status, progress, *, clip="c1", url="", duration=None):
    item = {"clipId": clip, "status": status, "progress": progress, "cld2AudioUrl": url,
            "cld2ImageUrl": f"https://cdn2.suno.ai/image_{clip}.jpeg"}
    if duration:
        item["duration"] = duration
    return item


def _payload(task_status, clips, fail_reason=""):
    return {"code": "success", "message": "", "data": [{
        "task_id": "1327981691373608960", "status": task_status, "progress": "4%", "fail_reason": fail_reason, "data": clips,
    }]}


def test_parse_fetch_in_progress_ignores_streaming_url():
    state = parse_fetch(_payload("IN_PROGRESS", [
        _clip(20, 45, clip="a", url="https://audiopipe.suno.ai/?item_id=a&format=webm"),
        _clip(30, 100, clip="b", url="https://file.lloongai.com/temp/suno/b.m4a", duration=132.56),
    ]))
    assert state["state"] == "running"
    a, b = state["tracks"]
    assert a == {"clipId": "a", "title": "", "done": False, "progress": 45, "duration": None, "audioUrl": "",
                 "coverUrl": "https://cdn2.suno.ai/image_a.jpeg", "lyrics": "", "tags": ""}
    assert b["done"] and b["progress"] == 100 and b["audioUrl"].endswith("b.m4a") and b["duration"] == 132.56


def test_parse_fetch_success_and_failure():
    done = parse_fetch(_payload("SUCCESS", [
        _clip(30, 100, clip="a", url="https://x/a.m4a", duration=122.4),
        _clip(30, 100, clip="b", url="https://x/b.m4a", duration=132.56),
    ]))
    assert done["state"] == "success" and len(done["tracks"]) == 2
    failed = parse_fetch(_payload("FAILURE", [], fail_reason="content policy"))
    assert failed == {"state": "failed", "error": "content policy", "tracks": [], "result": {}}
    assert parse_fetch({"code": "error", "message": "无效的令牌"})["state"] == "failed"
    # 状态写着成功但还没拿到成品地址：继续等
    assert parse_fetch(_payload("SUCCESS", [_clip(30, 100, clip="a")]))["state"] == "running"


class _FakeStorage:
    public_url = "https://oss"

    def __init__(self):
        self.uploaded = {}

    def upload_bytes(self, data, key, content_type=None):
        self.uploaded[key] = (len(data), content_type)
        return True


def test_save_attaches_music_meta_and_large_cover(monkeypatch):
    storage = _FakeStorage()
    service = music_module.MusicService(llm_service=None, storage_service=storage)
    asked = []

    def download(url, read_timeout=120.0):
        asked.append(url)
        if "image_large_" in url:
            raise music_module.MusicError("HTTP 404")  # 大图拿不到就退回小图
        return b"x" * 7

    monkeypatch.setattr(service, "_download", download)
    request = normalize_music_args({"title": "锁舞", "style": "funk", "lyrics": "[Verse]\n我们给的词"})
    state = parse_fetch(_payload("SUCCESS", [
        {**_clip(30, 100, clip="a", url="https://x/a.m4a", duration=122.4), "prompt": "[Verse]\nSuno 收到的词", "tags": "funk, groovy"},
    ]))
    [f] = service.save(state["tracks"], request, "u1", "s1", task_id="t9")
    assert f["url"] == "https://oss/users/u1/sessions/s1/music/a/%E9%94%81%E8%88%9E-1.m4a"
    assert asked == ["https://x/a.m4a", "https://cdn2.suno.ai/image_large_a.jpeg", "https://cdn2.suno.ai/image_a.jpeg"]
    assert f["music"] == {
        "title": "锁舞", "style": "funk, groovy", "instrumental": False, "lyrics": "[Verse]\nSuno 收到的词",
        "version": 1, "duration": 122.4, "cover": "https://oss/users/u1/sessions/s1/music/a/cover.jpeg",
        "clipId": "a", "taskId": "t9",
    }
    assert storage.uploaded["users/u1/sessions/s1/music/a/cover.jpeg"] == (7, "image/jpeg")


def test_submit_body_modes():
    instrumental = normalize_music_args({"title": "Lock Groove", "style": "funk, 100 bpm", "lyrics": "ignored", "instrumental": True})
    assert instrumental["lyrics"] == ""
    assert build_submit_body(instrumental, "chirp-v6") == {
        "mv": "chirp-v6", "title": "Lock Groove", "tags": "funk, 100 bpm", "prompt": "", "make_instrumental": True,
    }
    custom = normalize_music_args({"title": "锁舞", "style": "funk", "lyrics": "[Verse]\n第一句"})
    body = build_submit_body(custom, "chirp-v6")
    assert body["prompt"] == "[Verse]\n第一句" and body["make_instrumental"] is False and "gpt_description_prompt" not in body
    described = build_submit_body(normalize_music_args({"title": "锁舞", "style": "funk"}), "chirp-v6")
    assert described["gpt_description_prompt"] == "锁舞，funk" and "prompt" not in described


# ------------------------------------------------------------------
# generate_music 工具流程
# ------------------------------------------------------------------

class _FakeMusic:
    available = True

    def model_label(self):
        return "Campbell Music"

    def __init__(self, states):
        self.states = list(states)
        self.submitted = []
        self.uploaded = {}
        self.calls = []

    def units_for(self, kind="generate"):
        return {"generate": 200_000, "sound": 40_000, "stems": 200_000, "stems_all": 1_000_000}[kind]

    def model_for(self, task=""):
        return "chirp-v5" if task == "sound" else "chirp-v6"

    def submit_body(self, body):
        self.submitted.append(body)
        return "task-1"

    def upload(self, url, name):
        self.calls.append(("upload", url, name))
        return "upload-1"

    def concat(self, clip_id):
        self.calls.append(("concat", clip_id))
        return f"concat-{clip_id}"

    def persona(self, clip_id, style, start, end):
        self.calls.append(("persona", clip_id, start, end))
        return "persona-1"

    def stems(self, clip_id, full):
        self.calls.append(("stems", clip_id, full))
        return "stems-1"

    def sound(self, description, loop):
        self.calls.append(("sound", description, loop))
        return "sound-1"

    def midi(self, clip_id, stem_id):
        self.calls.append(("midi", clip_id, stem_id))
        return {"instruments": [{"name": "Bass", "program": 33, "is_drum": False,
                                 "notes": [{"start": 0, "end": 0.5, "pitch": 40, "velocity": 0.8}]}]} if stem_id == "s-bass" else {}

    def fetch(self, task_id):
        return self.states.pop(0)

    def save_plain(self, items, base, user_id, session_id, folder_id, *, taken=None):
        return [{"name": f"{base}-{i['label']}.m4a", "path": f"music/{base}-{i['label']}.m4a", "size": 1, "mime": "audio/mp4",
                 "url": f"https://oss/{folder_id}/{i['label']}.m4a", **({"clipId": i["clipId"]} if i.get("clipId") else {})}
                for i in items]

    def save_bytes(self, data, stem, ext, mime, user_id, session_id, folder_id, *, taken=None):
        self.midi_bytes = data
        return {"name": stem + ext, "path": f"music/{stem}{ext}", "size": len(data), "mime": mime, "url": f"https://oss/{stem}{ext}"}

    def save(self, tracks, request, user_id, session_id, *, task_id="", taken=None, extra=None):
        self.saved_tracks = tracks
        self.saved_extra = extra
        title = request["title"]
        return [{"name": f"{title}-{i}.m4a", "path": f"music/{title}-{i}.m4a", "size": 10, "mime": "audio/mp4",
                 "url": f"https://oss/{title}-{i}.m4a",
                 "music": {"title": title, "clipId": t["clipId"], "duration": t.get("duration")}}
                for i, t in enumerate(tracks, 1)]


class _FakeUsage:
    def __init__(self, ok=True):
        self.ok = ok
        self.recorded = []

    @staticmethod
    def credits_of(units):
        return round(units / 5000, 2)

    def check(self, user_id, cost):
        self.checked = cost
        return (True, None, None) if self.ok else (False, "weekly", "本周 Campbell 额度已用完")

    def record_fixed_call(self, user_id, units):
        self.recorded.append(units)
        return units / 5000


class _FakeSandbox:
    def __init__(self):
        self.synced = []

    def sync_inputs(self, sandbox, items):
        self.synced.append(items)


def _service(states, usage=None):
    service = AIService.__new__(AIService)
    service.music = _FakeMusic(states)
    service.usage = usage or _FakeUsage()
    service.sandbox = _FakeSandbox()
    return service


def _run(service, trace, turn, args=None, tool="generate_music", session_id="s1"):
    events = []
    gen = service._run_music(args or {"title": "Lock Groove", "style": "funk", "instrumental": True},
                             tool_trace=trace, assistant_message_id="m1", user_id="u1", session_id=session_id, turn=turn,
                             tool=tool)
    try:
        while True:
            events.append(next(gen))
    except StopIteration as stop:
        return events, stop.value


def test_music_tool_streams_progress_saves_bills_and_syncs(monkeypatch):
    monkeypatch.setattr(music_module, "POLL_SECONDS", 0)
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    running = {"state": "running", "error": "", "tracks": [
        {"clipId": "a", "done": False, "progress": 45, "duration": None, "audioUrl": ""},
        {"clipId": "b", "done": True, "progress": 100, "duration": 132.56, "audioUrl": "https://x/b.m4a"},
    ]}
    done = {"state": "success", "error": "", "tracks": [
        {"clipId": "a", "done": True, "progress": 100, "duration": 122.4, "audioUrl": "https://x/a.m4a"},
        {"clipId": "b", "done": True, "progress": 100, "duration": 132.56, "audioUrl": "https://x/b.m4a"},
    ]}
    service = _service([running, running, done])
    trace, turn = [], {"sandbox": object()}
    events, result = _run(service, trace, turn)

    types_ = [e["type"] for e in events]
    assert types_ == ["music_start", "music_progress", "music_progress", "music_end"]  # 进度没变的那次不推
    assert events[1]["tracks"] == [{"progress": 45, "done": False}, {"progress": 100, "done": True, "duration": 132.56}]
    end = events[-1]
    assert end["success"] and [f["name"] for f in end["files"]] == ["Lock Groove-1.m4a", "Lock Groove-2.m4a"]
    assert trace[0]["kind"] == "music" and trace[0]["status"] == "done" and trace[0]["files"]
    assert service.usage.checked == 40 and service.usage.recorded == [200_000]
    # 这一轮开着沙箱：立刻放进 inputs/music/，之后重开沙箱也会带上
    assert [i["path"] for i in service.sandbox.synced[0]] == ["music/Lock Groove-1.m4a", "music/Lock Groove-2.m4a"]
    assert turn["generated_inputs"] == service.sandbox.synced[0]
    assert "/home/user/inputs/music/Lock Groove-1.m4a" in result and "2:02" in result


def test_music_tool_failure_is_not_billed(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    service = _service([{"state": "failed", "error": "content policy", "tracks": []}])
    events, result = _run(service, [], {})
    assert events[-1]["type"] == "music_end" and events[-1]["success"] is False and events[-1]["error"] == "content policy"
    assert service.usage.recorded == []
    assert "content policy" in result


def test_music_tool_respects_quota_and_once_per_answer():
    service = _service([], usage=_FakeUsage(ok=False))
    events, result = _run(service, [], {})
    assert events[-1]["success"] is False and service.music.submitted == []
    assert "额度" in result

    service = _service([])
    trace = [{"kind": "music", "status": "done"}, {"kind": "music", "status": "done"}]
    events, result = _run(service, trace, {})
    assert events[-1]["error"] == "这次回答的音乐任务已到上限" and service.music.submitted == []


def test_music_tool_stops_with_the_answer(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0.01)
    running = {"state": "running", "error": "", "tracks": [{"clipId": "a", "done": False, "progress": 4, "duration": None, "audioUrl": ""}]}
    service = _service([running] * 5)
    control = types.SimpleNamespace(should_stop=lambda: True)
    events, result = _run(service, [], {"control": control})
    assert events[-1]["error"] == "已停止" and service.usage.recorded == []


def test_history_summary_mentions_generated_music():
    service = AIService.__new__(AIService)
    summary = service._format_tool_trace_summary([{
        "kind": "music", "status": "done", "success": True, "title": "Lock Groove", "style": "funk",
        "files": [{"name": "Lock Groove-1.m4a", "path": "music/Lock Groove-1.m4a", "url": "https://oss/1"}],
    }])
    assert "generate_music" in summary and "/home/user/inputs/ 下的 music/Lock Groove-1.m4a" in summary


# ------------------------------------------------------------------
# 编辑、分轨、音效（参数形状取自 2026-11-13 实测通过的请求）
# ------------------------------------------------------------------

def _edit(args):
    return normalize_edit_args(args)


def test_edit_bodies_match_tested_requests():
    src = {"clipId": "c1", "duration": 120.0, "lyrics": "[Verse]\n原词"}
    up = {**src, "uploaded": True}
    extend = _edit({"action": "extend", "source": "x", "lyrics": "[Verse]\n新词", "title": "续", "style": "funk"})
    extend["start"] = 120.0
    assert build_edit_body(extend, src, "chirp-v6") == {
        "mv": "chirp-v6", "title": "续", "tags": "funk", "prompt": "[Verse]\n新词", "continue_clip_id": "c1",
        "continue_at": 120.0, "make_instrumental": False}
    body = build_edit_body({**extend, "start": 15.0}, up, "chirp-v6")
    assert body["task"] == "upload_extend" and body["metadata_params"] == {"clip_id": "c1"} and body["continue_at"] == 15.0

    infill = _edit({"action": "replace_section", "source": "x", "lyrics": "新的一段", "start": 40, "end": 60})
    body = build_edit_body(infill, src, "chirp-v6")
    assert body["task"] == "infill" and body["continue_clip_id"] == "c1" and body["prompt"] == "[Verse]\n原词"
    assert body["metadata_params"] == {"infill_start_s": 40.0, "infill_end_s": 60.0, "infill_context_start_s": 10.0,
                                       "infill_context_end_s": 90.0, "metadata": {"infill_lyrics": "新的一段"}}

    vocals = _edit({"action": "add_vocals", "source": "x", "lyrics": "词", "instrumental": True, "start": 0, "end": 29.6})
    body = build_edit_body(vocals, src, "chirp-v6")
    assert body["task"] == "underpainting" and body["make_instrumental"] is False and body["prompt"] == "词"
    assert body["metadata_params"] == {"underpainting_clip_id": "c1", "underpainting_start_s": 0.0, "underpainting_end_s": 29.6}
    backing = build_edit_body(_edit({"action": "add_backing", "source": "x", "style": "funk band", "end": 10}), src, "chirp-v6")
    assert "prompt" not in backing and backing["tags"] == "funk band"

    assert build_edit_body(_edit({"action": "hum_to_song", "source": "x"}), src, "chirp-v6")["artist_clip_id"] == "c1"
    mash = build_edit_body(_edit({"action": "mashup", "source": "x", "second_source": "y"}), src, "chirp-v6", second={"clipId": "c2"})
    assert mash["metadata_params"] == {"mashup_clip_ids": ["c1", "c2"]}
    same = build_edit_body(_edit({"action": "same_voice", "source": "x", "lyrics": "词"}), src, "chirp-v6", persona_id="p1")
    assert same["task"] == "artist_consistency" and same["persona_id"] == "p1" and same["artist_clip_id"] == "c1"
    remaster = build_edit_body(_edit({"action": "remaster", "source": "x"}), src, "chirp-v6")
    assert remaster["metadata_params"] == {"clip_id": "c1", "variation_category": "normal"} and remaster["prompt"]


def test_stem_names_clip_in_url_and_midi_file():
    assert stem_label("镜子里锁步 (Backing Vocals)") == "和声" and stem_label("(Vocals)") == "人声"
    assert full_stems({"v1": [{"id": "s1", "url": "https://x/1.m4a", "title": "(Drums)"}], "v2": []}) == [
        {"id": "s1", "label": "鼓", "url": "https://x/1.m4a"}]
    uid = "acb514aa-328d-40e6-8787-fdf12c82af6f"
    assert clip_from_url(f"https://oss/users/u/sessions/s/music/{uid}/a.m4a") == uid
    assert clip_from_url(f"https://oss/users/u/sessions/s/music/stems-1/{uid}.m4a") == ""

    data = notes_to_midi([
        {"name": "Bass", "program": 33, "notes": [{"start": 0, "end": 0.5, "pitch": 40, "velocity": 1.0},
                                                   {"start": 0.5, "end": 1, "pitch": 40, "velocity": 0.5}]},
        {"name": "Drums", "is_drum": True, "notes": [{"start": 0, "end": 0.1, "pitch": 36}]},
        {"name": "空的", "notes": []},
    ])
    assert data[:4] == b"MThd" and int.from_bytes(data[10:12], "big") == 3  # 速度轨 + 两个有音符的乐器
    assert data.count(b"MTrk") == 3
    assert bytes([0xC0, 33]) in data and bytes([0x99, 36]) in data  # 贝斯音色、鼓在第 10 通道
    # 首尾相接的同音高：先停后发（0 delta 的 note-off 在 note-on 前面）
    assert bytes([0x80, 40, 0, 0x00, 0x90, 40]) in data


def _song(clip="c1", duration=120.0, name="锁舞-1.m4a"):
    return {"name": name, "path": f"music/{name}", "url": f"https://oss/music/{clip}/{name}", "size": 1,
            "music": {"title": "锁舞", "style": "funk", "clipId": clip, "duration": duration, "lyrics": "[Verse]\n原词"}}


def _done(*clips, result=None):
    return {"state": "success", "error": "", "result": result or {}, "tracks": [
        {"clipId": c, "title": t, "done": True, "progress": 100, "duration": 30.0, "audioUrl": f"https://x/{c}.m4a", "coverUrl": ""}
        for c, t in clips]}


def test_extend_joins_each_version_back_onto_the_song(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    failed = {"state": "failed", "error": "busy", "tracks": [], "result": {}}
    service = _service([_done(("e1", ""), ("e2", "")), _done(("w1", "")), failed])
    turn = {"generated_inputs": [_song()]}
    events, result = _run(service, [], turn, {"action": "extend", "source": "/home/user/inputs/music/锁舞-1.m4a",
                                               "lyrics": "[Verse]\n新词"}, tool="edit_music", session_id=None)
    [body] = service.music.submitted
    assert body["continue_clip_id"] == "c1" and body["continue_at"] == 120.0 and body["tags"] == "funk"
    assert body["title"] == "锁舞（续写）"
    assert service.music.calls == [("concat", "e1"), ("concat", "e2")]
    # 第一版拼成了；第二版没拼成，交付接上的那一段
    assert [t["clipId"] for t in service.music.saved_tracks] == ["w1", "e2"] and service.music.saved_extra == {"edit": "extend"}
    assert "没能拼成完整一首" in result and service.usage.recorded == [200_000]
    assert events[0]["action"] == "extend" and events[0]["source"] == "music/锁舞-1.m4a"
    assert any(e.get("phase") == "正在拼成完整一首" for e in events)


def test_uploaded_audio_is_uploaded_once_and_needs_a_length(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    hum = {"name": "hum.m4a", "url": "https://oss/users/u/files/hum.m4a", "size": 1, "mime": "audio/mp4"}
    # 不知道时长：先让模型量，不上传
    service = _service([])
    events, result = _run(service, [], {"files": [hum]}, {"action": "add_backing", "source": "hum.m4a"},
                          tool="edit_music", session_id=None)
    assert "ffprobe" in result and service.music.calls == [] and events[-1]["success"] is False

    service = _service([_done(("up1", "")), _done(("b1", ""), ("b2", ""))])
    events, result = _run(service, [], {"files": [hum]}, {"action": "add_backing", "source": "inputs/hum.m4a", "end": 15,
                                                          "style": "funk band"}, tool="edit_music", session_id=None)
    assert service.music.calls == [("upload", hum["url"], "hum")] and service.music.uploaded == {hum["url"]: "up1"}
    [body] = service.music.submitted
    assert body["metadata_params"]["underpainting_clip_id"] == "up1" and body["metadata_params"]["underpainting_end_s"] == 15.0
    assert any(e.get("phase") == "正在读取音频" for e in events) and events[-1]["success"]


def test_edit_rejects_missing_files_and_non_audio():
    service = _service([])
    events, result = _run(service, [], {}, {"action": "extend", "source": "nope.m4a"}, tool="edit_music", session_id=None)
    assert "找不到文件 nope.m4a" in result
    pic = {"name": "a.png", "path": "images/a.png", "url": "https://oss/a.png"}
    events, result = _run(service, [], {"files": [pic]}, {"action": "remaster", "source": "images/a.png"},
                          tool="edit_music", session_id=None)
    assert "不是音频" in result and service.music.submitted == []


def test_full_separation_saves_stems_and_one_midi(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    result_v1 = {"v1": [{"id": "s-voc", "url": "https://x/v.m4a", "title": "(Vocals)"},
                        {"id": "s-bass", "url": "https://x/b.m4a", "title": "(Bass)"}]}
    service = _service([_done(("all1", "锁舞(Stems)"), result=result_v1)])
    events, result = _run(service, [], {"generated_inputs": [_song()]}, {"source": "music/锁舞-1.m4a", "full": True},
                          tool="separate_music", session_id=None)
    assert ("stems", "c1", True) in service.music.calls
    assert {c for c in service.music.calls if c[0] == "midi"} == {("midi", "all1", "s-voc"), ("midi", "all1", "s-bass")}
    names = [f["name"] for f in events[-1]["files"]]
    assert names == ["锁舞-人声.m4a", "锁舞-贝斯.m4a", "锁舞-MIDI.mid"]
    assert service.music.midi_bytes[:4] == b"MThd"
    assert service.usage.recorded == [1_000_000] and service.usage.checked == 200


def test_two_stem_split_and_sound_effects(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    service = _service([_done(("v", "锁舞 (Vocals)"), ("i", "锁舞 (Instrumental)"))])
    events, result = _run(service, [], {"generated_inputs": [_song()]}, {"source": "锁舞-1.m4a"},
                          tool="separate_music", session_id=None)
    files = events[-1]["files"]
    assert [f["name"] for f in files] == ["锁舞-人声.m4a", "锁舞-伴奏.m4a"] and files[0]["clipId"] == "v"
    assert service.usage.recorded == [200_000]

    service = _service([_done(("s1", ""), ("s2", ""))])
    events, result = _run(service, [], {}, {"description": "crowd cheering", "title": "欢呼", "loop": True},
                          tool="generate_sound")
    assert service.music.calls == [("sound", "crowd cheering", True)]
    assert [f["name"] for f in events[-1]["files"]] == ["欢呼-1.m4a", "欢呼-2.m4a"]
    assert service.usage.recorded == [40_000] and "音效" in result


def test_generate_from_an_image(monkeypatch):
    monkeypatch.setattr("services.ai.MUSIC_POLL_SECONDS", 0)
    service = _service([_done(("a", ""), ("b", ""))])
    pic = {"name": "dance.png", "path": "images/dance.png", "url": "https://oss/dance.png"}
    _run(service, [], {"files": [pic]}, {"title": "画里的律动", "style": "funk", "reference": "/home/user/inputs/images/dance.png"},
         session_id=None)
    [body] = service.music.submitted
    assert body["task"] == "image_to_song" and body["metadata_params"] == {"image_url": "https://oss/dance.png"}


def test_history_summary_names_the_edit():
    service = AIService.__new__(AIService)
    summary = service._format_tool_trace_summary([{
        "kind": "music", "status": "done", "success": True, "action": "extend", "title": "锁舞（续写）",
        "source": "music/锁舞-1.m4a", "files": [{"name": "锁舞（续写）-1.m4a", "path": "music/锁舞（续写）-1.m4a", "url": "u"}],
    }])
    assert 'edit_music(action=extend, source="music/锁舞-1.m4a"' in summary
