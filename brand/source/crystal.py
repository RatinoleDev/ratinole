"""Ratinole logo: the crystal. Writes every SVG in brand/svg. Usage: python3 crystal.py ../svg"""
import json, math, os, sys
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
W = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "wm-manrope.json")))
INK, FOG, LIME = "#0B0B0C", "#F3F1EC", "#C6F432"

def squircle(r=512, n=4.6, steps=240, cx=512, cy=512):
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps; c, s = math.cos(t), math.sin(t)
        pts.append(f"{cx + r * math.copysign(abs(c) ** (2 / n), c):.1f},{cy + r * math.copysign(abs(s) ** (2 / n), s):.1f}")
    return "M" + " L".join(pts) + " Z"
SQ = squircle()

R, CX, CY = 330, 512, 512
C = (512, 504)  # facets meet a little above centre, for depth
V = [(CX + R * math.cos(math.radians(a)), CY + R * math.sin(math.radians(a))) for a in (-90, -30, 30, 90, 150, 210)]

def rounded_hex(t=34):
    def lerp(a, b, d):
        L = math.dist(a, b); return (a[0] + (b[0] - a[0]) * d / L, a[1] + (b[1] - a[1]) * d / L)
    out = []
    for i in range(6):
        a, b, c = V[i - 1], V[i], V[(i + 1) % 6]
        p_in, p_out = lerp(b, a, t), lerp(b, c, t)
        out.append(("L" if out else "M") + f"{p_in[0]:.1f} {p_in[1]:.1f} Q{b[0]:.1f} {b[1]:.1f} {p_out[0]:.1f} {p_out[1]:.1f}")
    return " ".join(out) + " Z"
HEX = rounded_hex()

# Light from the top left. The top-right facet is the decision, in lime.
FACETS = [  # (inner colour near the centre, outer colour at the edge, flat colour)
    ("#F2FFB8", "#B4E31C", LIME),
    ("#DEDAD0", "#BAB5A9", "#CFCBC0"),
    ("#94907F", "#6C685F", "#8A867C"),
    ("#5E5A54", "#403D39", "#57534D"),
    ("#C7C3B8", "#A39E93", "#B5B1A6"),
    ("#FFFFFF", "#E4E0D6", "#F3F1EC"),
]

def crystal(uid, flat=False, mono=None, seam=14, glow=False):
    """The crystal in a 1024 box, seams cut out with a mask so any background shows through."""
    defs, shapes = [], []
    for i in range(6):
        a, b = V[i], V[(i + 1) % 6]
        tri = f"M{a[0]:.1f} {a[1]:.1f} L{b[0]:.1f} {b[1]:.1f} L{C[0]} {C[1]} Z"
        if mono:
            fill = mono
        elif flat:
            fill = FACETS[i][2]
        else:
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            defs.append(f'<linearGradient id="{uid}f{i}" gradientUnits="userSpaceOnUse" x1="{C[0]}" y1="{C[1]}" x2="{mx:.1f}" y2="{my:.1f}"><stop offset="0" stop-color="{FACETS[i][0]}"/><stop offset="1" stop-color="{FACETS[i][1]}"/></linearGradient>')
            fill = f"url(#{uid}f{i})"
        shapes.append(f'<path d="{tri}" fill="{fill}"/>')
    seams = "".join(f'<path d="M{C[0]} {C[1]} L{x:.1f} {y:.1f}" stroke="#000" stroke-width="{seam}" stroke-linecap="round"/>' for x, y in V)
    defs.append(f'<clipPath id="{uid}hex"><path d="{HEX}"/></clipPath>')
    defs.append(f'<mask id="{uid}m" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/>{seams}</mask>')
    shine = ""
    if not flat and not mono:
        # A thin highlight along the top-left edges.
        shine = f'<path d="M{V[4][0]:.1f} {V[4][1]:.1f} L{V[5][0]:.1f} {V[5][1]:.1f} L{V[0][0]:.1f} {V[0][1]:.1f}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="10"/>'
    halo = ""
    if glow:
        a, b = V[0], V[1]
        defs.append(f'<filter id="{uid}g" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="34"/></filter>')
        halo = f'<path d="M{a[0]:.1f} {a[1]:.1f} L{b[0]:.1f} {b[1]:.1f} L{C[0]} {C[1]} Z" fill="{LIME}" opacity=".75" filter="url(#{uid}g)"/>'
    body = f'{halo}<g mask="url(#{uid}m)"><g clip-path="url(#{uid}hex)">{"".join(shapes)}{shine}</g></g>'
    return "".join(defs), body

def scaled(body, k):
    return f'<g transform="translate(512 512) scale({k}) translate(-512 -512)">{body}</g>'

def tile_svg(premium=True, k=0.8, seam=14, full_bleed=False):
    d, body = crystal("c", flat=not premium, seam=seam, glow=premium)
    bg = "url(#bg)" if premium else INK
    shape = f'<rect width="1024" height="1024" fill="{bg}"/>' if full_bleed else f'<path d="{SQ}" fill="{bg}"/>'
    extra = ""
    if premium:
        d += '''<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1F201D"/><stop offset=".55" stop-color="#0E0E0F"/><stop offset="1" stop-color="#060607"/></linearGradient>
<radialGradient id="halo" cx=".64" cy=".3" r=".62"><stop offset="0" stop-color="#C6F432" stop-opacity=".2"/><stop offset="1" stop-color="#C6F432" stop-opacity="0"/></radialGradient>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".35" stop-color="#fff" stop-opacity=".03"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'''
        if full_bleed:
            extra = '<rect width="1024" height="1024" fill="url(#halo)"/>'
        else:
            d += f'<clipPath id="sq"><path d="{SQ}"/></clipPath>'
            extra = '<g clip-path="url(#sq)"><rect width="1024" height="1024" fill="url(#halo)"/></g>'
    rim = '' if (not premium or full_bleed) else f'<path d="{SQ}" fill="none" stroke="url(#rim)" stroke-width="6" transform="translate(512 512) scale(.994) translate(-512 -512)"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>{d}</defs>{shape}{extra}{scaled(body, k)}{rim}</svg>'

def standalone_svg(premium=True, mono=None):
    d, body = crystal("s", flat=not premium, mono=mono, glow=False)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="172 172 680 680"><defs>{d}</defs>{body}</svg>'

def wordmark_group(color, x, base, s):
    return f'<g transform="translate({x:.1f} {base:.1f}) scale({s:.5f})"><path d="{W["d"]}" fill="{color}"/></g>'

def lockup_svg(text_color, with_tile=True, premium=False):
    top = -W["top"]; s = (0.46 * 1024) / top; gap = 0.26 * 1024
    width = 1024 + gap + W["width"] * s; base = 512 + top * s / 2
    if with_tile:
        icon = tile_svg(premium=premium)
        inner = icon[icon.index("<defs>"):icon.rindex("</svg>")]
    else:
        d, body = crystal("l", flat=not premium)
        inner = f"<defs>{d}</defs>" + scaled(body, 1.36)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} 1024">{inner}{wordmark_group(text_color, 1024 + gap, base, s)}</svg>'

def wordmark_svg(color):
    top = -W["top"]
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 {-top - 10:.0f} {W["width"] + 20:.0f} {top + 20:.0f}"><path d="{W["d"]}" fill="{color}"/></svg>'

files = {
    "ratinole-icon-premium.svg": tile_svg(premium=True),
    "ratinole-icon.svg": tile_svg(premium=False),
    "ratinole-icon-small.svg": tile_svg(premium=False, k=0.9, seam=26),
    "ratinole-avatar.svg": tile_svg(premium=True, k=0.72, full_bleed=True),
    "ratinole-crystal.svg": standalone_svg(premium=True),
    "ratinole-crystal-flat.svg": standalone_svg(premium=False),
    "ratinole-crystal-black.svg": standalone_svg(mono=INK),
    "ratinole-crystal-white.svg": standalone_svg(mono="#FFFFFF"),
    "ratinole-logo-light-bg.svg": lockup_svg(INK),
    "ratinole-logo-dark-bg.svg": lockup_svg(FOG, with_tile=False, premium=True),
    "ratinole-logo-dark-bg-tile.svg": lockup_svg(FOG),
    "ratinole-wordmark-black.svg": wordmark_svg(INK),
    "ratinole-wordmark-white.svg": wordmark_svg("#FFFFFF"),
}
for name, svg in files.items():
    open(os.path.join(OUT, name), "w").write(svg)
print("ok", len(files))
