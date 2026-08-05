# Brand assets

The Sketch mark is a white **S** on the brand orange, gradient `#FF7A3D` → `#E8631A`.

| File | Size | Corners | Use it for |
|---|---|---|---|
| `sketch-logo-400.png` | 400×400 | full bleed | **LinkedIn** profile photo or company logo, X/Twitter, Discord, any avatar |
| `sketch-logo-1024.png` | 1024×1024 | full bleed | app store listings, press, print, anything that may be downscaled later |
| `sketch-logo-rounded-512.png` | 512×512 | transparent | web, README, docs, or a light background where the rounded tile should read as a tile |

## Which one for a social avatar

Use **`sketch-logo-400.png`**. Avatars get cropped to a circle, and the full-bleed version keeps
colour all the way into the corners so nothing is clipped to grey or white. The rounded version is
the wrong choice there — its transparent corners become whatever the platform puts behind them.

## Source of truth

| Asset | Path |
|---|---|
| Favicon | `packages/desktop/favicon.svg` |
| App icon | `packages/desktop/src-tauri/icons/icon.png` (512×512) |
| Windows icon | `packages/desktop/src-tauri/icons/icon.ico` (256×256) |

The files here are generated to match the shipped app icon: the glyph occupies ~44% of the canvas
width and is centred on measured ink bounds rather than on font metrics. Font ascender and descender
padding is not symmetrical, so centring a glyph by its text box sits it noticeably high — measuring
the pixels is what makes it land dead centre at every size.

## Regenerating

Draw at the target resolution rather than upscaling a smaller PNG, keep the gradient above, and
preserve the glyph aspect ratio — stretch the `S` to hit a height target and the mark stops matching
the app.
