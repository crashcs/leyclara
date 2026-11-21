// Revisión diaria de Ley Chile (Cron Trigger del Worker).
//
// 1. Descarga el XML de cada norma y compara su fechaVersion con la guardada en D1.
// 2. Si cambió, la parsea (parser.ts), detecta artículos nuevos, modificados o
//    eliminados, y actualiza solo esos: D1 (artículos, chunks, FTS, relaciones)
//    y Vectorize (embeddings bge-m3 de los chunks afectados).
// 3. Guarda en meta la fecha de la última revisión y el resultado.
//
// Si nada cambió (lo normal), solo cuesta una descarga y una comparación.

import { NORMAS, URL_NORMA, URL_XML, USER_AGENT, type NormaConfig } from "./normas";
import { articulosDeNorma, chunkArticulo, fechaVersionXml, parseNorma, referenciasAlCodigo, rutaStr, type Articulo } from "./parser";
import { embed, type SearchEnv } from "./search";
import { tokens } from "./textnorm";

export interface InformeNorma {
  norma: string;
  estado: "sin_cambios" | "actualizada" | "error";
  fecha_version?: string;
  anterior?: string;
  nuevos?: number;
  modificados?: number;
  eliminados?: number;
  chunks_indexados?: number;
  error?: string;
}

export interface Informe {
  revisado: string;
  normas: InformeNorma[];
}

interface MetaNorma {
  id: string;
  nombre: string;
  titulo: string;
  fecha_version: string;
  fuente: string;
}

const textoStem = (s: string) => tokens(s).join(" ");

async function leerMeta(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM meta").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function descargar(id: string): Promise<string> {
  const r = await fetch(URL_XML(id), { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) throw new Error(`Ley Chile respondió ${r.status} para idNorma=${id}`);
  const xml = await r.text();
  if (!xml.trimStart().startsWith("<?xml")) throw new Error(`La respuesta para idNorma=${id} no es XML`);
  return xml;
}

/** Inserta embeddings de chunks en Vectorize, en lotes. */
export async function indexarChunks(env: SearchEnv, chunks: { id: string; articulo_id: string; texto: string }[]): Promise<number> {
  if (!env.AI || !env.VECTORIZE || !chunks.length) return 0;
  for (let i = 0; i < chunks.length; i += 50) {
    const lote = chunks.slice(i, i + 50);
    const vectores = await embed(env.AI, lote.map((c) => c.texto));
    await env.VECTORIZE.upsert(lote.map((c, j) => ({ id: c.id, values: vectores[j], metadata: { articulo_id: c.articulo_id } })));
  }
  return chunks.length;
}

const igual = (a: Articulo, fila: Record<string, unknown>) =>
  fila.texto === a.texto &&
  fila.fecha_version === a.fecha_version &&
  Number(fila.derogado) === Number(a.derogado) &&
  fila.numero === a.numero &&
  fila.ruta_str === rutaStr(a);

async function sincronizarNorma(env: SearchEnv, cfg: NormaConfig, xml: string, ordenBase: number): Promise<Omit<InformeNorma, "norma" | "estado">> {
  const db = env.DB;
  const nuevos = articulosDeNorma(parseNorma(xml), cfg);
  const { results: actuales } = await db
    .prepare("SELECT id, numero, fecha_version, derogado, ruta_str, texto FROM articulos WHERE norma = ?1")
    .bind(cfg.id)
    .all<Record<string, unknown>>();
  const porId = new Map(actuales.map((f) => [String(f.id), f]));
  const idsNuevos = new Set(nuevos.map((a) => a.id));

  const cambiados = nuevos.filter((a) => !porId.has(a.id) || !igual(a, porId.get(a.id)!));
  const eliminados = actuales.map((f) => String(f.id)).filter((id) => !idsNuevos.has(id));
  const afectados = [...cambiados.map((a) => a.id), ...eliminados];

  // Chunks viejos de los artículos afectados (para borrar sus vectores).
  const viejos: string[] = [];
  for (let i = 0; i < afectados.length; i += 50) {
    const lote = afectados.slice(i, i + 50);
    const ph = lote.map((_, j) => `?${j + 1}`).join(",");
    const { results } = await db.prepare(`SELECT id FROM chunks WHERE articulo_id IN (${ph})`).bind(...lote).all<{ id: string }>();
    viejos.push(...results.map((r) => r.id));
  }

  const stmts: D1PreparedStatement[] = [];
  for (const id of afectados) {
    stmts.push(db.prepare("DELETE FROM chunks_fts WHERE articulo_id = ?1").bind(id));
    stmts.push(db.prepare("DELETE FROM chunks WHERE articulo_id = ?1").bind(id));
  }
  for (const id of eliminados) {
    stmts.push(db.prepare("DELETE FROM articulos WHERE id = ?1").bind(id));
    stmts.push(db.prepare("DELETE FROM relaciones WHERE articulo_id = ?1 OR relacionado_id = ?1").bind(id));
  }
  const chunksNuevos: { id: string; articulo_id: string; texto: string }[] = [];
  for (const a of cambiados) {
    const orden = ordenBase + nuevos.indexOf(a);
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO articulos (id, numero, orden, transitorio, derogado, fecha_version, id_parte, url, ruta, ruta_str, texto, norma, norma_nombre)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(a.id, a.numero, orden, a.transitorio ? 1 : 0, a.derogado ? 1 : 0, a.fecha_version, a.id_parte, a.url,
          JSON.stringify(a.ruta), rutaStr(a), a.texto, a.norma, a.norma_nombre),
    );
    if (a.derogado) continue; // los derogados se guardan pero no se indexan
    for (const c of chunkArticulo(a)) {
      chunksNuevos.push(c);
      stmts.push(db.prepare("INSERT INTO chunks (id, articulo_id, idx, texto) VALUES (?1, ?2, ?3, ?4)").bind(c.id, c.articulo_id, c.idx, c.texto));
      stmts.push(
        db
          .prepare("INSERT INTO chunks_fts (chunk_id, articulo_id, texto_stem, ruta_stem) VALUES (?1, ?2, ?3, ?4)")
          .bind(c.id, c.articulo_id, textoStem(c.texto.split("\n").slice(1).join("\n")), textoStem(a.ruta.join(" "))),
      );
    }
  }

  // Relaciones de las leyes complementarias hacia el Código (se recalculan completas).
  if (!cfg.principal && cambiados.length + eliminados.length > 0) {
    const { results: cod } = await db
      .prepare("SELECT id FROM articulos WHERE norma = ?1 AND derogado = 0")
      .bind(NORMAS[0].id)
      .all<{ id: string }>();
    const idsCodigo = new Set(cod.map((r) => r.id));
    const propios = new Set(parseNorma(xml).articulos.filter((a) => !a.transitorio).map((a) => a.id));
    stmts.push(db.prepare("DELETE FROM relaciones WHERE relacionado_id LIKE ?1").bind(`${cfg.prefijo}-%`));
    for (const a of nuevos.filter((x) => !x.derogado)) {
      for (const ref of referenciasAlCodigo(a.texto, idsCodigo, propios)) {
        stmts.push(db.prepare("INSERT OR IGNORE INTO relaciones (articulo_id, relacionado_id) VALUES (?1, ?2)").bind(ref, a.id));
      }
    }
  }

  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));

  // Vectorize: borrar los chunks que ya no existen y subir los nuevos.
  const idsChunksNuevos = new Set(chunksNuevos.map((c) => c.id));
  const borrar = viejos.filter((id) => !idsChunksNuevos.has(id));
  if (env.VECTORIZE && borrar.length) {
    for (let i = 0; i < borrar.length; i += 100) await env.VECTORIZE.deleteByIds(borrar.slice(i, i + 100));
  }
  const indexados = await indexarChunks(env, chunksNuevos);

  return {
    nuevos: cambiados.filter((a) => !porId.has(a.id)).length,
    modificados: cambiados.filter((a) => porId.has(a.id)).length,
    eliminados: eliminados.length,
    chunks_indexados: indexados,
  };
}

/** Revisa todas las normas. Con `forzar`, reprocesa aunque la fecha de versión no haya cambiado. */
export async function revisarNormas(env: SearchEnv, opciones: { forzar?: boolean } = {}): Promise<Informe> {
  const db = env.DB;
  const meta = await leerMeta(db);
  const metaNormas: MetaNorma[] = meta.normas ? JSON.parse(meta.normas) : [];
  const informe: Informe = { revisado: new Date().toISOString(), normas: [] };
  let ordenBase = 0;

  for (const cfg of NORMAS) {
    const guardada = metaNormas.find((n) => n.id === cfg.id);
    try {
      const xml = await descargar(cfg.id);
      const fecha = fechaVersionXml(xml.slice(0, 4000));
      if (!fecha) throw new Error("No encontré fechaVersion en el XML");
      if (guardada && guardada.fecha_version === fecha && !opciones.forzar) {
        informe.normas.push({ norma: cfg.nombre, estado: "sin_cambios", fecha_version: fecha });
      } else {
        const r = await sincronizarNorma(env, cfg, xml, ordenBase);
        const norma = parseNorma(xml);
        const nueva: MetaNorma = { id: cfg.id, nombre: cfg.nombre, titulo: norma.titulo, fecha_version: fecha, fuente: URL_NORMA(cfg.id) };
        const i = metaNormas.findIndex((n) => n.id === cfg.id);
        if (i >= 0) metaNormas[i] = nueva;
        else metaNormas.push(nueva);
        if (cfg.principal) {
          await db.batch([
            db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fecha_version', ?1)").bind(fecha),
            db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('titulo', ?1)").bind(norma.titulo),
            db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('n_articulos', ?1)").bind(String(norma.articulos.length)),
          ]);
        }
        informe.normas.push({ norma: cfg.nombre, estado: "actualizada", fecha_version: fecha, anterior: guardada?.fecha_version, ...r });
      }
    } catch (e) {
      informe.normas.push({ norma: cfg.nombre, estado: "error", anterior: guardada?.fecha_version, error: e instanceof Error ? e.message : String(e) });
    }
    ordenBase += 10000;
  }

  await db.batch([
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('normas', ?1)").bind(JSON.stringify(metaNormas)),
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ultima_revision', ?1)").bind(JSON.stringify(informe)),
  ]);
  return informe;
}

