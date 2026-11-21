import { describe, expect, it } from "vitest";
import { mensajeAlerta } from "../src/index";

describe("mensajeAlerta", () => {
  it("no avisa si nada cambió", () => {
    expect(mensajeAlerta({ revisado: "x", normas: [{ norma: "Código del Trabajo", estado: "sin_cambios" }] })).toBeNull();
  });
  it("resume actualizaciones, pendientes y errores", () => {
    const m = mensajeAlerta({
      revisado: "x",
      normas: [
        { norma: "Código del Trabajo", estado: "actualizada", fecha_version: "2027-03-15", anterior: "2026-07-23", nuevos: 1, modificados: 3, eliminados: 0 },
        { norma: "Ley 21.561", estado: "pendiente", error: "429" },
      ],
    })!;
    expect(m).toContain("Código del Trabajo: nueva versión 2027-03-15 (antes 2026-07-23). 1 nuevos, 3 modificados, 0 eliminados.");
    expect(m).toContain("Ley 21.561: hay versión nueva pero no se pudo descargar el XML (429)");
  });
});
