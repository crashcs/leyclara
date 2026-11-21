import { describe, expect, it } from "vitest";
import cases from "../../shared/textnorm_cases.json";
import { normalizar, tokens } from "../src/textnorm";

describe("textnorm (espejo de ingest/leyclara/textnorm.py)", () => {
  it("normaliza", () => {
    expect(normalizar("¿Cuántos DÍAS?  Ñandú")).toBe("cuantos dias nandu");
  });
  it("coincide con Python en frases", () => {
    for (const f of cases.frases) expect(tokens(f.input)).toEqual(f.tokens);
  });
  it("coincide con Python en el vocabulario de muestra", () => {
    for (const [w, t] of Object.entries(cases.palabras)) expect(tokens(w), w).toEqual(t);
  });
});
