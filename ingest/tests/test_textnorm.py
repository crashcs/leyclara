import json
from pathlib import Path

from leyclara.textnorm import normalizar, stem, tokens

CASES = json.loads((Path(__file__).resolve().parents[2] / "shared" / "textnorm_cases.json").read_text(encoding="utf-8"))


def test_normalizar():
    assert normalizar("¿Cuántos DÍAS?  Ñandú") == "cuantos dias nandu"


def test_stem_basico():
    assert stem("trabajadores") == stem("trabajador") == "trabaj"
    assert stem("indemnizaciones") == stem("indemnización".replace("ó", "o"))
    assert stem("161") == "161"


def test_casos_compartidos():
    # Este archivo también lo valida worker/test/textnorm.test.ts
    for f in CASES["frases"]:
        assert tokens(f["input"]) == f["tokens"]
    for w, t in CASES["palabras"].items():
        assert tokens(w) == t
