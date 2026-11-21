import re
from pathlib import Path

from leyclara.build import NORMAS, cargar_corpus, referencias_al_codigo

RAIZ = Path(__file__).resolve().parents[2]


def test_normas_sincronizadas_con_worker():
    ts = (RAIZ / "worker" / "src" / "normas.ts").read_text(encoding="utf-8")
    ids_ts = re.findall(r'id: "(\d+)"', ts)
    prefijos_ts = re.findall(r'prefijo: "([\w-]+)"', ts)
    assert ids_ts == [n.id for n in NORMAS]
    assert prefijos_ts == [n.prefijo for n in NORMAS if n.prefijo]


def test_referencias_al_codigo():
    ids = {"22", "25-bis", "28", "1", "2"}
    texto = (
        "Las modificaciones contenidas en el artículo 1, referidas al inciso segundo del artículo 22; "
        "al inciso primero del artículo 25 bis. Conforme al artículo segundo de la ley N° 20.416 y al "
        "artículo primero transitorio, y al artículo 28 del Código del Trabajo."
    )
    assert referencias_al_codigo(texto, ids, propios=frozenset({"1", "2", "3"})) == ["22", "25-bis", "28"]


def test_transitorio_40_horas_vinculado_al_articulo_22():
    corpus = cargar_corpus()
    rel = set(corpus.relaciones)
    assert ("22", "l21561-t-primero") in rel
    ids = {a.id for a in corpus.articulos}
    assert "l21561-t-primero" in ids
    a = next(a for a in corpus.articulos if a.id == "l21561-t-primero")
    assert a.numero == "primero transitorio, Ley 21.561"
    assert a.norma == "1191554" and a.norma_nombre == "Ley 21.561"
