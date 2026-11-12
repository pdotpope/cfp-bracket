#!/usr/bin/env python3
"""
Renders og-image.png, the 1200x630 link-preview card, as an "if the
playoff started today" bracket built from the current rankings.json.

Runs in the weekly GitHub Actions workflow right after update_rankings.py,
so every shared link previews this week's real matchups. Link-preview
crawlers never execute JavaScript, which is why this image has to exist as
a static file rather than being drawn client-side.

Also stamps a cache-busting ?v=<date> onto the og:image / twitter:image
URLs in index.html: X, iMessage, etc. cache preview images by URL, so a
new URL each week is what gets them to fetch the new image.
"""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent
RANKINGS_PATH = REPO_ROOT / "rankings.json"
INDEX_PATH = REPO_ROOT / "index.html"
OUTPUT_PATH = REPO_ROOT / "og-image.png"

W, H = 1200, 630
BG, PANEL, PANEL_EDGE = "#1a1a1a", "#2a2a2a", "#444444"
GOLD, WHITE, GREY = "#c38d13", "#ffffff", "#9a9a9a"

# Seed indices (0-based) per first-round game and the bye seed each winner
# meets in the quarterfinal. Must stay in sync with FIRST_ROUND_SEEDS and
# QUARTERFINAL_BYE_SEEDS in script.js so the card matches the site.
FIRST_ROUND_SEEDS = [(7, 8), (4, 11), (6, 9), (5, 10)]
QUARTERFINAL_BYE_SEEDS = [0, 3, 1, 2]

# Font candidates: macOS (local runs) first, then DejaVu, which ships on
# GitHub's ubuntu runners. Falls back to Pillow's built-in font so the
# image still renders (less prettily) on an unexpected machine.
FONT_CANDIDATES = {
    "black": ["/System/Library/Fonts/Supplemental/Arial Black.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "bold": ["/System/Library/Fonts/Supplemental/Arial Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "regular": ["/System/Library/Fonts/Supplemental/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
}


def log(msg):
    print(f"[make_og_image] {msg}", file=sys.stderr)


def font(weight, size):
    for path in FONT_CANDIDATES[weight]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    log(f"WARNING: no '{weight}' font found; using Pillow default.")
    return ImageFont.load_default(size)


def calculate_seeds(rankings):
    """Python mirror of calculateSeeds() in script.js: the five
    highest-ranked conference champions are guaranteed a spot, the rest
    are filled by ranking, then all 12 are seeded straight by ranking."""
    playoff = [t for t in rankings if t.get("champ")][:5]
    for team in rankings:
        if len(playoff) >= 12:
            break
        if team not in playoff:
            playoff.append(team)
    playoff.sort(key=rankings.index)
    return [{**team, "seed": i + 1} for i, team in enumerate(playoff)]


def load_logo(team, size):
    """Team logo from team-logos/, fit into a size x size square. Returns
    None for a missing/remote logo so the slot just renders without one."""
    logo_path = team.get("logo", "")
    if not logo_path.startswith("/"):
        return None
    path = REPO_ROOT / logo_path.lstrip("/")
    if not path.exists():
        return None
    img = Image.open(path).convert("RGBA")
    img.thumbnail((size, size), Image.LANCZOS)
    return img


def draw_slot(img, draw, x, y, w, h, team, label=None):
    """One team row: logo, gold seed number, name. `label` replaces the
    team for placeholder rows such as "Winner 8/9"."""
    draw.rounded_rectangle([x, y, x + w, y + h], 6, fill=PANEL, outline=PANEL_EDGE, width=2)
    mid = y + h // 2
    if team is None:
        draw.text((x + 16, mid), label or "", font=font("regular", 22), fill=GREY, anchor="lm")
        return
    text_x = x + 14
    logo = load_logo(team, h - 12)
    if logo:
        img.paste(logo, (text_x + (h - 12 - logo.width) // 2, mid - logo.height // 2), logo)
        text_x += h
    seed_font = font("bold", 22)
    draw.text((text_x, mid), str(team["seed"]), font=seed_font, fill=GOLD, anchor="lm")
    draw.text((text_x + 34, mid), team["name"], font=font("bold", 24), fill=WHITE, anchor="lm")


def render(rankings, date_label):
    seeds = calculate_seeds(rankings)
    if len(seeds) < 12:
        raise SystemExit(f"Need 12 playoff teams, got {len(seeds)}; not rendering.")

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, W, 8], fill=GOLD)

    # Header.
    draw.text((50, 34), "IF THE PLAYOFF STARTED TODAY", font=font("black", 38), fill=GOLD)
    draw.text((52, 84), f"Based on the latest CFP rankings · updated {date_label}", font=font("regular", 22), fill=GREY)

    # Column geometry: first round on the left, quarterfinals in the middle.
    slot_w, slot_h = 300, 44
    r1_x, qf_x = 50, 420
    top, game_gap = 155, 116
    connector = "#555555"
    column_font = font("bold", 18)
    draw.text((r1_x, top - 12), "FIRST ROUND", font=column_font, fill=GOLD, anchor="ls")
    draw.text((qf_x, top - 12), "QUARTERFINALS", font=column_font, fill=GOLD, anchor="ls")

    for game, ((hi, lo), bye) in enumerate(zip(FIRST_ROUND_SEEDS, QUARTERFINAL_BYE_SEEDS)):
        y = top + game * game_gap
        draw_slot(img, draw, r1_x, y, slot_w, slot_h, seeds[hi])
        draw_slot(img, draw, r1_x, y + slot_h + 4, slot_w, slot_h, seeds[lo])

        # Quarterfinal: bye team vs this first-round game's winner,
        # aligned with the game feeding it, plus a bracket connector.
        draw_slot(img, draw, qf_x, y, slot_w, slot_h, seeds[bye])
        draw_slot(img, draw, qf_x, y + slot_h + 4, slot_w, slot_h, None,
                  label=f"Winner {hi + 1}/{lo + 1}")
        game_mid = y + slot_h + 2
        elbow_x = r1_x + slot_w + 35
        draw.line([r1_x + slot_w, game_mid, elbow_x, game_mid], fill=connector, width=2)
        draw.line([elbow_x, game_mid, elbow_x, y + slot_h + 4 + slot_h // 2], fill=connector, width=2)
        draw.line([elbow_x, y + slot_h + 4 + slot_h // 2, qf_x, y + slot_h + 4 + slot_h // 2],
                  fill=connector, width=2)

    # Right panel: branding and call to action.
    panel_x = 790
    draw.rounded_rectangle([panel_x, top - 10, W - 50, H - 50], 12, fill=PANEL, outline=PANEL_EDGE, width=2)
    center_x = (panel_x + W - 50) // 2
    cfp_logo = Image.open(REPO_ROOT / "other-logos" / "cfplogo.png").convert("RGBA")
    cfp_logo.thumbnail((130, 130), Image.LANCZOS)
    img.paste(cfp_logo, (center_x - cfp_logo.width // 2, top + 25), cfp_logo)
    draw.text((center_x, top + 205), "Who wins it all?", font=font("bold", 30), fill=WHITE, anchor="mm")
    draw.text((center_x, top + 250), "Re-rank the top 25 and", font=font("regular", 21), fill=GREY, anchor="mm")
    draw.text((center_x, top + 278), "pick every game", font=font("regular", 21), fill=GREY, anchor="mm")
    draw.rounded_rectangle([panel_x + 30, top + 330, W - 80, top + 390], 8, fill=GOLD)
    draw.text((center_x, top + 360), "cfp-bracket.pdot.dev", font=font("bold", 24), fill=BG, anchor="mm")

    img.save(OUTPUT_PATH, optimize=True)
    log(f"Wrote {OUTPUT_PATH.name} ({len(seeds)} seeds).")


def bust_preview_cache(version):
    """Point og:image / twitter:image at og-image.png?v=<version> so
    preview caches keyed by image URL fetch the new week's card."""
    html = INDEX_PATH.read_text()
    updated = re.sub(r"(og-image\.png)(\?v=[\w-]+)?", rf"\1?v={version}", html)
    if updated != html:
        INDEX_PATH.write_text(updated)
        log(f"Set preview image version to {version} in {INDEX_PATH.name}.")


def main():
    rankings = json.loads(RANKINGS_PATH.read_text())
    now = datetime.now(timezone.utc)
    render(rankings, f"{now:%b} {now.day}, {now.year}")
    bust_preview_cache(f"{now:%Y%m%d}")


if __name__ == "__main__":
    main()
