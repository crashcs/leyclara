-- Varias normas (Código del Trabajo + transitorios de leyes con vigencia gradual)
-- y relaciones entre artículos.

ALTER TABLE articulos ADD COLUMN norma TEXT NOT NULL DEFAULT '207436';
ALTER TABLE articulos ADD COLUMN norma_nombre TEXT NOT NULL DEFAULT 'Código del Trabajo';

-- Al recuperar articulo_id, se agrega también relacionado_id como contexto.
-- Ej.: art. 22 del Código -> artículo primero transitorio de la Ley 21.561.
CREATE TABLE IF NOT EXISTS relaciones (
  articulo_id    TEXT NOT NULL,
  relacionado_id TEXT NOT NULL,
  PRIMARY KEY (articulo_id, relacionado_id)
);
