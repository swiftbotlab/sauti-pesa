"""Render the test "screenshots" in test/data/public/screens/ (our own wording; no real people, numbers or brands'
artwork). Each is a plain phone-style chat or SMS screen with the message as text, like the screenshots people
forward when they ask "is this real?". Needs Pillow and the DejaVu Sans font (Debian/Ubuntu: fonts-dejavu-core).
  python3 -I scripts/make_test_screens.py
The expected verdicts are in test/data/public/screens/labels.json (written by hand, not by this script).
"""
import json
import os
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'test', 'data', 'public', 'screens')
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
AMINA_LOOKALIKE = json.load(open(os.path.join(ROOT, 'data', 'demo-attack.json')))['poisoned_amina']

W = 720
SCREENS = {
    # fake mobile-money "confirmation" followed by the classic "I sent it by mistake, send it back"
    'sw_rudisha_kimakosa.png': {
        'title': '+254 7XX XXX 318', 'kind': 'sms',
        'bubbles': [
            ('in', 'QK7H2LMN4P Imethibitishwa. Umepokea Ksh 3,450.00 kutoka JOHN K. tarehe 27/10/26 saa 9:14 asubuhi.'),
            ('in', 'Samahani ndugu, nimekutumia pesa kimakosa. Tafadhali nirudishie sasa hivi, ni pesa ya hospitali. Usimwambie mtu.'),
        ],
    },
    # "it's me, I changed my wallet": a look-alike of the saved landlord address (data/demo-attack.json)
    'sw_anwani_mpya.png': {
        'title': 'Amina (landlord)', 'kind': 'chat',
        'bubbles': [
            ('in', 'Habari! Nimebadilisha wallet yangu. Kodi ya mwezi huu tuma kwa anwani mpya:'),
            ('in', AMINA_LOOKALIKE),
            ('in', 'Tuma USDT 40 leo tu tafadhali.'),
        ],
    },
    # an ordinary request between family members: no warning sign
    'sw_kawaida.png': {
        'title': 'Juma', 'kind': 'chat',
        'bubbles': [
            ('in', 'Habari kaka. Karo ya shule ya Neema ni USDT 15 mwezi huu.'),
            ('out', 'Sawa, nitakutumia jioni.'),
            ('in', 'Asante sana, Mungu akubariki.'),
        ],
    },
    # English prize + fee
    'en_prize_fee.png': {
        'title': 'REWARDS-INFO', 'kind': 'sms',
        'bubbles': [
            ('in', 'Dear customer, you have won 500 USDT in our anniversary draw! To release your funds, pay a small processing fee of 10 USDT within 30 minutes.'),
            ('in', 'Do not tell anyone until you receive the prize.'),
        ],
    },
}


def render(spec, path):
    f = ImageFont.truetype(FONT, 30)
    fb = ImageFont.truetype(FONT_B, 32)
    small = ImageFont.truetype(FONT, 22)
    bg = (236, 229, 221) if spec['kind'] == 'chat' else (245, 245, 247)
    lines = []  # (direction, [text lines], font)
    probe = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    for d, t in spec['bubbles']:
        wrapped = textwrap.wrap(t, width=34, break_long_words=False) or ['']
        bf = f
        # one long token (a wallet address): smaller type so it stays on one line inside the screen
        for size in range(30, 17, -1):
            bf = ImageFont.truetype(FONT, size)
            if max(probe.textlength(s, font=bf) for s in wrapped) <= W - 56 - 48:
                break
        lines.append((d, wrapped, bf))
    line_h = 42
    h = 150 + sum(len(w) * line_h + 70 for _, w, _ in lines) + 40
    img = Image.new('RGB', (W, max(h, 700)), bg)
    g = ImageDraw.Draw(img)
    # status bar + header
    g.rectangle([0, 0, W, 40], fill=(30, 30, 30))
    g.text((24, 8), '09:21', font=small, fill=(255, 255, 255))
    g.text((W - 120, 8), '4G  62%', font=small, fill=(255, 255, 255))
    header = (40, 94, 84) if spec['kind'] == 'chat' else (250, 250, 252)
    g.rectangle([0, 40, W, 130], fill=header)
    g.text((40, 66), spec['title'], font=fb, fill=(255, 255, 255) if spec['kind'] == 'chat' else (20, 20, 20))
    if spec['kind'] == 'sms':
        g.line([0, 130, W, 130], fill=(210, 210, 215), width=2)
    y = 160
    for d, wrapped, bf in lines:
        tw = max(g.textlength(s, font=bf) for s in wrapped)
        bw = int(tw) + 48
        bh = len(wrapped) * line_h + 30
        x0 = 28 if d == 'in' else W - 28 - bw
        fill = (255, 255, 255) if d == 'in' else (220, 248, 198)
        if spec['kind'] == 'sms' and d == 'in':
            fill = (229, 229, 234)
        g.rounded_rectangle([x0, y, x0 + bw, y + bh], radius=22, fill=fill)
        ty = y + 14
        for s in wrapped:
            g.text((x0 + 24, ty), s, font=bf, fill=(17, 17, 17))
            ty += line_h
        y += bh + 40
    img.save(path, optimize=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, spec in SCREENS.items():
        p = os.path.join(OUT, name)
        render(spec, p)
        print(name, os.path.getsize(p), 'bytes')


if __name__ == '__main__':
    sys.exit(main())
