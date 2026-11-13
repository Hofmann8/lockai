"""
音乐：RelayRouter 的 Suno 接口（models.json 的 music_generator）。作曲、编辑已有音频、分轨、音效。

提交 → 每隔几秒查一次 → 完成后下载音频转存 OSS。2026-11 实测（chirp-v6）：
- 一次提交出两个版本，各约两分钟长，整体约 50 秒完成
- 每首各有 status（0 排队 / 20 生成中 / 30 完成 / 40 失败）和 0~100 的 progress；任务整体的 progress 会倒退，不用
- 成品在每首的 cld2AudioUrl，是第三方的临时地址，完成后立刻转存；生成中这个字段是 Suno 自家的边播地址，国内连不上，不用
- 查询只认任务编号（task_id），按 clipId 查不到；编辑、分轨要的是 clipId，所以生成时两个都存下来
- 用户上传的音频先走 /suno/uploads/audio（普通上传免费，约 10~30 秒）变成 Suno 里的 clip，之后和生成的歌一样能编辑
- 续写只返回接上的那一段，再调一次 /suno/submit/concat（免费）拼成完整一首
- 全轨分离的结果在 result.v1：12 条分轨，各有 id 和音频地址；MIDI 按「分离任务的 clipId + 分轨 id」取，返回的是音符 JSON
- 换风格翻唱（task=cover）按文档的写法 v5、v6 都失败（卡在 30% 后超时或报参数问题），暂不提供
"""

from __future__ import annotations

import posixpath
import re
import struct
import uuid
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from .http_client import build_http_client
from .media_label import label_media
from .sandbox import safe_filename

MODEL_ID = "music_generator"
# 单次提交最多等多久（上游排队时会比 50 秒久得多）
TIMEOUT_SECONDS = 600
POLL_SECONDS = 4
DEFAULT_PER_CALL_UNITS = 200_000

TITLE_CHARS = 80
STYLE_CHARS = 400
LYRICS_CHARS = 3000

STATUS_DONE = 30
STATUS_FAILED = 40
# 封面：Suno 给的是 360px 小图，同一个地址换成 image_large_ 是 1024px 大图（2026-11 实测国内服务器能下）
COVER_SMALL_RE = re.compile(r"/image_(?!large_)")
AUDIO_MIME = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac"}
AUDIO_EXT = set(AUDIO_MIME) | {".aac", ".opus", ".webm", ".aiff", ".aif"}
SPACE_RE = re.compile(r"\s+")
# 早期作曲的文件没存 clipId，但 OSS 路径里有：.../music/<clipId>/<文件名>
CLIP_IN_URL_RE = re.compile(r"/music/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/", re.I)

# 编辑动作：给界面和模型看的名字
EDIT_ACTIONS: dict[str, str] = {
    "extend": "续写",
    "replace_section": "局部重写",
    "remaster": "重制",
    "add_vocals": "加人声",
    "add_backing": "加伴奏",
    "hum_to_song": "哼唱成曲",
    "mashup": "混搭",
    "same_voice": "沿用歌手",
}
# 编辑动作对应的 Suno task（续写不带 task；上传音频的续写是 upload_extend）
ACTION_TASKS = {
    "extend": "", "replace_section": "infill", "remaster": "remaster",
    "add_vocals": "underpainting", "add_backing": "underpainting", "hum_to_song": "vox",
    "mashup": "mashup_condition", "same_voice": "artist_consistency",
}
# 只有特定版本能跑的任务（2026-11 实测：音效只有 chirp-v5 能出）；models.json 的 task_models 可覆盖
DEFAULT_TASK_MODELS = {"sound": "chirp-v5"}
# 每种动作的计费项（models.json music_generator.billing 的键）
BILLING_KEYS = {"generate": "per_call", "sound": "sound", "stems": "stems", "stems_all": "stems_all"}
# 分轨名
STEM_NAMES = {
    "vocals": "人声", "instrumental": "伴奏", "backing vocals": "和声", "drums": "鼓", "bass": "贝斯",
    "guitar": "吉他", "keyboard": "键盘", "percussion": "打击乐", "strings": "弦乐", "synth": "合成器",
    "fx": "效果声", "brass": "铜管", "woodwinds": "木管",
}


class MusicError(Exception):
    pass


def _clean(value: Any, limit: int) -> str:
    return SPACE_RE.sub(" ", str(value or "")).strip()[:limit]


def _seconds(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 2) if number >= 0 else None


def _is_true(value: Any) -> bool:
    return value is True or str(value).lower() == "true"


def normalize_music_args(arguments: dict[str, Any] | None) -> dict[str, Any]:
    """模型给的 generate_music 参数收拾成固定形状。"""
    args = arguments if isinstance(arguments, dict) else {}
    instrumental = _is_true(args.get("instrumental"))
    return {
        "title": _clean(args.get("title"), TITLE_CHARS),
        "style": _clean(args.get("style"), STYLE_CHARS),
        "lyrics": "" if instrumental else str(args.get("lyrics") or "").strip()[:LYRICS_CHARS],
        "instrumental": instrumental,
        "reference": str(args.get("reference") or "").strip(),
    }


def normalize_edit_args(arguments: dict[str, Any] | None) -> dict[str, Any]:
    """edit_music 的参数。"""
    args = arguments if isinstance(arguments, dict) else {}
    if str(args.get("action") or "").strip() == "add_vocals":
        args = {**args, "instrumental": False}  # 加人声一定有人声，词不能被当成纯音乐清掉
    request = normalize_music_args(args)
    request.update(
        action=str(args.get("action") or "").strip(),
        source=str(args.get("source") or "").strip(),
        second_source=str(args.get("second_source") or "").strip(),
        start=_seconds(args.get("start")),
        end=_seconds(args.get("end")),
    )
    # 没说是不是纯音乐时沿用原曲（由调用方补）
    request["instrumental_given"] = "instrumental" in args
    return request


def normalize_separate_args(arguments: dict[str, Any] | None) -> dict[str, Any]:
    args = arguments if isinstance(arguments, dict) else {}
    return {"source": str(args.get("source") or "").strip(), "full": _is_true(args.get("full")),
            "title": "", "style": "", "lyrics": "", "instrumental": True}


def normalize_sound_args(arguments: dict[str, Any] | None) -> dict[str, Any]:
    args = arguments if isinstance(arguments, dict) else {}
    description = _clean(args.get("description"), STYLE_CHARS)
    title = _clean(args.get("title"), TITLE_CHARS) or description[:24]
    return {"description": description, "loop": _is_true(args.get("loop")), "title": title,
            "style": description, "lyrics": "", "instrumental": True}


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi"}


def media_kind(item: dict[str, Any]) -> str:
    """附件是 audio / image / video / 其他（空串）：先看 mime，再看扩展名"""
    mime = str(item.get("mime") or "").lower()
    for kind in ("audio", "image", "video"):
        if mime.startswith(kind + "/"):
            return kind
    name = str(item.get("name") or "") or urlsplit(str(item.get("url") or "")).path
    ext = posixpath.splitext(name)[1].lower()
    if ext in AUDIO_EXT:
        return "audio"
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    return ""


def build_submit_body(request: dict[str, Any], model: str) -> dict[str, Any]:
    """纯音乐和有歌词的走自定义模式（风格 + 歌词）；要人声但没给歌词时退回灵感模式，让 Suno 自己写词。"""
    body: dict[str, Any] = {"mv": model, "title": request["title"]}
    if request["instrumental"] or request["lyrics"]:
        body.update(tags=request["style"], prompt=request["lyrics"], make_instrumental=request["instrumental"])
    else:
        body.update(gpt_description_prompt="，".join(p for p in (request["title"], request["style"]) if p),
                    make_instrumental=False)
    return body


def build_reference_body(request: dict[str, Any], model: str, kind: str, url: str) -> dict[str, Any]:
    """看图 / 看视频作曲：灵感模式 + 图片或视频地址"""
    description = "，".join(p for p in (request["title"], request["style"]) if p) or "根据画面的氛围作曲"
    if request["lyrics"]:
        description = f"{description}。歌词：\n{request['lyrics']}"
    return {
        "mv": model, "title": request["title"], "task": "image_to_song" if kind == "image" else "video_to_song",
        "gpt_description_prompt": description[:LYRICS_CHARS], "tags": request["style"],
        "make_instrumental": request["instrumental"],
        "metadata_params": {"image_url" if kind == "image" else "video_url": url},
    }


def build_edit_body(
    request: dict[str, Any], source: dict[str, Any], model: str, *,
    second: dict[str, Any] | None = None, persona_id: str = "",
) -> dict[str, Any]:
    """
    edit_music 的提交参数。source：{clipId, uploaded, duration, lyrics}。
    start / end 已由调用方补齐（需要的动作一定有值）。
    """
    action = request["action"]
    clip = source["clipId"]
    lyrics = request["lyrics"]
    body: dict[str, Any] = {"mv": model, "title": request["title"], "tags": request["style"]}
    description = "，".join(p for p in (request["title"], request["style"]) if p)
    start, end = request["start"], request["end"]

    if action == "extend":
        body.update(prompt=lyrics, continue_clip_id=clip, continue_at=start, make_instrumental=request["instrumental"])
        if source.get("uploaded"):
            body.update(task="upload_extend", metadata_params={"clip_id": clip})
    elif action == "replace_section":
        duration = source.get("duration") or end + 30
        params: dict[str, Any] = {
            "infill_start_s": start, "infill_end_s": end,
            "infill_context_start_s": max(0.0, start - 30), "infill_context_end_s": min(duration, end + 30),
        }
        if lyrics:
            params["metadata"] = {"infill_lyrics": lyrics}
        # prompt 是原曲歌词（上下文），新词放 infill_lyrics
        body.update(task="infill", continue_clip_id=clip, prompt=source.get("lyrics") or lyrics, metadata_params=params)
    elif action == "remaster":
        body.update(task="remaster", prompt=lyrics or "保持原曲风格，做适度变化",
                    metadata_params={"clip_id": clip, "variation_category": "normal"})
    elif action in ("add_vocals", "add_backing"):
        body.update(task="underpainting", metadata_params={
            "underpainting_clip_id": clip, "underpainting_start_s": start or 0, "underpainting_end_s": end,
        })
        if action == "add_vocals":
            body.update(prompt=lyrics or description, make_instrumental=False)
    elif action == "hum_to_song":
        body.update(task="vox", artist_clip_id=clip, prompt=lyrics or description or "根据哼唱旋律写一首完整的歌",
                    make_instrumental=request["instrumental"])
    elif action == "mashup":
        body.update(task="mashup_condition", prompt=lyrics, make_instrumental=request["instrumental"],
                    metadata_params={"mashup_clip_ids": [clip, (second or {}).get("clipId")]})
    elif action == "same_voice":
        body.update(task="artist_consistency", persona_id=persona_id, artist_clip_id=clip, prompt=lyrics)
    else:
        raise MusicError(f"不支持的操作：{action}")
    return body


def parse_fetch(payload: Any) -> dict[str, Any]:
    """/suno/fetch 的返回 → {state: running / success / failed, error, tracks: [...], result}。"""
    if not isinstance(payload, dict) or payload.get("code") not in (None, "success"):
        message = payload.get("message") if isinstance(payload, dict) else ""
        return {"state": "failed", "error": str(message or "查询失败"), "tracks": [], "result": {}}
    items = payload.get("data")
    task = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else {}
    status = str(task.get("status") or "").upper()
    tracks = []
    result: dict[str, Any] = {}
    for clip in task.get("data") or []:
        if not isinstance(clip, dict):
            continue
        done = clip.get("status") == STATUS_DONE
        try:
            progress = 100 if done else max(0, min(99, int(clip.get("progress") or 0)))
        except (TypeError, ValueError):
            progress = 0
        if isinstance(clip.get("result"), dict) and not result:
            result = clip["result"]
        tracks.append({
            "clipId": str(clip.get("clipId") or ""),
            "title": str(clip.get("title") or ""),
            "done": done,
            "progress": progress,
            "duration": clip.get("duration") if done else None,
            "audioUrl": str(clip.get("cld2AudioUrl") or "") if done else "",
            "coverUrl": str(clip.get("cld2ImageUrl") or ""),
            # 自定义模式是我们给的歌词，灵感模式是 Suno 自己写的；纯音乐为空
            "lyrics": str(clip.get("prompt") or "").strip(),
            "tags": str(clip.get("tags") or "").strip(),
        })
    if status in ("FAILURE", "FAILED", "ERROR"):
        return {"state": "failed", "error": str(task.get("fail_reason") or "生成失败"), "tracks": tracks, "result": result}
    if status == "SUCCESS" and tracks and all(t["done"] and t["audioUrl"] for t in tracks):
        return {"state": "success", "error": "", "tracks": tracks, "result": result}
    return {"state": "running", "error": "", "tracks": tracks, "result": result}


def stem_label(title: str) -> str:
    """「镜子里锁步 (Vocals)」「(Backing Vocals)」→ 人声 / 和声"""
    match = re.search(r"\(([^()]+)\)\s*$", title or "")
    key = (match.group(1) if match else title or "").strip().lower()
    return STEM_NAMES.get(key, key or "分轨")


def full_stems(result: dict[str, Any]) -> list[dict[str, str]]:
    """全轨分离 result.v1（v2 是另一套分法，只取一套）→ [{id, label, url}]"""
    items = result.get("v1") if isinstance(result, dict) else None
    stems = []
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and item.get("url"):
            stems.append({"id": str(item.get("id") or ""), "label": stem_label(str(item.get("title") or "")), "url": str(item["url"])})
    return stems


def clip_from_url(url: str) -> str:
    match = CLIP_IN_URL_RE.search(url or "")
    return match.group(1).lower() if match else ""


# ------------------------------------------------------------------
# MIDI：Suno 给的是音符 JSON（秒为单位），写成标准 MIDI 文件（format 1，每个乐器一轨）
# ------------------------------------------------------------------

MIDI_TPQ = 480
MIDI_BPM = 120


def _varlen(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(out))


def _track(events: list[tuple[int, bytes]]) -> bytes:
    # 同一时刻先停后发：同音高的两个音首尾相接时，不然后一个音会被前一个的 note-off 掐掉
    events.sort(key=lambda e: (e[0], 0 if e[1][0] & 0xF0 == 0x80 else 1))
    data = bytearray()
    last = 0
    for tick, payload in events:
        data += _varlen(tick - last) + payload
        last = tick
    data += b"\x00\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + bytes(data)


def notes_to_midi(instruments: list[dict[str, Any]], bpm: int = MIDI_BPM) -> bytes:
    """[{name, is_drum, notes: [{start, end, pitch, velocity(0~1)}]}] → .mid 字节"""
    ticks_per_second = MIDI_TPQ * bpm / 60
    tempo = int(60_000_000 / bpm)
    tracks = [_track([(0, b"\xff\x51\x03" + tempo.to_bytes(3, "big"))])]
    channel = 0
    for inst in instruments:
        notes = [n for n in inst.get("notes") or [] if isinstance(n, dict)]
        if not notes:
            continue
        ch = 9 if inst.get("is_drum") else channel
        if not inst.get("is_drum"):
            channel = channel + 1 if channel + 1 != 9 else 10
            channel %= 16
        name = str(inst.get("name") or "Track").encode("utf-8")[:120]
        events: list[tuple[int, bytes]] = [(0, b"\xff\x03" + _varlen(len(name)) + name)]
        try:
            program = int(inst.get("program") or 0)
        except (TypeError, ValueError):
            program = 0
        if not inst.get("is_drum") and 0 <= program <= 127:
            events.append((0, bytes([0xC0 | ch, program])))
        for n in notes:
            try:
                pitch = max(0, min(127, int(n["pitch"])))
                start = max(0, int(float(n["start"]) * ticks_per_second))
                end = max(start + 1, int(float(n["end"]) * ticks_per_second))
                velocity = max(1, min(127, int(round(float(n.get("velocity") or 0.6) * 127))))
            except (KeyError, TypeError, ValueError):
                continue
            events.append((start, bytes([0x90 | ch, pitch, velocity])))
            events.append((end, bytes([0x80 | ch, pitch, 0])))
        tracks.append(_track(events))
    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), MIDI_TPQ)
    return header + b"".join(tracks)


class MusicService:
    def __init__(self, llm_service, storage_service):
        self.llm = llm_service
        self.storage = storage_service
        # 已转进 Suno 的上传音频：OSS 地址 → clipId（免得同一段音频每次编辑都重新上传）
        self.uploaded: dict[str, str] = {}

    def config(self) -> dict[str, Any]:
        return self.llm.get_model_config(MODEL_ID)

    @property
    def available(self) -> bool:
        cfg = self.config()
        return bool(cfg.get("id") == MODEL_ID and cfg.get("available", True) and self.llm._collect_api_keys(cfg))

    def model_label(self) -> str:
        return str(self.config().get("name") or "Campbell Music")

    def model_for(self, task: str = "") -> str:
        """提交用的模型版本：默认 model，个别任务在 task_models 里单独指定"""
        cfg = self.config()
        overrides = cfg.get("task_models") if isinstance(cfg.get("task_models"), dict) else {}
        return str(overrides.get(task) or DEFAULT_TASK_MODELS.get(task) or cfg.get("model") or "chirp-v6")

    def units_for(self, kind: str = "generate") -> float:
        """一次调用的计费量：作曲和所有编辑都按 per_call，音效、分轨各有单价"""
        billing = self.config().get("billing") or {}
        key = BILLING_KEYS.get(kind, "per_call")
        try:
            return float(billing.get(key) or billing.get("per_call") or DEFAULT_PER_CALL_UNITS)
        except (TypeError, ValueError):
            return float(DEFAULT_PER_CALL_UNITS)

    def per_call_units(self) -> float:
        return self.units_for("generate")

    def _endpoint(self, path: str) -> str:
        base = str(self.config().get("api_base") or self.llm.legacy_api_base).rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        return f"{base}{path}"

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None, params: dict[str, Any] | None = None) -> Any:
        cfg = self.config()
        try:
            with build_http_client(httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)) as client:
                resp = client.request(method, self._endpoint(path), json=body, params=params,
                                      headers=self.llm._build_headers(self.llm.get_api_key(cfg) or ""))
        except httpx.HTTPError as exc:
            raise MusicError(f"音乐服务连不上（{type(exc).__name__}）") from exc
        if resp.status_code != 200:
            print(f"[Music] {path} HTTP {resp.status_code}: {resp.text[:300]}")
            if resp.status_code == 429:
                raise MusicError("音乐服务繁忙，请稍后再试")
            raise MusicError(f"音乐服务出错（HTTP {resp.status_code}）")
        try:
            return resp.json()
        except ValueError as exc:
            raise MusicError("音乐服务返回了无法解析的内容") from exc

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        return self._request("POST", path, body)

    def submit_raw(self, path: str, body: dict[str, Any]) -> str:
        """提交异步任务，返回任务编号"""
        data = self._post(path, body)
        task_id = data.get("data") if isinstance(data, dict) else None
        if not isinstance(task_id, str) or not task_id or (isinstance(data, dict) and data.get("code") not in (None, "success")):
            message = data.get("message") if isinstance(data, dict) else ""
            print(f"[Music] 提交失败 {path}: {str(data)[:300]}")
            raise MusicError(str(message or "提交失败"))
        print(f"[Music] 已提交 {path} {task_id}: {body.get('task') or ''} {body.get('title') or ''!r} ({body.get('mv') or ''})")
        return task_id

    def submit(self, request: dict[str, Any]) -> str:
        return self.submit_raw("/suno/submit/music", build_submit_body(request, self.model_for()))

    def submit_body(self, body: dict[str, Any]) -> str:
        return self.submit_raw("/suno/submit/music", body)

    def upload(self, url: str, name: str) -> str:
        """把一段音频（OSS 地址）转进 Suno，返回任务编号；完成后的 clipId 用 fetch 拿"""
        return self.submit_raw("/suno/uploads/audio", {
            "name": (name or "audio")[:60], "url": url, "upload_type": "NORMAL",
            "speed_multiplier": 1, "speed_multiplier_fix": True,
        })

    def persona(self, clip_id: str, style: str, start: float, end: float) -> str:
        return self.submit_raw("/suno/submit/persona", {
            "root_clip_id": clip_id, "user_input_styles": style or "vocal", "vocal_start_s": int(start), "vocal_end_s": int(end),
        })

    def concat(self, clip_id: str) -> str:
        return self.submit_raw("/suno/submit/concat", {"clip_id": clip_id})

    def stems(self, clip_id: str, full: bool) -> str:
        return self.submit_raw("/suno/submit/stems-all" if full else "/suno/submit/stems", {"clip_id": clip_id})

    def sound(self, description: str, loop: bool) -> str:
        return self.submit_body({
            "task": "sound", "mv": self.model_for("sound"),
            "metadata_params": {"sound": description, "type": "loop" if loop else "one_shot"},
        })

    def midi(self, clip_id: str, stem_id: str) -> dict[str, Any]:
        data = self._request("GET", "/suno/act/midi", params={"clipId": clip_id, "stemClipId": stem_id})
        inner = data.get("data") if isinstance(data, dict) else None
        return inner if isinstance(inner, dict) else {}

    def fetch(self, task_id: str) -> dict[str, Any]:
        return parse_fetch(self._post("/suno/fetch", {"ids": [task_id]}))

    def _download(self, url: str, read_timeout: float = 120.0) -> bytes:
        with build_http_client(httpx.Timeout(connect=10.0, read=read_timeout, write=10.0, pool=10.0)) as client:
            resp = client.get(url, follow_redirects=True)
        if resp.status_code != 200 or not resp.content:
            raise MusicError(f"HTTP {resp.status_code}")
        return resp.content

    def _save_cover(self, url: str, folder: str) -> str:
        """封面转存 OSS（上游地址会过期）：先要大图，拿不到用小图；都失败就不要封面"""
        if not url or not self.storage:
            return ""
        for candidate in dict.fromkeys([COVER_SMALL_RE.sub("/image_large_", url, count=1), url]):
            try:
                data = self._download(candidate, read_timeout=30.0)
            except Exception as exc:
                print(f"[Music] 封面下载失败 {candidate}: {type(exc).__name__}: {exc}")
                continue
            key = f"{folder}/cover.jpeg"
            data = label_media(data, uuid.uuid4().hex)
            if self.storage.upload_bytes(data, key, content_type="image/jpeg"):
                return f"{self.storage.public_url}/{quote(key)}"
        return ""

    @staticmethod
    def _free_name(base: str, index: int, ext: str, taken: set[str]) -> tuple[str, int]:
        """会话里已有同名文件（同一首歌再改一次）就往后编号，免得覆盖沙箱里的旧文件"""
        while f"music/{base}-{index}{ext}" in taken:
            index += 1
        taken.add(f"music/{base}-{index}{ext}")
        return f"{base}-{index}{ext}", index

    def _store(self, url: str, folder: str, name: str, title: str = "") -> tuple[bytes, str, str, str]:
        """下载、换上 LockAI 的标识（去掉 Suno 写的注释）、存 OSS。返回 (内容, mime, 地址, 内容编号)"""
        content_id = uuid.uuid4().hex
        content = label_media(self._download(url), content_id, title=title)
        ext = posixpath.splitext(name)[1].lower()
        mime = AUDIO_MIME.get(ext, "application/octet-stream")
        key = f"{folder}/{name}"
        if not (self.storage and self.storage.upload_bytes(content, key, content_type=mime)):
            raise MusicError("存储不可用")
        return content, mime, f"{self.storage.public_url}/{quote(key)}", content_id

    def save(
        self, tracks: list[dict[str, Any]], request: dict[str, Any], user_id: str | None, session_id: str | None,
        *, task_id: str = "", taken: set[str] | None = None, extra: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        下载每首成品转存 OSS，返回文件卡片（FileArtifact）；两首文件名用 -1 / -2 区分，不然会被当成同一份东西的两种格式。
        每个文件带上 music（歌名、风格、歌词、封面、时长、clipId），界面据此用音乐播放器打开，之后也能拿来编辑。
        """
        title = request.get("title") or ""
        base = safe_filename(title).rsplit(".", 1)[0].strip() or "音乐"
        taken = taken if taken is not None else set()
        files = []
        for position, track in enumerate(tracks, 1):
            url = track.get("audioUrl") or ""
            ext = posixpath.splitext(urlsplit(url).path)[1].lower() or ".m4a"
            name, _ = self._free_name(base, position, ext, taken)
            folder = f"users/{user_id or 'anonymous'}/sessions/{session_id or 'none'}/music/{track.get('clipId') or position}"
            try:
                content, mime, public, content_id = self._store(url, folder, name, title=title or base)
                meta: dict[str, Any] = {
                    "title": title or base,
                    "style": track.get("tags") or request.get("style") or "",
                    "instrumental": bool(request.get("instrumental")),
                    "lyrics": "" if request.get("instrumental") else (track.get("lyrics") or request.get("lyrics") or ""),
                    "version": position,
                    "clipId": track.get("clipId") or "",
                }
                if task_id:
                    meta["taskId"] = task_id
                if track.get("duration"):
                    meta["duration"] = track["duration"]
                if extra:
                    meta.update(extra)
                cover = self._save_cover(track.get("coverUrl") or "", folder)
                if cover:
                    meta["cover"] = cover
                files.append({"name": name, "path": f"music/{name}", "size": len(content), "mime": mime, "url": public,
                              "contentId": content_id, "music": meta})
            except Exception as exc:
                print(f"[Music] 转存第 {position} 首失败: {type(exc).__name__}: {exc}")
                files.append({"name": name, "path": f"music/{name}", "size": 0, "error": "保存失败"})
        return files

    @staticmethod
    def _plain_name(stem: str, ext: str, taken: set[str]) -> str:
        stem = safe_filename(stem).rsplit(".", 1)[0].strip() or "音频"
        name, n = stem + ext, 2
        while f"music/{name}" in taken:
            name, n = f"{stem}-{n}{ext}", n + 1
        taken.add(f"music/{name}")
        return name

    def save_plain(
        self, items: list[dict[str, Any]], base: str, user_id: str | None, session_id: str | None,
        folder_id: str, *, taken: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        分轨、音效这类不是「一首歌」的音频：按 label 命名，不带 music（用普通播放器）。
        items：[{label, url, clipId?, duration?}]；有 clipId 的（两轨分离、音效）之后还能拿来编辑。
        folder_id 不要是纯 clipId：OSS 路径里的 /music/<clipId>/ 留给歌曲认 clipId 用。
        """
        base = safe_filename(base).rsplit(".", 1)[0].strip() or "音频"
        taken = taken if taken is not None else set()
        folder = f"users/{user_id or 'anonymous'}/sessions/{session_id or 'none'}/music/{folder_id}"
        files = []
        for item in items:
            url = item.get("url") or ""
            ext = posixpath.splitext(urlsplit(url).path)[1].lower() or ".m4a"
            name = self._plain_name(f"{base}-{item.get('label') or len(files) + 1}", ext, taken)
            try:
                content, mime, public, content_id = self._store(url, folder, name, title=posixpath.splitext(name)[0])
                entry: dict[str, Any] = {"name": name, "path": f"music/{name}", "size": len(content), "mime": mime, "url": public,
                                         "contentId": content_id}
                if item.get("clipId"):
                    entry["clipId"] = item["clipId"]
                if item.get("duration"):
                    entry["duration"] = item["duration"]
                files.append(entry)
            except Exception as exc:
                print(f"[Music] 转存 {name} 失败: {type(exc).__name__}: {exc}")
                files.append({"name": name, "path": f"music/{name}", "size": 0, "error": "保存失败"})
        return files

    def save_bytes(
        self, data: bytes, stem: str, ext: str, mime: str, user_id: str | None, session_id: str | None,
        folder_id: str, *, taken: set[str] | None = None,
    ) -> dict[str, Any]:
        name = self._plain_name(stem, ext, taken if taken is not None else set())
        content_id = uuid.uuid4().hex
        data = label_media(data, content_id)
        key = f"users/{user_id or 'anonymous'}/sessions/{session_id or 'none'}/music/{folder_id}/{name}"
        if not (self.storage and self.storage.upload_bytes(data, key, content_type=mime)):
            return {"name": name, "path": f"music/{name}", "size": 0, "error": "保存失败"}
        return {"name": name, "path": f"music/{name}", "size": len(data), "mime": mime,
                "url": f"{self.storage.public_url}/{quote(key)}", "contentId": content_id}
