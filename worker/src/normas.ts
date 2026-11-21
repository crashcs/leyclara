// Normas que indexa Ley Clara. Mantener sincronizado con NORMAS en
// ingest/leyclara/build.py (lo verifica ingest/tests/test_normas.py).

export interface Etapa {
  desde: string; // AAAA-MM-DD (inclusive)
  valor: string;
}

/**
 * Calendario de entrada en vigencia gradual, calculado a partir del texto del
 * transitorio. El modelo calcula mal las fechas ("quinto año" -> 2027), así que
 * se las damos hechas y le indicamos cuál rige hoy.
 */
export interface Calendario {
  titulo: string;
  fuente: string; // artículo que lo establece (el que el modelo debe citar)
  inicial: string; // valor antes de la primera etapa
  etapas: Etapa[];
  nota?: string;
}

export interface NormaConfig {
  id: string; // idNorma de Ley Chile
  nombre: string; // nombre corto para citas
  principal?: boolean;
  prefijo?: string; // prefijo de ids de artículos (normas complementarias)
  descripcion?: string;
  soloTransitorios?: boolean;
  calendario?: Calendario;
}

export const NORMAS: NormaConfig[] = [
  { id: "207436", nombre: "Código del Trabajo", principal: true },
  {
    id: "1191554",
    nombre: "Ley 21.561",
    prefijo: "l21561",
    descripcion: "Ley 40 horas, reducción gradual de la jornada",
    soloTransitorios: true,
    // Art. primero transitorio: publicada el 26-04-2023; 44 h al primer año, 42 h al
    // tercero y 40 h al quinto. Coincide con el Dictamen 142/09 de la Dirección del Trabajo.
    calendario: {
      titulo: "Límite semanal de la jornada ordinaria (art. 22 del Código del Trabajo)",
      fuente: "primero transitorio, Ley 21.561",
      inicial: "45 horas",
      etapas: [
        { desde: "2024-04-26", valor: "44 horas" },
        { desde: "2026-04-26", valor: "42 horas" },
        { desde: "2028-04-26", valor: "40 horas" },
      ],
      nota: "Las demás jornadas que menciona el transitorio se reducen en las mismas fechas, según su propio texto.",
    },
  },
];

export const URL_XML = (id: string) => `https://www.leychile.cl/Consulta/obtxml?opt=7&idNorma=${id}`;
// API JSON de Ley Chile: responde desde la red de Cloudflare (el XML a veces no, ver actualizar.ts).
export const URL_JSON = (id: string) => `https://nuevo.leychile.cl/servicios/Navegar/get_norma_json?idNorma=${id}`;
export const URL_NORMA = (id: string) => `https://www.bcn.cl/leychile/navegar?idNorma=${id}`;
// Ley Chile responde 401 sin un User-Agent de navegador.
export const USER_AGENT = "Mozilla/5.0 (compatible; LeyClara/0.1; +https://ley.manuel.ac)";

const fmt = (iso: string) => iso.split("-").reverse().join("-");

/** Texto del calendario para el contexto del modelo, marcando la etapa vigente en `hoy`. */
export function calendarioTexto(c: Calendario, hoy: string): string {
  const vigente = [...c.etapas].reverse().find((e) => e.desde <= hoy);
  const lineas = [`Antes del ${fmt(c.etapas[0].desde)}: ${c.inicial}${vigente ? "" : "  <- RIGE HOY"}`];
  for (const e of c.etapas) lineas.push(`Desde el ${fmt(e.desde)}: ${e.valor}${e === vigente ? "  <- RIGE HOY" : ""}`);
  const proxima = c.etapas.find((e) => e.desde > hoy);
  if (proxima) lineas.push(`Próximo cambio: ${fmt(proxima.desde)}, a ${proxima.valor}.`);
  if (c.nota) lineas.push(c.nota);
  return `<calendario titulo="${c.titulo}" fuente="Art. ${c.fuente}" hoy="${fmt(hoy)}">\n${lineas.join("\n")}\n</calendario>`;
}
