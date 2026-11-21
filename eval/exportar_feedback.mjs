// Exporta las valoraciones (👍/👎) guardadas en D1 y prepara candidatas para el
// set de evaluación.
//
// Uso:
//   node eval/exportar_feedback.mjs                 # D1 remota (producción)
//   node eval/exportar_feedback.mjs --local         # D1 local de `wrangler dev`
//   node eval/exportar_feedback.mjs --desde 2026-11-01
//
// Salidas:
//   eval/feedback/resumen.json     conteos por día y tasa de 👍
//   eval/feedback/candidatas.jsonl preguntas marcadas con 👎 que aún no están en
//                                  eval/preguntas.jsonl, listas para revisar: hay que
//                                  completar "esperados" (ids de artículos) o marcar
//                                  "tipo": "fuera_de_alcance", y luego moverlas a mano.
//
// Las preguntas pueden traer datos personales: revisa candidatas.jsonl antes de
// copiar nada al repositorio (eval/feedback/ está en .gitignore).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const local = args.includes("--local");
const desde = args[args.indexOf("--desde") + 1] && args.includes("--desde") ? args[args.indexOf("--desde") + 1] : "2000-01-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error("--desde debe ser AAAA-MM-DD");

// Wrangler se ejecuta con Node directamente (sin shell): en Windows, npx.cmd con
// shell partiría la consulta SQL en palabras.
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function consultar(sql) {
  const salida = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "leyclara", local ? "--local" : "--remote", "--env=", "--json", "--command", sql],
    { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first` } },
  );
  const json = JSON.parse(salida.slice(salida.indexOf("[")));
  return json[0]?.results ?? [];
}

const normalizar = (s) =>
  s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();

const filas = consultar(
  `SELECT id, creado, pregunta, util, citas, abstencion, huella FROM feedback WHERE creado >= '${desde}' ORDER BY creado`,
);

// Resumen
const porDia = {};
for (const f of filas) {
  const d = f.creado.slice(0, 10);
  porDia[d] ??= { utiles: 0, no_utiles: 0 };
  porDia[d][f.util ? "utiles" : "no_utiles"]++;
}
const utiles = filas.filter((f) => f.util).length;
const resumen = {
  fuente: local ? "D1 local" : "D1 remota",
  desde,
  total: filas.length,
  utiles,
  no_utiles: filas.length - utiles,
  tasa_utiles: filas.length ? Math.round((utiles / filas.length) * 1000) / 10 : null,
  abstenciones_valoradas: filas.filter((f) => f.abstencion).length,
  por_dia: porDia,
};

// Candidatas: 👎 que no estén ya en el set (comparación sin tildes ni signos)
const enSet = new Set(
  readFileSync(new URL("./preguntas.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => normalizar(JSON.parse(l).pregunta)),
);
const vistas = new Set();
const candidatas = [];
for (const f of filas.filter((x) => !x.util)) {
  const clave = normalizar(f.pregunta);
  if (enSet.has(clave) || vistas.has(clave)) continue;
  vistas.add(clave);
  candidatas.push({
    pregunta: f.pregunta,
    tipo: "en_alcance",
    esperados: [],
    _citadas_por_la_app: JSON.parse(f.citas || "[]"),
    _abstencion: !!f.abstencion,
    _fecha: f.creado.slice(0, 10),
    _feedback_id: f.id,
  });
}

mkdirSync(new URL("./feedback/", import.meta.url), { recursive: true });
writeFileSync(new URL("./feedback/resumen.json", import.meta.url), JSON.stringify(resumen, null, 2));
writeFileSync(new URL("./feedback/candidatas.jsonl", import.meta.url), candidatas.map((c) => JSON.stringify(c)).join("\n") + (candidatas.length ? "\n" : ""));

console.log(resumen);
console.log(`\n${candidatas.length} candidatas nuevas en eval/feedback/candidatas.jsonl`);
if (candidatas.length) console.log("Completa 'esperados' (o marca fuera_de_alcance), quita los campos _* y agrégalas a eval/preguntas.jsonl.");
