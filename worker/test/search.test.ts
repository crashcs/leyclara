import { describe, expect, it } from "vitest";
import { ftsQuery, referenciasExplicitas, rrf } from "../src/search";

describe("referenciasExplicitas", () => {
  it.each([
    ["¿Qué dice el artículo 67?", ["67"]],
    ["art. 161 y art 163", ["161", "163"]],
    ["Artículo 152 quáter J del código", ["152-quater-j"]],
    ["el art. 40 bis E", ["40-bis-e"]],
    ["artículo 183-Ñ", ["183-nn"]],
    ["artículo 159 a plazo fijo", ["159"]],
    ["¿cuántos días de vacaciones?", []],
  ])("%s", (q, esperado) => {
    expect(referenciasExplicitas(q)).toEqual(esperado);
  });
});

describe("ftsQuery", () => {
  it("usa tokens stemmeados con prefijo y descarta números y stopwords", () => {
    expect(ftsQuery("¿Me pueden despedir con licencia médica?")).toBe('"pueden"* OR "despedir"* OR "licenci"* OR "medic"*');
    expect(ftsQuery("¿y?")).toBeNull();
  });
});

describe("rrf", () => {
  it("premia lo que aparece en ambas listas", () => {
    const r = rrf({ fts: ["a", "b", "c"], vector: ["c", "a", "d"] });
    expect(r.map((x) => x.articulo_id)).toEqual(["a", "c", "b", "d"]);
    expect(r[0].fuentes).toEqual({ fts: 1, vector: 2 });
  });
});
