// Worker de Ley Clara: API + archivos estáticos (web/).
//
//   GET  /api/meta                 fecha de versión de la ley, conteos y modo de búsqueda
//   GET  /api/articulos/:id        texto completo de un artículo
//   GET  /api/search?q=&k=&modo=   búsqueda (fts | vector | hybrid | hybrid_rerank)
//   POST /api/ask {pregunta, modelo?}  respuesta con citas validadas
//   POST /admin/index?offset=&limit=   embebe chunks de D1 y los sube a Vectorize (requiere ADMIN_TOKEN)

import { buscar, embed, obtenerArticulos, type Modo, type SearchEnv } from "./search";
import { generar, MODELO_DEFAULT, MODELO_PRECISO, RESPUESTA_SIN_BASE } from "./generate";

export interface Env extends SearchEnv {
  ASSETS?: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  SEARCH_MODE?: Modo;
  CONTEXT_K?: string;
}

const MODOS: Modo[] = ["fts", "vector", "hybrid", "hybrid_rerank"];
const MAX_PREGUNTA = 500;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function modoPorDefecto(env: Env): Modo {
  if (env.SEARCH_MODE && MODOS.includes(env.SEARCH_MODE)) return env.SEARCH_MODE;
  return env.AI && env.VECTORIZE ? "hybrid" : "fts";
}

async function meta(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta").all<{ key: string; value: string }>();
  return { ...Object.fromEntries(results.map((r) => [r.key, r.value])), modo_busqueda: modoPorDefecto(env) };
}

async function handleSearch(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") || "").slice(0, MAX_PREGUNTA).trim();
  if (!q) return json({ error: "Falta el parámetro q" }, 400);
  const k = Math.min(Math.max(parseInt(url.searchParams.get("k") || "8", 10) || 8, 1), 30);
  const modoParam = url.searchParams.get("modo") as Modo | null;
  const modo = modoParam && MODOS.includes(modoParam) ? modoParam : modoPorDefecto(env);
  const t0 = Date.now();
  const res = await buscar(env, q, { k, modo });
  const arts = await obtenerArticulos(env.DB, res.map((r) => r.articulo_id));
  return json({
    q,
    modo,
    ms: Date.now() - t0,
    resultados: res.map((r) => {
      const a = arts.get(r.articulo_id);
      return { ...r, score: Number.isFinite(r.score) ? r.score : null, numero: a?.numero, ruta: a?.ruta_str, url: a?.url };
    }),
  });
}

async function handleAsk(req: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Falta ANTHROPIC_API_KEY (ver .dev.vars.example)" }, 503);
  let body: { pregunta?: string; modelo?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  const pregunta = (body.pregunta || "").trim();
  if (!pregunta) return json({ error: "Falta la pregunta" }, 400);
  if (pregunta.length > MAX_PREGUNTA) return json({ error: `La pregunta supera ${MAX_PREGUNTA} caracteres` }, 400);
  const modelo = body.modelo === "preciso" ? MODELO_PRECISO : MODELO_DEFAULT;

  const t0 = Date.now();
  const k = parseInt(env.CONTEXT_K || "8", 10);
  const recuperados = await buscar(env, pregunta, { k, modo: modoPorDefecto(env) });
  const arts = await obtenerArticulos(env.DB, recuperados.map((r) => r.articulo_id));
  const articulos = recuperados.map((r) => arts.get(r.articulo_id)!).filter(Boolean);
  const m = await meta(env);

  if (!articulos.length) {
    return json({
      respuesta: RESPUESTA_SIN_BASE,
      citas: [],
      sin_base_legal: true,
      recuperados: [],
      fecha_version: m.fecha_version,
    });
  }

  const g = await generar(env.ANTHROPIC_API_KEY, pregunta, articulos, modelo);
  const porId = new Map(articulos.map((a) => [a.id, a]));
  return json({
    respuesta: g.salida.respuesta,
    sin_base_legal: g.abstencion,
    advertencia: g.advertencia,
    citas: g.salida.citas.map((c) => {
      const a = porId.get(c.articulo_id)!;
      return { ...c, numero: a.numero, ruta: a.ruta_str, url: a.url, fecha_version: a.fecha_version };
    }),
    recuperados: articulos.map((a) => ({ id: a.id, numero: a.numero, ruta: a.ruta_str, url: a.url })),
    fecha_version: m.fecha_version,
    fuente: m.fuente,
    modelo: g.modelo,
    intentos: g.intentos,
    validacion: {
      primer_intento_ok: g.validacion_primer_intento.ok,
      citas_invalidas: g.validacion.citas.filter((c) => !c.valida),
      marcadores_huerfanos: g.validacion.marcadores_huerfanos,
    },
    uso: g.uso,
    ms: Date.now() - t0,
  });
}

async function handleIndex(req: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || req.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "No autorizado" }, 401);
  }
  if (!env.AI || !env.VECTORIZE) return json({ error: "Vectorize/AI no configurados" }, 503);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const { results } = await env.DB.prepare("SELECT id, articulo_id, texto FROM chunks ORDER BY rowid LIMIT ?1 OFFSET ?2")
    .bind(limit, offset)
    .all<{ id: string; articulo_id: string; texto: string }>();
  if (!results.length) return json({ indexados: 0, siguiente: null });
  const vectores = await embed(env.AI, results.map((r) => r.texto));
  await env.VECTORIZE.upsert(
    results.map((r, i) => ({ id: r.id, values: vectores[i], metadata: { articulo_id: r.articulo_id } })),
  );
  return json({ indexados: results.length, dim: vectores[0]?.length, siguiente: offset + results.length });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/meta" && req.method === "GET") return json(await meta(env));
      if (url.pathname === "/api/search" && req.method === "GET") return await handleSearch(url, env);
      if (url.pathname === "/api/ask" && req.method === "POST") return await handleAsk(req, env);
      const art = url.pathname.match(/^\/api\/articulos\/([\w-]+)$/);
      if (art && req.method === "GET") {
        const a = (await obtenerArticulos(env.DB, [art[1]])).get(art[1]);
        return a ? json(a) : json({ error: "Artículo no encontrado" }, 404);
      }
      if (url.pathname === "/admin/index" && req.method === "POST") return await handleIndex(req, url, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "No encontrado" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Error interno", detalle: e instanceof Error ? e.message : String(e) }, 500);
    }
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Ley Clara API", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
