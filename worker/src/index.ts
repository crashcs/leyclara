// Worker de Ley Clara: API + archivos estáticos (web/).
//
//   GET  /api/meta                  versión de la ley, normas, última revisión y configuración pública
//   GET  /api/articulos/:id         texto completo de un artículo
//   POST /api/search {q, k?, modo?, peso_fts?}   búsqueda (fts | vector | hybrid | hybrid_rerank)
//   POST /api/ask {pregunta, turnstile?}         respuesta con citas validadas
//   POST /api/feedback {pregunta, util, citas, abstencion}   valoración anónima de una respuesta
//   POST /admin/index?offset=&limit=&faltantes=1 embebe chunks y los sube a Vectorize (ADMIN_TOKEN)
//   POST /admin/revisar?forzar=1    ejecuta la revisión de Ley Chile (ADMIN_TOKEN)
//
// Las preguntas nunca van en la URL: así no quedan en los logs de Cloudflare.

import { buscar, obtenerArticulos, type Modo, type SearchEnv } from "./search";
import { fechaChile, generar, MODELO_DEFAULT, MODELO_PRECISO, RESPUESTA_SIN_BASE, SYSTEM_PROMPT } from "./generate";
import { normalizar } from "./textnorm";
import { indexarChunks, revisarNormas, type Informe } from "./actualizar";
import { NORMAS } from "./normas";

/** Huella del prompt y de las normas: si cambian, las respuestas cacheadas dejan de servirse. */
const HUELLA = (() => {
  let h = 0x811c9dc5;
  for (const ch of SYSTEM_PROMPT + JSON.stringify(NORMAS)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
})();

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
  /** Tope global de preguntas nuevas (no cacheadas) por día. */
  MAX_PREGUNTAS_DIA?: string;
  /** Cloudflare Turnstile: si ambos existen, /api/ask exige un token válido. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Webhook opcional (Discord, Slack, ntfy…) para avisar cambios o fallas de la revisión diaria. */
  ALERTA_WEBHOOK_URL?: string;
}

/** Sin CF-Visitor la petición no pasó por el borde de Cloudflare: es `wrangler dev`. */
const enProduccion = (req: Request) => req.headers.has("cf-visitor");

async function limitado(env: Env, req: Request, prefijo: string): Promise<boolean> {
  if (!env.RATE_LIMITER || !enProduccion(req)) return false;
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const { success } = await env.RATE_LIMITER.limit({ key: `${prefijo}:${ip}` });
  return !success;
}

function error(mensaje: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: mensaje }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

const respuestaLimitada = () =>
  error("Demasiadas preguntas seguidas. Espera un minuto e intenta de nuevo.", 429, { "retry-after": "60" });

const MODOS: Modo[] = ["fts", "vector", "hybrid", "hybrid_rerank"];
const MAX_PREGUNTA = 500;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function leerJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function modoPorDefecto(env: Env): Modo {
  if (env.SEARCH_MODE && MODOS.includes(env.SEARCH_MODE)) return env.SEARCH_MODE;
  return env.AI && env.VECTORIZE ? "hybrid" : "fts";
}

async function meta(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta").all<{ key: string; value: string }>();
  return { ...Object.fromEntries(results.map((r) => [r.key, r.value])), modo_busqueda: modoPorDefecto(env) };
}

/** /api/meta: normas y última revisión como objetos, y la clave pública de Turnstile. */
async function metaPublica(env: Env) {
  const m = await meta(env);
  const parse = (s?: string) => {
    try {
      return s ? JSON.parse(s) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    ...m,
    normas: parse(m.normas) ?? [],
    ultima_revision: parse(m.ultima_revision),
    turnstile_site_key: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET ? env.TURNSTILE_SITE_KEY : null,
  };
}

/* ---------- Búsqueda ---------- */

async function handleSearch(req: Request, env: Env): Promise<Response> {
  if (await limitado(env, req, "search")) return respuestaLimitada();
  const body = await leerJson<{ q?: string; k?: number; modo?: Modo; peso_fts?: number; expandir?: boolean }>(req);
  if (!body) return error("JSON inválido", 400);
  const q = (body.q || "").slice(0, MAX_PREGUNTA).trim();
  if (!q) return error("Falta q", 400);
  const k = Math.min(Math.max(Math.floor(body.k ?? 8) || 8, 1), 30);
  const modo = body.modo && MODOS.includes(body.modo) ? body.modo : modoPorDefecto(env);
  const pesoFts = typeof body.peso_fts === "number" ? body.peso_fts : undefined;
  const t0 = Date.now();
  const res = await buscar(env, q, { k, modo, pesoFts, expandir: body.expandir });
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

/* ---------- Protecciones de /api/ask ---------- */

async function turnstileValido(env: Env, req: Request, token: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY || !enProduccion(req)) return true; // desactivado
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const d = (await r.json().catch(() => ({}))) as { success?: boolean };
  return d.success === true;
}

/** Suma una pregunta al contador del día; false si se superó el tope. */
async function dentroDelTope(env: Env): Promise<boolean> {
  const max = parseInt(env.MAX_PREGUNTAS_DIA || "0", 10);
  if (!max) return true;
  const fila = await env.DB.prepare(
    `INSERT INTO uso_diario (fecha, preguntas) VALUES (?1, 1)
     ON CONFLICT(fecha) DO UPDATE SET preguntas = preguntas + 1
     RETURNING preguntas`,
  )
    .bind(fechaChile())
    .first<{ preguntas: number }>();
  return (fila?.preguntas ?? 0) <= max;
}

/* ---------- Preguntas ---------- */

async function handleAsk(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return error("Falta ANTHROPIC_API_KEY (ver .dev.vars.example)", 503);
  const body = await leerJson<{ pregunta?: string; modelo?: string; turnstile?: string }>(req);
  if (!body) return error("JSON inválido", 400);
  const pregunta = (body.pregunta || "").trim();
  if (!pregunta) return error("Falta la pregunta", 400);
  if (pregunta.length > MAX_PREGUNTA) return error(`La pregunta supera ${MAX_PREGUNTA} caracteres`, 400);
  // "preciso" (Sonnet) queda solo para evaluación; la UI no lo ofrece.
  const modelo = body.modelo === "preciso" ? MODELO_PRECISO : MODELO_DEFAULT;

  // Caché: misma pregunta, misma versión de la ley, mismo prompt, mismo día y modelo.
  const horas = parseFloat(env.CACHE_HORAS ?? "24");
  const m = await meta(env);
  const cacheKey = new Request(
    `https://cache.leyclara.internal/ask?v=${encodeURIComponent(m.fecha_version ?? "")}&h=${HUELLA}&d=${fechaChile()}&m=${modelo}&q=${encodeURIComponent(normalizar(pregunta))}`,
  );
  const cache = horas > 0 && typeof caches !== "undefined" ? caches.default : undefined;
  const enCache = cache ? await cache.match(cacheKey) : undefined;
  if (enCache) {
    const r = new Response(enCache.body, enCache);
    r.headers.set("x-cache", "HIT");
    r.headers.set("cache-control", "no-store");
    return r;
  }

  // Solo las preguntas nuevas (que llaman al modelo) pasan por las protecciones de costo.
  if (await limitado(env, req, "ask")) return respuestaLimitada();
  if (!(await turnstileValido(env, req, body.turnstile))) {
    return error("No pudimos verificar que eres una persona. Recarga la página e intenta de nuevo.", 403);
  }
  if (!(await dentroDelTope(env))) {
    return error("Ley Clara alcanzó su límite de preguntas por hoy. Vuelve mañana, o revisa el Código en Ley Chile.", 503);
  }

  const t0 = Date.now();
  const k = parseInt(env.CONTEXT_K || "8", 10);
  // Hasta 2 artículos relacionados extra (p. ej. el transitorio de la Ley 21.561 que escalona el art. 22).
  const recuperados = await buscar(env, pregunta, { k, modo: modoPorDefecto(env), relacionados: 2 });
  const arts = await obtenerArticulos(env.DB, recuperados.map((r) => r.articulo_id));
  const articulos = recuperados.map((r) => arts.get(r.articulo_id)!).filter(Boolean);

  if (!articulos.length) {
    return json({ respuesta: RESPUESTA_SIN_BASE, citas: [], sin_base_legal: true, recuperados: [], fecha_version: m.fecha_version, huella: HUELLA });
  }

  const g = await generar(env.ANTHROPIC_API_KEY, pregunta, articulos, modelo);
  const porId = new Map(articulos.map((a) => [a.id, a]));
  const resp = json({
    respuesta: g.salida.respuesta,
    sin_base_legal: g.abstencion,
    advertencia: g.advertencia,
    citas: g.salida.citas.map((c) => {
      const a = porId.get(c.articulo_id)!;
      return { ...c, numero: a.numero, ruta: a.ruta_str, url: a.url, fecha_version: a.fecha_version, norma: a.norma_nombre };
    }),
    recuperados: articulos.map((a) => ({ id: a.id, numero: a.numero, ruta: a.ruta_str, url: a.url, norma: a.norma_nombre })),
    fecha_version: m.fecha_version,
    fuente: m.fuente,
    modelo: g.modelo,
    huella: HUELLA,
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

/* ---------- Valoraciones ---------- */

async function handleFeedback(req: Request, env: Env): Promise<Response> {
  if (await limitado(env, req, "feedback")) return respuestaLimitada();
  const b = await leerJson<{ pregunta?: string; util?: boolean; citas?: string[]; abstencion?: boolean; huella?: string }>(req);
  if (!b || typeof b.util !== "boolean") return error("Falta util (true/false)", 400);
  const pregunta = (b.pregunta || "").trim().slice(0, MAX_PREGUNTA);
  if (!pregunta) return error("Falta la pregunta", 400);
  const citas = Array.isArray(b.citas) ? b.citas.filter((c) => typeof c === "string").slice(0, 20) : [];
  await env.DB.prepare(
    "INSERT INTO feedback (creado, pregunta, util, citas, abstencion, huella) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(new Date().toISOString(), pregunta, b.util ? 1 : 0, JSON.stringify(citas), b.abstencion ? 1 : 0, (b.huella || "").slice(0, 20))
    .run();
  return json({ ok: true });
}

/* ---------- Administración ---------- */

const autorizado = (req: Request, env: Env) =>
  !!env.ADMIN_TOKEN && req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;

async function handleIndex(req: Request, url: URL, env: Env): Promise<Response> {
  if (!autorizado(req, env)) return error("No autorizado", 401);
  if (!env.AI || !env.VECTORIZE) return error("Vectorize/AI no configurados", 503);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const soloFaltantes = url.searchParams.get("faltantes") === "1";
  const { results } = await env.DB.prepare("SELECT id, articulo_id, texto FROM chunks ORDER BY rowid LIMIT ?1 OFFSET ?2")
    .bind(limit, offset)
    .all<{ id: string; articulo_id: string; texto: string }>();
  if (!results.length) return json({ indexados: 0, siguiente: null });
  let pendientes = results;
  if (soloFaltantes) {
    const existentes = new Set((await env.VECTORIZE.getByIds(results.map((r) => r.id))).map((v) => v.id));
    pendientes = results.filter((r) => !existentes.has(r.id));
  }
  const indexados = await indexarChunks(env, pendientes);
  return json({ revisados: results.length, indexados, siguiente: offset + results.length });
}

/** Avisa por webhook si la revisión actualizó una norma o tuvo problemas. */
export function mensajeAlerta(inf: Informe): string | null {
  const relevantes = inf.normas.filter((n) => n.estado !== "sin_cambios");
  if (!relevantes.length) return null;
  const lineas = relevantes.map((n) => {
    if (n.estado === "actualizada")
      return `✅ ${n.norma}: nueva versión ${n.fecha_version} (antes ${n.anterior ?? "—"}). ${n.nuevos ?? 0} nuevos, ${n.modificados ?? 0} modificados, ${n.eliminados ?? 0} eliminados.`;
    if (n.estado === "pendiente") return `⏳ ${n.norma}: hay versión nueva pero no se pudo descargar el XML (${n.error}). Se reintenta mañana.`;
    return `⚠️ ${n.norma}: error en la revisión (${n.error}).`;
  });
  return `Ley Clara · revisión de Ley Chile\n${lineas.join("\n")}`;
}

async function alertar(env: Env, inf: Informe): Promise<void> {
  const texto = mensajeAlerta(inf);
  if (!texto || !env.ALERTA_WEBHOOK_URL) return;
  // `content` lo entiende Discord, `text` Slack; ntfy usa el cuerpo completo.
  await fetch(env.ALERTA_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: texto, text: texto }),
  }).catch((e) => console.error("alerta fallida", e));
}

async function revisarYAvisar(env: Env, forzar = false): Promise<Informe> {
  const inf = await revisarNormas(env, { forzar });
  console.log(JSON.stringify({ revision_ley_chile: inf }));
  await alertar(env, inf);
  return inf;
}

async function handleRevisar(req: Request, url: URL, env: Env): Promise<Response> {
  if (!autorizado(req, env)) return error("No autorizado", 401);
  return json(await revisarYAvisar(env, url.searchParams.get("forzar") === "1"));
}

/* ---------- Entrada ---------- */

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
    // El borde de Cloudflare indica el esquema original en CF-Visitor; en `wrangler dev`
    // no existe (y la URL llega reescrita con el dominio de producción).
    const esHttp = (req.headers.get("cf-visitor") ?? "").includes('"http"');
    // Solo se redirigen GET/HEAD: un 301 a un POST de una pestaña abierta en http://
    // lo convierte en una petición a otro origen y el navegador la corta ("Failed to fetch").
    if (esHttp && (req.method === "GET" || req.method === "HEAD")) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return conSeguridad(await manejar(req, url, env, ctx));
  },

  // Cron Trigger (wrangler.jsonc > triggers): revisa Ley Chile una vez al día.
  async scheduled(_evento: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(revisarYAvisar(env));
  },
} satisfies ExportedHandler<Env>;

async function manejar(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const p = url.pathname;
    if (p === "/api/meta" && req.method === "GET") return json(await metaPublica(env));
    if (p === "/api/search" && req.method === "POST") return await handleSearch(req, env);
    if (p === "/api/ask" && req.method === "POST") return await handleAsk(req, env, ctx);
    if (p === "/api/feedback" && req.method === "POST") return await handleFeedback(req, env);
    const art = p.match(/^\/api\/articulos\/([\w-]+)$/);
    if (art && req.method === "GET") {
      const a = (await obtenerArticulos(env.DB, [art[1]])).get(art[1]);
      return a ? json(a) : error("Artículo no encontrado", 404);
    }
    if (p === "/admin/index" && req.method === "POST") return await handleIndex(req, url, env);
    if (p === "/admin/revisar" && req.method === "POST") return await handleRevisar(req, url, env);
    if (p.startsWith("/api/") || p.startsWith("/admin/")) return error("No encontrado", 404);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return error("Error interno. Intenta de nuevo en un momento.", 500);
  }
  return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Ley Clara API", { status: 200 });
}
