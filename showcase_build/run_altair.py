#!/usr/bin/env python3
"""Batch-run vl2altair over every spec in vega-lite-example-specs/, writing
generated code (or an error message) per example plus a status summary."""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from vl2altair import vegalite_to_altair_code  # noqa: E402

SPECS_DIR = REPO / "vega-lite-example-specs"
OUT_DIR = REPO / "showcase" / "examples"

def main():
    statuses = {}
    specs = sorted(SPECS_DIR.glob("*.vl.json"))
    for i, spec_path in enumerate(specs):
        name = spec_path.name[: -len(".vl.json")]
        out_dir = OUT_DIR / name
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            spec = json.loads(spec_path.read_text())
            code = vegalite_to_altair_code(spec, format_with_black=True, include_source_paths=True)
            (out_dir / "altair.py").write_text(code)
            statuses[name] = {"ok": True}
        except Exception as e:  # noqa: BLE001
            msg = str(e).strip().splitlines()[0] if str(e).strip() else repr(e)
            (out_dir / "altair.py").write_text(f"# Translation failed:\n# {msg}\n")
            statuses[name] = {"ok": False, "error": msg}
        if (i + 1) % 50 == 0:
            print(f"altair: {i + 1}/{len(specs)}", file=sys.stderr)

    (OUT_DIR.parent / "status_altair.json").write_text(json.dumps(statuses, indent=2))
    ok = sum(1 for v in statuses.values() if v["ok"])
    print(f"altair: {ok}/{len(statuses)} ok")

if __name__ == "__main__":
    main()
