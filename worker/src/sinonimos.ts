// Expansión de consultas: palabras cotidianas -> términos que usa el Código del Trabajo.
//
// La gente pregunta por "vacaciones", "sueldo" o "me echaron"; la ley habla de
// "feriado", "remuneración" y "término del contrato". El embedding multilingüe
// salva buena parte de la distancia, pero no toda. Este diccionario es genérico
// (lenguaje cotidiano chileno), no ajustado a preguntas del set de evaluación.

const TERMINOS: [RegExp, string][] = [
  [/\bvacacion(es)?\b/i, "feriado anual"],
  [/\b(sueldo|salario|plata|pago)s?\b/i, "remuneración"],
  [/\b(jefe|jefa|patr[oó]n|patrona|empresa)\b/i, "empleador"],
  [/\b(me echaron|echar|me despidieron|despid\w*|correr de la pega)\b/i, "término del contrato de trabajo despido"],
  [/\brenunci\w*\b/i, "renuncia del trabajador término del contrato aviso"],
  [/\b(pega|chamba)\b/i, "trabajo"],
  [/\bhoras? extras?\b/i, "horas extraordinarias"],
  [/\b(dividir|partir|fraccionar|separar)\b/i, "fraccionar"],
  [/\b(juntar|acumular)\b/i, "acumular"],
  [/\bembarazad\w*\b/i, "fuero maternal maternidad"],
  [/\b(guagua|beb[eé]|recién nacido)\b/i, "hijo menor"],
  [/\b(licencia m[eé]dica|estoy enfermo|enferma)\b/i, "licencia por enfermedad"],
  [/\b(almuerzo|almorzar|colaci[oó]n)\b/i, "colación descanso dentro de la jornada"],
  [/\b(día libre|días libres|permiso)\b/i, "permiso"],
  [/\b(contrato a plazo|plazo fijo)\b/i, "contrato de plazo fijo"],
  [/\b(liquidaci[oó]n de sueldo)\b/i, "comprobante de remuneraciones"],
  [/\b(acoso|me acosa|maltrato)\b/i, "acoso laboral acoso sexual"],
  [/\bhome ?office|desde (mi )?casa\b/i, "trabajo a distancia teletrabajo"],
];

/** Devuelve la consulta con los términos legales agregados (si corresponde). */
export function expandirConsulta(q: string): string {
  const extra: string[] = [];
  for (const [re, t] of TERMINOS) if (re.test(q) && !extra.includes(t) && !q.toLowerCase().includes(t)) extra.push(t);
  return extra.length ? `${q} (${extra.join("; ")})` : q;
}
