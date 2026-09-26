# 图片处理

## 常用
- 看信息：`identify in.jpg`（ImageMagick）；EXIF：`exiftool in.jpg`
- 格式转换 / 缩放 / 压缩：Pillow 或 ImageMagick
  - `magick in.png -resize 1600x1600\> -quality 85 out.jpg`（`\>` 只缩不放）
  - 批量：`magick mogrify -path out/ -resize 1200x -format jpg *.png`
- **iPhone HEIC**：`from pillow_heif import register_heif_opener; register_heif_opener()` 之后 Pillow 直接 `Image.open('a.heic')`；注意用 `ImageOps.exif_transpose` 纠正方向。
- 去除 EXIF（隐私）：`exiftool -all= -overwrite_original in.jpg`
- **抠图 / 去背景**：用 Python（没装 rembg 命令行）：`from rembg import remove, new_session; remove(Image.open('in.jpg'), session=new_session('u2net')).save('out.png')`，模型已预装，人像、商品效果好。
- 拼图 / 九宫格 / 长图：Pillow 计算坐标 `Image.new` + `paste`；长图拼接注意统一宽度。
- 加边框、圆角、阴影、文字：Pillow `ImageDraw`，中文字体 `ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', size)`。
- SVG 转 PNG：`rsvg-convert -w 1200 in.svg -o out.png` 或 cairosvg；位图转矢量：`potrace`（先转黑白 bmp）。
- 证件照换底色：rembg 抠出人像，再贴到纯色底（蓝 #438EDB / 红 #D9001B / 白）。

## 二维码 / 条码
- 生成：`qrcode.make('https://…').save('qr.png')`；带 logo 就用 Pillow 贴在中间（不超过 25% 面积，纠错级别用 H）。
- 识别：`from pyzbar.pyzbar import decode; decode(Image.open('a.png'))`
- 条码：python-barcode（Code128 / EAN13）。

## OCR（识别图片里的文字）
- 中文优先 RapidOCR：
  ```python
  from rapidocr_onnxruntime import RapidOCR
  result, _ = RapidOCR()('scan.jpg')   # [[box, text, score], ...]
  ```
- Tesseract 备选：`tesseract in.png - -l chi_sim+eng`
- 识别前先预处理：放大到文字高 30px 以上、转灰度、提高对比度，效果会好很多。
- 表格照片：OCR 出坐标后按行列聚类还原，结果写成 xlsx，并提醒用户核对。

## 自检与交付
处理完用 `show` 看成品（抠图边缘、方向、裁切）。成品写到 `/home/user/outputs/`；多张打 zip。
