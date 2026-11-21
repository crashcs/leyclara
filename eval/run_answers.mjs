// Evalúa las respuestas completas (recuperación + LLM + validación de citas)
// llamando a POST /api/ask del Worker.
//
// Uso: node eval/run_answers.mjs [--base http://localhost:8787] [--modelo rapido|preciso] [--limite N]
//
// Métricas:
//   exactitud de citas (precisión) : citas válidas / citas emitidas por el LLM (antes de filtrar),
//                                    válida = artículo recuperado + fragmento textual presente en el artículo
//   citas correctas                : % de respuestas en alcance que citan al menos un artículo esperado
//   respuestas con cita válida     : % de respuestas en alcance que no se abstuvieron y tienen ≥1 cita verificada
//   abstención correcta            : % de preguntas fuera de alcance donde respondió "sin base legal"
//   abstención indebida            : % de preguntas en alcance donde se abstuvo
//   primer intento ok              : % de respuestas que pasaron la validación sin reintento

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const BASE = args.base || "http://localhost:8787";
const MODELO = args.modelo || "rapido";
let preguntas = readFileSync(new URL("./preguntas.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (args.limite) preguntas = preguntas.slice(0, parseInt(args.limite, 10));

async function preguntar(pregunta) {
  for (let intento = 0; intento < 3; intento++) {
    const r = await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pregunta, modelo: MODELO }),
    });
    if (r.ok) return r.json();
    if (r.status === 429) {
      // límite por IP del Worker: esperar lo que indique retry-after
      const s = parseInt(r.headers.get("retry-after") || "60", 10);
      await new Promise((res) => setTimeout(res, (s + 1) * 1000));
      intento--;
      continue;
    }
    if (r.status < 500) throw new Error(`${r.status} ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 2000 * (intento + 1)));
  }
  throw new Error("Falló 3 veces");
}

const filas = [];
for (const p of preguntas) {
  const r = await preguntar(p.pregunta);
  const invalidas = r.validacion?.citas_invalidas ?? [];
  const validas = r.citas ?? [];
  const fila = {
    id: p.id,
    tipo: p.tipo,
    pregunta: p.pregunta,
    esperados: p.esperados,
    abstencion: r.sin_base_legal,
    citas: validas.map((c) => c.articulo_id),
    citas_invalidas: invalidas.map((c) => `${c.articulo_id}:${c.motivo}`),
    recuperado_esperado: p.esperados.some((e) => (r.recuperados ?? []).some((x) => x.id === e)),
    cita_esperada: p.esperados.some((e) => validas.some((c) => c.articulo_id === e)),
    primer_intento_ok: r.validacion?.primer_intento_ok ?? true,
    intentos: r.intentos ?? 0,
    advertencia: r.advertencia ?? null,
    respuesta: r.respuesta,
    uso: r.uso,
    ms: r.ms,
  };
  filas.push(fila);
  const marca = p.tipo === "fuera_de_alcance" ? (fila.abstencion ? "ok" : "XX") : fila.cita_esperada ? "ok" : fila.abstencion ? "ab" : "--";
  console.log(`${marca} ${p.id} citas=[${fila.citas.join(",")}] inval=[${fila.citas_invalidas.join(",")}] ${p.pregunta}`);
}

const en = filas.filter((f) => f.tipo === "en_alcance");
const fuera = filas.filter((f) => f.tipo === "fuera_de_alcance");
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const totalValidas = filas.reduce((s, f) => s + f.citas.length, 0);
const totalInvalidas = filas.reduce((s, f) => s + f.citas_invalidas.length, 0);
const metricas = {
  modelo: MODELO,
  n_en_alcance: en.length,
  n_fuera_de_alcance: fuera.length,
  exactitud_citas: pct(totalValidas, totalValidas + totalInvalidas),
  citas_emitidas: totalValidas + totalInvalidas,
  respuestas_con_cita_esperada: pct(en.filter((f) => f.cita_esperada).length, en.length),
  respuestas_con_cita_esperada_si_recuperado: pct(
    en.filter((f) => f.cita_esperada && f.recuperado_esperado).length,
    en.filter((f) => f.recuperado_esperado).length,
  ),
  respuestas_con_cita_valida: pct(en.filter((f) => !f.abstencion && f.citas.length > 0).length, en.length),
  abstencion_correcta: pct(fuera.filter((f) => f.abstencion).length, fuera.length),
  abstencion_indebida: pct(en.filter((f) => f.abstencion).length, en.length),
  primer_intento_ok: pct(filas.filter((f) => f.primer_intento_ok).length, filas.length),
  tokens_entrada: filas.reduce((s, f) => s + (f.uso?.input_tokens ?? 0), 0),
  tokens_salida: filas.reduce((s, f) => s + (f.uso?.output_tokens ?? 0), 0),
  latencia_mediana_ms: filas.map((f) => f.ms ?? 0).sort((a, b) => a - b)[Math.floor(filas.length / 2)],
};
console.log("\n", metricas);
mkdirSync(new URL("./resultados/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(`./resultados/answers-${MODELO}.json`, import.meta.url),
  JSON.stringify({ fecha: new Date().toISOString(), metricas, filas }, null, 2),
);
console.log(`Guardado en eval/resultados/answers-${MODELO}.json`);
