# Ratinole brand

The logo is a crystal. Its six facets are the evidence an agent weighs each
hour; the lime facet is the decision. Light falls from the top left.

## Files

| File | Use |
|---|---|
| `svg/ratinole-icon-premium.svg`, `png/ratinole-icon-premium-1024.png` | App icon with gradients and glow: app stores, decks, large placements |
| `svg/ratinole-icon.svg`, `png/ratinole-icon-512.png` | Flat app icon: anywhere effects would be lost |
| `svg/ratinole-icon-small.svg` | Flat icon drawn bigger with wider seams, for 16 to 48 px (favicon) |
| `svg/ratinole-avatar.svg`, `png/ratinole-avatar-1000.png` | Square profile picture for X, Telegram, Discord (safe inside a circle crop) |
| `svg/ratinole-icon-black.svg`, `png/ratinole-icon-black-2048.png` | Premium crystal on a plain black tile, no glow (as on the website) |
| `svg/ratinole-avatar-black.svg`, `png/ratinole-avatar-black-2048.png` | Premium crystal on a plain black square, for profile pictures |
| `svg/ratinole-logo-black.svg`, `png/ratinole-logo-black-3000.png` | Crystal and name on a plain black background |
| `svg/ratinole-crystal.svg`, `png/ratinole-crystal-1024.png` | The crystal on its own, transparent, for dark backgrounds |
| `svg/ratinole-crystal-flat.svg` | The same without gradients |
| `svg/ratinole-crystal-black.svg`, `svg/ratinole-crystal-white.svg` (+ PNG) | One colour, for print, stamps and watermarks |
| `svg/ratinole-logo-light-bg.svg`, `png/ratinole-logo-light-bg-2400.png` | Icon tile and name, for light backgrounds |
| `svg/ratinole-logo-dark-bg.svg`, `png/ratinole-logo-dark-bg-2400.png` | Crystal and name, for dark backgrounds |
| `svg/ratinole-logo-dark-bg-tile.svg` | Icon tile and name, for dark backgrounds |
| `svg/ratinole-wordmark-black.svg`, `svg/ratinole-wordmark-white.svg` (+ PNG) | The name alone |
| `x/ratinole-x-header-1500x500.png` (+ `-3000x1000.jpg`) | X header with the headline; text and crystal stay clear of the profile picture and the mobile crop |
| `x/ratinole-x-header-minimal-1500x500.png` (+ `-3000x1000.jpg`) | X header with the logo only |

The lettering is converted to outlines, so no font is needed to open the files.
The crystal's seams are cut out, so the background shows through them.

The website uses `apps/web/components/Brand.tsx` (the same artwork inline) and
the icons in `apps/web/app` and `apps/web/public`.

## Colours

| Name | Hex |
|---|---|
| Ink | `#0B0B0C` |
| Cream | `#F3F1EC` |
| Lime (the decision) | `#C6F432` |
| Facets, light to dark | `#F3F1EC`, `#CFCBC0`, `#B5B1A6`, `#8A867C`, `#57534D` |

## Type

The name is set in Manrope Bold with tight tracking (−0.035 em). The site's
headlines use Bricolage Grotesque and body text Instrument Sans. All three are
under the SIL Open Font License.

## Rules

- Keep clear space around the logo of at least half the icon's width.
- Do not recolour the facets, rotate the crystal or move the lime facet.
- On light backgrounds use the icon tile, not the bare crystal: the light facets
  disappear on white.
- Smallest size: 16 px for the icon, 80 px wide for the full logo.

## Regenerating

`source/crystal.py` draws every SVG from the geometry and the name's outlines
(`source/wm-manrope.json`); it needs only Python 3:

```bash
python3 brand/source/crystal.py brand/svg
```

`source/wm2.py` made those outlines from the Manrope font file (it needs the
`fonttools`, `brotli` and `uharfbuzz` Python packages). PNGs were rendered from
the SVGs in a headless browser.
