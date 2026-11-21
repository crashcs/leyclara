// Espejo exacto de ingest/leyclara/textnorm.py. Ambos se prueban contra
// shared/textnorm_cases.json para garantizar que consulta e índice coincidan.

export const STOPWORDS = new Set(
  `a al algo algun alguna algunas alguno algunos ante antes aquel aquella aquellas aquellos aqui asi aun
  bajo bien cada cual cuales cualquier como con contra cual cuando cuanto de del desde donde dos e el
  ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estado estan estar este
  esto estos fue fueron ha habia han hasta hay la las le les lo los mas me mi mis mismo mucho muy nada
  ni no nos nosotros o os otra otras otro otros para pero poco por porque que quien quienes se sea sean
  segun ser si sido sin sino sobre son su sus tal tambien tan tanto te tener tiene tienen toda todas
  todo todos tu tus u un una unas uno unos usted ustedes y ya yo`.split(/\s+/).filter(Boolean),
);

const SUFIJOS = [
  "amientos", "imientos", "aciones", "uciones", "amiento", "imiento", "idades", "adoras", "adores",
  "ancias", "encias", "mente", "acion", "ucion", "adora", "ador", "ancia", "encia", "idad",
  "ables", "ibles", "able", "ible", "istas", "ista", "osas", "osos", "osa", "oso",
  "ivas", "ivos", "iva", "ivo",
];

export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function stem(palabra: string): string {
  let w = palabra;
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  for (const suf of SUFIJOS) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
  }
  if (w.endsWith("ces") && w.length > 5) w = w.slice(0, -3) + "z";
  else if (w.endsWith("es") && w.length > 4 && !"aeiou".includes(w[w.length - 3])) w = w.slice(0, -2);
  else if (w.endsWith("s") && w.length > 3) w = w.slice(0, -1);
  if (w.length > 4 && "aeo".includes(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

export function tokens(texto: string): string[] {
  const n = normalizar(texto);
  if (!n) return [];
  return n.split(" ").filter((t) => !STOPWORDS.has(t)).map(stem);
}
