"""Genera los artefactos de ingesta a partir del XML cacheado.

Salidas (en data/build/):
  - articulos.json : todos los artículos parseados (referencia y UI)
  - chunks.json    : chunks para embeddings/FTS (un artículo o un grupo de incisos)
  - seed.sql       : INSERTs para D1 (tablas definidas en migrations/0001_init.sql)

Uso: python -m leyclara.build
Después: npx wrangler d1 execute leyclara --local --file data/build/seed.sql
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .fetch import DESTINO, ROOT, fetch
from .parser import Articulo, Norma, parse_norma
from .textnorm import texto_stem

BUILD = ROOT / "data" / "build"
MAX_CHARS = 1500  # bge-m3 acepta más, pero chunks cortos dan vectores más precisos


@dataclass
class Chunk:
    id: str
    articulo_id: str
    idx: int
    texto: str  # incluye encabezado con número y ruta (contexto para el embedding)


def chunk_articulo(a: Articulo, max_chars: int = MAX_CHARS) -> list[Chunk]:
    """Un chunk por artículo; si es largo, se divide por incisos.

    Cada chunk repite el encabezado "Artículo N (ruta)" para no perder contexto.
    """
    encabezado = f"Artículo {a.numero} del Código del Trabajo. {' › '.join(a.ruta)}\n"
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


def generar_sql(norma: Norma, chunks: list[Chunk]) -> str:
    out = [
        "-- Generado por ingest/leyclara/build.py. No editar a mano.",
        "DELETE FROM chunks_fts;",
        "DELETE FROM chunks;",
        "DELETE FROM articulos;",
        "DELETE FROM meta;",
    ]
    meta = {
        "id_norma": norma.id_norma,
        "titulo": norma.titulo,
        "nombre": "Código del Trabajo",
        "fecha_version": norma.fecha_version,
        "fuente": f"https://www.bcn.cl/leychile/navegar?idNorma={norma.id_norma}",
        "n_articulos": str(len(norma.articulos)),
    }
    for k, v in meta.items():
        out.append(f"INSERT INTO meta (key, value) VALUES ({_q(k)}, {_q(v)});")
    for orden, a in enumerate(norma.articulos):
        out.append(
            "INSERT INTO articulos (id, numero, orden, transitorio, derogado, fecha_version, id_parte, url, ruta, ruta_str, texto) "
            f"VALUES ({_q(a.id)}, {_q(a.numero)}, {orden}, {_q(a.transitorio)}, {_q(a.derogado)}, {_q(a.fecha_version)}, "
            f"{_q(a.id_parte)}, {_q(a.url)}, {_q(json.dumps(a.ruta, ensure_ascii=False))}, {_q(a.ruta_str)}, {_q(a.texto)});"
        )
    por_id = {a.id: a for a in norma.articulos}
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
    return "\n".join(out) + "\n"


def build() -> dict:
    xml = DESTINO if DESTINO.exists() else fetch()
    norma = parse_norma(xml)
    # Los artículos derogados quedan en la tabla (para mostrarlos si se citan),
    # pero no se indexan para búsqueda.
    chunks = [c for a in norma.articulos if not a.derogado for c in chunk_articulo(a)]
    BUILD.mkdir(parents=True, exist_ok=True)
    (BUILD / "articulos.json").write_text(
        json.dumps(
            {"id_norma": norma.id_norma, "fecha_version": norma.fecha_version, "articulos": [a.to_dict() for a in norma.articulos]},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
        newline="\n",
    )
    (BUILD / "chunks.json").write_text(
        json.dumps([c.__dict__ for c in chunks], ensure_ascii=False, indent=1), encoding="utf-8", newline="\n"
    )
    # newline="\n": en Windows, write_text convertiría los saltos de línea de los textos legales en CRLF.
    (BUILD / "seed.sql").write_text(generar_sql(norma, chunks), encoding="utf-8", newline="\n")
    stats = {
        "fecha_version": norma.fecha_version,
        "articulos": len(norma.articulos),
        "derogados": sum(a.derogado for a in norma.articulos),
        "chunks": len(chunks),
        "chunk_max_chars": max(len(c.texto) for c in chunks),
    }
    print(json.dumps(stats, ensure_ascii=False))
    return stats


if __name__ == "__main__":
    build()
