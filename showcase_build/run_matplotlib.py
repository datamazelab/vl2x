#!/usr/bin/env python3
"""Batch-run vl2matplotlib over every spec in vega-lite-example-specs/: write
the generated code, exec() it, and savefig() a PNG render per example that
succeeds -- the Python/matplotlib analog of render_ggplot.R (matplotlib
can't run in a browser either, so this showcase panel is a static image like
the ggplot2 one, not a live embed). Writes a status JSON summarizing ok/error
per example."""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

import matplotlib  # noqa: E402

matplotlib.use("Agg")  # no display backend needed for a headless batch run

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

import matplotlib.pyplot as plt  # noqa: E402

from vl2matplotlib import vegalite_to_matplotlib_code  # noqa: E402

SPECS_DIR = REPO / "vega-lite-example-specs"
OUT_DIR = REPO / "showcase" / "examples"
RENDERS_DIR = REPO / "showcase" / "renders_matplotlib"


def px_to_in(px: float) -> float:
    return max(1.5, min(14.0, px / 96))


def main():
    RENDERS_DIR.mkdir(parents=True, exist_ok=True)
    statuses = {}
    specs = sorted(SPECS_DIR.glob("*.vl.json"))

    # Generated code uses relative "data/..." paths -- resolve them against
    # showcase/data (a copy of vega-datasets) by running from showcase/.
    old_cwd = Path.cwd()
    import os

    os.chdir(REPO / "showcase")

    for i, spec_path in enumerate(specs):
        name = spec_path.name[: -len(".vl.json")]
        out_dir = OUT_DIR / name
        out_dir.mkdir(parents=True, exist_ok=True)
        code_path = out_dir / "matplotlib.py"
        png_path = RENDERS_DIR / f"{name}.png"

        try:
            spec = json.loads((REPO / "vega-lite-example-specs" / spec_path.name).read_text())
            code = vegalite_to_matplotlib_code(spec, ignore_unsupported=True, include_source_paths=True)
            code_path.write_text(code)

            ns: dict = {}
            exec(compile(code, "<generated>", "exec"), ns)
            fig = ns.get("fig")
            if fig is None:
                raise RuntimeError("generated code's own namespace has no 'fig'")

            width = spec.get("width")
            height = spec.get("height")
            if isinstance(width, (int, float)) and isinstance(height, (int, float)):
                fig.set_size_inches(px_to_in(width), px_to_in(height))
            fig.savefig(png_path, dpi=120, facecolor="white", bbox_inches="tight")
            statuses[name] = {"ok": True}
        except Exception as e:  # noqa: BLE001
            msg = str(e).strip().splitlines()[0] if str(e).strip() else repr(e)
            if not code_path.exists():
                code_path.write_text(f"# Translation failed:\n# {msg}\n")
            if png_path.exists():
                png_path.unlink()
            statuses[name] = {"ok": False, "error": msg}
        finally:
            plt.close("all")

        if (i + 1) % 50 == 0:
            print(f"matplotlib: {i + 1}/{len(specs)}", file=sys.stderr)

    os.chdir(old_cwd)

    (REPO / "showcase" / "status_matplotlib.json").write_text(json.dumps(statuses, indent=2))
    ok = sum(1 for v in statuses.values() if v["ok"])
    print(f"matplotlib: {ok}/{len(statuses)} ok")


if __name__ == "__main__":
    main()
