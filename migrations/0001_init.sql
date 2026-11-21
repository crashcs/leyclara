-- Esquema de Ley Clara (D1 / SQLite)

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articulos (
  id            TEXT PRIMARY KEY,   -- slug: "67", "40-bis-e", "t-23"
  numero        TEXT NOT NULL,      -- "67", "40 bis E", "23 transitorio"
  orden         INTEGER NOT NULL,
  transitorio   INTEGER NOT NULL DEFAULT 0,
  derogado      INTEGER NOT NULL DEFAULT 0,
  fecha_version TEXT NOT NULL,
  id_parte      TEXT NOT NULL,
  url           TEXT NOT NULL,
  ruta          TEXT NOT NULL,      -- JSON array
  ruta_str      TEXT NOT NULL,
  texto         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,     -- "<articulo_id>#<idx>" (también es el id en Vectorize)
  articulo_id TEXT NOT NULL REFERENCES articulos(id),
  idx         INTEGER NOT NULL,
  texto       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_articulo ON chunks(articulo_id);

-- Texto normalizado y stemmeado (ver ingest/leyclara/textnorm.py y worker/src/textnorm.ts)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  articulo_id UNINDEXED,
  texto_stem,
  ruta_stem,
  tokenize = 'unicode61 remove_diacritics 2'
);
