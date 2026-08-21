# Vendored Sportradar assets

The page used to embed the Sportradar **LMT Plus** widget. That widget cannot run
on a public domain without a licensed client key — Sportradar's licensing
endpoint checks the requesting origin:

```
Origin: file://                        -> signed token (dev origins are allowed)
Origin: http://localhost:3000          -> signed token
Origin: https://<your-domain>          -> {"valid":false,"emsg":"No packages licensed for ..."}
```

That is why the page worked when opened locally and rendered blank once deployed.

`app.js` now draws the same UI from MLB's public StatsAPI (no key, no origin
check), reusing Sportradar's class names so their stylesheets still apply.

## Files

- **`sr-layout.css`** — the widget's layout stylesheets, concatenated **in the
  exact order the widget loads them**. Order matters: several rules collide at
  equal specificity and there are no `@media` blocks to disambiguate, so
  reordering silently changes the layout. Source chunks, in order:

  1. `chunk.33860.14d51016.css`
  2. `chunk.match.lmtPlus.1c1359b7.css`
  3. `chunk.match.lmtPlus_lmt.f68a6661.css`
  4. `chunk.match.lmtPlus_statistics_3.80572ea6.css`
  5. `chunk.match.lmt_3.ff010d31.css`
  6. `chunk.86639.4c708b07.css`
  7. `chunk.79662.71e43210.css`
  8. `chunk.match.lmtPlus_boxScore_3.b43f452c.css`
  9. `chunk.match.lmtPlus_headToHead_3.577a75c0.css`
  10. `chunk.match.lmtPlus_timelineRow_3.87fb84af.css`

  All from `https://widgets.sir.sportradar.com/assets/css/`. Chunks 8–10 are
  loaded lazily by the real widget when you open those tabs — miss them and
  those panels render with no styling at all.

- **`sr-pitch.js`** — the baseball diamond SVG and its wrappers, captured
  verbatim from the rendered widget. The `sr-lmt-3-state` header was stripped
  out; `app.js` builds that from MLB data and appends it into `.sr-lmt__content`
  (not `.sr-lmt-wrap` — `.sr-lmt__content` has `z-index:1` and would paint over
  the header).

These are copies of Sportradar's stylesheets, kept locally so hashed CDN
filenames cannot 404 later. They carry no licence of their own — if this is ever
more than a personal project, get a Sportradar subscription and use the real
widget.

## Colours

`../theme.css` is untouched. It is tokens only (339 rules, ~2 layout
declarations); every bit of layout comes from `sr-layout.css`.
