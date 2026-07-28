#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
watermark_pdf.py — 给 PDF 添加中文斜体水印

用法：
    python watermark_pdf.py <pdf路径> <第一行> [第二行]

输出：
    同目录下生成 <原名>_有水印.pdf

依赖（首次运行自动安装）：
    pypdf, reportlab
"""

import sys
import os
import subprocess
import math

# ── 样式常量（修改这里定制风格）──────────────────────────────────────
ANGLE       = -60    # 旋转角度（度）
ALPHA       = 0.3    # 不透明度（0-1），平铺模式下 0.3 视觉合适
FONT_SIZE   = 11     # 字号（pt）
LINE_SPACING = 16    # 行间距（pt）

# 跨平台字体查找顺序（中文字体优先，最后降级 Helvetica）
FONT_PATHS = [
    r"C:\Windows\Fonts\simhei.ttf",                                        # Windows 黑体
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",                      # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",              # Linux (Noto)
    "/System/Library/Fonts/PingFang.ttc",                                   # macOS
    "/Library/Fonts/Arial Unicode MS.ttf",                                  # macOS fallback
]
# ─────────────────────────────────────────────────────────────────────


def ensure_deps():
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "pypdf", "reportlab", "pymupdf"],
        check=False
    )


def find_cjk_font():
    for path in FONT_PATHS:
        if os.path.exists(path):
            return path
    return None


def add_watermark(input_pdf, lines, output_path=None):
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas
    from reportlab.lib import colors
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from io import BytesIO

    font_name = "Helvetica"
    font_path = find_cjk_font()
    if font_path:
        try:
            pdfmetrics.registerFont(TTFont("CJKFont", font_path))
            font_name = "CJKFont"
        except Exception:
            pass

    reader = PdfReader(input_pdf)
    first_page = reader.pages[0]
    pw = float(first_page.mediabox.width)
    ph = float(first_page.mediabox.height)

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    c.setFont(font_name, FONT_SIZE)
    c.setFillColor(colors.black)
    c.setFillAlpha(ALPHA)

    # 平铺：在旋转坐标系中按网格重复，覆盖任意尺寸和布局的 PDF
    max_w = max(c.stringWidth(l, font_name, FONT_SIZE) for l in lines)
    x_step = max_w + 60                          # 横向间距
    y_step = len(lines) * LINE_SPACING + 50      # 纵向间距
    diagonal = math.sqrt(pw ** 2 + ph ** 2)
    half = diagonal / 2 + max(x_step, y_step)

    c.saveState()
    c.translate(pw / 2, ph / 2)
    c.rotate(ANGLE)

    cols = int(half / x_step) + 1
    rows = int(half / y_step) + 1
    for row in range(-rows, rows + 1):
        for col in range(-cols, cols + 1):
            ox = col * x_step
            oy = row * y_step
            start_y = oy + (len(lines) - 1) * LINE_SPACING / 2
            for i, line in enumerate(lines):
                w = c.stringWidth(line, font_name, FONT_SIZE)
                c.drawString(ox - w / 2, start_y - i * LINE_SPACING, line)

    c.restoreState()
    c.save()
    buf.seek(0)

    writer = PdfWriter()
    wm_page = PdfReader(buf).pages[0]
    for page in reader.pages:
        page.merge_page(wm_page)
        writer.add_page(page)

    base, ext = os.path.splitext(input_pdf)
    output = output_path if output_path else base + "_有水印" + ext
    with open(output, "wb") as f:
        writer.write(f)
    return output


def flatten_to_image(pdf_path):
    """将 PDF 渲染为图片型 PDF，水印烧入像素，无法被编辑工具分离。"""
    import fitz
    src = fitz.open(pdf_path)
    out = fitz.open()
    for page in src:
        mat = fitz.Matrix(150 / 72, 150 / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img_page = out.new_page(width=page.rect.width, height=page.rect.height)
        img_page.insert_image(img_page.rect, pixmap=pix)
    src.close()
    tmp = pdf_path + ".tmp"
    out.save(tmp, deflate=True)
    out.close()
    os.replace(tmp, pdf_path)


def main():
    if sys.version_info < (3, 7):
        print("Error: Python 3.7+ required. Current: " + sys.version)
        print("Download: https://python.org")
        sys.exit(1)

    raw_args = sys.argv[1:]

    # 解析 --output=<path> 参数
    output_path = None
    args = []
    for arg in raw_args:
        if arg.startswith("--output="):
            output_path = arg[len("--output="):]
        else:
            args.append(arg)

    if len(args) < 2:
        print("Usage: watermark_pdf.py <pdf_path> <line1> [line2] [--output=<output_path>]")
        sys.exit(1)

    pdf_path = args[0]
    lines = args[1:]

    if not os.path.exists(pdf_path):
        print(f"Error: file not found: {pdf_path}")
        sys.exit(1)

    ensure_deps()
    out = add_watermark(pdf_path, lines, output_path)
    flatten_to_image(out)
    print(f"OK: {out}")


if __name__ == "__main__":
    main()
