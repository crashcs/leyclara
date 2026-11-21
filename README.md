# Ley Clara

**En vivo: [ley.manuel.ac](https://ley.manuel.ac)**

Responde dudas sobre el **Código del Trabajo de Chile** en lenguaje simple, **siempre citando el artículo exacto** con link a Ley Chile. Si ningún artículo respalda la respuesta, lo dice en vez de adivinar.

> **No es asesoría legal.** Explica lo que dice el texto de la ley y puede equivocarse.

Todo corre en Cloudflare: D1 (SQLite + FTS5), Vectorize, Workers AI (embeddings `bge-m3`) y un Worker que sirve la API y la página. El LLM es Claude (`claude-haiku-5-5` por defecto, `claude-sonnet-5-5` en "modo preciso").

## Resultados de la evaluación

Set propio de **57 preguntas en lenguaje coloquial** con sus artículos correctos, más **10 preguntas fuera de alcance** (arriendo, tránsito, AFP, herencias…). Ver [eval/preguntas.jsonl](eval/preguntas.jsonl). Versión del Código del 23-jul-2026.

La tabla de recuperación es del 20-nov-2026, sobre las 56 preguntas originales. La pregunta 57 (jornada máxima vigente) se agregó al incorporar la Ley 21.561. Con ella, solo vectores da hit@5 = 94,7 % ([retrieval-vector-57.json](eval/resultados/retrieval-vector-57.json)): el transitorio queda en el puesto 7 con búsqueda pura, y en `/api/ask` entra igual gracias a la relación con el art. 22.

### Recuperación (antes del LLM)

| Modo | hit@1 | **hit@5** | recall@5 | hit@10 | MRR@10 |
|---|---|---|---|---|---|
| FTS5 (BM25 + stemming ligero) | 33,9 % | 55,4 % | 53,6 % | 64,3 % | 0,436 |
| **Vectores (bge-m3)** ← por defecto | **73,2 %** | **96,4 %** | **93,8 %** | 96,4 % | **0,824** |
| Híbrido RRF, peso FTS 1,0 | 42,9 % | 80,4 % | 77,7 % | 91,1 % | 0,594 |
| Híbrido RRF, peso FTS 0,1 | 60,7 % | 92,9 % | 90,2 % | 96,4 % | 0,748 |
| Híbrido + re-ranking (`bge-reranker-base`) | 41,1 % | 82,1 % | 80,4 % | 96,4 % | 0,590 |

*hit@k*: % de preguntas con al menos un artículo correcto entre los k primeros. *recall@k*: fracción de los artículos correctos encontrados.

Lo que mostró la medición: la búsqueda por palabras falla porque la gente dice "vacaciones" y la ley dice "feriado". Mezclarla con los vectores **empeora** el resultado con cualquier peso probado, y el re-ranker (entrenado sobre todo en inglés) también. Por eso el modo por defecto es solo vectores, más una regla que pone primero los artículos citados por número ("¿qué dice el artículo 161?"). FTS sigue como respaldo cuando Vectorize no está disponible (`wrangler dev --env offline`).

### Respuestas con citas (recuperación + LLM + validación)

| Métrica | Haiku 5.5 (por defecto) | Sonnet 5.5 (modo preciso) |
|---|---|---|
| Exactitud de citas mostradas¹ | 100 % (166/166) | 100 % (132/132) |
| Validación de citas al primer intento | 80,6 % | 87,9 % |
| Respuestas que citan un artículo correcto | 94,7 % | 94,6 % |
| … cuando la búsqueda trajo el artículo correcto | 98,2 % | 98,1 % |
| Abstención correcta (fuera de alcance) | 90 % (9/10) | 90 % (9/10) |
| Abstención indebida (en alcance) | 3,5 % (2/57) | 1,8 % (1/56) |
| Latencia mediana | 2,8 s | 4,0 s |
| Tokens por pregunta (entrada / salida) | ~6.800 / ~620 | ~6.000 / ~450 |

¹ Una cita es válida si (a) el artículo estaba entre los recuperados y (b) el fragmento citado aparece **textualmente** en ese artículo (comparando sin tildes ni mayúsculas). Si una respuesta falla la validación, se reintenta una vez con el detalle del error. Si sigue sin una cita verificable, se reemplaza por "no encontré base legal". Por eso las citas que llegan al usuario son 100 % verificables. La tasa al primer intento indica cuánto trabajo hace la validación.

Las 2 abstenciones indebidas de Haiku (q05, q15) ocurren justo cuando la búsqueda no trajo el artículo correcto: el modelo dijo que no tenía base en vez de inventar. El falso positivo fuera de alcance (x07, retiro de fondos AFP) cita el art. 165 sobre la cuenta de indemnización sustitutiva, que es tangencial.

La columna de Haiku corresponde al prompt actual (21-nov-2026: tutear, no mencionar el proceso de búsqueda, abstenerse sin datos tangenciales y aplicar los transitorios según la fecha de hoy). La de Sonnet corresponde a la primera versión del prompt. Un ajuste intermedio bajó la abstención correcta a 50 % porque el modelo agregaba datos tangenciales; la regla 4 ahora lo prohíbe. Para evaluar, usa `wrangler dev --var CACHE_HORAS:0`; si no, la caché de 24 h devuelve respuestas viejas.

**Límites de esta evaluación**: 57 preguntas es poco. Las escribí yo con mis artículos de referencia, así que pueden tener sesgo y no reemplazan preguntas de usuarios reales. "Respalda lo que se afirma" se verifica por fragmento textual por artículo, no por cada frase de la respuesta.

Reproducir: `npm run eval:retrieval -- --modos fts,vector,hybrid,hybrid_rerank` y `npm run eval:answers -- --modelo rapido` con `wrangler dev` corriendo. Los resultados completos, pregunta por pregunta, quedan en [eval/resultados/](eval/resultados/).

## Cómo funciona

```
Ley Chile (XML) ──► ingest/ (Python) ──► seed.sql ──► D1: articulos, chunks, chunks_fts (FTS5)
                                                 └──► POST /admin/index ──► Workers AI bge-m3 ──► Vectorize

Pregunta ──► Worker /api/ask
              ├─ búsqueda: vectores (+ refs explícitas "art. 161")  → top 8 artículos
              ├─ Claude: salida JSON {respuesta, citas[{articulo_id, fragmento}], sin_base_legal}
              ├─ validación: cada cita ∈ recuperados y fragmento textual ∈ artículo; marcadores [Art. N] con cita
              └─ reintento con feedback, o abstención si no hay cita verificable
```

- **Parser** ([ingest/leyclara/parser.py](ingest/leyclara/parser.py)): los 737 artículos del Código (714 permanentes y 23 transitorios, 4 derogados) con su ruta Libro › Título › Capítulo › Párrafo, su `fechaVersion` y el link directo (`idParte`). Quita las notas al margen de modificaciones ("L. 18.620 / Art. 1° N° 40") que vienen mezcladas en el texto.
- **Chunking**: un chunk por artículo; los largos se dividen por incisos (máx. ~1.500 caracteres), repitiendo número y ruta en cada chunk. 912 chunks (901 del Código y 11 de los transitorios de la Ley 21.561).
- **Stemming en español** para FTS5: implementado igual en Python y TypeScript, y verificado contra el mismo archivo de casos ([shared/textnorm_cases.json](shared/textnorm_cases.json)).
- **Prompt injection**: los artículos y la pregunta van en etiquetas como datos; las reglas de citado viven en el system prompt y la validación es código, no depende de que el modelo obedezca.
- **Versión de la ley**: cada respuesta muestra la fecha de versión de la norma, y el panel muestra la fecha de última modificación de cada artículo.

### Leyes con entrada en vigencia gradual

Ley Chile publica el texto consolidado con la redacción final de cada reforma, aunque entre en vigor por etapas. Ejemplo: el art. 22 ya dice "cuarenta horas", pero según la Ley 21.561 la jornada fue de 44 horas desde el 26-abr-2024, es de 42 desde el 26-abr-2026 y será de 40 desde el 26-abr-2028. Para no responder algo fiel al texto pero falso hoy:

- Se indexan también los **artículos transitorios** de esas leyes ([`NORMAS`](ingest/leyclara/build.py)); por ahora, la Ley 21.561.
- La ingesta detecta qué artículos del Código menciona cada transitorio y guarda la **relación** (el primero transitorio queda vinculado a los arts. 22, 25 bis, 27, 32, 33…). Al recuperar uno de esos artículos, `/api/ask` agrega el transitorio como contexto.
- El modelo recibe la **fecha de hoy** (zona horaria de Chile) y tiene una regla explícita: empezar por la cifra que rige hoy y decir desde cuándo cambia.

Resultado: a "¿cuántas horas a la semana puede durar la jornada?" responde "Hoy el máximo es de 42 horas…", citando el transitorio y el art. 22.

### Actualización automática

Un **Cron Trigger** del Worker ([worker/src/actualizar.ts](worker/src/actualizar.ts)) revisa Ley Chile todos los días a las 10:00 UTC:

1. Consulta la fecha de versión vigente en la API JSON de Ley Chile (`metadatos.vigencia.inicio_vigencia`) y la compara con la guardada en D1. Si no cambió (lo normal), termina ahí: en producción usa unos 8 ms de CPU.
2. Si cambió, descarga el XML y lo parsea con un puerto a TypeScript del parser de Python. Un test de paridad compara ambos sobre los 746 artículos reales: textos, rutas, chunks y relaciones idénticos.
3. Actualiza solo lo que cambió (artículos nuevos, modificados y eliminados) en D1, FTS, relaciones y Vectorize (borra los vectores viejos y genera embeddings nuevos).
4. Guarda el resultado en `meta.ultima_revision`. La barra lateral muestra "Revisado en Ley Chile: hoy, 07:00".

Por qué dos endpoints: el XML está detrás de CloudFront, que responde 429/401 ("Service limit has been reached") a las IP compartidas de Cloudflare cuando el documento no está en su caché. La API JSON sí responde. Si el XML no se puede descargar, la norma queda `pendiente` y la revisión del día siguiente lo vuelve a intentar; mientras tanto se sigue usando la versión anterior. La sincronización compara contra D1, así que es idempotente: una ejecución cortada a la mitad se completa en la siguiente. Si una actualización grande excede el límite de CPU del plan gratuito de Workers, la alternativa es correr `npm run deploy` en local (ingesta en Python y recarga de D1).

Para forzarla en local: `curl "localhost:8787/__scheduled?cron=0+10+*+*+*"` (con `wrangler dev --test-scheduled`), o `POST /admin/revisar?forzar=1` con `ADMIN_TOKEN`.

## Correr en local

Requisitos: Node 22+, Python 3.11+ con [uv](https://docs.astral.sh/uv/), y `wrangler login` para Vectorize y Workers AI (no tienen simulador local).

```bash
npm install
cd ingest && uv run python -m leyclara.fetch && uv run python -m leyclara.build && cd ..   # descarga (cacheada) + seed.sql
npm run db:migrate:local && npm run db:seed:local
cp .dev.vars.example .dev.vars        # ANTHROPIC_API_KEY y ADMIN_TOKEN
npx wrangler vectorize create leyclara-chunks --dimensions 1024 --metric cosine   # una vez
npm run dev
# indexar vectores (repetir con offset=50, 100, … hasta "siguiente": null)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "localhost:8787/admin/index?offset=0&limit=50"
```

Sin cuenta de Cloudflare: `npx wrangler dev --env offline` (solo FTS, sin vectores).

Tests: `cd ingest && uv run pytest` (parser y stemming) y `npx vitest run` (validación de citas, búsqueda y stemming compartido).

> En Windows, si `wrangler dev` queda colgado en "Establishing remote connection", revisa que no queden procesos `workerd.exe` de corridas anteriores ocupando el puerto 8787.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/meta` | Fecha de versión de la ley, fuente y modo de búsqueda |
| GET | `/api/search?q=&k=&modo=` | `fts`, `vector`, `hybrid`, `hybrid_rerank` (+ `peso_fts`) |
| POST | `/api/ask` | `{pregunta, modelo?: "rapido" \| "preciso"}` → respuesta, citas validadas, artículos recuperados |
| GET | `/api/articulos/:id` | Texto completo de un artículo (`67`, `152-quater-j`, `t-23`) |

## Deploy

Un solo Worker sirve la API y la página (Workers Static Assets), así que no hace falta un proyecto de Pages aparte.

```bash
npm run deploy        # scripts/deploy.sh
```

Publicado en **https://ley.manuel.ac** (custom domain del Worker; `leyclara.venuxgaming.workers.dev` queda como respaldo).

Si la key no está en Cloudflare, el script sube la de `.dev.vars` junto con el deploy. Para cambiarla después: `powershell -ExecutionPolicy Bypass -File scripts\set-api-key.ps1` (la pide oculta).

El script crea la D1 remota si no existe (y anota su `database_id` en `wrangler.jsonc`), aplica la migración, carga `seed.sql`, verifica el secreto, hace el deploy y prueba `/api/meta` y `/api/search`. Usa el mismo índice Vectorize que el desarrollo local.

Protecciones activas en producción: 10 solicitudes por minuto por IP a `/api/ask` y a `/api/search` (binding `ratelimits`; es aproximado y con consistencia eventual: en una ráfaga de 60 búsquedas se bloquearon las últimas 6), caché de 24 h para preguntas repetidas (la clave incluye la versión de la ley y el modelo) y preguntas de 500 caracteres como máximo.

El dominio se declara en `routes` de `wrangler.jsonc` como custom domain; Cloudflare crea el DNS y el certificado en el deploy. La caché de respuestas solo opera en el dominio propio, no en `*.workers.dev`.

## Pendiente

- Más leyes: Ley del Consumidor 19.496, Ley de Arriendo 18.101, y transitorios de otras reformas graduales.
- Alertas de cambios para usuarios (la revisión diaria ya detecta qué artículos cambiaron).

## Fuente y licencia

Texto legal: [Ley Chile, Biblioteca del Congreso Nacional](https://www.bcn.cl/leychile/navegar?idNorma=207436), DFL 1 de 2002 (texto refundido del Código del Trabajo). El XML se descarga una vez y se cachea localmente.

Código bajo licencia [MIT](LICENSE).
