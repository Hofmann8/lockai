"""LaTeX 编译器 + extract_errors 测试"""

from services.paper.latex import extract_errors, CompileResult


class TestExtractErrors:
    def test_xelatex_error(self):
        log = (
            "This is XeTeX\n"
            "! Undefined control sequence.\n"
            "l.42 \\badcommand\n"
            "               {arg}\n"
            "some other line\n"
        )
        result = extract_errors(log)
        assert "Undefined control sequence" in result
        assert "l.42" in result

    def test_bibtex_warning(self):
        log = "Warning--empty year in ref3\nsome other line"
        result = extract_errors(log)
        assert "Warning--empty year" in result

    def test_emergency_stop(self):
        log = "some line\n!  ==> Fatal error occurred, no output PDF file produced!\nend"
        result = extract_errors(log)
        assert "Fatal error" in result

    def test_file_line_error(self):
        log = "./chapters/01_intro.tex:42: Undefined control sequence"
        result = extract_errors(log)
        assert "chapters/01_intro.tex:42" in result

    def test_empty_log(self):
        assert extract_errors("") == ""
        assert extract_errors(None) == ""

    def test_no_errors_fallback(self):
        lines = [f"line {i}" for i in range(50)]
        log = "\n".join(lines)
        result = extract_errors(log)
        assert "line 49" in result
        assert "line 20" in result

    def test_multiple_errors(self):
        log = (
            "! Missing $ inserted.\n"
            "l.10 some math\n"
            "\n"
            "! Undefined control sequence.\n"
            "l.25 \\foo\n"
        )
        result = extract_errors(log)
        assert "Missing $" in result
        assert "Undefined control sequence" in result

    def test_error_message_in_bibtex(self):
        log = 'I found no \\citation commands---while reading file main.aux\nerror message---line 5 of file refs.bib'
        result = extract_errors(log)
        assert "error message" in result


class TestCompileResult:
    def test_success(self):
        r = CompileResult(success=True, pdf_data=b"pdf", log="ok")
        assert r.success
        assert r.pdf_data == b"pdf"

    def test_failure(self):
        r = CompileResult(success=False, error="xelatex failed", log="err", errors="! error")
        assert not r.success
        assert r.error == "xelatex failed"
        assert r.errors == "! error"
