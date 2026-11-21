"""Genera los artefactos de ingesta a partir de los XML cacheados.

Normas incluidas (ver NORMAS):
  - Código del Trabajo (DFL 1/2002), completo.
  - Leyes complementarias con entrada en vigencia gradual: solo sus artículos
    transitorios, vinculados a los artículos del Código que mencionan. Ejemplo:
    la Ley 21.561 baja la jornada de 45 a 40 horas por etapas, pero el art. 22
    del Código ya dice "cuarenta horas"; sin el transitorio, la respuesta sería
    fiel al texto pero no a lo que rige hoy.

Salidas (en data/build/):
  - articulos.json : todos los artículos parseados (referencia y UI)
  - chunks.json    : chunks para embeddings/FTS (un artículo o un grupo de incisos)
  - seed.sql       : INSERTs para D1 (tablas en migrations/)

Uso: python -m leyclara.build
Después: npx wrangler d1 execute leyclara --local --env="" --file data/build/seed.sql
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .fetch import ROOT, fetch_norma
from .parser import Articulo, Norma, normalizar_numero, parse_norma
from .textnorm import texto_stem

BUILD = ROOT / "data" / "build"
MAX_CHARS = 1500  # bge-m3 acepta más, pero chunks cortos dan vectores más precisos


@dataclass(frozen=True)
class NormaConfig:
    id: str  # idNorma de Ley Chile
    nombre: str  # nombre corto para citas: "Código del Trabajo", "Ley 21.561"
    principal: bool = False
    prefijo: str = ""  # prefijo de los ids de artículos (normas complementarias)
    descripcion: str = ""
    solo_transitorios: bool = False


# Mantener sincronizado con worker/src/normas.ts (lo verifica un test).
NORMAS: tuple[NormaConfig, ...] = (
    NormaConfig(id="207436", nombre="Código del Trabajo", principal=True),
    NormaConfig(
        id="1191554",
        nombre="Ley 21.561",
        prefijo="l21561",
        descripcion="Ley 40 horas, reducción gradual de la jornada",
        solo_transitorios=True,
    ),
)


@dataclass
class Chunk:
    id: str
    articulo_id: str
    idx: int
    texto: str  # incluye encabezado con número y ruta (contexto para el embedding)


@dataclass
class Corpus:
    normas: list[tuple[NormaConfig, Norma]]
    articulos: list[Articulo]
    relaciones: list[tuple[str, str]] = field(default_factory=list)  # (articulo, relacionado)


def adaptar(a: Articulo, cfg: NormaConfig, norma: Norma) -> Articulo:
    """Ajusta id, número y ruta de un artículo según su norma."""
    a.norma_nombre = cfg.nombre
    if cfg.principal:
        return a
    a.id = f"{cfg.prefijo}-{a.id}"
    a.numero = f"{a.numero}, {cfg.nombre}"
    a.ruta = [f"{cfg.nombre} ({cfg.descripcion})" if cfg.descripcion else cfg.nombre, *a.ruta]
    return a


_REF_RE = re.compile(
    r"art[íi]culos?\s+(\d{1,3}(?:\s+(?:bis|ter|qu[áa]ter|quinquies))?)(?![\w°º])(?=(?P<cola>.{0,40}))",
    re.IGNORECASE | re.DOTALL,
)


def referencias_al_codigo(texto: str, ids_codigo: set[str], propios: frozenset[str] = frozenset()) -> list[str]:
    """Artículos del Código mencionados en un texto ("del artículo 22", "artículo 25 bis").

    Se descartan las referencias a la propia ley ("artículo 1 de la presente ley",
    "artículo primero transitorio", o un número de artículo de la misma ley en `propios`)
    y a otras leyes ("artículo segundo de la ley N° 20.416").
    """
    out: list[str] = []
    for m in _REF_RE.finditer(texto):
        cola = m.group("cola").lower()
        if re.match(r"\s*(de la presente ley|de esta ley|transitorio|de la ley|del decreto)", cola):
            continue
        _, slug = normalizar_numero(m.group(1))
        if slug in propios:
            continue
        if slug in ids_codigo and slug not in out:
            out.append(slug)
    return out


def cargar_corpus(forzar_descarga: bool = False) -> Corpus:
    normas: list[tuple[NormaConfig, Norma]] = []
    articulos: list[Articulo] = []
    propios: dict[str, frozenset[str]] = {}  # números de artículos permanentes de cada ley complementaria
    for cfg in NORMAS:
        norma = parse_norma(fetch_norma(cfg.id, forzar=forzar_descarga))
        normas.append((cfg, norma))
        propios[cfg.id] = frozenset(a.id for a in norma.articulos if not a.transitorio)
        for a in norma.articulos:
            if cfg.solo_transitorios and not a.transitorio:
                continue
            articulos.append(adaptar(a, cfg, norma))

    ids_codigo = {a.id for a in articulos if a.norma == NORMAS[0].id and not a.derogado}
    relaciones: list[tuple[str, str]] = []
    for a in articulos:
        if a.norma != NORMAS[0].id and not a.derogado:
            for ref in referencias_al_codigo(a.texto, ids_codigo, propios[a.norma]):
                relaciones.append((ref, a.id))  # al recuperar el art. del Código, traer también el transitorio
    return Corpus(normas=normas, articulos=articulos, relaciones=relaciones)


def chunk_articulo(a: Articulo, max_chars: int = MAX_CHARS) -> list[Chunk]:
    """Un chunk por artículo; si es largo, se divide por incisos.

    Cada chunk repite el encabezado "Artículo N (ruta)" para no perder contexto.
    """
    if a.norma_nombre in ("", "Código del Trabajo"):
        encabezado = f"Artículo {a.numero} del Código del Trabajo. {' › '.join(a.ruta)}\n"
    else:
        encabezado = f"Artículo {a.numero}. {' › '.join(a.ruta)}\n"
    incisos = a.texto.split("\n\n")
    grupos: list[list[str]] = [[]]
    largo = 0
    for inc in incisos:
        if grupos[-1] and largo + len(inc) > max_chars:
            grupos.append([])
            largo = 0
        grupos[-1].append(inc)
        largo += len(inc) + 2
    return [
        Chunk(id=f"{a.id}#{i}", articulo_id=a.id, idx=i, texto=encabezado + "\n\n".join(g))
        for i, g in enumerate(grupos)
    ]


def _q(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def meta_normas(corpus: Corpus) -> list[dict]:
    return [
        {
            "id": cfg.id,
            "nombre": cfg.nombre,
            "titulo": norma.titulo,
            "fecha_version": norma.fecha_version,
            "fuente": f"https://www.bcn.cl/leychile/navegar?idNorma={cfg.id}",
        }
        for cfg, norma in corpus.normas
    ]


def generar_sql(corpus: Corpus, chunks: list[Chunk]) -> str:
    principal = corpus.normas[0][1]
    out = [
        "-- Generado por ingest/leyclara/build.py. No editar a mano.",
        "DELETE FROM relaciones;",
        "DELETE FROM chunks_fts;",
        "DELETE FROM chunks;",
        "DELETE FROM articulos;",
        "DELETE FROM meta;",
    ]
    meta = {
        "id_norma": principal.id_norma,
        "titulo": principal.titulo,
        "nombre": "Código del Trabajo",
        "fecha_version": principal.fecha_version,
        "fuente": f"https://www.bcn.cl/leychile/navegar?idNorma={principal.id_norma}",
        "n_articulos": str(len(principal.articulos)),
        "normas": json.dumps(meta_normas(corpus), ensure_ascii=False),
    }
    for k, v in meta.items():
        out.append(f"INSERT INTO meta (key, value) VALUES ({_q(k)}, {_q(v)});")
    for orden, a in enumerate(corpus.articulos):
        out.append(
            "INSERT INTO articulos (id, numero, orden, transitorio, derogado, fecha_version, id_parte, url, ruta, ruta_str, texto, norma, norma_nombre) "
            f"VALUES ({_q(a.id)}, {_q(a.numero)}, {orden}, {_q(a.transitorio)}, {_q(a.derogado)}, {_q(a.fecha_version)}, "
            f"{_q(a.id_parte)}, {_q(a.url)}, {_q(json.dumps(a.ruta, ensure_ascii=False))}, {_q(a.ruta_str)}, {_q(a.texto)}, "
            f"{_q(a.norma)}, {_q(a.norma_nombre)});"
        )
    por_id = {a.id: a for a in corpus.articulos}
    for c in chunks:
        a = por_id[c.articulo_id]
        out.append(
            f"INSERT INTO chunks (id, articulo_id, idx, texto) VALUES ({_q(c.id)}, {_q(c.articulo_id)}, {c.idx}, {_q(c.texto)});"
        )
        out.append(
            "INSERT INTO chunks_fts (chunk_id, articulo_id, texto_stem, ruta_stem) "
            f"VALUES ({_q(c.id)}, {_q(c.articulo_id)}, {_q(texto_stem(c.texto.split(chr(10), 1)[1]))}, "
            f"{_q(texto_stem(' '.join(a.ruta)))});"
        )
    for art, rel in corpus.relaciones:
        out.append(f"INSERT OR IGNORE INTO relaciones (articulo_id, relacionado_id) VALUES ({_q(art)}, {_q(rel)});")
    return "\n".join(out) + "\n"


def _escribir(ruta: Path, contenido: str) -> None:
    # newline="\n": en Windows, write_text convertiría los saltos de línea de los textos legales en CRLF.
    ruta.write_text(contenido, encoding="utf-8", newline="\n")


def build(forzar_descarga: bool = False) -> dict:
    corpus = cargar_corpus(forzar_descarga)
    # Los artículos derogados quedan en la tabla (para mostrarlos si se citan),
    # pero no se indexan para búsqueda.
    chunks = [c for a in corpus.articulos if not a.derogado for c in chunk_articulo(a)]
    BUILD.mkdir(parents=True, exist_ok=True)
    _escribir(
        BUILD / "articulos.json",
        json.dumps(
            {"normas": meta_normas(corpus), "articulos": [a.to_dict() for a in corpus.articulos]},
            ensure_ascii=False,
            indent=1,
        ),
    )
    _escribir(BUILD / "chunks.json", json.dumps([c.__dict__ for c in chunks], ensure_ascii=False, indent=1))
    _escribir(BUILD / "seed.sql", generar_sql(corpus, chunks))
    stats = {
        "normas": {cfg.nombre: norma.fecha_version for cfg, norma in corpus.normas},
        "articulos": len(corpus.articulos),
        "derogados": sum(a.derogado for a in corpus.articulos),
        "chunks": len(chunks),
        "relaciones": len(corpus.relaciones),
        "chunk_max_chars": max(len(c.texto) for c in chunks),
    }
    print(json.dumps(stats, ensure_ascii=False))
    return stats


if __name__ == "__main__":
    import sys

    build(forzar_descarga="--descargar" in sys.argv)
