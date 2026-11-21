-- Tope global de preguntas por día (protección de costos).
CREATE TABLE IF NOT EXISTS uso_diario (
  fecha     TEXT PRIMARY KEY,   -- AAAA-MM-DD en hora de Chile
  preguntas INTEGER NOT NULL DEFAULT 0
);

-- Valoraciones de las respuestas (anónimas: no se guarda IP ni identificador del usuario).
CREATE TABLE IF NOT EXISTS feedback (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  creado    TEXT NOT NULL,      -- ISO 8601
  pregunta  TEXT NOT NULL,
  util      INTEGER NOT NULL,   -- 1 = sirvió, 0 = no sirvió
  citas     TEXT NOT NULL,      -- JSON: ids de artículos citados
  abstencion INTEGER NOT NULL DEFAULT 0,
  huella    TEXT                -- versión del prompt/normas que generó la respuesta
);
CREATE INDEX IF NOT EXISTS feedback_util ON feedback(util, creado);
