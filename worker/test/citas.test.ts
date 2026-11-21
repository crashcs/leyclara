import { describe, expect, it } from "vitest";
import { fragmentoEnTexto, marcadores, numeroASlug, validarCitas } from "../src/citas";

const recuperados = new Map([
  ["67", { numero: "67", texto: "Art. 67. Los trabajadores con más de un año de servicio tendrán derecho a un feriado anual de quince días hábiles, con remuneración íntegra." }],
  ["152-quater-j", { numero: "152 quáter J", texto: "Artículo 152 quáter J.- La modalidad de trabajo a distancia o teletrabajo podrá abarcar todo o parte de la jornada laboral." }],
]);

describe("fragmentoEnTexto", () => {
  it("tolera tildes, mayúsculas y espacios", () => {
    expect(fragmentoEnTexto("feriado anual de QUINCE dias  habiles", recuperados.get("67")!.texto)).toBe(true);
  });
  it("rechaza paráfrasis y fragmentos muy cortos", () => {
    expect(fragmentoEnTexto("vacaciones de quince días", recuperados.get("67")!.texto)).toBe(false);
    expect(fragmentoEnTexto("feriado", recuperados.get("67")!.texto)).toBe(false);
  });
});

describe("marcadores y slugs", () => {
  it("extrae marcadores", () => {
    expect(marcadores("Tienes 15 días [Art. 67]. En teletrabajo [Art. 152 quáter J] y [Artículo 23 transitorio].")).toEqual([
      "67",
      "152 quáter J",
      "23 transitorio",
    ]);
  });
  it.each([
    ["67", "67"],
    ["152 quáter J", "152-quater-j"],
    ["40 bis E", "40-bis-e"],
    ["183 Ñ", "183-nn"],
    ["23 transitorio", "t-23"],
  ])("%s -> %s", (n, s) => expect(numeroASlug(n)).toBe(s));
});

describe("validarCitas", () => {
  it("acepta citas recuperadas con fragmento textual", () => {
    const v = validarCitas(
      { respuesta: "Tienes 15 días hábiles [Art. 67].", citas: [{ articulo_id: "67", fragmento: "feriado anual de quince días hábiles" }], sin_base_legal: false },
      recuperados,
    );
    expect(v.ok).toBe(true);
  });
  it("rechaza artículos no recuperados, fragmentos inventados y marcadores huérfanos", () => {
    const v = validarCitas(
      {
        respuesta: "Tienes 15 días [Art. 67] y 5 más [Art. 68].",
        citas: [
          { articulo_id: "67", fragmento: "tendrás vacaciones pagadas siempre" },
          { articulo_id: "68", fragmento: "un día adicional de feriado por cada tres nuevos años" },
        ],
        sin_base_legal: false,
      },
      recuperados,
    );
    expect(v.ok).toBe(false);
    expect(v.citas.map((c) => c.motivo)).toEqual(["fragmento_no_encontrado", "no_recuperado"]);
    expect(v.marcadores_huerfanos).toEqual(["67", "68"]);
  });
});
