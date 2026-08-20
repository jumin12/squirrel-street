"""Build wood-plank menu buttons using playup/playdown + letters-numbers.png."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "art" / "ui"
SHEET = Image.open(UI / "letters-numbers.png").convert("RGBA")
PLAY_UP = Image.open(UI / "playup.png").convert("RGBA")
PLAY_DOWN = Image.open(UI / "playdown.png").convert("RGBA")

ROW_CHARS = [
    ((0, 11), "0123456789"),
    ((21, 31), "ABCDEFGHI"),
    ((37, 48), "JKLMNOPQR"),
    ((53, 63), "STUVWXYZ"),
]

CREAM = (252, 240, 205, 255)
OUTLINE = (20, 10, 8, 255)


def glyph_boxes(y0, y1):
    px = SHEET.load()
    w = SHEET.width
    boxes = []
    x = 0
    while x < w:
        hit = any(
            px[x, y][3] > 10 and px[x, y][0] + px[x, y][1] + px[x, y][2] > 40
            for y in range(y0, y1 + 1)
        )
        if hit:
            x0 = x
            while x < w and any(
                px[x, y][3] > 10 and px[x, y][0] + px[x, y][1] + px[x, y][2] > 40
                for y in range(y0, y1 + 1)
            ):
                x += 1
            boxes.append((x0, y0, x - 1, y1))
        x += 1
    return boxes


GLYPHS = {}
for (y0, y1), chars in ROW_CHARS:
    boxes = glyph_boxes(y0, y1)
    if len(boxes) != len(chars):
        raise SystemExit(f"Glyph count mismatch for {chars}: {len(boxes)}")
    for ch, box in zip(chars, boxes):
        x0, gy0, x1, gy1 = box
        GLYPHS[ch] = SHEET.crop((x0, gy0, x1 + 1, gy1 + 1))


def blank_plank(src, text_x0, text_x1):
    img = src.copy()
    px = img.load()
    w, h = img.size
    strip_x0 = 10
    strip_x1 = 26
    for y in range(h):
        for x in range(text_x0, min(text_x1, w)):
            src_x = strip_x0 + ((x - text_x0) % (strip_x1 - strip_x0))
            px[x, y] = px[src_x, y]
    return img


def render_word(text):
    glyphs = []
    width = 0
    height = 0
    for i, ch in enumerate(text):
        if ch == " ":
            width += 4
            continue
        g = GLYPHS[ch]
        if glyphs:
            width += 1
        glyphs.append((width, g))
        width += g.width
        height = max(height, g.height)
    if width <= 0:
        width = 1
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for x, g in glyphs:
        tinted = Image.new("RGBA", g.size, (0, 0, 0, 0))
        gp = g.load()
        tp = tinted.load()
        for gy in range(g.height):
            for gx in range(g.width):
                r, b_g, b, a = gp[gx, gy]
                if a < 10 or r + b_g + b < 40:
                    continue
                if r > 180:
                    tp[gx, gy] = CREAM
                else:
                    tp[gx, gy] = OUTLINE
        out.paste(tinted, (x, height - g.height), tinted)
    return out


def stamp(plank, word):
    img = plank.copy()
    text = render_word(word)
    max_w = img.width - 16
    if text.width > max_w:
        ratio = max_w / text.width
        text = text.resize(
            (max_w, max(7, int(text.height * ratio))),
            Image.NEAREST,
        )
    x = (img.width - text.width) // 2
    y = (img.height - text.height) // 2
    img.paste(text, (x, y), text)
    return img


BUTTONS = {
    "solo": "SOLO",
    "challenge": "CHALLENGE",
    "back": "BACK",
    "resume": "RESUME",
    "exit": "EXIT",
    "keep": "KEEP",
    "menu": "MENU",
    "howto": "HOW TO",
    "dictionary": "DICTIONARY",
    "credits": "CREDITS",
    "changelog": "CHANGES",
    "continue": "CONTINUE",
}

BLANK_UP = blank_plank(PLAY_UP, 30, 76)
BLANK_DOWN = blank_plank(PLAY_DOWN, 28, 72)

for stem, label in BUTTONS.items():
    stamp(BLANK_UP, label).save(UI / f"{stem}up.png")
    stamp(BLANK_DOWN, label).save(UI / f"{stem}down.png")
    print(f"wrote {stem}up.png / {stem}down.png ({label})")
