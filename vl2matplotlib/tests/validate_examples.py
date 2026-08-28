"""Ad-hoc validation harness (not a pytest suite): run the translator over
the real-world Vega-Lite example corpus, exec the generated code, and
report which ones raise errors -- mirroring `vl2d3`'s own 3-bucket
methodology (a plain pass/fail wouldn't be meaningful for a deliberately
scoped-down v1; most failures here are expected "Unsupported: ..." skips,
not bugs).

Usage: python3 tests/validate_examples.py /path/to/specs/dir [/path/to/vega-datasets] [limit]
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

matplotlib.use("Agg")  # no display backend needed for a headless batch run
warnings.filterwarnings("ignore")  # pandas SettingWithCopy/FutureWarning noise from generated code, not this harness's own concern

import matplotlib.pyplot as plt  # noqa: E402

from vl2matplotlib import vegalite_to_matplotlib_code  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python3 tests/validate_examples.py /path/to/specs/dir [/path/to/vega-datasets] [limit]")
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

    ok = 0
    skipped: dict[str, int] = {}
    failed: list[tuple[str, str]] = []

    for path in paths:
        name = os.path.basename(path)
        try:
            spec = json.loads(Path(path).read_text())
            code = vegalite_to_matplotlib_code(spec, ignore_unsupported=False)
            ns: dict = {}
            exec(compile(code, "<generated>", "exec"), ns)
            ok += 1
        except Exception as e:  # noqa: BLE001
            msg = str(e).strip().splitlines()[0] if str(e).strip() else repr(e)
            if msg.startswith("Unsupported"):
                skipped[msg[:80]] = skipped.get(msg[:80], 0) + 1
            else:
                failed.append((name, msg))
        finally:
            plt.close("all")  # each spec's own figure(s), so a 633-spec run doesn't pile up thousands of open ones

    os.chdir(old_cwd)

    print(f"OK: {ok}/{len(paths)}")
    print(f"Skipped (documented unsupported features): {sum(skipped.values())}/{len(paths)}")
    print(f"Failed (unexpected): {len(failed)}/{len(paths)}")
    print()
    print("Top skip reasons:")
    for msg, n in sorted(skipped.items(), key=lambda kv: -kv[1])[:15]:
        print(f"  [{n:3d}] {msg}")
    print()
    print("Top failure reasons (unexpected -- these are real bugs):")
    for name, msg in failed[:30]:
        print(f"  {name}: {msg}")

    details_path = Path(__file__).parent / "validate_failures.txt"
    with open(details_path, "w") as f:
        for name, msg in failed:
            f.write(f"===== {name} =====\n{msg}\n\n")
    print(f"\nFull details written to {details_path}")


if __name__ == "__main__":
    main()
