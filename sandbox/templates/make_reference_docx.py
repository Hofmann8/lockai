"""
生成 pandoc 转 Word 用的参考样式（reference.docx），镜像构建时跑一次。

从 pandoc 自带的参考文档出发，把样式改成中文论文的常见格式：
正文宋体小四、1.5 倍行距、首行缩进两字；标题黑体、不带颜色；A4、页码居中；三线表。

    python make_reference_docx.py /opt/lockai/templates/reference.docx
"""

import subprocess
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

SONG = "宋体"
HEI = "黑体"
LATIN = "Times New Roman"
# Word 字号
XIAO_ER, SAN, XIAO_SAN, SI, XIAO_SI, WU = 18, 16, 15, 14, 12, 10.5


def set_fonts(style, east_asia: str, latin: str = LATIN, size: float | None = None, bold: bool | None = None):
    font = style.font
    font.name = latin
    font.color.rgb = RGBColor(0, 0, 0)
    font.italic = False
    if size is not None:
        font.size = Pt(size)
    if bold is not None:
        font.bold = bold
    rpr = style.element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs"):
        fonts.set(qn(attr), latin)
    fonts.set(qn("w:eastAsia"), east_asia)
    # 去掉主题字体引用，否则 Word 会优先用主题字体
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        if fonts.get(qn(attr)) is not None:
            del fonts.attrib[qn(attr)]


def paragraph(style, *, align=None, first_indent_chars: float | None = None, before=0, after=0, spacing=1.5):
    fmt = style.paragraph_format
    if align is not None:
        fmt.alignment = align
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    fmt.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    fmt.line_spacing = spacing
    ppr = style.element.get_or_add_pPr()
    ind = ppr.find(qn("w:ind"))
    if first_indent_chars is not None:
        if ind is None:
            ind = OxmlElement("w:ind")
            ppr.append(ind)
        # 按字符缩进（200 = 两个字），字号变了也对得齐
        ind.set(qn("w:firstLineChars"), str(int(first_indent_chars * 100)))
        ind.set(qn("w:firstLine"), str(int(first_indent_chars * XIAO_SI * 20)))
    elif ind is not None:
        ppr.remove(ind)


def style_or_none(doc, name):
    # pandoc 的样式名是 "Heading 1" 这种大写形式，python-docx 按名字取会先转成内置小写名而取不到，只能遍历
    for style in doc.styles:
        if style.name == name:
            return style
    return None


def main(out: str) -> None:
    subprocess.run(["pandoc", "-o", out, "--print-default-data-file", "reference.docx"], check=True)
    doc = Document(out)

    # 文档默认字体
    normal = style_or_none(doc, "Normal")
    set_fonts(normal, SONG, size=XIAO_SI)
    paragraph(normal, align=WD_ALIGN_PARAGRAPH.JUSTIFY)

    # pandoc 正文段落用 Body Text / First Paragraph；中文论文每段都缩进
    for name in ("Body Text", "First Paragraph"):
        st = style_or_none(doc, name)
        if st is not None:
            set_fonts(st, SONG, size=XIAO_SI)
            paragraph(st, align=WD_ALIGN_PARAGRAPH.JUSTIFY, first_indent_chars=2)
    compact = style_or_none(doc, "Compact")
    if compact is not None:
        set_fonts(compact, SONG, size=XIAO_SI)
        paragraph(compact, spacing=1.5)

    title = style_or_none(doc, "Title")
    set_fonts(title, HEI, size=XIAO_ER, bold=True)
    paragraph(title, align=WD_ALIGN_PARAGRAPH.CENTER, before=12, after=6, spacing=1.25)
    for name, size in (("Subtitle", SAN), ("Author", XIAO_SI), ("Date", WU)):
        st = style_or_none(doc, name)
        if st is not None:
            set_fonts(st, SONG if name != "Subtitle" else HEI, size=size, bold=False)
            paragraph(st, align=WD_ALIGN_PARAGRAPH.CENTER, after=3, spacing=1.25)

    for name in ("Abstract", "Abstract Title"):
        st = style_or_none(doc, name)
        if st is not None:
            set_fonts(st, SONG if name == "Abstract" else HEI, size=XIAO_SI if name == "Abstract" else SI,
                      bold=name != "Abstract")
            paragraph(st, align=WD_ALIGN_PARAGRAPH.JUSTIFY if name == "Abstract" else WD_ALIGN_PARAGRAPH.CENTER,
                      first_indent_chars=2 if name == "Abstract" else None, before=6 if name != "Abstract" else 0)

    for level, size, before, after in ((1, XIAO_SAN, 12, 6), (2, SI, 9, 4), (3, XIAO_SI, 6, 3), (4, XIAO_SI, 6, 3)):
        st = style_or_none(doc, f"Heading {level}")
        set_fonts(st, HEI, size=size, bold=True)
        paragraph(st, align=WD_ALIGN_PARAGRAPH.LEFT, before=before, after=after, spacing=1.5)
        st.paragraph_format.keep_with_next = True

    for name in ("Caption", "Table Caption", "Image Caption"):
        st = style_or_none(doc, name)
        if st is not None:
            set_fonts(st, SONG, size=WU, bold=False)
            paragraph(st, align=WD_ALIGN_PARAGRAPH.CENTER, before=3, after=6, spacing=1.25)

    for name in ("Bibliography",):
        st = style_or_none(doc, name)
        if st is not None:
            set_fonts(st, SONG, size=WU)
            paragraph(st, spacing=1.25)
            st.paragraph_format.left_indent = Cm(0.74)
            st.paragraph_format.first_line_indent = Cm(-0.74)

    for name in ("Footnote Text", "Block Text"):
        st = style_or_none(doc, name)
        if st is not None:
            set_fonts(st, SONG, size=WU if name == "Footnote Text" else XIAO_SI)
            paragraph(st, spacing=1.25)

    hyperlink = style_or_none(doc, "Hyperlink")
    if hyperlink is not None:
        hyperlink.font.color.rgb = RGBColor(0, 0, 0)
        hyperlink.font.underline = False

    # A4、页边距同 Word 默认、页脚居中页码
    for section in doc.sections:
        section.page_width, section.page_height = Cm(21), Cm(29.7)
        section.top_margin = section.bottom_margin = Cm(2.54)
        section.left_margin = section.right_margin = Cm(3.17)
        footer = section.footer
        para = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = para.add_run()
        for kind, text in (("begin", None), (None, "PAGE"), ("end", None)):
            if kind:
                el = OxmlElement("w:fldChar")
                el.set(qn("w:fldCharType"), kind)
            else:
                el = OxmlElement("w:instrText")
                el.set(qn("xml:space"), "preserve")
                el.text = text
            run._r.append(el)
        run.font.size = Pt(WU)

    doc.save(out)
    print(f"reference.docx -> {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "reference.docx")
