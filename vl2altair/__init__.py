"""Translate Vega-Lite JSON specifications into Python/Altair source code.

Basic usage::

    import json
    from vl2altair import vegalite_to_altair_code

    spec = json.load(open("chart.vl.json"))
    print(vegalite_to_altair_code(spec))
"""

from .translator import spec_to_code as vegalite_to_altair_code

__all__ = ["vegalite_to_altair_code"]
