# Ley Clara

Responde dudas sobre el **Código del Trabajo de Chile** en lenguaje simple, **siempre citando el artículo exacto** con link a Ley Chile. Si ningún artículo respalda la respuesta, lo dice en vez de adivinar.

> **No es asesoría legal.** Explica lo que dice el texto de la ley y puede equivocarse.

Todo corre en Cloudflare: D1 (SQLite + FTS5), Vectorize, Workers AI (embeddings `bge-m3`) y un Worker que sirve la API y la página. El LLM es Claude (`claude-haiku-5-5` por defecto, `claude-sonnet-5-5` en "modo preciso").

## Resultados de la evaluación

Set propio de **56 preguntas en lenguaje coloquial** con sus artículos correctos, más **10 preguntas fuera de alcance** (arriendo, tránsito, AFP, herencias…). Ver [eval/preguntas.jsonl](eval/preguntas.jsonl). Corrida del 20-nov-2026 sobre la versión del Código del 23-jul-2026.

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
| Exactitud de citas mostradas¹ | 100 % (171/171) | 100 % (132/132) |
| Validación de citas al primer intento | 81,8 % | 87,9 % |
| Respuestas que citan un artículo correcto | 94,6 % | 94,6 % |
| … cuando la búsqueda trajo el artículo correcto | 98,1 % | 98,1 % |
| Abstención correcta (fuera de alcance) | 90 % (9/10) | 90 % (9/10) |
| Abstención indebida (en alcance) | 3,6 % (2/56) | 1,8 % (1/56) |
| Latencia mediana | 2,8 s | 4,0 s |
| Tokens por pregunta (entrada / salida) | ~6.100 / ~560 | ~6.000 / ~450 |

¹ Una cita es válida si (a) el artículo estaba entre los recuperados y (b) el fragmento citado aparece **textualmente** en ese artículo (comparando sin tildes ni mayúsculas). Si una respuesta falla la validación, se reintenta una vez con el detalle del error. Si sigue sin una cita verificable, se reemplaza por "no encontré base legal". Por eso las citas que llegan al usuario son 100 % verificables. La tasa al primer intento indica cuánto trabajo hace la validación.

Las 2 abstenciones indebidas de Haiku (q05, q15) ocurren justo cuando la búsqueda no trajo el artículo correcto: el modelo dijo que no tenía base en vez de inventar. El falso positivo fuera de alcance (x07, retiro de fondos AFP) cita el art. 165 sobre la cuenta de indemnización sustitutiva, que es tangencial.

**Límites de esta evaluación**: 56 preguntas es poco. Las escribí yo con mis artículos de referencia, así que pueden tener sesgo y no reemplazan preguntas de usuarios reales. "Respalda lo que se afirma" se verifica por fragmento textual por artículo, no por cada frase de la respuesta.

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

- **Parser** ([ingest/leyclara/parser.py](ingest/leyclara/parser.py)): los 737 artículos (714 permanentes y 23 transitorios, 4 derogados) con su ruta Libro › Título › Capítulo › Párrafo, su `fechaVersion` y el link directo (`idParte`). Quita las notas al margen de modificaciones ("L. 18.620 / Art. 1° N° 40") que vienen mezcladas en el texto.
- **Chunking**: un chunk por artículo; los largos se dividen por incisos (máx. ~1.500 caracteres), repitiendo número y ruta en cada chunk. 901 chunks.
- **Stemming en español** para FTS5: implementado igual en Python y TypeScript, y verificado contra el mismo archivo de casos ([shared/textnorm_cases.json](shared/textnorm_cases.json)).
- **Prompt injection**: los artículos y la pregunta van en etiquetas como datos; las reglas de citado viven en el system prompt y la validación es código, no depende de que el modelo obedezca.
- **Versión de la ley**: cada respuesta muestra la fecha de versión de la norma, y el panel muestra la fecha de última modificación de cada artículo.

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

## Pendiente

- Deploy en `ley.manuel.ac`: D1 y Vectorize de producción, secreto `ANTHROPIC_API_KEY`, dominio.
- Rate limit por IP y caché de preguntas frecuentes.
- Cron diario que compare `fechaVersion` y reindexe solo lo que cambió.
- Más leyes: Ley del Consumidor 19.496, Ley de Arriendo 18.101.

## Fuente y licencia

Texto legal: [Ley Chile, Biblioteca del Congreso Nacional](https://www.bcn.cl/leychile/navegar?idNorma=207436), DFL 1 de 2002 (texto refundido del Código del Trabajo). El XML se descarga una vez y se cachea localmente.

Código bajo licencia [MIT](LICENSE).
