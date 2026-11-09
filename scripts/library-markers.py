#!/usr/bin/env python3
"""Generate printable Central Library 2F location QR markers (docs/library-markers/index.html).

Payload: CONTOUR-LOC|1|<floor>|<x>|<y>|<facing>|<label>
x/y are normalised on the 1178x817 saved 2F plan (ios/Contour/Resources/default-floor-overlay.json);
facing is degrees clockwise from map-up that a person faces when looking straight at the sheet.
Requires: pip install qrcode
"""
import html
import io
import pathlib

import qrcode
import qrcode.image.svg

W, H = 1178, 817
# shortcut: positions are read off the unsurveyed floor image on the existing exit path; adjust after walking them.
MARKERS = [
    ("M1", "OPAC aisle", 780, 330, 270, "Stand in the aisle just right of the OPAC kiosk / Key Deposit. Face the OPAC wall (map-left) and tape the sheet on it at eye level."),
    ("M2", "Newly Arrived Books", 780, 445, 270, "Stand in the aisle in front of the Newly Arrived Books shelf. Face the shelf (map-left) and tape the sheet on its end at eye level."),
    ("M3", "Service Desk", 760, 565, 180, "Stand on the public side of the Service Desk, facing the counter (map-down). Tape the sheet on the counter front."),
    ("M4", "Entrance Hall", 945, 520, 90, "Stand in the middle of the Entrance Hall facing the exit doors (map-right). Tape the sheet beside the doors at eye level."),
]


def svg(payload: str) -> str:
    image = qrcode.make(payload, image_factory=qrcode.image.svg.SvgPathImage, box_size=10, border=2)
    out = io.BytesIO()
    image.save(out)
    text = out.getvalue().decode()
    return text[text.index("<svg"):]


cards = []
for code, label, x, y, facing, where in MARKERS:
    payload = f"CONTOUR-LOC|1|2F|{x / W:.4f}|{y / H:.4f}|{facing}|{label}"
    cards.append(f"""<section class="card"><h2>{code} · {html.escape(label)} · 2F</h2>
<div class="qr">{svg(payload)}</div>
<p class="where">{html.escape(where)}</p>
<p class="meta">Plan pixel ({x}, {y}) of 1178×817 · facing {facing}° from map-up<br><code>{html.escape(payload)}</code></p></section>""")

page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Library Location Markers</title>
<style>
:root{{--bg:#fff;--fg:#111;--muted:#555;--card:#fff;--cardfg:#111}}
@media (prefers-color-scheme:dark){{:root:not([data-theme=light]){{--bg:#111;--fg:#eee;--muted:#aaa}}}}
:root[data-theme=dark]{{--bg:#111;--fg:#eee;--muted:#aaa}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}}
h1{{font-size:20px}} .card{{break-after:page;page-break-after:always;max-width:640px;margin:0 auto 32px;background:var(--card);color:var(--cardfg);padding:16px;border-radius:8px}} .card .meta{{color:#555}}
.qr svg{{width:100%;max-width:520px;height:auto;display:block;margin:0 auto}}
.where{{font-size:18px}} .meta{{color:var(--muted);font-size:12px;word-break:break-all}}
@media print{{.intro{{display:none}}}}
</style></head><body>
<div class="intro"><h1>Contour · Central Library 2F location markers</h1>
<p>Print one per page (≥15 cm wide) or show full-screen on a spare phone/laptop. Place each where its card says.
In Contour open 01 Central Library → 3D AR · Library exit and point the camera straight at a marker from 1–2 m:
the phone snaps to that spot and direction, then ARKit tracks you. Each marker you pass re-corrects drift.
Positions are image-inferred, not surveyed — demo/prototype only, not verified evacuation guidance.</p></div>
{''.join(cards)}
</body></html>
"""
target = pathlib.Path(__file__).resolve().parent.parent / "docs" / "library-markers" / "index.html"
target.write_text(page)
print(target)
