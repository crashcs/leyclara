// Validación de citas: cada cita del LLM debe (1) apuntar a un artículo que
// estaba entre los recuperados y (2) traer un fragmento que aparezca
// textualmente en ese artículo. Las afirmaciones sin cita válida no se muestran.

import { normalizar } from "./textnorm";

export interface CitaLLM {
  articulo_id: string;
  fragmento: string;
}

export interface SalidaLLM {
  respuesta: string;
  citas: CitaLLM[];
  sin_base_legal: boolean;
}

export interface CitaValidada extends CitaLLM {
  valida: boolean;
  motivo?: "no_recuperado" | "fragmento_no_encontrado";
}

export interface Validacion {
  citas: CitaValidada[];
  validas: CitaValidada[];
  marcadores_huerfanos: string[]; // [Art. N] en el texto sin cita válida que lo respalde
  ok: boolean; // hay al menos una cita válida y ninguna inválida
}

/** Normaliza para comparar fragmentos: sin tildes, minúsculas, espacios colapsados. */
function norm(s: string): string {
  return normalizar(s.replace(/[“”«»"]/g, " "));
}

export function fragmentoEnTexto(fragmento: string, texto: string): boolean {
  const f = norm(fragmento);
  if (f.split(" ").length < 3) return false; // demasiado corto para respaldar algo
  return norm(texto).includes(f);
}

/** Extrae los marcadores [Art. 67], [Art. 161 bis], [Art. 152 quáter J] del texto. */
export function marcadores(respuesta: string): string[] {
  const out: string[] = [];
  for (const m of respuesta.matchAll(/\[Art(?:[íi]culo|\.)?\s*([^\]]+?)\]/gi)) out.push(m[1].trim());
  return out;
}

/** "152 quáter J" -> "152-quater-j"; "23 transitorio" -> "t-23". */
export function numeroASlug(numero: string): string {
  let n = numero.trim().toLowerCase().replace(/ñ/g, "nn").normalize("NFD").replace(/\p{Mn}/gu, "");
  const trans = /\btransitorio\b/.test(n);
  n = n.replace(/\btransitorio\b/, "").trim();
  const slug = n.split(/[\s-]+/).filter(Boolean).join("-");
  return trans ? `t-${slug}` : slug;
}

export function validarCitas(
  salida: SalidaLLM,
  recuperados: Map<string, { numero: string; texto: string }>,
): Validacion {
  const citas: CitaValidada[] = salida.citas.map((c) => {
    const a = recuperados.get(c.articulo_id);
    if (!a) return { ...c, valida: false, motivo: "no_recuperado" };
    if (!fragmentoEnTexto(c.fragmento, a.texto)) return { ...c, valida: false, motivo: "fragmento_no_encontrado" };
    return { ...c, valida: true };
  });
  const validas = citas.filter((c) => c.valida);
  const idsValidos = new Set(validas.map((c) => c.articulo_id));
  const marcadores_huerfanos = marcadores(salida.respuesta).filter((m) => !idsValidos.has(numeroASlug(m)));
  return {
    citas,
    validas,
    marcadores_huerfanos,
    ok: validas.length > 0 && validas.length === citas.length && marcadores_huerfanos.length === 0,
  };
}
