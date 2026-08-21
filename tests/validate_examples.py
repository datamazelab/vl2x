"""Ad-hoc validation harness (not a pytest suite): run the translator over the
real-world Vega-Lite example corpus bundled in vega-lite/examples/specs, exec
the generated code, and report which ones raise errors.

Usage: python3 tests/validate_examples.py [limit]
"""

from __future__ import annotations

import glob
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vl2altair import vegalite_to_altair_code  # noqa: E402

SPECS_DIR = ROOT / "vega-lite" / "examples" / "specs"


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    paths = sorted(glob.glob(str(SPECS_DIR / "*.vl.json")))
    if limit:
        paths = paths[:limit]

    failures = []
    successes = 0
    for path in paths:
        name = Path(path).name
        try:
            spec = json.loads(Path(path).read_text())
        except Exception as e:
            continue
        try:
            code = vegalite_to_altair_code(spec, format_with_black=False)
        except Exception as e:
            failures.append((name, "TRANSLATE", repr(e), traceback.format_exc()))
            continue
        try:
            ns = {}
            exec(compile(code, f"<{name}>", "exec"), ns)
            _ = ns["chart"].to_dict()
        except Exception as e:
            failures.append((name, "EXEC", repr(e), code + "\n\n" + traceback.format_exc()))
            continue
        successes += 1

    print(f"OK: {successes}/{len(paths)}")
    print(f"Failures: {len(failures)}")

    # Group by error message to see recurring root causes.
    from collections import Counter

    counter = Counter(f[2] for f in failures)
    print("\nTop failure reasons:")
    for msg, count in counter.most_common(25):
        print(f"  [{count:3d}] {msg}")

    detail_path = ROOT / "tests" / "validate_failures.txt"
    with open(detail_path, "w") as f:
        for name, stage, msg, tb in failures:
            f.write(f"===== {name} [{stage}] =====\n{msg}\n{tb}\n\n")
    print(f"\nFull details written to {detail_path}")


if __name__ == "__main__":
    main()
