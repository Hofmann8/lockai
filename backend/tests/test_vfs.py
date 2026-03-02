"""VirtualFileSystem 测试"""

from services.paper.vfs import VirtualFileSystem


class TestVFS:
    def test_write_read(self):
        vfs = VirtualFileSystem()
        vfs.write("main.tex", "hello")
        assert vfs.read("main.tex") == "hello"

    def test_read_nonexistent(self):
        vfs = VirtualFileSystem()
        assert vfs.read("nope.tex") is None

    def test_exists(self):
        vfs = VirtualFileSystem()
        vfs.write("a.tex", "x")
        assert vfs.exists("a.tex")
        assert not vfs.exists("b.tex")

    def test_delete(self):
        vfs = VirtualFileSystem()
        vfs.write("a.tex", "x")
        assert vfs.delete("a.tex") is True
        assert vfs.read("a.tex") is None
        assert vfs.delete("a.tex") is False

    def test_list_files(self):
        vfs = VirtualFileSystem()
        vfs.write("main.tex", "a")
        vfs.write("chapters/01.tex", "b")
        files = vfs.list_files()
        assert "main.tex" in files
        assert "chapters/01.tex" in files

    def test_get_all(self):
        vfs = VirtualFileSystem()
        vfs.write("a", "1")
        vfs.write("b", "2")
        d = vfs.get_all()
        assert d == {"a": "1", "b": "2"}
        # get_all 返回副本，修改不影响原始
        d["c"] = "3"
        assert not vfs.exists("c")

    def test_clear(self):
        vfs = VirtualFileSystem()
        vfs.write("a", "1")
        vfs.clear()
        assert vfs.list_files() == []

    def test_serialize_deserialize(self):
        vfs = VirtualFileSystem()
        vfs.write("main.tex", "\\documentclass{article}")
        vfs.write("refs.bib", "@misc{ref1}")
        data = vfs.serialize()
        vfs2 = VirtualFileSystem.deserialize(data)
        assert vfs2.read("main.tex") == "\\documentclass{article}"
        assert vfs2.read("refs.bib") == "@misc{ref1}"

    def test_overwrite(self):
        vfs = VirtualFileSystem()
        vfs.write("a.tex", "v1")
        vfs.write("a.tex", "v2")
        assert vfs.read("a.tex") == "v2"
