"""Descarga el XML de Ley Chile y lo cachea en data/raw/.

Solo descarga si el archivo no existe o tiene más de 24 h (o con --force).
Uso: python -m leyclara.fetch [--force]
"""

from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

ID_NORMA = "207436"  # DFL 1/2002, Código del Trabajo
URL = f"https://www.leychile.cl/Consulta/obtxml?opt=7&idNorma={ID_NORMA}"
ROOT = Path(__file__).resolve().parents[2]
DESTINO = ROOT / "data" / "raw" / f"codigo-trabajo-{ID_NORMA}.xml"
MAX_EDAD_S = 24 * 3600
# Ley Chile responde 401 sin un User-Agent de navegador.
USER_AGENT = "Mozilla/5.0 (compatible; LeyClara/0.1; +https://ley.manuel.ac)"


def fetch(force: bool = False) -> Path:
    if DESTINO.exists() and not force and time.time() - DESTINO.stat().st_mtime < MAX_EDAD_S:
        print(f"usando cache: {DESTINO}")
        return DESTINO
    req = urllib.request.Request(URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not data.lstrip().startswith(b"<?xml"):
        raise RuntimeError("La respuesta de Ley Chile no es XML")
    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    DESTINO.write_bytes(data)
    print(f"descargado {len(data):,} bytes -> {DESTINO}")
    return DESTINO


if __name__ == "__main__":
    fetch(force="--force" in sys.argv)
