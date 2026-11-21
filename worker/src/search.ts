// Búsqueda híbrida: FTS5 (D1) + vectores (Vectorize, bge-m3) + fusión RRF +
// re-ranking opcional con un cross-encoder de Workers AI.

import { tokens } from "./textnorm";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

export type Modo = "fts" | "vector" | "hybrid" | "hybrid_rerank";

export interface SearchEnv {
  DB: D1Database;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
}

export interface ArticuloRow {
  id: string;
  numero: string;
  transitorio: number;
  derogado: number;
  fecha_version: string;
  url: string;
  ruta_str: string;
  texto: string;
}

export interface Resultado {
  articulo_id: string;
  score: number;
  fuentes: { fts?: number; vector?: number; ref?: true; rerank?: number };
}

const RRF_K = 60;
const CANDIDATOS = 30;

/** Detecta referencias explícitas: "artículo 67", "art. 161 bis", "art 152 quáter J". */
export function referenciasExplicitas(q: string): string[] {
  const re =
    /(?<![\p{L}\d])art(?:[íi]culo|s?\.)?\s*(\d{1,3})(?:\s*[°ºo]\.?)?((?:\s*-?\s*(?:bis|ter|qu[áa]ter|quinquies|sexies))*)(?:\s*-?\s*([a-zñ])(?![\p{L}\d]))?/giu;
  const out: string[] = [];
  for (const m of q.matchAll(re)) {
    const sufijos = (m[2] || "")
      .toLowerCase()
      .replace(/á/g, "a")
      .split(/[\s-]+/)
      .filter(Boolean);
    let letra = (m[3] || "").toLowerCase();
    // evita tomar la preposición "a"/"y"/"o" como letra del artículo
    if (["a", "y", "o", "e", "u"].includes(letra) && !/[A-ZÑ]/.test(m[3] || "")) letra = "";
    if (letra === "ñ") letra = "nn";
    out.push([m[1], ...sufijos, ...(letra ? [letra] : [])].join("-"));
  }
  return [...new Set(out)];
}

/** Construye la consulta MATCH de FTS5 a partir de la pregunta. */
export function ftsQuery(q: string): string | null {
  const toks = [...new Set(tokens(q))].filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  if (!toks.length) return null;
  // prefijo (*) porque el stemmer es ligero: "despid" calza "despido"/"despidos"
  return toks.map((t) => `"${t}"*`).join(" OR ");
}

export async function buscarFts(db: D1Database, q: string, limit = CANDIDATOS): Promise<string[]> {
  const match = ftsQuery(q);
  if (!match) return [];
  const { results } = await db
    .prepare(
      `SELECT articulo_id, MIN(s) AS s FROM (
         SELECT articulo_id, bm25(chunks_fts, 0, 0, 1.0, 0.4) AS s
         FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY s LIMIT 200
       ) GROUP BY articulo_id ORDER BY s LIMIT ?2`,
    )
    .bind(match, limit)
    .all<{ articulo_id: string; s: number }>();
  return results.map((r) => r.articulo_id);
}

export async function embed(ai: Ai, textos: string[]): Promise<number[][]> {
  const out = (await ai.run(EMBEDDING_MODEL as any, { text: textos } as any)) as any;
  const data = out?.data ?? out?.response;
  if (!Array.isArray(data)) throw new Error("Respuesta de embeddings inesperada");
  return data as number[][];
}

export async function buscarVector(env: SearchEnv, q: string, limit = CANDIDATOS): Promise<string[]> {
  if (!env.AI || !env.VECTORIZE) throw new Error("Vectorize/AI no configurados");
  const [vec] = await embed(env.AI, [q]);
  const res = await env.VECTORIZE.query(vec, { topK: Math.min(limit * 2, 100), returnMetadata: "none" });
  const ids: string[] = [];
  for (const m of res.matches) {
    const art = m.id.split("#")[0];
    if (!ids.includes(art)) ids.push(art);
    if (ids.length >= limit) break;
  }
  return ids;
}

export function rrf(listas: Record<string, string[]>, k = RRF_K): Resultado[] {
  const acc = new Map<string, Resultado>();
  for (const [fuente, ids] of Object.entries(listas)) {
    ids.forEach((id, i) => {
      const r = acc.get(id) ?? { articulo_id: id, score: 0, fuentes: {} };
      r.score += 1 / (k + i + 1);
      (r.fuentes as any)[fuente] = i + 1;
      acc.set(id, r);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

export async function obtenerArticulos(db: D1Database, ids: string[]): Promise<Map<string, ArticuloRow>> {
  const map = new Map<string, ArticuloRow>();
  if (!ids.length) return map;
  const ph = ids.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await db
    .prepare(
      `SELECT id, numero, transitorio, derogado, fecha_version, url, ruta_str, texto FROM articulos WHERE id IN (${ph})`,
    )
    .bind(...ids)
    .all<ArticuloRow>();
  for (const r of results) map.set(r.id, r);
  return map;
}

async function rerank(ai: Ai, q: string, cands: Resultado[], textos: Map<string, ArticuloRow>): Promise<Resultado[]> {
  const contexts = cands.map((c) => {
    const a = textos.get(c.articulo_id);
    return { text: a ? `${a.ruta_str}\n${a.texto}`.slice(0, 2000) : c.articulo_id };
  });
  const out = (await ai.run(RERANK_MODEL as any, { query: q, contexts, top_k: cands.length } as any)) as any;
  const scores: { id: number; score: number }[] = out?.response ?? [];
  const res = scores
    .filter((s) => cands[s.id])
    .map((s) => ({ ...cands[s.id], score: s.score, fuentes: { ...cands[s.id].fuentes, rerank: s.score } }));
  return res.sort((a, b) => b.score - a.score);
}

export interface SearchOptions {
  k?: number;
  modo?: Modo;
}

export async function buscar(env: SearchEnv, q: string, opts: SearchOptions = {}): Promise<Resultado[]> {
  const k = opts.k ?? 8;
  const modo: Modo = opts.modo ?? (env.VECTORIZE && env.AI ? "hybrid" : "fts");
  const refs = referenciasExplicitas(q);

  let fusion: Resultado[];
  if (modo === "fts") {
    fusion = rrf({ fts: await buscarFts(env.DB, q) });
  } else if (modo === "vector") {
    fusion = rrf({ vector: await buscarVector(env, q) });
  } else {
    const [fts, vector] = await Promise.all([buscarFts(env.DB, q), buscarVector(env, q)]);
    fusion = rrf({ fts, vector });
  }

  // Las referencias explícitas ("artículo 67") van primero si existen.
  if (refs.length) {
    const existentes = await obtenerArticulos(env.DB, refs);
    const ref = refs.filter((id) => existentes.has(id));
    fusion = [
      ...ref.map((id) => ({ articulo_id: id, score: Infinity, fuentes: { ref: true as const } })),
      ...fusion.filter((r) => !ref.includes(r.articulo_id)),
    ];
  }

  if (modo === "hybrid_rerank" && env.AI) {
    const nRef = fusion.filter((r) => r.fuentes.ref).length;
    const pool = fusion.slice(nRef, nRef + 20);
    const textos = await obtenerArticulos(env.DB, pool.map((p) => p.articulo_id));
    const rer = await rerank(env.AI, q, pool, textos);
    fusion = [...fusion.slice(0, nRef), ...rer];
  }
  return fusion.slice(0, k);
}
