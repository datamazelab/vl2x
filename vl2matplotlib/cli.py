"""Command-line interface: ``python -m vl2matplotlib spec.vl.json [-o out.py]``."""

from __future__ import annotations

import argparse
import json
import sys

from .translator import spec_to_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="vl2matplotlib",
        description="Translate a Vega-Lite JSON specification into Python/matplotlib code.",
    )
    parser.add_argument(
        "spec",
        nargs="?",
        help="Path to a Vega-Lite JSON file. Reads from stdin if omitted.",
    )
    parser.add_argument("-o", "--output", help="Write the generated code to this file instead of stdout.")
    parser.add_argument("--ignore-unsupported", action="store_true", help="Best-effort fallback instead of a strict error for unsupported features.")
    parser.add_argument("--include-source-paths", action="store_true", help="Annotate each statement with a '# from: <json path>' comment.")
    parser.add_argument(
        "--no-black",
        action="store_true",
        help="Skip optional formatting with the 'black' package, even if it's installed.",
    )
    args = parser.parse_args(argv)

    if args.spec:
        with open(args.spec) as f:
            spec = json.load(f)
    else:
        spec = json.load(sys.stdin)

    code = spec_to_code(
        spec,
        ignore_unsupported=args.ignore_unsupported,
        include_source_paths=args.include_source_paths,
        format_with_black=not args.no_black,
    )

    if args.output:
        with open(args.output, "w") as f:
            f.write(code)
    else:
        sys.stdout.write(code)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
