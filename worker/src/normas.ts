// Normas que indexa Ley Clara. Mantener sincronizado con NORMAS en
// ingest/leyclara/build.py (lo verifica ingest/tests/test_normas.py).

export interface NormaConfig {
  id: string; // idNorma de Ley Chile
  nombre: string; // nombre corto para citas
  principal?: boolean;
  prefijo?: string; // prefijo de ids de artículos (normas complementarias)
  descripcion?: string;
  soloTransitorios?: boolean;
}

export const NORMAS: NormaConfig[] = [
  { id: "207436", nombre: "Código del Trabajo", principal: true },
  {
    id: "1191554",
    nombre: "Ley 21.561",
    prefijo: "l21561",
    descripcion: "Ley 40 horas, reducción gradual de la jornada",
    soloTransitorios: true,
  },
];

export const URL_XML = (id: string) => `https://www.leychile.cl/Consulta/obtxml?opt=7&idNorma=${id}`;
// API JSON de Ley Chile: responde desde la red de Cloudflare (el XML a veces no, ver actualizar.ts).
export const URL_JSON = (id: string) => `https://nuevo.leychile.cl/servicios/Navegar/get_norma_json?idNorma=${id}`;
export const URL_NORMA = (id: string) => `https://www.bcn.cl/leychile/navegar?idNorma=${id}`;
// Ley Chile responde 401 sin un User-Agent de navegador.
export const USER_AGENT = "Mozilla/5.0 (compatible; LeyClara/0.1; +https://ley.manuel.ac)";
