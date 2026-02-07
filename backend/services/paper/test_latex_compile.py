"""
最小 xelatex 编译验证脚本。
使用 LocalCompiler 编译一个包含 ctex 包的最小 .tex 文件，验证编译流程正常。
"""

import sys
from latex import CompileResult, LocalCompiler


def main():
    minimal_tex = r"""\documentclass[12pt,a4paper]{article}
\usepackage{ctex}
\usepackage{fontspec}
\usepackage{geometry}
\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}

\title{编译验证}
\author{测试}
\date{\today}

\begin{document}
\maketitle

\section{引言}

这是一个最小的 xelatex 编译验证文档。如果你能看到这段中文，说明 ctex 包和 xelatex 编译器工作正常。

\section{结论}

编译成功。

\end{document}
"""

    files = {"main.tex": minimal_tex}

    print("=" * 60)
    print("xelatex 编译验证")
    print("=" * 60)

    compiler = LocalCompiler()
    print("\n正在编译（xelatex × 2）...")
    result: CompileResult = compiler.compile(files)

    if result.success:
        pdf_size = len(result.pdf_data) if result.pdf_data else 0
        print(f"\n✓ 编译成功！PDF 大小: {pdf_size:,} bytes")
    else:
        print(f"\n✗ 编译失败: {result.error}")
        print("\n--- 编译日志（最后 50 行）---")
        log_lines = result.log.strip().split("\n")
        for line in log_lines[-50:]:
            print(line)
        sys.exit(1)

    print("\n验证完成。")


if __name__ == "__main__":
    main()
