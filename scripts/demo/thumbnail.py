#!/usr/bin/env -S python3 -I
"""Video thumbnail (1280x720): title on the left, the REAL confirmation screen from the video on the right.
  thumbnail.py media/sauti-pesa-demo-frame.png media/sauti-pesa-thumbnail.png
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

src, out = sys.argv[1], sys.argv[2]
W, H = 1280, 720
F = "/usr/share/fonts/truetype/noto/NotoSans-{}.ttf"
bold = lambda s: ImageFont.truetype(F.format("Bold"), s)  # noqa: E731
reg = lambda s: ImageFont.truetype(F.format("Regular"), s)  # noqa: E731

img = Image.new("RGB", (W, H))
top, bot = (8, 32, 26), (14, 59, 46)
for y in range(H):
    k = y / (H - 1)
    ImageDraw.Draw(img).line([(0, y), (W, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * k) for i in range(3)))

frame = Image.open(src).convert("RGB")
if frame.size != (1920, 1080):
    raise SystemExit(f"unexpected frame size {frame.size}")
phone = frame.crop((516, 30, 958, 940))  # the app column, as recorded
ph_h = 640
phone = phone.resize((round(phone.width * ph_h / phone.height), ph_h), Image.LANCZOS)
x0, y0 = W - phone.width - 90, (H - ph_h) // 2
shadow = Image.new("L", (phone.width + 60, ph_h + 60), 0)
ImageDraw.Draw(shadow).rounded_rectangle([30, 30, 30 + phone.width, 30 + ph_h], radius=26, fill=150)
img.paste((0, 0, 0), (x0 - 30, y0 - 18), shadow.filter(ImageFilter.GaussianBlur(18)))
mask = Image.new("L", phone.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, phone.width - 1, ph_h - 1], radius=22, fill=255)
img.paste(phone, (x0, y0), mask)

d = ImageDraw.Draw(img)
accent = (72, 209, 151)
d.text((80, 150), "AI YAKO · AGENTIC FINANCE WITH WDK", font=bold(22), fill=accent)
d.text((76, 190), "Sauti Pesa", font=bold(92), fill=(255, 255, 255))
d.text((80, 318), "Swahili + English voice wallet", font=reg(38), fill=(226, 240, 234))
d.text((80, 364), "for USDT", font=reg(38), fill=(226, 240, 234))
d.rounded_rectangle([80, 440, 560, 494], radius=27, fill=(18, 82, 62))
d.ellipse([102, 460, 116, 474], fill=accent)
d.text((130, 449), "AI on device · Internet OFF", font=bold(26), fill=(235, 250, 244))
d.text((80, 520), "QVAC Whisper + Qwen3 · WDK offline signing", font=reg(24), fill=(170, 200, 188))
d.text((80, 640), "Swift Bot Labs · testnet demo", font=reg(20), fill=(140, 170, 158))
img.save(out, optimize=True)
print(out)
