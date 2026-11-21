// Paridad entre el parser de TypeScript (usado por la revisión diaria del Worker)
// y el de Python (ingesta). Usa los XML reales de data/raw y la salida de
// `python -m leyclara.build` en data/build; si no existen, los tests se saltan.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NORMAS } from "../src/normas";
import {
  articulosDeNorma,
  chunkArticulo,
  fechaVersionXml,
  limpiarTexto,
  normalizarNumero,
  parseNorma,
  referenciasAlCodigo,
  rutaStr,
} from "../src/parser";

const raiz = resolve(__dirname, "../..");
const xmlDe = (id: string) =>
  resolve(raiz, "data/raw", id === "207436" ? "codigo-trabajo-207436.xml" : `norma-${id}.xml`);
const build = resolve(raiz, "data/build");
const hayDatos = NORMAS.every((n) => existsSync(xmlDe(n.id))) && existsSync(resolve(build, "articulos.json"));

describe("parser.ts (unidades)", () => {
  it("quita notas al margen como Python", () => {
    const raw =
      "     Art. 126. En los casos de enfermedad, todo el personal         L. 18.620\n" +
      "de dotación será asistido por cuenta del armador durante            ART. PRIMERO\n" +
      "su permanencia a bordo.                                             Art. 123\n" +
      "     Cuando la enfermedad no se halle comprendida.\n";
    expect(limpiarTexto(raw).split("\n\n")).toEqual([
      "Art. 126. En los casos de enfermedad, todo el personal de dotación será asistido por cuenta del armador durante su permanencia a bordo.",
      "Cuando la enfermedad no se halle comprendida.",
    ]);
  });
  it.each([
    ["40 bis e", "40 bis E", "40-bis-e"],
    ["18 QUÁTER", "18 quáter", "18-quater"],
    ["183 Ñ", "183 Ñ", "183-nn"],
    ["primero", "primero", "primero"],
  ])("normalizarNumero(%s)", (raw, numero, slug) => {
    expect(normalizarNumero(raw)).toEqual([numero, slug]);
  });
  it("lee la fecha de versión del comienzo del XML", () => {
    expect(fechaVersionXml('<?xml version="1.0"?><Norma xmlns="x" normaId="1" fechaVersion="2026-07-23" derogado="no">')).toBe(
      "2026-07-23",
    );
  });
});

describe.skipIf(!hayDatos)("paridad con la ingesta de Python", () => {
  const py = JSON.parse(readFileSync(resolve(build, "articulos.json"), "utf8"));
  const pyChunks: { id: string; texto: string }[] = JSON.parse(readFileSync(resolve(build, "chunks.json"), "utf8"));
  const ts = NORMAS.flatMap((cfg) => articulosDeNorma(parseNorma(readFileSync(xmlDe(cfg.id), "utf8")), cfg));

  it("mismos artículos, en el mismo orden", () => {
    expect(ts.map((a) => a.id)).toEqual(py.articulos.map((a: any) => a.id));
  });

  it("mismos campos en cada artículo", () => {
    const campos = ["numero", "transitorio", "derogado", "fecha_version", "id_parte", "url", "ruta", "texto", "norma", "norma_nombre"];
    for (let i = 0; i < ts.length; i++) {
      for (const c of campos) expect((ts[i] as any)[c], `${ts[i].id}.${c}`).toEqual(py.articulos[i][c]);
      expect(rutaStr(ts[i]), `${ts[i].id}.ruta_str`).toBe(py.articulos[i].ruta_str);
    }
  });

  it("mismos chunks", () => {
    const tsChunks = ts.filter((a) => !a.derogado).flatMap((a) => chunkArticulo(a));
    expect(tsChunks.map((c) => c.id)).toEqual(pyChunks.map((c) => c.id));
    for (let i = 0; i < tsChunks.length; i++) expect(tsChunks[i].texto, tsChunks[i].id).toBe(pyChunks[i].texto);
  });

  it("mismas relaciones", () => {
    const seed = readFileSync(resolve(build, "seed.sql"), "utf8");
    const pyRel = [...seed.matchAll(/INSERT OR IGNORE INTO relaciones \(articulo_id, relacionado_id\) VALUES \('([^']+)', '([^']+)'\)/g)].map(
      (m) => `${m[1]}>${m[2]}`,
    );
    const idsCodigo = new Set(ts.filter((a) => a.norma === "207436" && !a.derogado).map((a) => a.id));
    const tsRel: string[] = [];
    for (const cfg of NORMAS.filter((n) => !n.principal)) {
      const norma = parseNorma(readFileSync(xmlDe(cfg.id), "utf8"));
      const propios = new Set(norma.articulos.filter((a) => !a.transitorio).map((a) => a.id));
      for (const a of ts.filter((x) => x.norma === cfg.id && !x.derogado)) {
        for (const ref of referenciasAlCodigo(a.texto, idsCodigo, propios)) tsRel.push(`${ref}>${a.id}`);
      }
    }
    expect(tsRel).toEqual(pyRel);
  });
});
