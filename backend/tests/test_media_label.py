"""生成内容出库前换标识：上游的信息去干净，LockAI 的 AIGC 标识写对，画面和声音不受影响。"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

from services.media_label import aigc_label, label_media, read_label, sniff
from services.music import notes_to_midi

FIXTURES = Path(__file__).parent / "fixtures"


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def _png_with_vendor_info() -> bytes:
    """1x1 的 PNG，带上 C2PA（caBX）、文字块和 EXIF，模拟上游返回的图"""
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\x00\x00")
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"sRGB", b"\x00")
            + _chunk(b"caBX", b"jumb c2pa OpenAI Media Service API gpt-image") + _chunk(b"tEXt", b"Software\x00OpenAI")
            + _chunk(b"eXIf", b"MM\x00*") + _chunk(b"IDAT", idat) + _chunk(b"IEND", b""))


def _png_chunks(data: bytes) -> list[bytes]:
    pos, kinds = 8, []
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        assert struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])[0] == zlib.crc32(kind + body) & 0xFFFFFFFF
        kinds.append(kind)
        pos += 12 + length
    return kinds


def test_png_keeps_pixels_drops_c2pa_and_adds_aigc():
    raw = _png_with_vendor_info()
    out = label_media(raw, "img1")
    assert _png_chunks(out) == [b"IHDR", b"sRGB", b"iTXt", b"IDAT", b"IEND"]
    assert b"OpenAI" not in out and b"c2pa" not in out
    assert raw[raw.index(b"IDAT") - 4:].endswith(out[out.index(b"IDAT") - 4:])  # 图像数据原样
    assert read_label(out) == aigc_label("img1")
    assert b"xmp:CreatorTool=\"LockAI\"" in out and b"trainedAlgorithmicMedia" in out


def _segment(marker: int, body: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack(">H", len(body) + 2) + body


def test_jpeg_keeps_color_segments_and_image_data():
    scan = b"\xff\xda" + struct.pack(">H", 8) + b"\x01\x01\x00\x00\x3f\x00" + b"\x12\x34\xff\x00\x56" + b"\xff\xd9"
    raw = (b"\xff\xd8" + _segment(0xE0, b"JFIF\x00\x01\x01") + _segment(0xE1, b"Exif\x00\x00MM OpenAI")
           + _segment(0xE2, b"ICC_PROFILE\x00..") + _segment(0xEB, b"JP c2pa jumb") + _segment(0xFE, b"made by vendor")
           + _segment(0xDB, b"\x00" + bytes(64)) + scan)
    out = label_media(raw, "cover1", title="锁舞")
    assert b"OpenAI" not in out and b"c2pa" not in out and b"vendor" not in out
    assert b"ICC_PROFILE" in out and out.endswith(scan)
    assert out.index(b"JFIF") < out.index(b"http://ns.adobe.com/xap/1.0/\x00") < out.index(b"ICC_PROFILE")
    assert read_label(out)["ProduceID"] == "cover1" and "锁舞".encode() in out


def test_m4a_tags_are_replaced():
    raw = (FIXTURES / "tiny_suno.m4a").read_bytes()
    assert b"made with suno" in raw and b"Lavf" in raw
    out = label_media(raw, "song1", title="镜子里锁步")
    assert b"suno" not in out and b"Lavf" not in out
    assert read_label(out) == aigc_label("song1")
    from io import BytesIO

    from mutagen.mp4 import MP4
    tags = MP4(BytesIO(out)).tags
    assert tags["\xa9nam"] == ["镜子里锁步"] and tags["\xa9too"] == ["LockAI"]


def test_midi_gets_a_label_and_stays_valid():
    raw = notes_to_midi([{"name": "Bass", "notes": [{"start": 0, "end": 0.5, "pitch": 40}]}])
    out = label_media(raw, "midi1")
    assert read_label(out)["ProduceID"] == "midi1" and b"\xff\x02\x06LockAI" in out
    # 第一轨长度跟着改了：按长度能走到第二轨
    first = struct.unpack(">I", out[18:22])[0]
    assert out[22 + first:26 + first] == b"MTrk"


def test_unknown_or_broken_files_are_kept_as_is():
    assert label_media(b"plain text", "x") == b"plain text"
    broken = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\xff\xffIHDR"  # 块长度越界
    assert label_media(broken, "x") == broken
    assert sniff(b"\xff\xd8\xff\xe0") == "jpeg" and sniff(b"....ftypisom") == "mp4"
