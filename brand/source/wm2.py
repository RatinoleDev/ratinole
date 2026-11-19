"""Text to SVG outlines with kerning. Usage: wm2.py font.woff2 "Text" tracking_em out.json
Output units: 1000 per em, y down, baseline 0."""
import json, sys, io
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

src, text, track, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
f = TTFont(src); f.flavor = None
bio = io.BytesIO(); f.save(bio); data = bio.getvalue()
f = TTFont(io.BytesIO(data))
upm = f["head"].unitsPerEm; k = 1000 / upm
font = hb.Font(hb.Face(hb.Blob(data)))
buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
hb.shape(font, buf, {"kern": True, "liga": False})
gs = f.getGlyphSet(); order = f.getGlyphOrder()
x = 0; parts = []; top = 0; bottom = 0
n = len(buf.glyph_infos)
for i, (gi, gp) in enumerate(zip(buf.glyph_infos, buf.glyph_positions)):
    name = order[gi.codepoint]
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (k, 0, 0, -k, x + gp.x_offset * k, -gp.y_offset * k)))
    parts.append(pen.getCommands())
    b = BoundsPen(gs); gs[name].draw(b)
    if b.bounds:
        top = max(top, b.bounds[3] * k); bottom = min(bottom, b.bounds[1] * k)
    x += gp.x_advance * k + (track * 1000 if i < n - 1 else 0)
json.dump({"d": " ".join(parts), "width": x, "top": -top, "bottom": -bottom}, open(out, "w"))
print(out, round(x), round(top), round(bottom))
