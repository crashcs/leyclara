// Si la página se abrió por http://, pasar a https:// (no en desarrollo local).
if (location.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  location.replace(`https://${location.host}${location.pathname}${location.search}${location.hash}`);
}

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
    $("pie-version").textContent = `· ${fmtFecha(m.fecha_version, true)}`;
    $("pie-fuente").href = m.fuente || $("pie-fuente").href;
    const r0 = m.ultima_revision?.revisado;
    if (r0) {
      const d = new Date(r0);
      const hoy = new Date().toDateString() === d.toDateString();
      const cuando = hoy
        ? `hoy, ${d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}`
        : `el ${d.toLocaleDateString("es-CL", { day: "numeric", month: "short" })}`;
      const conError = (m.ultima_revision.normas || []).some((n) => n.estado === "error");
      $("pie-rev").textContent = conError ? `Última revisión con errores (${cuando})` : `Revisado en Ley Chile ${cuando}`;
      $("pie-rev").title = "Ley Clara revisa una vez al día si Ley Chile publicó una versión nueva";
      $("pie-rev").hidden = false;
    }
    if (m.turnstile_site_key) iniciarTurnstile(m.turnstile_site_key);
  } catch {
    /* sin metadatos: el pie muestra solo el nombre de la ley */
  }
}

/* ---------- Render de una respuesta ---------- */
function renderTurno(turno, d) {
  // Numera las citas en orden de aparición del marcador [Art. N].
  // Igual que claveNumero() del Worker: "primero transitorio, Ley 21.561" == "Primero transitorio de la Ley 21.561"
  const clave = (n) => n.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^a-z0-9]+/g, " ").trim()
    .split(" ").filter((w) => w && !["de", "la", "del", "el", "art", "articulo"].includes(w)).join(" ");
  const porNumero = new Map(d.citas.map((c) => [clave(c.numero), c]));
  const orden = [];
  const idx = (c) => {
    let i = orden.findIndex((x) => x.articulo_id === c.articulo_id);
    if (i === -1) { orden.push(c); i = orden.length - 1; }
    return i + 1;
  };
  let cuerpo = escapar(d.respuesta).replace(/\s*\[(Art(?:ículo|\.)?\s*)?([^\]]{1,80}?)\]/gi, (todo, pref, num) => {
    const c = porNumero.get(clave(num));
    if (!c) return pref ? "" : todo; // [texto] que no es una cita: se deja tal cual
    const n = idx(c);
    return `<button type="button" class="cit" data-art="${escapar(c.articulo_id)}" aria-label="Cita ${n}: artículo ${escapar(c.numero)}">${n}</button>`;
  });
  for (const c of d.citas) idx(c); // citas sin marcador también van a fuentes
  cuerpo = cuerpo.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

  const meta = `<span>Código del Trabajo, versión del ${escapar(fmtFecha(d.fecha_version))}. Fuente: Ley Chile – BCN. No es asesoría legal.</span>`;
  const acciones = (pregunta) => `
    <div class="acciones-resp" data-pregunta="${escapar(pregunta)}">
      <span class="valorar"><span class="valorar-txt">¿Te sirvió?</span>
        <button type="button" class="btn-ico" data-util="1" aria-label="Sí, me sirvió">👍</button>
        <button type="button" class="btn-ico" data-util="0" aria-label="No me sirvió">👎</button>
      </span>
      <span class="acciones-der">
        <button type="button" class="btn-txt" data-accion="copiar">Copiar</button>
        <button type="button" class="btn-txt" data-accion="compartir">Compartir</button>
      </span>
    </div>`;
  turno._datos = d;

  if (d.sin_base_legal) {
    turno.querySelector(".turno-cuerpo").innerHTML = `
      <div class="sin-base"><div class="respuesta"><p>${escapar(d.respuesta)}</p></div></div>
      <div class="turno-meta">${meta}</div>
      ${acciones(turno.dataset.pregunta)}`;
    return;
  }

  const fuentes = orden.map((c, i) => `
    <li><button type="button" class="fuente-card" data-art="${escapar(c.articulo_id)}">
      <span class="fc-top"><span class="fc-n">${i + 1}</span><span class="fc-art">Artículo ${escapar(c.numero.replace(/, .*$/, ""))}</span></span>
      <span class="fc-ruta">${escapar(c.norma && c.norma !== "Código del Trabajo" ? c.norma : (c.ruta || "").split(" › ").slice(0, -1).pop() || "")}</span>
      <span class="fc-frag">“${escapar(c.fragmento)}”</span>
    </button></li>`).join("");

  turno.querySelector(".turno-cuerpo").innerHTML = `
    <div class="respuesta">${cuerpo}</div>
    ${d.advertencia ? `<p class="nota">${escapar(d.advertencia)}</p>` : ""}
    <p class="fuentes-titulo">Fuentes</p>
    <ul class="fuentes">${fuentes}</ul>
    <div class="turno-meta">${meta}</div>
    ${acciones(turno.dataset.pregunta)}`;
}

/* ---------- Preguntar ---------- */
/* ---------- Cloudflare Turnstile (opcional) ---------- */
let tsWidget = null;
let tsPendiente = null;
let tsListo = null; // promesa que se resuelve cuando el widget está montado
function iniciarTurnstile(sitekey) {
  let listo;
  tsListo = new Promise((r) => (listo = r));
  window.onTurnstileListo = () => {
    tsWidget = window.turnstile.render("#turnstile", {
      sitekey,
      execution: "execute",
      appearance: "interaction-only",
      callback: (token) => tsPendiente?.resolve(token),
      "error-callback": () => tsPendiente?.reject(new Error("No pudimos verificar que eres una persona. Recarga la página.")),
    });
    listo();
  };
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileListo";
  s.async = true;
  document.head.appendChild(s);
}
async function tokenTurnstile() {
  if (tsListo) await Promise.race([tsListo, new Promise((r) => setTimeout(r, 8000))]);
  if (tsWidget === null || !window.turnstile) return undefined;
  return new Promise((resolve, reject) => {
    tsPendiente = { resolve, reject };
    window.turnstile.reset(tsWidget);
    window.turnstile.execute(tsWidget);
  });
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
  turno.dataset.pregunta = pregunta;
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
    const turnstile = await tokenTurnstile();
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pregunta, turnstile }),
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
    const sinRed = e instanceof TypeError; // fetch() falló antes de recibir respuesta
    const msg = sinRed
      ? "No pude conectarme con el servidor. Revisa tu conexión y recarga la página."
      : `No pude responder: ${e.message}`;
    turno.querySelector(".turno-cuerpo").innerHTML = `<p class="error">${escapar(msg)}</p>`;
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
  const corto = a.numero.replace(/, .*$/, ""); // "primero transitorio, Ley 21.561" -> "primero transitorio"
  $("art-titulo").textContent = `Artículo ${corto}`;
  $("lector-etq").textContent = `${a.norma_nombre || "Código del Trabajo"} · Art. ${corto}`;
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
/* ---------- Valorar, copiar y compartir ---------- */
async function valorar(boton) {
  const caja = boton.closest(".acciones-resp");
  const turno = boton.closest(".turno");
  const d = turno?._datos;
  if (!caja || !d || caja.dataset.valorado) return;
  caja.dataset.valorado = "1";
  const util = boton.dataset.util === "1";
  caja.querySelectorAll("[data-util]").forEach((b) => (b.disabled = true));
  boton.setAttribute("aria-pressed", "true");
  try {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pregunta: caja.dataset.pregunta,
        util,
        citas: d.citas.map((c) => c.articulo_id),
        abstencion: !!d.sin_base_legal,
        huella: d.huella,
      }),
    });
    caja.querySelector(".valorar-txt").textContent = util ? "¡Gracias!" : "Gracias, nos ayuda a mejorar.";
  } catch {
    caja.querySelector(".valorar-txt").textContent = "No se pudo enviar.";
  }
}

const enlaceDe = (pregunta) => `${location.origin}/?q=${encodeURIComponent(pregunta)}`;

function textoParaCopiar(pregunta, d) {
  const respuesta = d.respuesta.replace(/\s*\[(Art(?:ículo|\.)?\s*)?([^\]]{1,80}?)\]/gi, (t, pref, num) => (pref ? ` (Art. ${num})` : t));
  const fuentes = d.citas
    .filter((c, i, l) => l.findIndex((x) => x.articulo_id === c.articulo_id) === i)
    .map((c) => `- Artículo ${c.numero}: ${c.url}`)
    .join("\n");
  return [
    pregunta,
    "",
    respuesta,
    fuentes ? `\nFuentes:\n${fuentes}` : "",
    `\nRespondido por Ley Clara (no es asesoría legal): ${enlaceDe(pregunta)}`,
  ].join("\n");
}

async function copiar(texto, boton, etiqueta) {
  try {
    await navigator.clipboard.writeText(texto);
    boton.textContent = etiqueta;
  } catch {
    boton.textContent = "No se pudo copiar";
  }
  setTimeout(() => (boton.textContent = boton.dataset.accion === "copiar" ? "Copiar" : "Compartir"), 2000);
}

async function accion(boton) {
  const caja = boton.closest(".acciones-resp");
  const d = boton.closest(".turno")?._datos;
  if (!caja || !d) return;
  const pregunta = caja.dataset.pregunta;
  if (boton.dataset.accion === "copiar") return copiar(textoParaCopiar(pregunta, d), boton, "Copiado");
  const url = enlaceDe(pregunta);
  if (navigator.share) {
    try {
      await navigator.share({ title: "Ley Clara", text: pregunta, url });
      return;
    } catch {
      /* cancelado o no disponible: se copia el enlace */
    }
  }
  copiar(url, boton, "Enlace copiado");
}

document.addEventListener("click", (e) => {
  const util = e.target.closest("[data-util]");
  if (util) return valorar(util);
  const acc = e.target.closest("[data-accion]");
  if (acc) accion(acc);
});

$("cerrar").addEventListener("click", cerrarLector);
$("velo").addEventListener("click", cerrarLector);
$("nueva").addEventListener("click", nuevaConsulta);
$("inicio").addEventListener("click", (e) => { e.preventDefault(); nuevaConsulta(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && artAbierto) cerrarLector(); });

pintarRecientes();
cargarMeta().then(() => {
  // Enlace compartido: /?q=pregunta
  const q = new URLSearchParams(location.search).get("q");
  if (q) {
    history.replaceState(null, "", location.pathname);
    preguntar(q.slice(0, 500));
  }
});
