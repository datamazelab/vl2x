"""Translate Vega-Lite JSON specifications into Python/matplotlib source code.

Basic usage::

    import json
    from vl2matplotlib import vegalite_to_matplotlib_code

    spec = json.load(open("chart.vl.json"))
    print(vegalite_to_matplotlib_code(spec))
"""

from .translator import spec_to_code as vegalite_to_matplotlib_code

__all__ = ["vegalite_to_matplotlib_code"]
