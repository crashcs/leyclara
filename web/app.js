const $ = (id) => document.getElementById(id);
const mensajes = $("mensajes");
const form = $("form");
const input = $("pregunta");
const enviar = $("enviar");

const escapar = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtFecha = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

// Guarda los fragmentos citados por artículo para resaltarlos en el panel.
const fragmentosPorArticulo = new Map();

async function cargarMeta() {
  try {
    const m = await (await fetch("/api/meta")).json();
    $("version").innerHTML = `Código del Trabajo, versión del <strong>${escapar(fmtFecha(m.fecha_version))}</strong> · <a href="${escapar(m.fuente)}" target="_blank" rel="noopener">fuente</a>`;
  } catch {
    $("version").textContent = "No se pudo cargar la versión de la ley.";
  }
}

function agregar(html, clase) {
  $("vacio")?.remove();
  const div = document.createElement("div");
  div.className = `msg ${clase}`;
  div.innerHTML = html;
  mensajes.appendChild(div);
  mensajes.scrollTop = mensajes.scrollHeight;
  return div;
}

// Convierte "[Art. 67]" en botones que abren el artículo.
function renderRespuesta(texto, citas) {
  const porNumero = new Map(citas.map((c) => [c.numero.toLowerCase(), c]));
  const conChips = escapar(texto).replace(/\[Art(?:ículo|\.)?\s*([^\]]+?)\]/gi, (m, num) => {
    const c = porNumero.get(num.trim().toLowerCase());
    return c ? `<button type="button" class="chip" data-art="${escapar(c.articulo_id)}">Art. ${escapar(c.numero)}</button>` : "";
  });
  return conChips
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function preguntar(pregunta) {
  agregar(escapar(pregunta), "user");
  const cargando = agregar('<span class="cargando">Buscando en el Código del Trabajo…</span>', "bot");
  enviar.disabled = true;
  try {
    const r = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pregunta, modelo: $("preciso").checked ? "preciso" : "rapido" }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    for (const c of d.citas) {
      const lista = fragmentosPorArticulo.get(c.articulo_id) ?? [];
      lista.push(c.fragmento);
      fragmentosPorArticulo.set(c.articulo_id, lista);
    }
    let html = d.sin_base_legal ? `<p class="sinbase">${escapar(d.respuesta)}</p>` : renderRespuesta(d.respuesta, d.citas);
    if (d.citas.length) {
      html += `<div class="citas">${d.citas
        .map((c) => `<button type="button" class="chip" data-art="${escapar(c.articulo_id)}">Art. ${escapar(c.numero)}</button>`)
        .join("")}</div>`;
    }
    if (d.advertencia) html += `<p class="nota">${escapar(d.advertencia)}</p>`;
    html += `<p class="nota">Según el Código del Trabajo vigente al ${escapar(fmtFecha(d.fecha_version))}.</p>`;
    cargando.innerHTML = html;
    if (d.citas[0]) abrirArticulo(d.citas[0].articulo_id);
  } catch (e) {
    cargando.classList.add("error");
    cargando.textContent = `No se pudo responder: ${e.message}`;
  } finally {
    enviar.disabled = false;
    mensajes.scrollTop = mensajes.scrollHeight;
  }
}

function resaltar(textoEscapado, fragmentos) {
  let out = textoEscapado;
  for (const f of fragmentos) {
    const fe = escapar(f.trim());
    if (fe && out.includes(fe)) out = out.replace(fe, `<mark>${fe}</mark>`);
  }
  return out;
}

async function abrirArticulo(id) {
  const r = await fetch(`/api/articulos/${encodeURIComponent(id)}`);
  if (!r.ok) return;
  const a = await r.json();
  $("panel-vacio").hidden = true;
  $("articulo").hidden = false;
  const partes = a.ruta_str.split(" › ");
  $("art-ruta").textContent = partes.slice(0, -1).join(" › ");
  $("art-titulo").textContent = `Artículo ${a.numero}`;
  $("art-meta").textContent = `${a.derogado ? "Derogado · " : ""}Última modificación: ${fmtFecha(a.fecha_version)}`;
  const frags = fragmentosPorArticulo.get(id) ?? [];
  $("art-texto").innerHTML = a.texto
    .split("\n\n")
    .map((p) => `<p>${resaltar(escapar(p), frags)}</p>`)
    .join("");
  $("art-link").href = a.url;
  $("panel").scrollTop = 0;
  if (window.matchMedia("(max-width: 860px)").matches) $("panel").scrollIntoView({ behavior: "smooth" });
}

document.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-art]");
  if (chip) abrirArticulo(chip.dataset.art);
  const ej = e.target.closest(".ejemplo");
  if (ej) preguntar(ej.textContent.trim());
});
$("cerrar").addEventListener("click", () => {
  $("articulo").hidden = true;
  $("panel-vacio").hidden = false;
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  preguntar(q);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

cargarMeta();
