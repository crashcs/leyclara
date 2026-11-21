"""Descarga los XML de Ley Chile y los cachea en data/raw/.

Usa el archivo cacheado si existe; solo vuelve a descargar con --force.
En producción, la revisión diaria la hace el Worker (worker/src/actualizar.ts).

Uso: python -m leyclara.fetch [--force]
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
URL = "https://www.leychile.cl/Consulta/obtxml?opt=7&idNorma={id}"
# Ley Chile responde 401 sin un User-Agent de navegador.
USER_AGENT = "Mozilla/5.0 (compatible; LeyClara/0.1; +https://ley.manuel.ac)"
ARCHIVOS = {"207436": "codigo-trabajo-207436.xml"}

ID_NORMA = "207436"  # DFL 1/2002, Código del Trabajo
DESTINO = RAW / ARCHIVOS[ID_NORMA]


def ruta_norma(id_norma: str) -> Path:
    return RAW / ARCHIVOS.get(id_norma, f"norma-{id_norma}.xml")


def fetch_norma(id_norma: str, forzar: bool = False) -> Path:
    destino = ruta_norma(id_norma)
    if destino.exists() and not forzar:
        return destino
    req = urllib.request.Request(URL.format(id=id_norma), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not data.lstrip().startswith(b"<?xml"):
        raise RuntimeError(f"La respuesta de Ley Chile para idNorma={id_norma} no es XML")
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(data)
    print(f"descargado {len(data):,} bytes -> {destino}")
    return destino


def fetch(force: bool = False) -> Path:
    return fetch_norma(ID_NORMA, forzar=force)


if __name__ == "__main__":
    from .build import NORMAS

    for cfg in NORMAS:
        print(fetch_norma(cfg.id, forzar="--force" in sys.argv))
