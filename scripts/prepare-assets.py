#!/usr/bin/env python3
"""One-time conversion of the original RealAmadeus assets for the mobile app.

Usage: python3 scripts/prepare-assets.py /path/to/RealAmadeus

Copies the Kurisu Live2D model (moc3 v5 + physics + display info), downscales the
8192x8192 texture (too large for phone GPUs) to 4096 and 2048, converts the UI images
to WebP at mobile-friendly sizes, and generates the Android launcher icons.
The outputs are committed, so this only needs to run again if the source art changes.
Requires Pillow.
"""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "web" / "public"
ANDROID_RES = ROOT / "android" / "res"


def resample():
    return Image.Resampling.LANCZOS


def downscale_premultiplied(img: Image.Image, size: int) -> Image.Image:
    # Resizing straight RGBA bleeds the colour of fully transparent texels into the
    # edges of the atlas parts; resizing premultiplied avoids dark/white fringes.
    return img.convert("RGBa").resize((size, size), resample()).convert("RGBA")


def save_webp(img: Image.Image, dest: Path, max_w: int | None = None, max_h: int | None = None, quality: int = 90):
    img = img.copy()
    if max_w or max_h:
        img.thumbnail((max_w or img.width, max_h or img.height), resample())
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, "WEBP", quality=quality, method=6)
    print(f"  {dest.relative_to(ROOT)} {img.size} {dest.stat().st_size // 1024} KB")


def model(src: Path):
    mdir = src / "Assets" / "AmadeusKurisu5.0" / "reama5.0"
    stem = "Live2D紅莉栖forSDK5.0"
    out = PUBLIC / "model" / "kurisu"
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(mdir / f"{stem}.moc3", out / "kurisu.moc3")
    shutil.copyfile(mdir / f"{stem}.physics3.json", out / "kurisu.physics3.json")
    shutil.copyfile(mdir / f"{stem}.cdi3.json", out / "kurisu.cdi3.json")

    tex = Image.open(mdir / f"{stem}.8192" / "texture_00.png")
    tex.load()
    for size in (4096, 2048):
        dest = out / f"texture_{size}.png"
        downscale_premultiplied(tex, size).save(dest, optimize=True)
        print(f"  {dest.relative_to(ROOT)} {dest.stat().st_size // 1024} KB")

    setting = {
        "Version": 3,
        "FileReferences": {
            "Moc": "kurisu.moc3",
            "Textures": ["texture_4096.png"],
            "Physics": "kurisu.physics3.json",
            "DisplayInfo": "kurisu.cdi3.json",
        },
        "Groups": [
            {"Target": "Parameter", "Name": "EyeBlink", "Ids": ["ParamEyeLOpen", "ParamEyeROpen"]},
            {"Target": "Parameter", "Name": "LipSync", "Ids": ["ParamMouthOpenY"]},
        ],
    }
    (out / "kurisu.model3.json").write_text(json.dumps(setting, indent=2) + "\n", encoding="utf-8")


def images(src: Path):
    idir = src / "Assets" / "Images"
    out = PUBLIC / "img"
    save_webp(Image.open(idir / "Amadeus_BG.png").convert("RGB"), out / "bg_binary.webp", max_w=1920, quality=82)
    save_webp(Image.open(idir / "RealAmadeus_Menu_BG_v3.jpg").convert("RGB"), out / "monitor.webp", quality=85)
    save_webp(Image.open(idir / "Menu.png").convert("RGBA"), out / "menu_circles.webp", max_w=1080, quality=88)
    save_webp(Image.open(idir / "amadeus_logo_v3.png").convert("RGBA"), out / "logo.webp", max_w=1024, quality=90)
    save_webp(Image.open(idir / "amadeus_login_button_v2.png").convert("RGBA"), out / "login_button.webp", max_w=512, quality=90)
    for name in ("Backlog", "ChangeLog", "Config", "Help", "Status"):
        save_webp(Image.open(idir / f"{name}.png").convert("RGBA"), out / f"icon_{name.lower()}.webp", max_w=192)
        save_webp(Image.open(idir / f"{name}Selected.png").convert("RGBA"), out / f"icon_{name.lower()}_sel.webp", max_w=192)
    save_webp(Image.open(idir / "DownAllow.png").convert("RGBA"), out / "icon_down.webp", max_w=128)


def launcher_icons(src: Path):
    logo = Image.open(src / "Assets" / "Images" / "amadeus_logo_v3.png").convert("RGBA")
    bbox = logo.getbbox()
    if bbox:
        logo = logo.crop(bbox)
    densities = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
    for density, scale in densities.items():
        d = ANDROID_RES / f"mipmap-{density}"
        d.mkdir(parents=True, exist_ok=True)

        # Legacy icon: 48dp square, dark rounded background.
        size = round(48 * scale)
        icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bg = Image.new("RGBA", (size, size), (14, 14, 16, 255))
        mask = Image.new("L", (size, size), 0)
        from PIL import ImageDraw

        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.18), fill=255)
        icon.paste(bg, (0, 0), mask)
        mark = logo.copy()
        mark.thumbnail((round(size * 0.82), round(size * 0.82)), resample())
        icon.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
        icon.save(d / "ic_launcher.png", optimize=True)

        # Adaptive icon foreground: 108dp canvas, artwork inside the 66dp safe zone.
        fsize = round(108 * scale)
        fg = Image.new("RGBA", (fsize, fsize), (0, 0, 0, 0))
        mark = logo.copy()
        mark.thumbnail((round(fsize * 0.60), round(fsize * 0.60)), resample())
        fg.alpha_composite(mark, ((fsize - mark.width) // 2, (fsize - mark.height) // 2))
        fg.save(d / "ic_launcher_foreground.png", optimize=True)
    print("  android launcher icons generated")


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    src = Path(sys.argv[1]).resolve()
    print("Model:")
    model(src)
    print("Images:")
    images(src)
    print("Launcher icons:")
    launcher_icons(src)


if __name__ == "__main__":
    main()
