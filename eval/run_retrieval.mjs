// Evalúa la recuperación contra eval/preguntas.jsonl usando la API del Worker
// (`wrangler dev`), es decir, el mismo código que corre en producción.
//
// Uso: node eval/run_retrieval.mjs [--modos fts,vector,hybrid,hybrid_rerank] [--base http://localhost:8787]
//
// Métricas (solo preguntas "en_alcance"):
//   hit@k     : % de preguntas con al menos un artículo esperado entre los k primeros
//   recall@k  : promedio de (artículos esperados encontrados en top-k / artículos esperados)
//   MRR@10    : promedio de 1/rango del primer artículo esperado

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const BASE = args.base || "http://localhost:8787";
// Un modo puede llevar peso FTS: "hybrid@0.3"
const MODOS = (args.modos || "fts").split(",");
const preguntas = readFileSync(new URL("./preguntas.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((p) => p.tipo === "en_alcance");

async function buscar(q, modoSpec) {
  const [modo, peso] = modoSpec.split("@");
  const cuerpo = { q, k: 10, modo, expandir: args.expandir !== "0", ...(peso !== undefined ? { peso_fts: parseFloat(peso) } : {}) };
  const r = await fetch(`${BASE}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()).resultados.map((x) => x.articulo_id);
}

const pct = (x) => Math.round(x * 1000) / 10;
const informe = { fecha: new Date().toISOString(), n: preguntas.length, modos: {} };

for (const modo of MODOS) {
  const filas = [];
  for (const p of preguntas) {
    const ids = await buscar(p.pregunta, modo);
    const rango = ids.findIndex((id) => p.esperados.includes(id));
    const rec = (k) => p.esperados.filter((e) => ids.slice(0, k).includes(e)).length / p.esperados.length;
    filas.push({ id: p.id, pregunta: p.pregunta, esperados: p.esperados, top5: ids.slice(0, 5), rango: rango + 1, rec1: rec(1), rec5: rec(5), rec10: rec(10) });
  }
  const prom = (f) => filas.reduce((s, x) => s + f(x), 0) / filas.length;
  const m = {
    "hit@1": pct(prom((x) => (x.rango === 1 ? 1 : 0))),
    "hit@5": pct(prom((x) => (x.rango >= 1 && x.rango <= 5 ? 1 : 0))),
    "hit@10": pct(prom((x) => (x.rango >= 1 ? 1 : 0))),
    "recall@5": pct(prom((x) => x.rec5)),
    "recall@10": pct(prom((x) => x.rec10)),
    "MRR@10": Math.round(prom((x) => (x.rango >= 1 ? 1 / x.rango : 0)) * 1000) / 1000,
  };
  informe.modos[modo] = { metricas: m, fallos: filas.filter((x) => !(x.rango >= 1 && x.rango <= 5)) };
  console.log(`\n== ${modo} ==`, m);
  for (const f of informe.modos[modo].fallos) console.log(`  x ${f.id} esperado ${f.esperados.join("/")} -> top5 ${f.top5.join(", ")} | ${f.pregunta}`);
}

mkdirSync(new URL("./resultados/", import.meta.url), { recursive: true });
const salida = args.salida || "retrieval.json";
writeFileSync(new URL(`./resultados/${salida}`, import.meta.url), JSON.stringify(informe, null, 2));
console.log(`\nGuardado en eval/resultados/${salida}`);
