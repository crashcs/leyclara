// Puerto a TypeScript de ingest/leyclara/parser.py y de la parte de build.py que
// adapta artículos, arma chunks y detecta relaciones. Lo usa la revisión diaria
// (actualizar.ts) para reprocesar una norma sin Python.
//
// worker/test/parser.test.ts compara este parser con la salida de Python sobre los
// XML reales: cualquier diferencia rompe el test.

import type { NormaConfig } from "./normas";
import { URL_NORMA } from "./normas";

export interface Articulo {
  id: string;
  numero: string;
  transitorio: boolean;
  derogado: boolean;
  fecha_version: string;
  id_parte: string;
  url: string;
  ruta: string[];
  texto: string;
  norma: string;
  norma_nombre: string;
}

export interface Norma {
  id_norma: string;
  titulo: string;
  fecha_version: string;
  articulos: Articulo[];
}

export interface Chunk {
  id: string;
  articulo_id: string;
  idx: number;
  texto: string;
}

const TIPOS_CONTENEDOR = new Set(["Libro", "Título", "Capítulo", "Párrafo", "Parágrafo", "Otros", "Artículo Transitorio"]);
const SUFIJOS = new Set(["bis", "ter", "quáter", "quater", "quinquies", "sexies", "septies", "octies"]);
const TIPOS_ACENTO: Record<string, string> = {
  libro: "Libro",
  titulo: "Título",
  capitulo: "Capítulo",
  parrafo: "Párrafo",
  paragrafo: "Parágrafo",
};
const MARGIN_COL = 45;
const MAX_CHARS = 1500;

// Equivalentes Unicode de \w y \b de Python.
const W = "[\\p{L}\\p{N}_]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/* ---------- XML mínimo para el esquema de Ley Chile ---------- */

interface Nodo {
  tag: string;
  attrs: Record<string, string>;
  hijos: Nodo[];
  texto: string; // texto antes del primer hijo (como Element.text)
}

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    return String.fromCodePoint(l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  });
}

function atributos(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodificar(m[2]);
  return out;
}

const TAGS = ["Norma", "EstructurasFuncionales", "EstructuraFuncional", "Texto", "Metadatos", "NombreParte", "TituloParte", "TituloNorma"];

/** Árbol con solo las etiquetas que importan; el resto se ignora. */
export function parseXml(xml: string): Nodo {
  const re = new RegExp(`<(/?)(${TAGS.join("|")})(\\s[^>]*?)?(/?)>`, "g");
  const raiz: Nodo = { tag: "#doc", attrs: {}, hijos: [], texto: "" };
  const pila: { nodo: Nodo; inicio: number; tieneHijos: boolean }[] = [{ nodo: raiz, inicio: 0, tieneHijos: true }];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, cierre, tag, attrs = "", autocierre] = m;
    const tope = pila[pila.length - 1];
    if (cierre) {
      if (tope.nodo.tag !== tag) continue; // XML mal formado: se ignora
      if (!tope.tieneHijos) tope.nodo.texto = decodificar(xml.slice(tope.inicio, m.index).replace(/<[^>]*>/g, ""));
      pila.pop();
      continue;
    }
    if (!tope.tieneHijos) {
      tope.nodo.texto = decodificar(xml.slice(tope.inicio, m.index).replace(/<[^>]*>/g, ""));
      tope.tieneHijos = true;
    }
    const nodo: Nodo = { tag, attrs: atributos(attrs), hijos: [], texto: "" };
    tope.nodo.hijos.push(nodo);
    if (!autocierre) pila.push({ nodo, inicio: re.lastIndex, tieneHijos: false });
  }
  return raiz;
}

const hijo = (n: Nodo | undefined, tag: string) => n?.hijos.find((h) => h.tag === tag);

/* ---------- Limpieza y normalización (idéntico a parser.py) ---------- */

function pyStrip(s: string, chars?: string): string {
  if (chars === undefined) return s.trim();
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

const esMayus = (s: string) => s === s.toUpperCase() && s !== s.toLowerCase();

export function limpiarTexto(texto: string): string {
  texto = texto.replace(/\r/g, "").replace(/ /g, " ");
  const margen = /^(.*?\S)( {3,})(\S.*)$/u;
  const lineas: string[] = [];
  for (let linea of texto.split("\n")) {
    linea = linea.trimEnd();
    const sinSangria = linea.replace(/^ +/, "");
    const sangria = linea.length - sinSangria.length;
    if (sinSangria && sangria >= MARGIN_COL) continue; // continuación de una nota al margen
    const m = margen.exec(linea);
    if (m && m[1].length + m[2].length >= MARGIN_COL) linea = m[1];
    lineas.push(linea);
  }
  const incisos: string[] = [];
  let actual: string[] = [];
  const enumRe = /^\s*(\d+[.°º]?-|\d+\)|[a-zñ]\)|[a-zñ]\.-)\s/u;
  for (const linea of lineas) {
    if (!linea.trim()) {
      if (actual.length) {
        incisos.push(actual.join(" "));
        actual = [];
      }
      continue;
    }
    const nueva = linea.startsWith("  ") || enumRe.test(linea);
    if (nueva && actual.length) {
      incisos.push(actual.join(" "));
      actual = [];
    }
    actual.push(linea.trim().replace(/\s+/gu, " "));
  }
  if (actual.length) incisos.push(actual.join(" "));
  return incisos.filter(Boolean).join("\n\n");
}

function sinTildes(s: string): string {
  return s.replace(/ñ/g, "nn").replace(/Ñ/g, "NN").normalize("NFD").replace(/\p{Mn}/gu, "");
}

export function normalizarNumero(nombre: string): [string, string] {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) throw new Error("Artículo sin número");
  const display = [partes[0]];
  for (const p of partes.slice(1)) {
    const low = p.toLowerCase();
    display.push(SUFIJOS.has(low) ? low : p.toUpperCase());
  }
  return [display.join(" "), sinTildes(display.join("-").toLowerCase())];
}

function formatearTitulo(t: string): string {
  const re = new RegExp(
    `^(LIBRO|T[IÍ]TULO|CAP[IÍ]TULO|P[AÁ]RRAFO|PAR[AÁ]GRAFO)\\s+([IVXLCDM]+|\\d+[°º]?|PRELIMINAR|FINAL|${W}+)${B}\\.?\\s*(.*)$`,
    "iu",
  );
  const m = re.exec(t);
  if (!m) return esMayus(t) ? t.slice(0, 1).toUpperCase() + t.slice(1).toLowerCase() : t;
  let [, tipo, num, resto] = m;
  const cap = tipo.slice(0, 1).toUpperCase() + tipo.slice(1).toLowerCase();
  tipo = TIPOS_ACENTO[sinTildes(tipo).toLowerCase()] ?? cap;
  resto = pyStrip(resto, " .-:");
  if (esMayus(resto)) resto = resto.slice(0, 1) + resto.slice(1).toLowerCase();
  if (["PRELIMINAR", "FINAL"].includes(num.toUpperCase())) return `${tipo} ${num.toLowerCase()}`;
  num = /^[ivxlcdm]+$/i.test(num) ? num.toUpperCase() : num.toLowerCase();
  return resto ? `${tipo} ${num}: ${resto}` : `${tipo} ${num}`;
}

function tituloContenedor(n: Nodo): string {
  const meta = hijo(n, "Metadatos");
  let titulo = meta ? (hijo(meta, "TituloParte")?.texto ?? "").trim() : "";
  if (!titulo || titulo === " ") titulo = hijo(n, "Texto")?.texto ?? "";
  return formatearTitulo(titulo.replace(/\s+/gu, " ").trim());
}

function parseArticulo(n: Nodo, ruta: string[], idNorma: string): Articulo {
  const meta = hijo(n, "Metadatos");
  let [numero, slug] = normalizarNumero(hijo(meta, "NombreParte")?.texto ?? "");
  const transitorio = n.attrs.transitorio === "transitorio";
  if (transitorio) {
    numero = `${numero} transitorio`;
    slug = `t-${slug}`;
  }
  const idParte = n.attrs.idParte ?? "";
  return {
    id: slug,
    numero,
    transitorio,
    derogado: n.attrs.derogado === "derogado",
    fecha_version: n.attrs.fechaVersion ?? "",
    id_parte: idParte,
    url: `https://www.bcn.cl/leychile/navegar?idNorma=${idNorma}&idParte=${idParte}`,
    ruta: [...ruta],
    texto: limpiarTexto(hijo(n, "Texto")?.texto ?? ""),
    norma: idNorma,
    norma_nombre: "",
  };
}

export function parseNorma(xml: string): Norma {
  const doc = parseXml(xml);
  const raiz = hijo(doc, "Norma");
  if (!raiz) throw new Error("El XML no tiene <Norma>");
  const idNorma = raiz.attrs.normaId ?? "";
  const articulos: Articulo[] = [];
  const visitar = (n: Nodo, ruta: string[]) => {
    for (const h of n.hijos) {
      if (h.tag !== "EstructuraFuncional") continue;
      const tipo = h.attrs.tipoParte ?? "";
      if (tipo === "Artículo") articulos.push(parseArticulo(h, ruta, idNorma));
      else {
        const nueva = TIPOS_CONTENEDOR.has(tipo) ? [...ruta, tituloContenedor(h)] : ruta;
        const sub = hijo(h, "EstructurasFuncionales");
        if (sub) visitar(sub, nueva);
      }
    }
  };
  const ef = hijo(raiz, "EstructurasFuncionales");
  if (ef) visitar(ef, []);
  const titulo = (hijo(hijo(raiz, "Metadatos"), "TituloNorma")?.texto ?? "").replace(/\s+/gu, " ").trim();
  return { id_norma: idNorma, titulo, fecha_version: raiz.attrs.fechaVersion ?? "", articulos };
}

/** Solo la fecha de versión, leyendo el comienzo del XML (sin parsearlo entero). */
export function fechaVersionXml(inicioXml: string): string | null {
  const m = /<Norma\b[^>]*\bfechaVersion="([^"]+)"/.exec(inicioXml);
  return m ? m[1] : null;
}

/* ---------- Adaptación, chunks y relaciones (idéntico a build.py) ---------- */

export function rutaStr(a: Pick<Articulo, "ruta" | "numero">): string {
  return [...a.ruta, `Artículo ${a.numero}`].join(" › ");
}

export function adaptar(a: Articulo, cfg: NormaConfig): Articulo {
  a.norma_nombre = cfg.nombre;
  if (cfg.principal) return a;
  a.id = `${cfg.prefijo}-${a.id}`;
  a.numero = `${a.numero}, ${cfg.nombre}`;
  a.ruta = [cfg.descripcion ? `${cfg.nombre} (${cfg.descripcion})` : cfg.nombre, ...a.ruta];
  return a;
}

/** Artículos de una norma listos para indexar (aplica soloTransitorios y adaptar). */
export function articulosDeNorma(norma: Norma, cfg: NormaConfig): Articulo[] {
  return norma.articulos.filter((a) => !cfg.soloTransitorios || a.transitorio).map((a) => adaptar(a, cfg));
}

export function chunkArticulo(a: Articulo, maxChars = MAX_CHARS): Chunk[] {
  const encabezado =
    a.norma_nombre === "" || a.norma_nombre === "Código del Trabajo"
      ? `Artículo ${a.numero} del Código del Trabajo. ${a.ruta.join(" › ")}\n`
      : `Artículo ${a.numero}. ${a.ruta.join(" › ")}\n`;
  const grupos: string[][] = [[]];
  let largo = 0;
  for (const inc of a.texto.split("\n\n")) {
    if (grupos[grupos.length - 1].length && largo + inc.length > maxChars) {
      grupos.push([]);
      largo = 0;
    }
    grupos[grupos.length - 1].push(inc);
    largo += inc.length + 2;
  }
  return grupos.map((g, i) => ({ id: `${a.id}#${i}`, articulo_id: a.id, idx: i, texto: encabezado + g.join("\n\n") }));
}

const REF_RE = new RegExp(
  `art[íi]culos?\\s+(\\d{1,3}(?:\\s+(?:bis|ter|qu[áa]ter|quinquies))?)(?![\\p{L}\\p{N}_°º])(?=([\\s\\S]{0,40}))`,
  "giu",
);

export function referenciasAlCodigo(texto: string, idsCodigo: Set<string>, propios: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (const m of texto.matchAll(REF_RE)) {
    if (/^\s*(de la presente ley|de esta ley|transitorio|de la ley|del decreto)/i.test(m[2].toLowerCase())) continue;
    const [, slug] = normalizarNumero(m[1]);
    if (propios.has(slug)) continue;
    if (idsCodigo.has(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

export const fuenteNorma = (id: string) => URL_NORMA(id);
