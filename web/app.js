const $ = (id) => document.getElementById(id);
const app = document.querySelector(".app");
const portada = $("portada");
const hilo = $("hilo");
const formHilo = $("form-hilo");
const main = $("main");

const escapar = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtFecha = (iso, corto = false) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CL", {
    day: "numeric", month: corto ? "short" : "long", year: "numeric", timeZone: "UTC",
  });
};

// Fragmentos citados por artículo, para resaltarlos en el lector.
const fragmentos = new Map();
let enCurso = false;

/* ---------- Recientes (solo en este navegador) ---------- */
const CLAVE = "leyclara:recientes";
function leerRecientes() {
  try { return JSON.parse(localStorage.getItem(CLAVE) || "[]"); } catch { return []; }
}
function guardarReciente(q) {
  try {
    const l = [q, ...leerRecientes().filter((x) => x !== q)].slice(0, 8);
    localStorage.setItem(CLAVE, JSON.stringify(l));
  } catch { /* almacenamiento bloqueado: no pasa nada */ }
  pintarRecientes();
}
function pintarRecientes() {
  const l = leerRecientes();
  $("recientes-wrap").hidden = !l.length;
  $("recientes").innerHTML = l.map((q) => `<li><button type="button" data-q="${escapar(q)}" title="${escapar(q)}">${escapar(q)}</button></li>`).join("");
}

/* ---------- Metadatos de la ley ---------- */
async function cargarMeta() {
  try {
    const r = await fetch("/api/meta");
    if (!r.ok) throw new Error(String(r.status));
    const m = await r.json();
    $("d-version").textContent = fmtFecha(m.fecha_version, true);
    $("d-articulos").textContent = m.n_articulos ?? "737";
    $("version").innerHTML = `Código del Trabajo<br><strong>versión del ${escapar(fmtFecha(m.fecha_version))}</strong> · <a href="${escapar(m.fuente)}" target="_blank" rel="noopener">fuente</a>`;
  } catch {
    $("version").textContent = "Código del Trabajo de Chile";
  }
}

/* ---------- Render de una respuesta ---------- */
function renderTurno(turno, d) {
  // Numera las citas en orden de aparición del marcador [Art. N].
  const porNumero = new Map(d.citas.map((c) => [c.numero.toLowerCase(), c]));
  const orden = [];
  const idx = (c) => {
    let i = orden.findIndex((x) => x.articulo_id === c.articulo_id);
    if (i === -1) { orden.push(c); i = orden.length - 1; }
    return i + 1;
  };
  let cuerpo = escapar(d.respuesta).replace(/\s*\[Art(?:ículo|\.)?\s*([^\]]+?)\]/gi, (_, num) => {
    const c = porNumero.get(num.trim().toLowerCase());
    if (!c) return "";
    const n = idx(c);
    return `<button type="button" class="cit" data-art="${escapar(c.articulo_id)}" aria-label="Cita ${n}: artículo ${escapar(c.numero)}">${n}</button>`;
  });
  for (const c of d.citas) idx(c); // citas sin marcador también van a fuentes
  cuerpo = cuerpo.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

  const meta = [
    `Código del Trabajo, versión del ${escapar(fmtFecha(d.fecha_version))}`,
    d.modelo ? (d.modelo.includes("sonnet") ? "Modo preciso" : "Modo rápido") : "",
  ].filter(Boolean).map((t) => `<span>${t}</span>`).join("");

  if (d.sin_base_legal) {
    turno.querySelector(".turno-cuerpo").innerHTML = `
      <div class="sin-base"><div class="respuesta"><p>${escapar(d.respuesta)}</p></div></div>
      <div class="turno-meta">${meta}</div>`;
    return;
  }

  const fuentes = orden.map((c, i) => `
    <li><button type="button" class="fuente-card" data-art="${escapar(c.articulo_id)}">
      <span class="fc-top"><span class="fc-n">${i + 1}</span><span class="fc-art">Artículo ${escapar(c.numero)}</span></span>
      <span class="fc-ruta">${escapar((c.ruta || "").split(" › ").slice(0, -1).pop() || "")}</span>
      <span class="fc-frag">“${escapar(c.fragmento)}”</span>
    </button></li>`).join("");

  turno.querySelector(".turno-cuerpo").innerHTML = `
    <div class="respuesta">${cuerpo}</div>
    ${d.advertencia ? `<p class="nota">${escapar(d.advertencia)}</p>` : ""}
    <p class="fuentes-titulo">Fuentes</p>
    <ul class="fuentes">${fuentes}</ul>
    <div class="turno-meta">${meta}</div>`;
}

/* ---------- Preguntar ---------- */
function modoPreciso() {
  return [...document.querySelectorAll("[data-preciso]")].some((x) => x.checked);
}

async function preguntar(pregunta) {
  pregunta = pregunta.trim();
  if (!pregunta || enCurso) return;
  enCurso = true;
  portada.hidden = true;
  hilo.hidden = false;
  formHilo.hidden = false;

  const turno = document.createElement("article");
  turno.className = "turno";
  turno.innerHTML = `
    <h2 class="turno-preg">${escapar(pregunta)}</h2>
    <div class="turno-cuerpo"><div class="cargando">
      <span class="estado">Buscando en los artículos del Código del Trabajo…</span>
      <div class="linea-sk" style="width:96%"></div><div class="linea-sk" style="width:88%"></div><div class="linea-sk" style="width:64%"></div>
    </div></div>`;
  hilo.appendChild(turno);
  turno.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll(".btn-enviar").forEach((b) => (b.disabled = true));

  const estado = turno.querySelector(".estado");
  const t = setTimeout(() => estado && (estado.textContent = "Redactando la respuesta y verificando cada cita…"), 1400);
  try {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pregunta, modelo: modoPreciso() ? "preciso" : "rapido" }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    for (const c of d.citas) {
      const l = fragmentos.get(c.articulo_id) ?? [];
      l.push(c.fragmento);
      fragmentos.set(c.articulo_id, l);
    }
    renderTurno(turno, d);
    guardarReciente(pregunta);
    if (d.citas[0] && window.matchMedia("(min-width: 1101px)").matches) abrirArticulo(d.citas[0].articulo_id);
  } catch (e) {
    turno.querySelector(".turno-cuerpo").innerHTML = `<p class="error">No pude responder: ${escapar(e.message)}</p>`;
  } finally {
    clearTimeout(t);
    enCurso = false;
    document.querySelectorAll(".btn-enviar").forEach((b) => (b.disabled = false));
  }
}

/* ---------- Lector de artículos ---------- */
function resaltar(textoEscapado, frags) {
  let out = textoEscapado;
  for (const f of frags) {
    const fe = escapar(f.trim());
    if (fe && out.includes(fe)) out = out.replace(fe, `<mark>${fe}</mark>`);
  }
  return out;
}

let artAbierto = null;
async function abrirArticulo(id) {
  const r = await fetch(`/api/articulos/${encodeURIComponent(id)}`);
  if (!r.ok) return;
  const a = await r.json();
  artAbierto = id;
  const partes = a.ruta_str.split(" › ");
  $("art-ruta").textContent = partes.slice(0, -1).join(" › ");
  $("art-titulo").textContent = `Artículo ${a.numero}`;
  $("lector-etq").textContent = `Código del Trabajo · Art. ${a.numero}`;
  $("art-meta").textContent = `${a.derogado ? "Derogado · " : ""}Última modificación: ${fmtFecha(a.fecha_version)}`;
  $("art-texto").innerHTML = a.texto.split("\n\n").map((p) => `<p>${resaltar(escapar(p), fragmentos.get(id) ?? [])}</p>`).join("");
  $("art-link").href = a.url;
  app.classList.add("con-lector");
  $("lector").setAttribute("aria-hidden", "false");
  $("velo").hidden = false;
  document.querySelectorAll("[data-art]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.art === id)));
  const cuerpo = document.querySelector(".lector-cuerpo");
  cuerpo.scrollTop = 0;
  requestAnimationFrame(() => cuerpo.querySelector("mark")?.scrollIntoView({ block: "center" }));
}
function cerrarLector() {
  app.classList.remove("con-lector");
  $("lector").setAttribute("aria-hidden", "true");
  $("velo").hidden = true;
  document.querySelectorAll("[data-art]").forEach((b) => b.setAttribute("aria-pressed", "false"));
  artAbierto = null;
}

function nuevaConsulta() {
  cerrarLector();
  hilo.innerHTML = "";
  hilo.hidden = true;
  formHilo.hidden = true;
  portada.hidden = false;
  main.scrollTop = 0;
  $("q-portada").focus();
}

/* ---------- Eventos ---------- */
document.addEventListener("click", (e) => {
  const art = e.target.closest("[data-art]");
  if (art) return artAbierto === art.dataset.art ? cerrarLector() : abrirArticulo(art.dataset.art);
  const q = e.target.closest("[data-q]");
  if (q) preguntar(q.dataset.q);
});
document.querySelectorAll("[data-form]").forEach((f) =>
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const ta = f.querySelector("textarea");
    const q = ta.value;
    ta.value = "";
    autoAlto(ta);
    preguntar(q);
  }),
);
function autoAlto(ta) { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; }
document.querySelectorAll("textarea").forEach((ta) => {
  ta.addEventListener("input", () => autoAlto(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.form.requestSubmit(); }
  });
});
document.querySelectorAll("[data-preciso]").forEach((c) =>
  c.addEventListener("change", () => document.querySelectorAll("[data-preciso]").forEach((o) => (o.checked = c.checked))),
);
$("cerrar").addEventListener("click", cerrarLector);
$("velo").addEventListener("click", cerrarLector);
$("nueva").addEventListener("click", nuevaConsulta);
$("inicio").addEventListener("click", (e) => { e.preventDefault(); nuevaConsulta(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && artAbierto) cerrarLector(); });

pintarRecientes();
cargarMeta();
