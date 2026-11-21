import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NORMAS, calendarioTexto } from "../src/normas";

const cal = NORMAS.find((n) => n.calendario)!.calendario!;

describe("calendario de la Ley 21.561", () => {
  it("noviembre de 2026: rigen 42 horas y el próximo cambio es el 26-04-2028", () => {
    const t = calendarioTexto(cal, "2026-11-21");
    expect(t).toContain("Desde el 26-04-2026: 42 horas  <- RIGE HOY");
    expect(t).toContain("Próximo cambio: 26-04-2028, a 40 horas.");
    expect(t.match(/RIGE HOY/g)).toHaveLength(1);
  });
  it("antes de la primera etapa rigen 45 horas", () => {
    expect(calendarioTexto(cal, "2024-01-10")).toContain("Antes del 26-04-2024: 45 horas  <- RIGE HOY");
  });
  it("el mismo día del cambio ya rige la nueva cifra", () => {
    expect(calendarioTexto(cal, "2028-04-26")).toContain("Desde el 26-04-2028: 40 horas  <- RIGE HOY");
    expect(calendarioTexto(cal, "2028-04-26")).not.toContain("Próximo cambio");
  });

  const json = resolve(__dirname, "../../data/build/articulos.json");
  it.skipIf(!existsSync(json))("coincide con el texto del artículo primero transitorio (publicación 26-04-2023 + 1, 3 y 5 años)", () => {
    const a = JSON.parse(readFileSync(json, "utf8")).articulos.find((x: any) => x.id === "l21561-t-primero");
    expect(a.texto).toContain("cuarenta y cuatro horas al primer año; cuarenta y dos horas al tercer año y cuarenta horas al quinto año, contados desde la publicación");
    expect(cal.etapas.map((e) => e.desde)).toEqual(["2024-04-26", "2026-04-26", "2028-04-26"]);
  });
});
