"""Parser del XML de Ley Chile (esquema http://www.leychile.cl/esquemas).

Convierte el XML de una norma en una lista de artículos con su ruta jerárquica
(Libro › Título › Capítulo › Párrafo › Artículo), su texto limpio, su fecha de
versión y el link directo a Ley Chile.
"""

from __future__ import annotations

import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path

NS = "{http://www.leychile.cl/esquemas}"
LEYCHILE_URL = "https://www.bcn.cl/leychile/navegar?idNorma={id_norma}&idParte={id_parte}"

# Tipos de nodo que forman parte de la ruta jerárquica (no son artículos).
TIPOS_CONTENEDOR = {"Libro", "Título", "Capítulo", "Párrafo", "Parágrafo", "Otros", "Artículo Transitorio"}

# Una nota al margen (p. ej. "L. 18.620 / Art. 1° N° 40") aparece a la derecha
# del texto, separada por varios espacios y empezando cerca de la columna 60.
_MARGIN_COL = 45
_MARGIN_RE = re.compile(r"^(?P<texto>.*?\S)(?P<sep> {3,})(?P<nota>\S.*)$")

_TIPOS_ACENTO = {
    "libro": "Libro",
    "titulo": "Título",
    "capitulo": "Capítulo",
    "parrafo": "Párrafo",
    "paragrafo": "Parágrafo",
}

_SUFIJOS = {"bis", "ter", "quáter", "quater", "quinquies", "sexies", "septies", "octies"}


@dataclass
class Articulo:
    id: str  # slug estable: "44", "40-bis-e", "t-23"
    numero: str  # como se muestra: "44", "40 bis E", "23 transitorio"
    transitorio: bool
    derogado: bool
    fecha_version: str
    id_parte: str
    url: str
    ruta: list[str] = field(default_factory=list)  # ["Libro I: ...", "Título II: ...", ...]
    texto: str = ""
    norma: str = ""  # idNorma de Ley Chile
    norma_nombre: str = ""  # "Código del Trabajo", "Ley 21.561"

    @property
    def ruta_str(self) -> str:
        return " › ".join([*self.ruta, f"Artículo {self.numero}"])

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ruta_str"] = self.ruta_str
        return d


@dataclass
class Norma:
    id_norma: str
    titulo: str
    fecha_version: str
    articulos: list[Articulo]


def _local(tag: str) -> str:
    return tag.replace(NS, "")


def _txt(el: ET.Element | None) -> str:
    return (el.text or "") if el is not None else ""


def limpiar_texto(texto: str) -> str:
    """Quita notas al margen, normaliza espacios y conserva los incisos.

    Los incisos se separan con una línea en blanco; las líneas de un mismo
    inciso se unen con espacio.
    """
    texto = texto.replace("\r", "").replace("\xa0", " ")
    lineas: list[str] = []
    for linea in texto.split("\n"):
        linea = linea.rstrip()
        stripped = linea.lstrip(" ")
        indent = len(linea) - len(stripped)
        if stripped and indent >= _MARGIN_COL:
            # línea que es solo continuación de una nota al margen
            continue
        m = _MARGIN_RE.match(linea)
        if m and len(m.group("texto")) + len(m.group("sep")) >= _MARGIN_COL:
            linea = m.group("texto")
        lineas.append(linea)

    # Reconstruir incisos: un inciso nuevo empieza tras una línea en blanco o
    # en una línea con sangría (los incisos de Ley Chile parten con 5 espacios),
    # o en una enumeración ("1.-", "a)").
    incisos: list[str] = []
    actual: list[str] = []
    enum_re = re.compile(r"^\s*(\d+[.°º]?-|\d+\)|[a-zñ]\)|[a-zñ]\.-)\s")
    for linea in lineas:
        if not linea.strip():
            if actual:
                incisos.append(" ".join(actual))
                actual = []
            continue
        nueva = linea.startswith("  ") or bool(enum_re.match(linea))
        if nueva and actual:
            incisos.append(" ".join(actual))
            actual = []
        actual.append(re.sub(r"\s+", " ", linea.strip()))
    if actual:
        incisos.append(" ".join(actual))
    return "\n\n".join(i for i in incisos if i)


def normalizar_numero(nombre: str) -> tuple[str, str]:
    """'40 bis e' -> ('40 bis E', '40-bis-e'); '18 QUÁTER' -> ('18 quáter', '18-quater')."""
    partes = nombre.strip().split()
    if not partes:
        raise ValueError("Artículo sin número")
    display = [partes[0]]
    for p in partes[1:]:
        low = p.lower()
        display.append(low if low in _SUFIJOS else p.upper())
    numero = " ".join(display)
    slug = _sin_tildes("-".join(display).lower())
    return numero, slug


def _sin_tildes(s: str) -> str:
    # la ñ se conserva como "nn" para no chocar con la letra n (183 N vs 183 Ñ)
    s = s.replace("ñ", "nn").replace("Ñ", "NN")
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def _titulo_contenedor(el: ET.Element) -> str:
    meta = el.find(f"{NS}Metadatos")
    titulo = _txt(meta.find(f"{NS}TituloParte")).strip() if meta is not None else ""
    if not titulo or titulo == "\xa0":
        titulo = _txt(el.find(f"{NS}Texto"))
    titulo = re.sub(r"\s+", " ", titulo).strip()
    return _formatear_titulo(titulo)


def _formatear_titulo(t: str) -> str:
    """'LIBRO I DEL CONTRATO ...' -> 'Libro I: Del contrato ...'."""
    m = re.match(
        r"^(LIBRO|T[IÍ]TULO|CAP[IÍ]TULO|P[AÁ]RRAFO|PAR[AÁ]GRAFO)\s+([IVXLCDM]+|\d+[°º]?|PRELIMINAR|FINAL|\w+)\b\.?\s*(.*)$",
        t,
        re.IGNORECASE,
    )
    if not m:
        return t[:1].upper() + t[1:].lower() if t.isupper() else t
    tipo, num, resto = m.groups()
    tipo = _TIPOS_ACENTO.get(_sin_tildes(tipo).lower(), tipo.capitalize())
    resto = resto.strip(" .-:")
    if resto.isupper():
        resto = resto[:1] + resto[1:].lower()
    if num.upper() in ("PRELIMINAR", "FINAL"):
        return f"{tipo} {num.lower()}"
    num = num.upper() if re.fullmatch(r"[ivxlcdm]+", num, re.I) else num.lower()
    return f"{tipo} {num}: {resto}" if resto else f"{tipo} {num}"


def parse_norma(xml: bytes | str | Path) -> Norma:
    if isinstance(xml, Path):
        root = ET.parse(xml).getroot()
    else:
        root = ET.fromstring(xml)
    id_norma = root.get("normaId", "")
    fecha_version = root.get("fechaVersion", "")
    titulo = re.sub(r"\s+", " ", _txt(root.find(f"{NS}Metadatos/{NS}TituloNorma"))).strip()

    articulos: list[Articulo] = []

    def visitar(el: ET.Element, ruta: list[str]) -> None:
        for hijo in el:
            if _local(hijo.tag) != "EstructuraFuncional":
                continue
            tipo = hijo.get("tipoParte", "")
            if tipo == "Artículo":
                articulos.append(_parse_articulo(hijo, ruta, id_norma))
            else:
                nueva_ruta = ruta
                if tipo in TIPOS_CONTENEDOR:
                    nueva_ruta = [*ruta, _titulo_contenedor(hijo)]
                sub = hijo.find(f"{NS}EstructurasFuncionales")
                if sub is not None:
                    visitar(sub, nueva_ruta)

    raiz = root.find(f"{NS}EstructurasFuncionales")
    if raiz is not None:
        visitar(raiz, [])
    return Norma(id_norma=id_norma, titulo=titulo, fecha_version=fecha_version, articulos=articulos)


def _parse_articulo(el: ET.Element, ruta: list[str], id_norma: str) -> Articulo:
    meta = el.find(f"{NS}Metadatos")
    nombre = _txt(meta.find(f"{NS}NombreParte")) if meta is not None else ""
    numero, slug = normalizar_numero(nombre)
    transitorio = el.get("transitorio") == "transitorio"
    if transitorio:
        numero, slug = f"{numero} transitorio", f"t-{slug}"
    id_parte = el.get("idParte", "")
    return Articulo(
        id=slug,
        numero=numero,
        transitorio=transitorio,
        derogado=el.get("derogado") == "derogado",
        fecha_version=el.get("fechaVersion", ""),
        id_parte=id_parte,
        url=LEYCHILE_URL.format(id_norma=id_norma, id_parte=id_parte),
        ruta=list(ruta),
        texto=limpiar_texto(_txt(el.find(f"{NS}Texto"))),
        norma=id_norma,
    )
