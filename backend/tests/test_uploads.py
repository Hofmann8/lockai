"""用户上传：文件夹结构进沙箱、图片同时进 inputs/images/、历史图片只留最近几条原图。"""

from __future__ import annotations

import json
import subprocess
import sys
import types

from services import sandbox as sandbox_module
from services.ai import AIService, _image_attachments
from services.sandbox import SandboxService, input_relpath, safe_relpath


# ------------------------------------------------------------------ 路径清洗

def test_relpath_keeps_folder_structure():
    assert safe_relpath("活动照片/day1/a.jpg") == "活动照片/day1/a.jpg"
    assert safe_relpath("活动照片\\day1\\a.jpg") == "活动照片/day1/a.jpg"


def test_relpath_cannot_escape_inputs():
    assert safe_relpath("../../etc/passwd") == "etc/passwd"
    assert safe_relpath("/etc/passwd") == "etc/passwd"
    assert safe_relpath("a/./../b.txt") == "a/b.txt"
    assert safe_relpath("") == ""
    assert safe_relpath("/".join(["d"] * 9) + "/x.txt") == ""


def test_input_relpath_prefers_path_then_name():
    assert input_relpath({"name": "a.jpg", "path": "照片/a.jpg"}) == "照片/a.jpg"
    assert input_relpath({"name": "a.jpg"}) == "a.jpg"
    assert input_relpath({"name": "a.jpg", "path": "../"}) == "a.jpg"


def test_chat_images_go_to_inputs_images():
    items = _image_attachments(["https://b.example/users/1/sessions/s/images/abc.png"])
    assert items[0]["path"] == "images/abc.png"


# ------------------------------------------------------------------ 同步进沙箱

class _FakeSandbox:
    def __init__(self):
        self.written = {}
        self.commands_run = []
        self.files = types.SimpleNamespace(write=lambda path, data: self.written.__setitem__(path, data))
        self.commands = types.SimpleNamespace(run=self._run)

    def _run(self, command, cwd=None, timeout=None):
        self.commands_run.append(command)
        return types.SimpleNamespace(stdout="")


def test_sync_inputs_writes_manifest_instead_of_long_command():
    service = SandboxService.__new__(SandboxService)
    box = _FakeSandbox()
    files = [{"name": f"{i}.jpg", "path": f"活动照片/day{i % 3}/{i}.jpg", "url": f"https://b/{i}.jpg"} for i in range(300)]
    files.append({"name": "x.png", "path": "images/x.png", "url": "https://b/x.png"})
    files.append({"name": "dup.jpg", "path": "活动照片/day0/0.jpg", "url": "https://b/other.jpg"})  # 同一路径只取第一个
    service.sync_inputs(box, files)

    manifest = json.loads(box.written[sandbox_module.INPUTS_MANIFEST])
    assert len(manifest) == 301
    assert manifest["活动照片/day0/0.jpg"] == "https://b/0.jpg"
    assert manifest["images/x.png"] == "https://b/x.png"
    # 命令行里只有固定的脚本，不随文件数变长
    assert len(box.commands_run) == 1 and "https://" not in box.commands_run[0]


def test_sync_script_downloads_into_folders_and_skips_existing(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.txt").write_text("A", encoding="utf-8")
    (src / "b.txt").write_text("B", encoding="utf-8")
    root = tmp_path / "inputs"
    (root / "keep").mkdir(parents=True)
    (root / "keep" / "old.txt").write_text("OLD", encoding="utf-8")
    manifest = tmp_path / "inputs.json"
    manifest.write_text(json.dumps({
        "照片/day1/a.txt": (src / "a.txt").as_uri(),
        "b.txt": (src / "b.txt").as_uri(),
        "keep/old.txt": (src / "a.txt").as_uri(),
        "missing/x.txt": (src / "nope.txt").as_uri(),
    }), encoding="utf-8")
    script = (
        sandbox_module.SYNC_INPUTS_SCRIPT
        .replace(repr(sandbox_module.INPUTS_DIR), repr(str(root)))
        .replace(repr(sandbox_module.INPUTS_MANIFEST), repr(str(manifest)))
    )
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True)

    assert (root / "照片" / "day1" / "a.txt").read_text(encoding="utf-8") == "A"
    assert (root / "b.txt").read_text(encoding="utf-8") == "B"
    assert (root / "keep" / "old.txt").read_text(encoding="utf-8") == "OLD"  # 已经有的不重下
    assert not (root / "missing").exists() or not any((root / "missing").iterdir())  # 下载失败不留半截文件


# ------------------------------------------------------------------ 告诉模型附件在哪

def _service(sandbox_ready=True):
    service = AIService.__new__(AIService)
    service.sandbox = types.SimpleNamespace(available=sandbox_ready)
    return service


def test_few_attachments_are_listed_one_by_one():
    text = _service()._with_attachments("看看", [{"name": "a.pdf", "path": "资料/a.pdf", "size": 2048}])
    assert "/home/user/inputs/资料/a.pdf（2 KB）" in text


def test_many_attachments_are_summarized_by_folder():
    files = [{"name": f"{i}.jpg", "path": f"活动照片/{i}.jpg", "size": 1024 * 1024} for i in range(120)]
    files += [{"name": "名单.xlsx", "size": 10}]
    text = _service()._with_attachments("挑几张", files)
    assert "/home/user/inputs/活动照片/ 文件夹：120 个文件，共 120.0 MB" in text
    assert "/home/user/inputs/名单.xlsx" in text
    assert "共 121 个文件" in text
    assert "活动照片/7.jpg" not in text


def test_without_sandbox_attachments_fall_back_to_urls():
    text = _service(False)._with_attachments("看看", [{"name": "a.pdf", "size": 1, "url": "https://b/a.pdf"}], ["https://b/i.png"])
    assert "a.pdf（1 B）：https://b/a.pdf" in text
    assert "inputs" not in text


# ------------------------------------------------------------------ 历史图片

def _built(history, images=None, sandbox_ready=True, monkeypatch=None):
    service = _service(sandbox_ready)
    service.llm = types.SimpleNamespace(get_model_config=lambda _id: {})
    service.image = types.SimpleNamespace(build_asset_catalog_message=lambda *a, **k: "")
    monkeypatch.setattr(AIService, "_delegate_target", lambda self, cfg: "")
    return service._build_messages(
        message="现在这条", history=history, model_id="campbell", session_id="s1",
        images=images or [], current_user_message_id=None,
    )


def _inline_images(messages):
    return [p["image_url"]["url"] for m in messages if isinstance(m["content"], list) for p in m["content"] if p["type"] == "image_url"]


def _history(n):
    rows = []
    for i in range(n):
        rows.append({"role": "user", "content": f"第{i}张", "images": [f"https://b/img{i}.png"]})
        rows.append({"role": "assistant", "content": "好的"})
    return rows


def test_only_recent_history_images_stay_in_context(monkeypatch):
    messages = _built(_history(4), monkeypatch=monkeypatch)
    assert _inline_images(messages) == ["https://b/img2.png", "https://b/img3.png"]
    old = next(m["content"] for m in messages if isinstance(m["content"], str) and m["content"].startswith("第0张"))
    assert "已不在上下文里" in old and "/home/user/inputs/images/img0.png" in old


def test_current_images_count_toward_recent(monkeypatch):
    messages = _built(_history(3), images=["https://b/now.png"], monkeypatch=monkeypatch)
    assert _inline_images(messages) == ["https://b/img2.png", "https://b/now.png"]


def test_without_sandbox_history_images_all_stay(monkeypatch):
    messages = _built(_history(4), sandbox_ready=False, monkeypatch=monkeypatch)
    assert len(_inline_images(messages)) == 4
