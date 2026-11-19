from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs" / "images" / "wallet-tutorial"
ASSETS = ROOT / "mobile" / "assets" / "images" / "wallet_tutorial"
GOLDENS = ROOT / "mobile" / "test" / "goldens" / "wallet_tutorial"

JOBS = [
    {
        "src": DOCS / "raw" / "site-02-signup.png",
        "out": "signup-fields.png",
        "crop": (60, 590, 1110, 1780),
        "boxes": [(195, 750, 985, 1510)],
        "assets": True,
    },
    {
        "src": DOCS / "raw" / "site-04-signup-filled.png",
        "out": "signup-filled.png",
        "crop": (60, 590, 1110, 1780),
        "boxes": [(195, 750, 985, 1510), (480, 1545, 700, 1750)],
        "assets": True,
    },
    {
        "src": DOCS / "raw" / "site-40-wallet-address.png",
        "out": "wallet-address.png",
        "crop": (60, 1690, 1110, 2532),
        "boxes": [(310, 1875, 875, 2060)],
        "assets": True,
    },
    {
        "src": DOCS / "raw" / "site-dashboard.png",
        "out": "dashboard-account.png",
        "crop": None,
        "boxes": [(635, 845, 1090, 1115)],
        "assets": True,
    },
    {
        "src": DOCS / "raw" / "site-wallet-address-scrolled.png",
        "out": "wallet-address-list.png",
        "crop": (60, 1600, 1110, 2350),
        "boxes": [(320, 1645, 850, 1795)],
        "assets": True,
    },
    {
        "src": GOLDENS / "02-connect-dialog.png",
        "out": "connect-dialog.png",
        "crop": None,
        "boxes": [(190, 1670, 980, 1840)],
        "assets": False,
    },
]

RED = (255, 0, 0)
WIDTH = 12


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    for job in JOBS:
        if not job["src"].exists():
            print(f"skip {job['out']}: missing {job['src']}")
            continue
        image = Image.open(job["src"]).convert("RGB")
        offset = (0, 0)
        if job["crop"]:
            offset = job["crop"][:2]
            image = image.crop(job["crop"])
        draw = ImageDraw.Draw(image)
        for x0, y0, x1, y1 in job["boxes"]:
            draw.rounded_rectangle(
                [x0 - offset[0], y0 - offset[1], x1 - offset[0], y1 - offset[1]],
                radius=20,
                outline=RED,
                width=WIDTH,
            )
        if job.get("assets", True):
            image.save(ASSETS / job["out"])
        image.save(DOCS / job["out"])
        print(f"wrote {job['out']} {image.size}")


if __name__ == "__main__":
    main()
