"""
Virtual File System — 纯内存文件系统，用于论文生成过程中的文件管理。
key=相对路径，value=文件内容。
"""

import json


class VirtualFileSystem:
    """纯内存文件系统，key=相对路径，value=文件内容"""

    def __init__(self) -> None:
        self._files: dict[str, str] = {}

    def write(self, path: str, content: str) -> None:
        self._files[path] = content

    def read(self, path: str) -> str | None:
        return self._files.get(path)

    def exists(self, path: str) -> bool:
        return path in self._files

    def delete(self, path: str) -> bool:
        return self._files.pop(path, None) is not None

    def list_files(self) -> list[str]:
        return list(self._files.keys())

    def get_all(self) -> dict[str, str]:
        return self._files.copy()

    def clear(self) -> None:
        self._files.clear()

    def serialize(self) -> str:
        """序列化为 JSON（用于持久化到 S3）"""
        return json.dumps(self._files, ensure_ascii=False)

    @classmethod
    def deserialize(cls, data: str) -> "VirtualFileSystem":
        """从 JSON 反序列化（从 S3 恢复）"""
        vfs = cls()
        vfs._files = json.loads(data)
        return vfs
