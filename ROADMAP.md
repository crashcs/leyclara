# Roadmap de Ley Clara

Estado al 21 de noviembre de 2026. Detalle técnico y métricas en el [README](README.md). `[x]` hecho, `[ ]` pendiente.

## MVP (hecho)

- [x] Parser del Código del Trabajo (737 artículos con ruta jerárquica) y tests.
- [x] Búsqueda vectorial (bge-m3 + Vectorize) evaluada contra FTS5, híbrido y re-ranking.
- [x] Generación con Claude Haiku 5.5 en JSON y validación de citas (artículo recuperado y fragmento textual).
- [x] UI editorial con lector de artículos, aviso de "no es asesoría legal" y fecha de versión.
- [x] Deploy en `ley.manuel.ac` (Worker + assets, D1, Vectorize, HTTPS, caché, límite por IP).
- [x] Transitorios de la Ley 21.561 (40 horas) con calendario de etapas calculado por código.
- [x] Revisión diaria automática de Ley Chile (Cron Trigger) que sincroniza solo lo que cambió.

## Antes del release público

### Costos y abuso
- [x] Cloudflare Turnstile en `/api/ask`: widget creado y clave pública configurada; se activa al cargar `TURNSTILE_SECRET`.
- [x] Tope global de preguntas por día (`MAX_PREGUNTAS_DIA`), contado en D1.
- [x] Límite de US$10/mes en un workspace propio de Anthropic ("Ley Clara"); falta mover la API key a ese workspace.

### Privacidad
- [x] Página `/privacidad` (qué se guarda, a quién se envía, cuánto tiempo).
- [x] Sin preguntas en los logs: `/api/search` pasa a POST.

### Producto
- [x] Quitar "modo preciso" de la UI (Sonnet no está re-evaluado con el prompt actual).
- [x] 👍 / 👎 en cada respuesta, guardado anónimo en D1, para construir un set de evaluación con preguntas reales.
- [x] Compartir una respuesta (`?q=`) y copiarla con sus citas.
- [x] Temas frecuentes visibles en móvil.
- [x] Open Graph (imagen y texto al compartir el link) e íconos.

### Operación
- [x] Aviso cuando la revisión diaria falla, queda pendiente o actualiza una norma (webhook opcional `ALERTA_WEBHOOK_URL`).

### Calidad
- [x] Expansión de sinónimos coloquiales → términos legales: hit@5 de 94,7 % a 96,5 % (57 preguntas).

### Repositorio
- [x] GIF de demo en el README.
- [x] Repo público en GitHub con licencia MIT y CI: [crashcs/leyclara](https://github.com/crashcs/leyclara).

## Después del release

- [ ] Registrarse en la [API oficial de Ley Chile](https://www.bcn.cl/leychile/api/condiciones-de-uso) (permite uso para IA) y migrar la revisión diaria a ella.
- [ ] Más leyes: Ley del Consumidor (19.496), Ley de Arriendo (18.101).
- [ ] Transitorios de otras reformas con vigencia gradual.
- [ ] Set de evaluación ampliado con las preguntas reales marcadas con 👎.
- [ ] Re-evaluar Sonnet 5.5 y decidir si vuelve el "modo preciso".
- [ ] Alertas para usuarios cuando cambia un artículo que consultaron.
