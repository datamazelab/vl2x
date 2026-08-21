# Showcase

A static site with one page per [Vega-Lite example spec](../vega-lite-example-specs)
(633 of them), showing the generated code from all four translators
(`vl2altair`, `vl2vlapi`, `vl2d3`, `vl2ggplot`) next to a rendering of each —
plus a searchable/filterable, thumbnail-gallery landing page (`index.html`),
organized the same way as the official
[Vega-Lite example gallery](https://vega.github.io/vega-lite/examples/):
the 189 examples it lists are grouped into the same sections/subsections and
use its own titles (`showcase_build/gallery_structure.py` parses a cached
copy of that page, `showcase_build/vega_lite_gallery_reference.html`); the
remaining ~444 test-corpus-only specs are grouped below that, by
filename-prefix category.

- **Altair / vega-lite-api**: both compile to a real Vega-Lite spec, so
  their "render" reuses the same [vega-embed](https://github.com/vega/vega-embed)
  instance as the original spec at the top of the page (rendered live via CDN
  `vega`/`vega-lite`/`vega-embed` scripts).
- **D3**: the generated JavaScript runs *live* in the page (via an
  [import map](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap)
  pointing the bare `d3` import at a CDN build) — no pre-rendering.
- **ggplot2**: pre-rendered to a static PNG ahead of time with R (a browser
  can't run R), embedded as a plain `<img>`.

## Viewing it

This needs an actual HTTP server (not `file://`) for the data
fetches (`fetch()`/`d3.json()`/vega-lite's own data loading) to work, and
internet access for the CDN-hosted `vega`/`vega-embed`/`d3`/`highlight.js`
scripts:

```bash
cd showcase
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Rebuilding

The site is generated, not hand-written — regenerate it after any
translator change:

```bash
# from the repo root
python3 showcase_build/run_altair.py       # -> examples/<name>/altair.py + status_altair.json
node showcase_build/run_vlapi.mjs          # -> examples/<name>/vlapi.js  + status_vlapi.json
node showcase_build/run_d3.mjs             # -> examples/<name>/d3.js    + status_d3.json
Rscript showcase_build/render_ggplot.R     # -> examples/<name>/ggplot.R + renders/<name>.png + status_ggplot.json
python3 showcase_build/build_site.py       # -> index.html + examples/<name>/index.html (reads all of the above + thumbs_png/)
```

`showcase/data/` is a copy of the [vega-datasets](https://github.com/vega/vega-datasets)
files the example specs reference (not re-fetched by the build scripts —
copy a fresh checkout's `data/` directory over it if a spec needs something
new).

`showcase/thumbs_png/` (the landing-page gallery thumbnails) is a copy of
`../vega-lite-example-compiled/` — official pre-rendered PNGs for every
example, one-to-one with this corpus's filenames. If that source directory
gets updated (or a new example is added without a matching PNG there),
re-copy it:

```bash
cp vega-lite-example-compiled/*.png showcase/thumbs_png/
```

`showcase_build/render_thumbnails.mjs` is a fallback for generating a
thumbnail from scratch (via the real Vega-Lite/Vega runtime, no browser
needed) for any example that doesn't have one in `vega-lite-example-compiled/`
— it writes SVGs to `showcase/thumbs/<name>.svg`; wire a name's `.svg` back in
as a fallback in `build_site.py`'s thumbnail lookup if you need it.

Current pass rates (translate + render), out of 633: Altair 633, vega-lite-api
633, D3 292 (drawn live), ggplot2 380 (pre-rendered) — matching each project's
own `docs/ARCHITECTURE.md` numbers modulo methodology differences (this
harness also counts execution failures the same way as translation failures,
where each project's own validator distinguishes them).
