"""
云沙箱：阿里云函数计算云沙箱（E2B 协议兼容）

一个会话对应一个沙箱。沙箱是临时的（闲置一段时间自动回收），会话的工作区是长期的：
每轮用过沙箱后把工作区打包存到 OSS，下次沙箱没了就新开一个再恢复，用户感觉环境一直在。

目录约定（写进了系统提示词）：
- /home/user/work     工作区，项目和中间文件放这里，会随会话保留
- /home/user/inputs   用户上传的附件，每次开沙箱时从 OSS 同步
- /home/user/outputs  成品，每条命令结束后新增或改动的文件自动交付给用户
- /opt/lockai/skills  场景说明书，模板里自带

密钥不进沙箱：沙箱和 OSS 之间的文件传输都用后端签好的临时地址。
"""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import posixpath
import shlex
import threading
import time
from collections import defaultdict
from typing import Any, Callable
from urllib.parse import quote

HOME = "/home/user"
WORK_DIR = f"{HOME}/work"
INPUTS_DIR = f"{HOME}/inputs"
OUTPUTS_DIR = f"{HOME}/outputs"
STATE_DIR = f"{HOME}/.lockai"
DELIVERED_FILE = f"{STATE_DIR}/delivered.json"
INPUTS_MANIFEST = f"{STATE_DIR}/inputs.json"
# 沙箱里跑的并发下载脚本：读清单，已经有且非空的跳过，8 路并发
SYNC_INPUTS_SCRIPT = f"""
import json, os, urllib.request
from concurrent.futures import ThreadPoolExecutor
root = {INPUTS_DIR!r}
wanted = json.load(open({INPUTS_MANIFEST!r}, encoding='utf-8'))
def get(item):
    rel, url = item
    dest = os.path.join(root, rel)
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + '.part'
    try:
        with urllib.request.urlopen(url, timeout=300) as r, open(tmp, 'wb') as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(tmp, dest)
    except Exception as exc:
        print('fail', rel, exc)
        if os.path.exists(tmp):
            os.remove(tmp)
with ThreadPoolExecutor(8) as pool:
    list(pool.map(get, wanted.items()))
""".strip()
SKILLS_DIR = "/opt/lockai/skills"

# 最后一次使用后保留多久（E2B 的超时从设置时刻起算，每次用都续上）。
# 空闲也按运行计费，而从快照恢复只要一两秒，所以留得短：文件都在，只是后台服务要重启
IDLE_SECONDS = 5 * 60
# 开着预览服务时用户在看网页，访问不算使用，留久一点
SERVING_IDLE_SECONDS = 30 * 60
DEFAULT_COMMAND_TIMEOUT = 120
MAX_COMMAND_TIMEOUT = 900
MAX_SNAPSHOT_BYTES = 300 * 1024 * 1024
MAX_DELIVER_BYTES = 200 * 1024 * 1024
MAX_SHOW_IMAGES = 4
MAX_SHOW_BYTES = 6 * 1024 * 1024
BACKGROUND_SETTLE_SECONDS = 3
SNAPSHOT_EXCLUDES = ("node_modules", ".cache", ".npm", "__pycache__", ".venv", "venv", ".pnpm-store")

# 交付时额外转一份 PDF 给网页预览（表格在前端直接渲染，不用转）
PDF_PREVIEW_EXTS = {".docx", ".doc", ".odt", ".rtf", ".pptx", ".ppt", ".odp"}

SHOW_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
EXTRA_MIME = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".ics": "text/calendar",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".typ": "text/plain",
    ".tex": "text/plain",
}


def guess_mime(name: str) -> str:
    ext = posixpath.splitext(name)[1].lower()
    return EXTRA_MIME.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def snapshot_key(session_id: str) -> str:
    # 不在公开读的 users/、public/ 目录下
    return f"workspaces/{session_id}.tar.gz"


class SandboxError(Exception):
    pass


class SandboxService:
    def __init__(self, storage):
        self.storage = storage
        self.api_key = os.environ.get("E2B_API_KEY", "").strip()
        self.api_url = os.environ.get("E2B_API_URL", "").strip()
        self.domain = os.environ.get("E2B_DOMAIN", "").strip()
        self.template = os.environ.get("SANDBOX_TEMPLATE", "lockai-office").strip()
        self._locks: dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._serving: set[str] = set()  # 起过后台服务的沙箱
        self._services: dict[str, set[int]] = defaultdict(set)  # 常驻服务的进程号，打断命令时不动它们
        self._snapshotting: dict[str, threading.Lock] = defaultdict(threading.Lock)  # 按会话：正在存快照
        try:
            import e2b  # noqa: F401
            self._sdk = True
        except ImportError:
            self._sdk = False

    @property
    def available(self) -> bool:
        return bool(self._sdk and self.api_key and self.api_url and self.domain and self.storage.available)

    def _opts(self) -> dict[str, str]:
        return {"api_key": self.api_key, "api_url": self.api_url, "domain": self.domain}

    # ------------------------------------------------------------------ 生命周期

    def acquire(self, session, attachments: list[dict[str, Any]] | None = None) -> tuple[Any, str]:
        """拿到会话的沙箱：还活着就连上，没了就新开并恢复工作区。返回 (sandbox, 状态说明)。"""
        from e2b import Sandbox

        with self._locks[session.id]:
            if session.sandbox_id:
                try:
                    sandbox = Sandbox.connect(session.sandbox_id, **self._opts())
                    sandbox.set_timeout(self._idle_for(sandbox))
                    self.sync_inputs(sandbox, attachments or [])
                    return sandbox, "reused"
                except Exception as exc:
                    print(f"[Sandbox] 连接 {session.sandbox_id} 失败，重建: {type(exc).__name__}: {str(exc)[:120]}")

            started = time.monotonic()
            sandbox = Sandbox.create(
                template=self.template,
                timeout=IDLE_SECONDS,
                metadata={"session_id": session.id, "user_id": str(session.user_id)},
                **self._opts(),
            )
            self._run_quiet(sandbox, f"mkdir -p {WORK_DIR} {INPUTS_DIR} {OUTPUTS_DIR} {STATE_DIR}")
            restored = self._restore_snapshot(sandbox, session.id)
            self.sync_inputs(sandbox, attachments or [])
            session.sandbox_id = sandbox.sandbox_id
            from models import db
            db.session.commit()
            state = "restored" if restored else "created"
            print(f"[Sandbox] {state} {sandbox.sandbox_id} for {session.id} in {time.monotonic() - started:.1f}s")
            return sandbox, state

    def kill(self, sandbox_id: str | None) -> None:
        if not sandbox_id or not self.available:
            return
        try:
            from e2b import Sandbox
            Sandbox.kill(sandbox_id, **self._opts())
        except Exception as exc:
            print(f"[Sandbox] 关闭 {sandbox_id} 失败: {type(exc).__name__}: {exc}")

    def forget_session(self, session_id: str, sandbox_id: str | None) -> None:
        """会话删除：关沙箱、删工作区快照。"""
        self.kill(sandbox_id)
        self.storage.delete_object(snapshot_key(session_id))

    def copy_workspace(self, source_session_id: str, target_session_id: str) -> None:
        """分支对话：新会话从原会话当前的工作区起步。刚结束的回答快照可能还在存，等它存完再复制。"""
        with self._snapshotting[source_session_id]:
            pass
        if self.storage.exists(snapshot_key(source_session_id)):
            self.storage.copy_object(snapshot_key(source_session_id), snapshot_key(target_session_id))

    # ------------------------------------------------------------------ 执行

    def run(
        self,
        sandbox,
        command: str,
        *,
        timeout: int | None = None,
        background: bool = False,
        on_output: Callable[[str], None] | None = None,
    ) -> dict[str, Any]:
        from e2b import CommandExitException, TimeoutException

        timeout = max(5, min(int(timeout or DEFAULT_COMMAND_TIMEOUT), MAX_COMMAND_TIMEOUT))
        chunks: list[str] = []

        def sink(text: str) -> None:
            chunks.append(text)
            if on_output:
                on_output(text)

        started = time.monotonic()
        result: dict[str, Any] = {"exit_code": None, "timed_out": False, "background": background}
        try:
            if background:
                handle = sandbox.commands.run(
                    command, background=True, cwd=HOME, on_stdout=sink, on_stderr=sink, timeout=0,
                )
                time.sleep(BACKGROUND_SETTLE_SECONDS)
                result["pid"] = getattr(handle, "pid", None)
                if result["pid"]:
                    self._services[sandbox.sandbox_id].add(result["pid"])
            else:
                done = sandbox.commands.run(
                    command, cwd=HOME, on_stdout=sink, on_stderr=sink, timeout=timeout,
                )
                result["exit_code"] = done.exit_code
        except CommandExitException as exc:
            result["exit_code"] = exc.exit_code
            if exc.error and not chunks:
                sink(exc.error)
        except TimeoutException:
            result["timed_out"] = True
            sink(f"\n[命令超过 {timeout} 秒被中止；耗时的任务可以调大 timeout，常驻服务用 background]")
        result["output"] = "".join(chunks)
        result["seconds"] = round(time.monotonic() - started, 1)
        try:
            if background:
                self._serving.add(sandbox.sandbox_id)
            sandbox.set_timeout(self._idle_for(sandbox))
        except Exception:
            pass
        return result

    def interrupt(self, sandbox) -> None:
        """停下回答时掐掉还在跑的前台命令（连同它起的子进程），常驻服务留着"""
        keep = self._services.get(sandbox.sandbox_id, set())
        try:
            pids = [p.pid for p in sandbox.commands.list() if p.pid not in keep]
        except Exception as exc:
            print(f"[Sandbox] 列进程失败: {type(exc).__name__}: {exc}")
            return
        if not pids:
            return
        script = (
            "k() { for c in $(pgrep -P $1); do k $c; done; kill -9 $1 2>/dev/null; }; "
            + "; ".join(f"k {int(pid)}" for pid in pids)
        )
        try:
            sandbox.commands.run(script, cwd=HOME, timeout=10)
        except Exception:
            pass
        for pid in pids:
            try:
                sandbox.commands.kill(pid)
            except Exception:
                pass

    def _idle_for(self, sandbox) -> int:
        return SERVING_IDLE_SECONDS if sandbox.sandbox_id in self._serving else IDLE_SECONDS

    def preview_url(self, sandbox, port: int) -> str:
        return f"https://{sandbox.get_host(int(port))}"

    def read_images(self, sandbox, paths: list[str]) -> tuple[list[str], list[str]]:
        """把沙箱里的图片读成 data URL 给模型看。返回 (图片, 读不了的说明)。"""
        images: list[str] = []
        problems: list[str] = []
        for raw in paths[:MAX_SHOW_IMAGES]:
            path = self._abs(raw)
            mime = SHOW_IMAGE_TYPES.get(posixpath.splitext(path)[1].lower())
            if not mime:
                problems.append(f"{raw}: 只能查看 png/jpg/webp/gif 图片，其他格式先转成 png")
                continue
            try:
                data = sandbox.files.read(path, format="bytes")
            except Exception as exc:
                problems.append(f"{raw}: 读取失败（{type(exc).__name__}）")
                continue
            if len(data) > MAX_SHOW_BYTES:
                problems.append(f"{raw}: 图片太大（{len(data) // 1024} KB），先缩小到 2000px 以内")
                continue
            images.append(f"data:{mime};base64,{base64.b64encode(bytes(data)).decode()}")
        if len(paths) > MAX_SHOW_IMAGES:
            problems.append(f"一次最多看 {MAX_SHOW_IMAGES} 张，其余的没有附上")
        return images, problems

    # ------------------------------------------------------------------ 文件进出

    def sync_inputs(self, sandbox, attachments: list[dict[str, Any]]) -> None:
        """用户附件按原来的目录结构放到 inputs/，已经在的跳过。

        上传整个文件夹时可能有几百个文件：清单写成文件再交给沙箱里的脚本并发下载，
        不拼进命令行（太长会被拒），也不一个个串行 curl（会超时）。
        """
        wanted: dict[str, str] = {}
        for item in attachments:
            rel = input_relpath(item)
            url = str(item.get("url") or "")
            if rel and url.startswith("http"):
                wanted.setdefault(rel, url)
        if not wanted:
            return
        try:
            sandbox.files.write(INPUTS_MANIFEST, json.dumps(wanted, ensure_ascii=False))
        except Exception as exc:
            print(f"[Sandbox] 写附件清单失败: {exc}")
            return
        self._run_quiet(sandbox, f"mkdir -p {INPUTS_DIR} && python3 - <<'PY'\n{SYNC_INPUTS_SCRIPT}\nPY", timeout=900)

    def collect_outputs(self, sandbox, user_id: str | None, session_id: str) -> list[dict[str, Any]]:
        """outputs/ 里新增或改动的文件上传到 OSS，返回交付清单。"""
        listing = self._run_quiet(
            sandbox,
            f"mkdir -p {OUTPUTS_DIR} && cd {OUTPUTS_DIR} && find . -type f -not -name '.*' -printf '%P\\t%s\\t%T@\\n'",
        )
        current: dict[str, tuple[int, str]] = {}
        for line in listing.splitlines():
            parts = line.split("\t")
            if len(parts) == 3 and parts[0]:
                try:
                    current[parts[0]] = (int(parts[1]), parts[2])
                except ValueError:
                    continue
        if not current:
            return []

        delivered = self._read_delivered(sandbox)
        changed = {path: meta for path, meta in current.items() if not same_version(delivered.get(path), meta)}
        if not changed:
            return []

        files: list[dict[str, Any]] = []
        uploads: list[str] = []
        for path, (size, mtime) in sorted(changed.items()):
            name = posixpath.basename(path)
            if size > MAX_DELIVER_BYTES:
                files.append({"name": name, "path": path, "size": size, "error": "文件超过 200MB，没有交付"})
                continue
            digest = hashlib.sha1(f"{session_id}:{path}:{mtime}".encode()).hexdigest()[:10]
            key = f"users/{user_id or 'anonymous'}/sessions/{session_id}/files/{digest}/{name}"
            mime = guess_mime(name)
            put_url = self.storage.presign("PUT", key, expires=1800, content_type=mime)
            if not put_url:
                continue
            uploads.append(
                f"curl -sf -X PUT -H {shlex.quote('Content-Type: ' + mime)} --upload-file "
                f"{shlex.quote(f'{OUTPUTS_DIR}/{path}')} {shlex.quote(put_url)} && echo ok:{shlex.quote(path)}"
            )
            files.append({
                "name": name,
                "path": path,
                "size": size,
                "mime": mime,
                "url": f"{self.storage.public_url}/{quote(key)}",
                "key": key,
            })
        if uploads:
            report = self._run_quiet(sandbox, " ; ".join(uploads), timeout=600)
            ok_paths = {line[3:] for line in report.splitlines() if line.startswith("ok:")}
            for item in files:
                if "url" in item and item["path"] not in ok_paths:
                    item.pop("url", None)
                    item["error"] = "上传失败"
        self._attach_pdf_previews(sandbox, files)
        for item in files:
            if item.get("url"):
                size, mtime = current[item["path"]]
                delivered[item["path"]] = [size, whole_seconds(mtime)]
        self._write_delivered(sandbox, delivered)
        return files

    def _attach_pdf_previews(self, sandbox, files: list[dict[str, Any]]) -> None:
        """Word / PPT 在沙箱里用 LibreOffice 转一份 PDF 给网页预览；和模型自检时看到的排版一致。"""
        targets = [f for f in files if f.get("url") and posixpath.splitext(f["name"])[1].lower() in PDF_PREVIEW_EXTS]
        if not targets:
            return
        # 用编号做软链接，一次 soffice 转完所有文件（它启动一次要好几秒），也避免同名不同后缀互相覆盖
        work = "/tmp/lockai-preview"
        links, uploads = [], []
        for i, item in enumerate(targets):
            key = f"{item['key']}.preview.pdf"
            put_url = self.storage.presign("PUT", key, expires=1800, content_type="application/pdf")
            if not put_url:
                continue
            ext = posixpath.splitext(item["name"])[1].lower()
            src = shlex.quote(f"{OUTPUTS_DIR}/{item['path']}")
            links.append(f"ln -sf {src} {work}/{i}{ext}")
            uploads.append(
                f"[ -s {work}/{i}.pdf ] && curl -sf -X PUT -H 'Content-Type: application/pdf' "
                f"--upload-file {work}/{i}.pdf {shlex.quote(put_url)} && echo preview:{i}"
            )
            item["_preview_key"] = key
        if not links:
            return
        script = (
            f"rm -rf {work} && mkdir -p {work} && " + " && ".join(links)
            + f" && (cd {work} && soffice --headless --convert-to pdf --outdir {work} $(ls | grep -v '\\.pdf$') >/dev/null 2>&1)"
            + " ; " + " ; ".join(uploads) + f" ; rm -rf {work}"
        )
        report = self._run_quiet(sandbox, script, timeout=240)
        done = {line[8:] for line in report.splitlines() if line.startswith("preview:")}
        for i, item in enumerate(targets):
            key = item.pop("_preview_key", None)
            if key and str(i) in done:
                item["preview"] = f"{self.storage.public_url}/{quote(key)}"

    def snapshot(self, sandbox_id: str, session_id: str) -> bool:
        """把工作区打包存到 OSS（后台线程里跑，不耽误回答结束）。确实传上去了才返回 True。"""
        if not sandbox_id or not self.available:
            return False
        with self._snapshotting[session_id]:
            return self._snapshot(sandbox_id, session_id)

    def _snapshot(self, sandbox_id: str, session_id: str) -> bool:
        try:
            from e2b import Sandbox
            sandbox = Sandbox.connect(sandbox_id, **self._opts())
            excludes = " ".join(f"--exclude={shlex.quote(p)}" for p in SNAPSHOT_EXCLUDES)
            size_text = self._run_quiet(
                sandbox,
                f"cd {HOME} && tar czf /tmp/ws.tgz {excludes} work outputs .lockai 2>/dev/null; stat -c %s /tmp/ws.tgz",
                timeout=300,
            ).strip().splitlines()
            size = int(size_text[-1]) if size_text and size_text[-1].isdigit() else 0
            if not size or size > MAX_SNAPSHOT_BYTES:
                print(f"[Sandbox] 跳过快照 {session_id}: {size} bytes")
                return False
            put_url = self.storage.presign("PUT", snapshot_key(session_id), expires=1800, content_type="application/gzip")
            report = self._run_quiet(
                sandbox,
                f"curl -sf -X PUT -H 'Content-Type: application/gzip' --upload-file /tmp/ws.tgz {shlex.quote(put_url)} "
                f"&& echo uploaded; rm -f /tmp/ws.tgz",
                timeout=600,
            )
            if "uploaded" not in report:
                print(f"[Sandbox] 快照上传失败 {session_id}")
                return False
            print(f"[Sandbox] 快照 {session_id}: {size // 1024} KB")
            return True
        except Exception as exc:
            print(f"[Sandbox] 快照失败 {session_id}: {type(exc).__name__}: {exc}")
            return False

    # ------------------------------------------------------------------ 内部

    def _restore_snapshot(self, sandbox, session_id: str) -> bool:
        if not self.storage.exists(snapshot_key(session_id)):
            return False
        get_url = self.storage.presign("GET", snapshot_key(session_id), expires=1800)
        out = self._run_quiet(
            sandbox,
            f"curl -sfL --max-time 300 {shlex.quote(get_url)} | tar xzf - -C {HOME} && echo restored",
            timeout=600,
        )
        return "restored" in out

    def _read_delivered(self, sandbox) -> dict[str, list]:
        try:
            data = json.loads(sandbox.files.read(DELIVERED_FILE) or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _write_delivered(self, sandbox, delivered: dict[str, list]) -> None:
        try:
            sandbox.files.write(DELIVERED_FILE, json.dumps(delivered, ensure_ascii=False))
        except Exception as exc:
            print(f"[Sandbox] 写交付清单失败: {exc}")

    def _run_quiet(self, sandbox, command: str, timeout: int = 60) -> str:
        from e2b import CommandExitException
        try:
            return sandbox.commands.run(command, cwd=HOME, timeout=timeout).stdout
        except CommandExitException as exc:
            return exc.stdout or ""

    @staticmethod
    def _abs(path: str) -> str:
        path = (path or "").strip()
        return path if path.startswith("/") else posixpath.join(HOME, path)


def whole_seconds(mtime: Any) -> str:
    """修改时间只比到秒：工作区快照用 tar 打包，恢复后亚秒部分会丢，比到亚秒会把旧文件当成新改的再交付一遍。"""
    try:
        return str(int(float(mtime)))
    except (TypeError, ValueError):
        return str(mtime)


def same_version(recorded: Any, meta: tuple[int, str]) -> bool:
    """交付清单里记的 [大小, 修改时间] 和现在的文件是不是同一版"""
    if not isinstance(recorded, list) or len(recorded) != 2:
        return False
    return recorded[0] == meta[0] and whole_seconds(recorded[1]) == whole_seconds(meta[1])


def safe_relpath(path: str, max_depth: int = 8) -> str:
    """用户上传时带的相对路径（文件夹上传）：逐段清洗，去掉 . 和 ..，不允许跳出 inputs/。"""
    parts = [safe_filename(p) for p in str(path or "").replace("\\", "/").split("/")]
    parts = [p for p in parts if p and p not in (".", "..")]
    if not parts or len(parts) > max_depth:
        return ""
    rel = "/".join(parts)
    return rel if len(rel) <= 240 else ""


def input_relpath(item: dict[str, Any]) -> str:
    """附件在 inputs/ 下的相对路径：有目录结构用 path，否则就是文件名。"""
    return safe_relpath(item.get("path") or "") or safe_filename(item.get("name") or "")


def safe_filename(name: str) -> str:
    name = posixpath.basename(str(name).replace("\\", "/")).strip()
    name = "".join(ch for ch in name if ch not in '\x00\n\r\t"\'`$')
    return name[:120] or ""
