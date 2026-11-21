from pathlib import Path

import pytest

from leyclara.parser import limpiar_texto, normalizar_numero, parse_norma

XML = Path(__file__).resolve().parents[2] / "data" / "raw" / "codigo-trabajo-207436.xml"
FIXTURE = Path(__file__).parent / "fixtures" / "mini_norma.xml"


# ---------- unidades (no requieren el XML completo) ----------

def test_limpiar_quita_notas_al_margen():
    raw = (
        "     Art. 126. En los casos de enfermedad, todo el personal         L. 18.620\n"
        "de dotación será asistido por cuenta del armador durante            ART. PRIMERO\n"
        "su permanencia a bordo.                                             Art. 123\n"
        "                                                                    D.O. 01.01.1990\n"
        "     Cuando la enfermedad no se halle comprendida.\n"
    )
    out = limpiar_texto(raw)
    assert "L. 18.620" not in out and "ART. PRIMERO" not in out and "D.O." not in out
    assert out.split("\n\n") == [
        "Art. 126. En los casos de enfermedad, todo el personal de dotación será asistido "
        "por cuenta del armador durante su permanencia a bordo.",
        "Cuando la enfermedad no se halle comprendida.",
    ]


def test_limpiar_respeta_enumeraciones():
    raw = "     Art. 1. Normas:\na) primera\nb) segunda\n1.- tercera"
    assert limpiar_texto(raw).split("\n\n") == ["Art. 1. Normas:", "a) primera", "b) segunda", "1.- tercera"]


@pytest.mark.parametrize(
    "raw,numero,slug",
    [
        ("44 ", "44", "44"),
        ("40 bis e", "40 bis E", "40-bis-e"),
        ("18 QUÁTER", "18 quáter", "18-quater"),
        ("152 BIS A", "152 bis A", "152-bis-a"),
        ("183 Ñ", "183 Ñ", "183-nn"),
    ],
)
def test_normalizar_numero(raw, numero, slug):
    assert normalizar_numero(raw) == (numero, slug)


def test_fixture_ruta_y_transitorios():
    n = parse_norma(FIXTURE)
    assert n.fecha_version == "2026-07-23"
    ids = [a.id for a in n.articulos]
    assert ids == ["1", "7", "t-1"]
    a7 = n.articulos[1]
    assert a7.ruta == ["Libro I: Del contrato individual", "Título I: Del contrato", "Capítulo I: Normas generales"]
    assert a7.ruta_str.endswith("Capítulo I: Normas generales › Artículo 7")
    assert a7.url == "https://www.bcn.cl/leychile/navegar?idNorma=207436&idParte=111"
    assert n.articulos[0].ruta == ["Título preliminar"]
    assert n.articulos[2].transitorio and n.articulos[2].numero == "1 transitorio"


# ---------- integración con el XML real (se salta si no está descargado) ----------

needs_xml = pytest.mark.skipif(not XML.exists(), reason="ejecuta `python -m leyclara.fetch` primero")


@pytest.fixture(scope="module")
def norma():
    return parse_norma(XML)


@needs_xml
def test_conteos(norma):
    assert norma.id_norma == "207436"
    assert len(norma.articulos) == 737
    assert sum(a.transitorio for a in norma.articulos) == 23
    assert len({a.id for a in norma.articulos}) == 737  # ids únicos
    assert sum(a.derogado for a in norma.articulos) == 4


@needs_xml
def test_todos_tienen_ruta_texto_y_link(norma):
    for a in norma.articulos:
        assert a.ruta, a.id
        assert a.texto, a.id
        assert a.fecha_version and a.id_parte
        assert a.url.startswith("https://www.bcn.cl/leychile/navegar?idNorma=207436&idParte=")


@needs_xml
def test_articulo_67_feriado(norma):
    a = {x.id: x for x in norma.articulos}["67"]
    assert a.ruta[0].startswith("Libro I")
    assert any(r.startswith("Capítulo VII") for r in a.ruta)
    assert "quince días hábiles" in a.texto


@needs_xml
def test_sin_notas_al_margen(norma):
    import re

    for a in norma.articulos:
        # patrones típicos de notas: "L. 18.620", "D.O. 01.01.1990"
        assert not re.search(r"\s{3,}L\. ?\d{2}\.?\d{3}", a.texto), a.id
        assert "  " not in a.texto, a.id


def test_seed_sin_crlf():
    # En Windows, write_text sin newline="\n" metía \r\n dentro de los textos legales.
    seed = Path(__file__).resolve().parents[2] / "data" / "build" / "seed.sql"
    if not seed.exists():
        pytest.skip("ejecuta `python -m leyclara.build` primero")
    assert b"\r" not in seed.read_bytes()
