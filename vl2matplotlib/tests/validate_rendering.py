"""Ad-hoc rendering-validation harness (not a pytest suite): like
`validate_examples.py`, translate + exec every corpus spec, but additionally
introspect the resulting `Figure`'s own `Axes` children (`ax.patches` for
bar/rect, `ax.lines` for line/rule/tick, `ax.collections` for point/area,
`ax.texts` for text) to catch a script that "succeeds" (no exception) but
silently draws nothing, or draws only NaN-valued geometry -- the matplotlib
equivalent of `vl2d3`'s own NaN/zero-shape rendering check. A spec whose
translation itself is an unsupported-feature skip (not this harness's
concern -- `validate_examples.py` already covers that) is bucketed the same
way; this harness's own added bucket is "ok but rendered empty".

Usage: python3 tests/validate_rendering.py /path/to/specs/dir [/path/to/vega-datasets] [limit]
"""

from __future__ import annotations

import glob
import json
import os
import sys
import warnings
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO))

import matplotlib  # noqa: E402

matplotlib.use("Agg")
warnings.filterwarnings("ignore")

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from vl2matplotlib import vegalite_to_matplotlib_code  # noqa: E402


def _artist_counts(fig) -> tuple[int, int]:
    """Returns `(n_artists, n_all_nan_artists)` across every `Axes` in
    `fig` -- `n_artists` counts every patch/line/collection/text drawn;
    `n_all_nan_artists` counts how many of those have *only* NaN-valued
    numeric data (a mark that "drew" but every point/bar is off-screen)."""
    n_artists = 0
    n_all_nan = 0
    for ax in fig.axes:
        for patch in ax.patches:
            n_artists += 1
            try:
                pts = patch.get_verts()
                if pts.size and not np.isfinite(pts).any():
                    n_all_nan += 1
            except Exception:  # noqa: BLE001
                pass
        for line in ax.lines:
            n_artists += 1
            xd, yd = line.get_xdata(), line.get_ydata()
            xd = np.asarray(xd, dtype=object)
            yd = np.asarray(yd, dtype=object)
            try:
                xf = np.array([v for v in xd if isinstance(v, (int, float))], dtype=float)
                yf = np.array([v for v in yd if isinstance(v, (int, float))], dtype=float)
                if (xf.size and not np.isfinite(xf).any()) or (yf.size and not np.isfinite(yf).any()):
                    n_all_nan += 1
            except Exception:  # noqa: BLE001
                pass
        for coll in ax.collections:
            n_artists += 1
            try:
                pts = coll.get_offsets()
                arr = np.asarray(pts, dtype=float)
                if arr.size and not np.isfinite(arr).any():
                    n_all_nan += 1
            except Exception:  # noqa: BLE001
                pass
        for text in ax.texts:
            if text.get_text().strip():
                n_artists += 1
    return n_artists, n_all_nan


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 tests/validate_rendering.py /path/to/specs/dir [/path/to/vega-datasets] [limit]")
        sys.exit(1)
    specs_dir = sys.argv[1]
    datasets_dir = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].isdigit() else None
    limit_idx = 3 if datasets_dir else 2
    limit_arg = sys.argv[limit_idx] if len(sys.argv) > limit_idx else None
    limit = int(limit_arg) if limit_arg else None

    old_cwd = os.getcwd()
    if datasets_dir:
        os.chdir(datasets_dir)

    paths = sorted(glob.glob(str(Path(specs_dir) / "*.vl.json")))
    if limit:
        paths = paths[:limit]

    rendered_ok = 0
    empty: list[str] = []
    skipped = 0
    failed: list[tuple[str, str]] = []

    for path in paths:
        name = os.path.basename(path)
        try:
            spec = json.loads(Path(path).read_text())
            code = vegalite_to_matplotlib_code(spec, ignore_unsupported=False)
        except Exception as e:  # noqa: BLE001
            msg = str(e).strip().splitlines()[0] if str(e).strip() else repr(e)
            if msg.startswith("Unsupported"):
                skipped += 1
            else:
                failed.append((name, f"translate: {msg}"))
            continue
        try:
            ns: dict = {}
            exec(compile(code, "<generated>", "exec"), ns)
            fig = ns.get("fig")
            if fig is None:
                failed.append((name, "no `fig` in generated code's own namespace"))
                continue
            n_artists, n_all_nan = _artist_counts(fig)
            if n_artists == 0:
                empty.append(name)
            elif n_all_nan == n_artists:
                empty.append(f"{name} (all-NaN)")
            else:
                rendered_ok += 1
        except Exception as e:  # noqa: BLE001
            msg = str(e).strip().splitlines()[0] if str(e).strip() else repr(e)
            failed.append((name, f"exec: {msg}"))
        finally:
            plt.close("all")

    os.chdir(old_cwd)

    print(f"Rendered non-empty: {rendered_ok}/{len(paths)}")
    print(f"Skipped (documented unsupported features): {skipped}/{len(paths)}")
    print(f"Rendered but empty/all-NaN: {len(empty)}/{len(paths)}")
    print(f"Failed (unexpected exec errors): {len(failed)}/{len(paths)}")
    print()
    if empty:
        print("Empty/all-NaN renders:")
        for name in empty[:40]:
            print(f"  {name}")
        print()
    if failed:
        print("Unexpected exec failures:")
        for name, msg in failed[:30]:
            print(f"  {name}: {msg}")


if __name__ == "__main__":
    main()
