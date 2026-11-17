"""
生成内容出库前的统一处理：去掉上游供应商写进文件的信息，换成 LockAI 的标识。

为什么要做：
- 上游会在文件里留自己的痕迹（2026-11 实测：生图的 PNG 带 OpenAI 签发的 C2PA 凭证，Suno 的 m4a 注释里写着
  "made with suno" 和它的 clipId）。供应商随时可能换，用户拿到的文件不该跟着变
- 《人工智能生成合成内容标识办法》（2025-09 施行）要求 AI 生成的文件带隐式标识，格式按 GB 45438-2025 附录 E：
  元数据里一个 AIGC 字段，值是 JSON（Label、ContentProducer、ProduceID、ReservedCode1、ContentPropagator、
  PropagateID、ReservedCode2）。这里只换掉「谁生成的」，「这是 AI 生成的」照实保留

写在哪里（和即梦、可灵以及常见检测工具一致）：
- PNG：iTXt 块（关键字 XML:com.adobe.xmp）里的 XMP，命名空间 http://www.tc260.org.cn/ns/AIGC/1.0/ 的 AIGC 属性
- JPEG：APP1 段的 XMP，同上
- m4a / mp4：moov.udta.meta.ilst 里名为 AIGC 的自由格式标签（用 mutagen 改，它会顺带修好音频数据的偏移）
- mp3：ID3 的 TXXX:AIGC
- MIDI：第一轨开头的文字事件
像素和音频里嵌的不可见水印不在元数据里，这里不碰。认不出的格式原样返回。
"""

from __future__ import annotations

import io
import json
import struct
import zlib
from typing import Any
from xml.sax.saxutils import escape

PRODUCER = "LockAI"
AIGC_NS = "http://www.tc260.org.cn/ns/AIGC/1.0/"
AI_SOURCE_TYPE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"

# PNG：只留显示需要的块，其余（caBX 即 C2PA、tEXt / iTXt / zTXt、eXIf、tIME、私有块）一律去掉
PNG_KEEP = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"sBIT", b"pHYs",
            b"bKGD", b"acTL", b"fcTL", b"fdAT"}
# JPEG：APP0（JFIF）、APP2（ICC 色彩）、APP14（Adobe 色彩变换）影响显示，留着；其余 APPn 和注释去掉
JPEG_KEEP_APP = {0xE0, 0xE2, 0xEE}
XMP_JPEG_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"


def aigc_label(content_id: str) -> dict[str, str]:
    """GB 45438-2025 附录 E 的隐式标识。生成方先写入时，传播方两项也填自己（附录 E 注 1）"""
    return {
        "Label": "1",
        "ContentProducer": PRODUCER,
        "ProduceID": content_id,
        "ReservedCode1": "",
        "ContentPropagator": PRODUCER,
        "PropagateID": content_id,
        "ReservedCode2": "",
    }


def _aigc_json(content_id: str) -> str:
    return json.dumps(aigc_label(content_id), ensure_ascii=False, separators=(",", ":"))


def xmp_packet(content_id: str, title: str = "") -> bytes:
    title_xml = (
        f'\n   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">{escape(title)}</rdf:li></rdf:Alt></dc:title>'
        if title else ""
    )
    return (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        f'    xmlns:TC260="{AIGC_NS}"\n'
        '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
        '    xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"\n'
        f'    xmp:CreatorTool="{PRODUCER}"\n'
        f'    Iptc4xmpExt:DigitalSourceType="{AI_SOURCE_TYPE}">\n'
        f'   <TC260:AIGC>{escape(_aigc_json(content_id))}</TC260:AIGC>{title_xml}\n'
        '  </rdf:Description>\n'
        ' </rdf:RDF>\n'
        '</x:xmpmeta>\n'
        '<?xpacket end="w"?>'
    ).encode("utf-8")


# ------------------------------------------------------------------
# 各格式
# ------------------------------------------------------------------

def _png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def label_png(data: bytes, content_id: str, title: str = "") -> bytes:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("不是 PNG")
    out = [data[:8]]
    pos, inserted = 8, False
    xmp = _png_chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x00\x00\x00\x00" + xmp_packet(content_id, title))
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        end = pos + 12 + length
        if end > len(data):
            raise ValueError("PNG 块越界")
        if kind == b"IDAT" and not inserted:
            out.append(xmp)
            inserted = True
        if kind in PNG_KEEP:
            out.append(data[pos:end])
        pos = end
        if kind == b"IEND":
            break
    if not inserted:
        raise ValueError("PNG 没有图像数据")
    return b"".join(out)


def label_jpeg(data: bytes, content_id: str, title: str = "") -> bytes:
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("不是 JPEG")
    out = [b"\xff\xd8"]
    pos, inserted = 2, False
    packet = XMP_JPEG_HEADER + xmp_packet(content_id, title)
    if len(packet) + 2 > 0xFFFF:
        raise ValueError("XMP 太长")
    xmp = b"\xff\xe1" + struct.pack(">H", len(packet) + 2) + packet
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            raise ValueError("JPEG 段错位")
        marker = data[pos + 1]
        if marker == 0xFF:  # 填充字节
            pos += 1
            continue
        if marker == 0xDA:  # 图像数据开始：后面整段原样保留
            if not inserted:
                out.append(xmp)
            out.append(data[pos:])
            return b"".join(out)
        length = struct.unpack(">H", data[pos + 2:pos + 4])[0]
        segment = data[pos:pos + 2 + length]
        is_app = 0xE0 <= marker <= 0xEF
        if not inserted and not (marker == 0xE0):  # 放在 JFIF 之后、其余段之前
            out.append(xmp)
            inserted = True
        if (not is_app and marker != 0xFE) or marker in JPEG_KEEP_APP:
            out.append(segment)
        pos += 2 + length
    raise ValueError("JPEG 没有图像数据")


def _blank_top_level_uuid(data: bytes) -> bytes:
    """
    顶层的 uuid 盒（C2PA 凭证就放在这里，2026-11 实测 Grok 的视频带）原地改成同样长的空 free 盒。
    不直接删：删了后面音视频数据的位置会变，得跟着改 moov 里的偏移
    """
    out = bytearray(data)
    pos = 0
    while pos + 8 <= len(out):
        size, kind = struct.unpack(">I4s", out[pos:pos + 8])
        header = 8
        if size == 1:
            size = struct.unpack(">Q", out[pos + 8:pos + 16])[0]
            header = 16
        elif size == 0:
            size = len(out) - pos
        if size < header or pos + size > len(out):
            break
        if kind == b"uuid":
            out[pos + 4:pos + 8] = b"free"
            out[pos + header:pos + size] = bytes(size - header)
        pos += size
    return bytes(out)


def label_mp4(data: bytes, content_id: str, title: str = "") -> bytes:
    from mutagen.mp4 import MP4, MP4FreeForm

    buf = io.BytesIO(_blank_top_level_uuid(data))
    audio = MP4(buf)
    if audio.tags is None:
        audio.add_tags()
    audio.tags.clear()
    audio.tags["\xa9too"] = [PRODUCER]
    if title:
        audio.tags["\xa9nam"] = [title]
    audio.tags["----:com.apple.iTunes:AIGC"] = [MP4FreeForm(_aigc_json(content_id).encode("utf-8"))]
    buf.seek(0)
    audio.save(buf)
    return buf.getvalue()


def label_mp3(data: bytes, content_id: str, title: str = "") -> bytes:
    from mutagen.id3 import TIT2, TSSE, TXXX
    from mutagen.mp3 import MP3

    buf = io.BytesIO(data)
    audio = MP3(buf)
    if audio.tags is None:
        audio.add_tags()
    audio.tags.clear()
    audio.tags.add(TSSE(encoding=3, text=[PRODUCER]))
    if title:
        audio.tags.add(TIT2(encoding=3, text=[title]))
    audio.tags.add(TXXX(encoding=3, desc="AIGC", text=[_aigc_json(content_id)]))
    buf.seek(0)
    audio.save(buf)
    return buf.getvalue()


def _midi_varlen(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(out))


def label_midi(data: bytes, content_id: str, title: str = "") -> bytes:
    """第一轨开头加版权和文字事件（MIDI 没有统一的元数据规范，写成可读文字）"""
    if not data.startswith(b"MThd"):
        raise ValueError("不是 MIDI")
    header_len = 8 + struct.unpack(">I", data[4:8])[0]
    if data[header_len:header_len + 4] != b"MTrk":
        raise ValueError("MIDI 没有音轨")
    size = struct.unpack(">I", data[header_len + 4:header_len + 8])[0]
    body = data[header_len + 8:header_len + 8 + size]
    events = b""
    for kind, text in ((0x02, PRODUCER), (0x01, "AIGC=" + _aigc_json(content_id))):
        raw = text.encode("utf-8")
        events += b"\x00\xff" + bytes([kind]) + _midi_varlen(len(raw)) + raw
    body = events + body
    return data[:header_len] + b"MTrk" + struct.pack(">I", len(body)) + body + data[header_len + 8 + size:]


LABELERS = {
    "png": label_png,
    "jpeg": label_jpeg,
    "mp4": label_mp4,
    "mp3": label_mp3,
    "midi": label_midi,
}


def sniff(data: bytes) -> str:
    """按文件头认格式：扩展名和上游给的 mime 都可能不准"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data[4:8] == b"ftyp":
        return "mp4"
    if data.startswith(b"ID3") or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0):
        return "mp3"
    if data.startswith(b"MThd"):
        return "midi"
    return ""


def label_media(data: bytes, content_id: str, *, title: str = "") -> bytes:
    """去掉上游的元数据、写入 LockAI 的标识。出错或认不出格式时原样返回（不能因为打标签丢了成品）"""
    kind = sniff(data)
    labeler = LABELERS.get(kind)
    if labeler is None:
        print(f"[Label] 认不出的格式，原样保存（{data[:8]!r}）")
        return data
    try:
        return labeler(data, content_id, title)
    except Exception as exc:
        print(f"[Label] {kind} 打标签失败，原样保存: {type(exc).__name__}: {exc}")
        return data


def read_label(data: bytes) -> dict[str, Any] | None:
    """读回 AIGC 标识（测试和核对用）"""
    marker = b"<TC260:AIGC>"
    if marker in data:
        start = data.index(marker) + len(marker)
        raw = data[start:data.index(b"</TC260:AIGC>", start)].decode("utf-8")
        return json.loads(raw.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    kind = sniff(data)
    if kind in ("mp4", "mp3"):
        from mutagen import File

        audio = File(io.BytesIO(data))
        tags = audio.tags if audio is not None else None
        if tags is None:
            return None
        value = tags.get("----:com.apple.iTunes:AIGC") if kind == "mp4" else tags.get("TXXX:AIGC")
        if value:
            raw = bytes(value[0]).decode("utf-8") if kind == "mp4" else str(value.text[0])
            return json.loads(raw)
    if kind == "midi" and b"AIGC=" in data:
        start = data.index(b"AIGC=") + 5
        return json.loads(data[start:data.index(b"}", start) + 1].decode("utf-8"))
    return None
