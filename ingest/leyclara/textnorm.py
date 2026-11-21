"""Normalización y stemming ligero para español.

FTS5 no trae stemmer para español, así que indexamos una versión "stemmeada"
del texto. El Worker (worker/src/textnorm.ts) aplica exactamente las mismas
reglas a la consulta; ambos se verifican contra shared/textnorm_cases.json.
"""

from __future__ import annotations

import re
import unicodedata

STOPWORDS = frozenset(
    """
    a al algo algun alguna algunas alguno algunos ante antes aquel aquella aquellas aquellos aqui asi aun
    bajo bien cada cual cuales cualquier como con contra cual cuando cuanto de del desde donde dos e el
    ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estado estan estar este
    esto estos fue fueron ha habia han hasta hay la las le les lo los mas me mi mis mismo mucho muy nada
    ni no nos nosotros o os otra otras otro otros para pero poco por porque que quien quienes se sea sean
    segun ser si sido sin sino sobre son su sus tal tambien tan tanto te tener tiene tienen toda todas
    todo todos tu tus u un una unas uno unos usted ustedes y ya yo
    """.split()
)

# Se aplica la primera regla que calce, siempre que quede una raíz de >= 4 letras.
SUFIJOS = (
    "amientos", "imientos", "aciones", "uciones", "amiento", "imiento", "idades", "adoras", "adores",
    "ancias", "encias", "mente", "acion", "ucion", "adora", "ador", "ancia", "encia", "idad",
    "ables", "ibles", "able", "ible", "istas", "ista", "osas", "osos", "osa", "oso",
    "ivas", "ivos", "iva", "ivo",
)

_NO_ALNUM = re.compile(r"[^a-z0-9]+")


def normalizar(texto: str) -> str:
    """Minúsculas, sin tildes (ñ -> n), solo [a-z0-9] separados por espacio."""
    texto = unicodedata.normalize("NFD", texto.lower())
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    return _NO_ALNUM.sub(" ", texto).strip()


def stem(palabra: str) -> str:
    w = palabra
    if len(w) <= 3 or w.isdigit():
        return w
    for suf in SUFIJOS:
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    if w.endswith("ces") and len(w) > 5:
        w = w[:-3] + "z"
    elif w.endswith("es") and len(w) > 4 and w[-3] not in "aeiou":
        w = w[:-2]
    elif w.endswith("s") and len(w) > 3:
        w = w[:-1]
    if len(w) > 4 and w[-1] in "aeo":
        w = w[:-1]
    return w


def tokens(texto: str) -> list[str]:
    """Tokens stemmeados sin stopwords."""
    return [stem(t) for t in normalizar(texto).split() if t not in STOPWORDS]


def texto_stem(texto: str) -> str:
    return " ".join(tokens(texto))
