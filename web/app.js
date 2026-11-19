// Conuco, la web de la demo: cuatro vistas sobre la misma API.
// Esta página no decide nada: precios, cuadre, tope, alarmas y permisos los decide la base.
// Si una regla viviera aquí, bastaría con saltarse la página. Por eso aquí solo se pinta.
// La identidad va en la cabecera x-usuario (en local simula el login de Supabase).

const vista = document.getElementById('vista');
let demo;            // productores, oficiales y compradores de la semilla
let reloj;           // el sondeo de pedidos nuevos de la productora
let chat = [];       // la conversación del simulador de WhatsApp
let compradorId;     // quién escribe en el simulador
let oficialId;       // quién consulta en el portal del banco

const dinero = new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP', maximumFractionDigits: 0 });
const libras = new Intl.NumberFormat('es-DO', { maximumFractionDigits: 0 });
const fecha = (f) => new Date(f.length === 10 ? f + 'T12:00' : f).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' });

const icono = {
  alerta: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4m0-4h.01"/></svg>',
  banco: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10 12 4l9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 21h18"/></svg>',
  campo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-9m0 0c0-4 2.6-6.5 6.5-6.5 0 4-2.6 6.5-6.5 6.5Zm0 0c0-3.2-2.3-5.2-5.3-5.2 0 3.1 2.1 5.2 5.3 5.2Z"/></svg>',
  escudo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
};

async function api(ruta, { metodo = 'GET', cuerpo, usuario, csv } = {}) {
  const cabeceras = {};
  if (usuario) cabeceras['x-usuario'] = usuario;
  if (cuerpo !== undefined) cabeceras['content-type'] = csv ? 'text/csv' : 'application/json';
  const r = await fetch('/api/' + ruta, { method: metodo, headers: cabeceras, body: cuerpo === undefined ? undefined : csv ? cuerpo : JSON.stringify(cuerpo) });
  const datos = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(datos?.error || 'No pudimos hablar con el servidor.'), { estado: r.status });
  return datos;
}

function avisar(texto) {
  const a = document.getElementById('aviso');
  a.textContent = texto;
  a.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => (a.hidden = true), 3200);
}

const falla = (err) => `<div class="nota mala">${icono.alerta}<span>${e(err.message)}</span></div>`;
const productora = () => demo.productores[0];
const nombreOficial = (id) => demo.oficiales.find((o) => o.id === id)?.nombre ?? 'el banco';

// ---------------------------------------------------------------- Productora
// La app del teléfono de la productora: su historial, lo que le deben, su inventario
// y a quién le deja ver todo eso.
async function verProductora() {
  const yo = productora();
  vista.innerHTML = `<div class="angosta">
    <div class="etiqueta">Mi conuco</div>
    <h1>Hola, ${e(yo.nombre.split(' ')[0])}. Tu historial <em>crece solo</em></h1>
    <p class="sub">Cada venta que te pagan por transferencia al Banco Agrícola se anota sola. El efectivo no suma.</p>
    <div id="p-resumen"><p class="cargando">Cargando tu historial…</p></div>
    <h2>Por cobrar</h2><p class="chico">Pedidos que esperan la transferencia.</p><div id="p-pendientes"></div>
    <h2>Tus ventas</h2><div id="p-ventas"></div>
    <h2>Lo que tienes hoy</h2><p class="chico">Es lo que el asistente de WhatsApp les ofrece a tus compradores.</p><div id="p-inventario"></div>
    <h2>Tú decides quién <em>ve tu historial</em></h2><p class="chico">Cada permiso es aparte. Lo puedes quitar cuando quieras, y vence solo.</p><div id="p-permisos"></div>
  </div>`;
  let antes = null;
  const refrescar = async () => {
    try {
      const [pedidos, finca] = await Promise.all([api('mis-pedidos', { usuario: yo.id }), api('finca', { usuario: yo.id })]);
      const nuevos = antes ? pedidos.filter((p) => !antes.has(p.id)) : [];
      const cambio = !antes || nuevos.length || pedidos.some((p) => antes.get(p.id) !== p.estado);
      if (nuevos.length) avisar(`Pedido nuevo de ${nuevos[0].comprador}: ${dinero.format(nuevos[0].monto)}`);
      if (cambio) pintarPedidos(pedidos, finca, new Set(nuevos.map((p) => p.id)));
      antes = new Map(pedidos.map((p) => [p.id, p.estado]));
    } catch (err) { document.getElementById('p-resumen').innerHTML = falla(err); }
  };
  await refrescar();
  // atajo: sondeo cada 3 s en la demo; con Supabase se cambia por su tiempo real.
  reloj = setInterval(refrescar, 3000);
  pintarInventario();
  pintarPermisos();
}

function pintarPedidos(pedidos, finca, nuevos) {
  const pagadas = pedidos.filter((p) => p.estado !== 'pendiente');
  const verificadas = pagadas.filter((p) => p.estado === 'verificada');
  const pendientes = pedidos.filter((p) => p.estado === 'pendiente');
  const vendidas = pagadas.reduce((s, p) => s + p.libras, 0);
  const tope = finca?.tope;
  document.getElementById('p-resumen').innerHTML = `<div class="resumen">
    <div class="chico" style="color:inherit">Ventas verificadas</div>
    <div class="cifra">${dinero.format(verificadas.reduce((s, p) => s + p.monto, 0))}</div>
    <div class="trio">
      <div><b>${verificadas.length}</b><span>verificadas</span></div>
      <div><b>${pagadas.length - verificadas.length}</b><span>retenidas</span></div>
      <div><b>${pendientes.length}</b><span>por cobrar</span></div>
    </div>
    ${tope ? `<div class="tope${vendidas > tope ? ' pasado' : ''}">${libras.format(vendidas)} de ${libras.format(tope)} lb vendidas, de las que tu finca puede dar esta temporada
      <div class="riel" role="progressbar" aria-label="Libras vendidas contra el tope de la finca" aria-valuemin="0" aria-valuemax="${tope}" aria-valuenow="${vendidas}"><i style="width:${Math.min(100, (vendidas / tope) * 100)}%"></i></div></div>`
    : '<div class="tope">El técnico del banco todavía no ha anotado tu finca.</div>'}
  </div>`;
  document.getElementById('p-pendientes').innerHTML = pendientes.length
    ? `<ul class="lista">${pendientes.map((p) => filaVenta(p, nuevos.has(p.id))).join('')}</ul>`
    : '<p class="vacio">No te deben nada ahora mismo.</p>';
  document.getElementById('p-ventas').innerHTML = pagadas.length
    ? `<ul class="lista">${pagadas.map((p) => filaVenta(p, nuevos.has(p.id))).join('')}</ul>`
    : '<p class="vacio">Todavía no tienes ventas pagadas por transferencia.</p>';
}

function filaVenta(p, nueva) {
  const nombre = { verificada: 'Verificada', retenida: 'Retenida', pendiente: 'Esperando pago' }[p.estado] ?? p.estado;
  return `<li class="tarjeta venta${nueva ? ' nueva' : ''}">
    <b>${e(p.comprador)}</b><span class="monto">${dinero.format(p.monto)}</span>
    <span class="chico">${libras.format(p.libras)} lb de ${e(p.producto)} · ${fecha(p.fecha_pago ?? p.creado)}</span>
    <span class="estado ${e(p.estado)}">${nombre}</span>
    ${(p.alarmas ?? []).map((a) => `<span class="alarma">${icono.alerta}<span>${e(a[0].toUpperCase() + a.slice(1))}. No suma hasta que el banco lo revise.</span></span>`).join('')}
  </li>`;
}

async function pintarInventario() {
  const caja = document.getElementById('p-inventario');
  const yo = productora().id;
  try {
    const inv = await api('inventario?productor=' + yo);
    if (!inv.length) { caja.innerHTML = '<p class="vacio">No tienes productos anotados.</p>'; return; }
    caja.innerHTML = `<div class="leyenda"><span>Producto</span><span>Libras</span><span>RD$ / lb</span></div>
      <form class="lista" id="inventario">${inv.map((i, n) => `<div class="tarjeta fila-inv">
        <label for="lb${n}">${e(i.producto)}</label>
        <input class="campo" id="lb${n}" name="libras" type="number" min="0" step="1" value="${i.libras}" data-producto="${e(i.producto)}" aria-label="Libras de ${e(i.producto)}">
        <input class="campo" name="precio" type="number" min="1" step="0.5" value="${i.precio}" aria-label="Precio por libra de ${e(i.producto)}">
      </div>`).join('')}
      <button class="boton" type="submit">Guardar inventario</button></form>`;
    document.getElementById('inventario').onsubmit = async (ev) => {
      ev.preventDefault();
      const boton = ev.submitter;
      boton.disabled = true;
      try {
        for (const fila of ev.target.querySelectorAll('.fila-inv')) {
          const [lb, precio] = fila.querySelectorAll('input');
          await api('inventario', { metodo: 'PUT', usuario: yo, cuerpo: { producto: lb.dataset.producto, libras: Number(lb.value), precio: Number(precio.value) } });
        }
        avisar('Inventario guardado');
      } catch (err) { avisar(err.message); }
      boton.disabled = false;
    };
  } catch (err) { caja.innerHTML = falla(err); }
}

async function pintarPermisos() {
  const caja = document.getElementById('p-permisos');
  const yo = productora().id;
  try {
    const vigentes = new Map((await api('permisos', { usuario: yo })).filter((p) => new Date(p.vence) > new Date()).map((p) => [p.oficial, p]));
    caja.innerHTML = `<ul class="lista">${demo.oficiales.map((o) => {
      const p = vigentes.get(o.id);
      return `<li class="tarjeta permiso">
        <span class="icono">${o.rol === 'tecnico' ? icono.campo : icono.banco}</span>
        <label for="o-${e(o.id)}"><b>${e(o.nombre)}</b><br><span class="chico">Banco Agrícola · ${o.rol === 'tecnico' ? 'técnico de campo' : 'oficial de crédito'}</span></label>
        <input class="interruptor" type="checkbox" role="switch" id="o-${e(o.id)}" data-oficial="${e(o.id)}" ${p ? 'checked' : ''}>
        <p>${p ? `Puede ver tus ventas confirmadas y sus alarmas hasta el ${fecha(p.vence)}.` : 'No ve nada.'}${o.rol === 'tecnico' ? ' Con permiso, anota tu finca en su visita.' : ''}</p>
      </li>`;
    }).join('')}</ul><p class="ley">Ley 172-13: tu permiso se pide aparte para cada persona, es solo para esto y cada consulta queda anotada.</p>`;
    caja.querySelectorAll('.interruptor').forEach((s) => (s.onchange = async () => {
      s.disabled = true;
      try {
        await api('permisos', { metodo: s.checked ? 'POST' : 'DELETE', usuario: yo, cuerpo: s.checked ? { oficial: s.dataset.oficial, dias: 30 } : { oficial: s.dataset.oficial } });
        avisar(s.checked ? `Permiso dado por 30 días a ${nombreOficial(s.dataset.oficial)}` : `Le quitaste el permiso a ${nombreOficial(s.dataset.oficial)}`);
        pintarPermisos();
      } catch (err) { avisar(err.message); s.checked = !s.checked; s.disabled = false; }
    }));
  } catch (err) { caja.innerHTML = falla(err); }
}

// ----------------------------------------------------------------- Comprador
// Simula el WhatsApp del comprador. En producción conversa el agente de IA
// (supabase/functions/whatsapp); aquí se llama directo a la misma herramienta,
// crear_pedido, para que la demo corra sin claves.
async function verComprador() {
  compradorId ??= demo.compradores[0].id;
  const c = demo.compradores.find((x) => x.id === compradorId);
  const yo = productora();
  vista.innerHTML = `<div class="angosta">
    <div class="etiqueta">WhatsApp del comprador</div>
    <h1>Pide como <em>siempre</em></h1>
    <p class="sub">Escoge quién escribe. El Primo tiene el mismo teléfono que la productora: es el caso de la venta arreglada.</p>
    <label class="chico" for="quien" style="display:block;margin-top:16px">Comprador</label>
    <select class="campo" id="quien">${demo.compradores.map((x) => `<option value="${x.id}" ${x.id === compradorId ? 'selected' : ''}>${e(x.nombre)}</option>`).join('')}</select>
    <div class="chat" id="chat"><p class="cargando">Cargando…</p></div>
    <form class="pedir" id="pedir"></form>
  </div>`;
  document.getElementById('quien').onchange = (ev) => { compradorId = Number(ev.target.value); chat = []; verComprador(); };
  try {
    const inv = await api('inventario?productor=' + yo.id);
    if (!chat.length) chat.push({ de: 'finca', texto: `¡Buenas! Esto es lo que tiene ${yo.nombre.split(' ')[0]} hoy:\n` + (inv.length ? inv.map((i) => `· ${i.producto}: ${libras.format(i.libras)} lb a ${dinero.format(i.precio)} la libra`).join('\n') : 'Por ahora no hay nada disponible.') });
    pintarChat();
    const form = document.getElementById('pedir');
    form.innerHTML = inv.length ? `
      <select class="campo" name="producto" aria-label="Producto">${inv.map((i) => `<option>${e(i.producto)}</option>`).join('')}</select>
      <input class="campo" name="libras" type="number" min="1" step="1" value="100" aria-label="Libras" required>
      <button class="boton" type="submit">Pedir</button>` : '';
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const lb = Number(f.get('libras'));
      chat.push({ de: 'yo', texto: `Mándame ${libras.format(lb)} lb de ${f.get('producto')}` });
      pintarChat();
      try {
        const p = await api('pedidos', { metodo: 'POST', cuerpo: { productor: yo.id, telefono: c.telefono, nombre: c.nombre, producto: f.get('producto'), libras: lb } });
        chat.push({ de: 'finca', texto: `Listo, pedido #${p.id}: ${libras.format(p.libras)} lb de ${p.producto}.\nSon ${dinero.format(p.monto)}. Transfiere a la cuenta ${p.cuenta_banco_agricola} del Banco Agrícola.`, pagar: p });
      } catch (err) { chat.push({ de: 'finca', texto: `No se pudo: ${err.message}` }); }
      pintarChat();
    };
  } catch (err) { document.getElementById('chat').innerHTML = falla(err); }
}

function pintarChat() {
  const caja = document.getElementById('chat');
  caja.innerHTML = chat.map((m, n) => `<div class="globo ${m.de}">${e(m.texto)}${m.pagar && !m.pagado ? `<button class="boton" type="button" data-n="${n}">Transferir ${dinero.format(m.pagar.monto)} desde mi banco</button>` : ''}</div>`).join('');
  caja.querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => transferir(chat[b.dataset.n], b)));
  caja.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

// La transferencia la hace el banco, no Conuco: aquí se simula el movimiento
// que el banco nos pasaría. El cuadre con el pedido lo hace la base al recibirlo.
async function transferir(m, boton) {
  const c = demo.compradores.find((x) => x.id === compradorId);
  boton.disabled = true;
  try {
    const mov = await api('movimientos', { metodo: 'POST', cuerpo: { cuenta_origen: c.cuenta, cuenta_destino: m.pagar.cuenta_banco_agricola, monto: m.pagar.monto } });
    m.pagado = true;
    chat.push({ de: 'sistema', texto: mov.pedido ? `Transferencia recibida. Conuco la cuadró con el pedido #${mov.pedido}.` : 'Transferencia recibida, pero no cuadró con ningún pedido: se guarda y no suma.' });
    chat.push({ de: 'finca', texto: '¡Gracias! Ya le llegó a la productora. Mírala en la pestaña Productora.' });
  } catch (err) { chat.push({ de: 'sistema', texto: err.message }); boton.disabled = false; }
  pintarChat();
}

// ---------------------------------------------------------------------- Banco
// El portal del Banco Agrícola: consultar el perfil (solo con permiso), anotar la
// finca en la visita y pasar el archivo diario de movimientos.
async function verBanco() {
  oficialId ??= demo.oficiales[0].id;
  const o = demo.oficiales.find((x) => x.id === oficialId);
  const yo = productora();
  vista.innerHTML = `<div class="ancha">
    <div class="etiqueta">Portal del Banco Agrícola</div>
    <h1>El historial que <em>nadie puede inventar</em></h1>
    <p class="sub">El banco no recibe un PDF del productor: consulta aquí, con su permiso, lo que salió del dinero.</p>
    <div class="columnas">
      <div class="pila">
        <div class="tarjeta"><b>Quién consulta</b>
          <div class="opciones">${demo.oficiales.map((x) => `<button class="opcion" type="button" data-oficial="${e(x.id)}" aria-pressed="${x.id === oficialId}">${e(x.nombre)}<small>${x.rol === 'tecnico' ? 'Técnico de campo' : 'Oficial de crédito'}</small></button>`).join('')}</div>
        </div>
        ${o.rol === 'tecnico' ? `<form class="tarjeta pila" id="finca"><b>Anotar la finca en la visita</b>
          <span class="chico">El tope de lo que ${e(yo.nombre.split(' ')[0])} puede vender sale de aquí.</span>
          <label>Cultivo<input class="campo" name="cultivo" value="plátano" required></label>
          <label>Tareas<input class="campo" name="tareas" type="number" min="1" step="0.5" value="40" required></label>
          <label>Libras por tarea en la temporada<input class="campo" name="rendimiento" type="number" min="1" step="1" value="250" required></label>
          <button class="boton" type="submit">Anotar finca</button><div id="finca-r"></div></form>` : ''}
        <form class="tarjeta pila" id="csv"><b>Movimientos del día</b>
          <span class="chico">El archivo que el banco nos pasa. Conuco cuadra cada pago con su pedido por monto, fecha y cuenta.</span>
          <textarea class="campo" name="csv" aria-label="Movimientos en CSV" spellcheck="false" wrap="off"></textarea>
          <button class="boton" type="submit">Pasar el archivo</button><div id="csv-r"></div></form>
      </div>
      <div><button class="boton" type="button" id="consultar">Consultar a ${e(yo.nombre)}</button><div id="perfil"></div></div>
    </div></div>`;
  vista.querySelectorAll('[data-oficial]').forEach((b) => (b.onclick = () => { oficialId = b.dataset.oficial; verBanco(); }));
  document.getElementById('consultar').onclick = consultar;
  document.getElementById('csv').onsubmit = pasarCsv;
  document.getElementById('finca')?.addEventListener('submit', anotarFinca);
  // Para la demo, el archivo trae el pago de un pedido pendiente y una transferencia suelta.
  const area = document.querySelector('#csv textarea');
  area.value = 'id,cuenta_origen,cuenta_destino,monto,fecha\n';
  try {
    const pendiente = (await api('mis-pedidos', { usuario: yo.id })).find((p) => p.estado === 'pendiente');
    const c = pendiente && demo.compradores.find((x) => x.telefono === pendiente.telefono);
    const n = Date.now().toString().slice(-6);
    if (c?.cuenta) area.value += `BA-${n}-1,${c.cuenta},${yo.cuenta},${pendiente.monto},${hoy()}\n`;
    area.value += `BA-${n}-2,BA-0999,${yo.cuenta},850,${hoy()}\n`;
  } catch { /* sin ejemplo: el área queda con la cabecera y se puede escribir a mano */ }
}

async function consultar() {
  const caja = document.getElementById('perfil');
  const yo = productora();
  caja.innerHTML = '<p class="cargando">Consultando…</p>';
  try {
    const filas = await api('perfil?productor=' + yo.id, { usuario: oficialId });
    const ver = filas.filter((f) => f.estado === 'verificada');
    const ret = filas.filter((f) => f.estado !== 'verificada');
    caja.innerHTML = `<div class="cuatro">
        <div><b>${dinero.format(ver.reduce((s, f) => s + f.monto, 0))}</b><span>vendido y verificado</span></div>
        <div><b>${ver.length}</b><span>ventas verificadas</span></div>
        <div><b>${ret.length}</b><span>retenidas</span></div>
        <div><b>${new Set(ver.map((f) => f.comprador)).size}</b><span>compradores distintos</span></div>
      </div>
      ${filas.length ? `<div class="tabla-envuelta"><table><thead><tr><th>Fecha</th><th>Comprador</th><th class="num">Libras</th><th class="num">Monto</th><th>Estado</th></tr></thead><tbody>
        ${filas.map((f) => `<tr><td>${fecha(f.fecha)}</td><td>${e(f.comprador)}${f.alarmas.map((a) => `<div class="chico" style="color:var(--rojo)">${e(a)}</div>`).join('')}</td><td class="num">${libras.format(f.libras)}</td><td class="num">${dinero.format(f.monto)}</td><td><span class="estado ${e(f.estado)}">${f.estado === 'verificada' ? 'Verificada' : 'Retenida'}</span></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="vacio">Todavía no tiene ventas pagadas por transferencia.</p>'}
      <div class="nota">${icono.info}<span>Esta consulta quedó anotada en el registro: quién miró y cuándo.</span></div>`;
  } catch (err) {
    caja.innerHTML = err.estado === 403
      ? `<div class="nota mala">${icono.escudo}<span><b>Sin permiso de ${e(yo.nombre.split(' ')[0])}, o ya venció.</b> Ella lo da desde su app, en «Tú decides quién ve tu historial».</span></div>`
      : falla(err);
  }
}

async function anotarFinca(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const r = document.getElementById('finca-r');
  try {
    await api('finca', { metodo: 'POST', usuario: oficialId, cuerpo: { productor: productora().id, cultivo: f.get('cultivo'), tareas: Number(f.get('tareas')), rendimiento: Number(f.get('rendimiento')) } });
    r.innerHTML = `<div class="nota">${icono.info}<span>Finca anotada. El nuevo tope ya cuenta en el historial.</span></div>`;
  } catch (err) { r.innerHTML = falla(err); }
}

async function pasarCsv(ev) {
  ev.preventDefault();
  const r = document.getElementById('csv-r');
  try {
    const x = await api('movimientos/csv', { metodo: 'POST', csv: true, cuerpo: new FormData(ev.target).get('csv') });
    r.innerHTML = `<div class="nota">${icono.info}<span>${x.leidos} movimientos leídos, ${x.cuadrados} cuadrados con un pedido${x.repetidos ? `, ${x.repetidos} ya estaban` : ''}. Los que no cuadran se guardan y no suman.</span></div>`;
  } catch (err) { r.innerHTML = falla(err); }
}

// ------------------------------------------------------------------- Registro
// Cada paso guarda la huella SHA-256 del anterior. Si alguien cambia un dato viejo,
// la cadena deja de cuadrar desde esa fila y se ve aquí.
async function verRegistro() {
  vista.innerHTML = `<div class="ancha">
    <div class="etiqueta">Registro encadenado</div>
    <h1>Si alguien cambia un dato, <em>se nota</em></h1>
    <p class="sub">La base no deja editar ni borrar el registro. Para la demo, el botón rojo se salta ese candado y cambia el monto de un pago viejo.</p>
    <div id="cadena"><p class="cargando">Cargando…</p></div></div>`;
  try {
    const { filas, rotos } = await api('registro');
    const rotas = new Set(rotos.map(Number));
    const pago = filas.find((f) => f.evento.pago && f.evento.monto && !rotas.has(Number(f.id)));
    document.getElementById('cadena').innerHTML = `
      <div class="cadena-estado ${rotos.length ? 'mal' : 'bien'}">${rotos.length ? icono.alerta : icono.escudo}
        <span>${rotos.length ? `La cadena se rompió en la fila ${rotos[0]}: ese dato ya no coincide con su huella. «Reiniciar demo» la deja como estaba.` : `Cadena intacta: ${filas.length} pasos y nadie ha tocado nada.`}</span></div>
      <div class="acciones">
        ${pago && !rotos.length ? `<button class="secundario peligro" type="button" id="alterar">Cambiar el pago de la fila ${pago.id}: ${dinero.format(pago.evento.monto)} a ${dinero.format(pago.evento.monto * 10)}</button>` : ''}
      </div>
      <div class="tabla-envuelta"><table class="cadena"><thead><tr><th>#</th><th>Qué pasó</th><th>Huella anterior</th><th>Huella</th></tr></thead><tbody>
        ${filas.slice().reverse().map((f) => `<tr class="eslabon${rotas.has(Number(f.id)) ? ' roto' : ''}"><td>${f.id}</td><td>${e(describir(f.evento))}<div class="chico">${new Date(f.creado).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' })}</div></td><td title="${e(f.previa)}">${e(f.previa.slice(0, 12))}</td><td title="${e(f.huella)}">${e(f.huella.slice(0, 12))}</td></tr>`).join('')}
      </tbody></table></div>`;
    document.getElementById('alterar')?.addEventListener('click', async () => {
      try {
        await api('demo/alterar', { metodo: 'POST', cuerpo: { id: pago.id, evento: { ...pago.evento, monto: pago.evento.monto * 10 } } });
        verRegistro();
      } catch (err) { avisar(err.message); }
    });
  } catch (err) { document.getElementById('cadena').innerHTML = falla(err); }
}

// Lo que dice cada evento, en palabras. Lo que no se reconoce sale tal cual.
function describir(ev) {
  if (ev.consulta) return `${nombreOficial(ev.por)} consultó el perfil`;
  if (ev.pago) return ev.pedido ? `Pago ${ev.pago} de ${dinero.format(ev.monto)}, cuadrado con el pedido #${ev.pedido}` : `Pago ${ev.pago} de ${dinero.format(ev.monto)} sin pedido: no suma`;
  if (ev.pedido) return `Pedido #${ev.pedido} por ${dinero.format(ev.monto)}`;
  if (ev.permiso) return `Permiso a ${nombreOficial(ev.a)} por ${ev.dias} días`;
  if (ev.quitar_permiso || ev.quita) return `Permiso quitado a ${nombreOficial(ev.a ?? ev.quitar_permiso ?? ev.quita)}`;
  if (ev.finca) return `${nombreOficial(ev.por)} anotó la finca: ${ev.tareas} tareas, ${ev.rendimiento} lb por tarea`;
  return JSON.stringify(ev);
}

// ------------------------------------------------------------------ Arranque
const vistas = { productora: verProductora, comprador: verComprador, banco: verBanco, registro: verRegistro };

async function mostrar() {
  clearInterval(reloj);
  const nombre = vistas[location.hash.slice(1)] ? location.hash.slice(1) : 'productora';
  document.querySelectorAll('.barra nav a').forEach((a) => (a.hash === '#' + nombre ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  try {
    demo ??= await api('demo');
    await vistas[nombre]();
  } catch (err) { vista.innerHTML = `<div class="angosta">${falla(err)}</div>`; }
  scrollTo(0, 0);
}

document.getElementById('reiniciar').onclick = async () => {
  if (!confirm('¿Volver la demo al principio? Se borra todo lo que hiciste.')) return;
  try {
    await api('demo/reiniciar', { metodo: 'POST' });
    demo = null; chat = []; compradorId = oficialId = undefined;
    avisar('Demo reiniciada');
    mostrar();
  } catch (err) { avisar(err.message); }
};
addEventListener('hashchange', mostrar);
mostrar();
