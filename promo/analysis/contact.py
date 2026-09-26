import sys
from PIL import Image, ImageDraw
paths = sys.argv[2:]; out = sys.argv[1]
cols = 4 if len(paths) > 4 else len(paths)
rows = (len(paths) + cols - 1) // cols
W, H = 640, 360
sheet = Image.new('RGB', (cols * W, rows * H), (30, 30, 30))
for i, p in enumerate(paths):
    im = Image.open(p).convert('RGB').resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im); d.rectangle([0, 0, 120, 22], fill=(0, 0, 0)); d.text((5, 4), p.split('/')[-1], fill=(255, 255, 0))
    sheet.paste(im, ((i % cols) * W, (i // cols) * H))
sheet.save(out)
