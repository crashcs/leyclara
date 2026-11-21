// Worker de Ley Clara: API + archivos estáticos (web/).
//
//   GET  /api/meta                 fecha de versión de la ley, conteos y modo de búsqueda
//   GET  /api/articulos/:id        texto completo de un artículo
//   GET  /api/search?q=&k=&modo=   búsqueda (fts | vector | hybrid | hybrid_rerank)
//   POST /api/ask {pregunta, modelo?}  respuesta con citas validadas
//   POST /admin/index?offset=&limit=   embebe chunks de D1 y los sube a Vectorize (requiere ADMIN_TOKEN)

import { buscar, embed, obtenerArticulos, type Modo, type SearchEnv } from "./search";
import { generar, MODELO_DEFAULT, MODELO_PRECISO, RESPUESTA_SIN_BASE } from "./generate";
import { normalizar } from "./textnorm";

export interface Env extends SearchEnv {
  ASSETS?: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  SEARCH_MODE?: Modo;
  CONTEXT_K?: string;
  /** Rate limiting por IP (binding "ratelimits"); si no existe, no se limita. */
  RATE_LIMITER?: RateLimit;
  /** Horas que se cachea una respuesta a la misma pregunta (0 = sin caché). */
  CACHE_HORAS?: string;
}

async function limitado(env: Env, req: Request, prefijo: string): Promise<boolean> {
  if (!env.RATE_LIMITER) return false;
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.RATE_LIMITER.limit({ key: `${prefijo}:${ip}` });
  return !success;
}

function respuestaLimitada(): Response {
  return new Response(JSON.stringify({ error: "Demasiadas preguntas seguidas. Espera un minuto e intenta de nuevo." }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60" },
  });
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

async function handleSearch(req: Request, url: URL, env: Env): Promise<Response> {
  if (await limitado(env, req, "search")) return respuestaLimitada();
  const q = (url.searchParams.get("q") || "").slice(0, MAX_PREGUNTA).trim();
  if (!q) return json({ error: "Falta el parámetro q" }, 400);
  const k = Math.min(Math.max(parseInt(url.searchParams.get("k") || "8", 10) || 8, 1), 30);
  const modoParam = url.searchParams.get("modo") as Modo | null;
  const modo = modoParam && MODOS.includes(modoParam) ? modoParam : modoPorDefecto(env);
  const t0 = Date.now();
  const pesoParam = url.searchParams.get("peso_fts");
  const pesoFts = pesoParam !== null && !Number.isNaN(parseFloat(pesoParam)) ? parseFloat(pesoParam) : undefined;
  const res = await buscar(env, q, { k, modo, pesoFts });
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

async function handleAsk(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // Caché de preguntas repetidas (la clave incluye la versión de la ley y el modelo).
  const horas = parseFloat(env.CACHE_HORAS ?? "24");
  const m0 = await meta(env);
  const cacheKey = new Request(
    `https://cache.leyclara.internal/ask?v=${encodeURIComponent(m0.fecha_version ?? "")}&m=${modelo}&q=${encodeURIComponent(normalizar(pregunta))}`,
  );
  const cache = horas > 0 && typeof caches !== "undefined" ? caches.default : undefined;
  const enCache = cache ? await cache.match(cacheKey) : undefined;
  if (enCache) {
    const r = new Response(enCache.body, enCache);
    r.headers.set("x-cache", "HIT");
    r.headers.set("cache-control", "no-store");
    return r;
  }
  if (await limitado(env, req, "ask")) return respuestaLimitada();

  const t0 = Date.now();
  const k = parseInt(env.CONTEXT_K || "8", 10);
  const recuperados = await buscar(env, pregunta, { k, modo: modoPorDefecto(env) });
  const arts = await obtenerArticulos(env.DB, recuperados.map((r) => r.articulo_id));
  const articulos = recuperados.map((r) => arts.get(r.articulo_id)!).filter(Boolean);
  const m = m0;

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
  const resp = json({
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
  if (cache) {
    const paraCache = resp.clone();
    const h = new Headers(paraCache.headers);
    h.set("cache-control", `public, max-age=${Math.round(horas * 3600)}`);
    ctx.waitUntil(cache.put(cacheKey, new Response(paraCache.body, { status: 200, headers: h })));
  }
  return resp;
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

const ES_LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Encabezados de seguridad para todas las respuestas en producción. */
function conSeguridad(res: Response): Response {
  const r = new Response(res.body, res);
  r.headers.set("Strict-Transport-Security", "max-age=31536000");
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return r;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (ES_LOCAL.has(url.hostname)) return manejar(req, url, env, ctx);
    // Fuera de local, todo va por HTTPS (si no, el navegador marca el sitio como "no seguro").
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return conSeguridad(await manejar(req, url, env, ctx));
  },
} satisfies ExportedHandler<Env>;

async function manejar(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (url.pathname === "/api/meta" && req.method === "GET") return json(await meta(env));
      if (url.pathname === "/api/search" && req.method === "GET") return await handleSearch(req, url, env);
      if (url.pathname === "/api/ask" && req.method === "POST") return await handleAsk(req, env, ctx);
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
}
