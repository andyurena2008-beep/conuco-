import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const raizWeb = fileURLToPath(new URL('./web', import.meta.url));
const tipos = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function fallo(estado, mensaje) {
  throw Object.assign(new Error(mensaje), { estado });
}

function uuid(valor, campo) {
  if (typeof valor !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(valor))
    fallo(400, `${campo} debe ser un UUID válido.`);
  return valor;
}

function texto(valor, campo) {
  if (typeof valor !== 'string' || !valor.trim() || /\p{Cc}/u.test(valor))
    fallo(400, `Revisa el campo ${campo}.`);
  return valor.trim();
}

function numero(valor, campo, aceptaCero = false) {
  if (!Number.isFinite(valor) || (aceptaCero ? valor < 0 : valor <= 0))
    fallo(400, `${campo} debe ser un número ${aceptaCero ? 'mayor o igual a cero' : 'mayor que cero'}.`);
  return valor;
}

function dinero(valor, campo) {
  numero(valor, campo);
  if (Number(valor.toFixed(2)) !== valor) fallo(400, `${campo} admite hasta dos decimales.`);
  return valor;
}

function entero(valor, campo) {
  if (!Number.isSafeInteger(valor) || valor <= 0) fallo(400, `${campo} debe ser un entero mayor que cero.`);
  return valor;
}

function telefono(valor) {
  const tel = texto(valor, 'telefono');
  if (!/^\+?\d{1,15}$/.test(tel)) fallo(400, 'Escribe un teléfono válido.');
  return tel.replace(/^\+/, '');
}

function fecha(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || valor.startsWith('0000')
      || !Number.isFinite(Date.parse(valor)) || new Date(valor).toISOString().slice(0, 10) !== valor)
    fallo(400, 'Escribe una fecha válida en formato AAAA-MM-DD.');
  return valor;
}

async function leerCuerpo(peticion, formato) {
  const partes = [];
  let bytes = 0;
  for await (const parte of peticion.iterator({ destroyOnReturn: false })) {
    bytes += parte.length;
    // atajo: hasta 1 MiB en memoria, cambiar a lectura por filas si el banco manda archivos más grandes.
    if (bytes > 1024 * 1024) {
      peticion.resume();
      fallo(400, 'El cuerpo supera 1 MiB.');
    }
    partes.push(parte);
  }
  let cuerpo;
  try {
    cuerpo = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(partes));
  } catch {
    fallo(400, 'El cuerpo debe estar en UTF-8.');
  }
  if (formato === 'csv') return leerCsv(cuerpo);
  let datos;
  try {
    datos = JSON.parse(cuerpo);
  } catch {
    fallo(400, 'El cuerpo debe ser JSON válido.');
  }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) fallo(400, 'Se espera un objeto JSON.');
  return datos;
}

function datosMovimiento({ id, cuenta_origen, cuenta_destino, monto, fecha: dia }) {
  return [
    id === undefined ? 'TR-' + randomUUID().slice(0, 8) : texto(id, 'id'),
    texto(cuenta_origen, 'cuenta_origen'), texto(cuenta_destino, 'cuenta_destino'),
    dinero(monto, 'monto'), dia === undefined ? null : fecha(dia),
  ];
}

function leerCsv(cuerpo) {
  const [cabecera, ...lineas] = cuerpo.trim().split(/\r\n|\n|\r/);
  if (cabecera !== 'id,cuenta_origen,cuenta_destino,monto,fecha')
    fallo(400, 'La cabecera debe ser id,cuenta_origen,cuenta_destino,monto,fecha.');
  // atajo: una línea por movimiento, cambiar si el banco permite saltos dentro de un campo.
  return lineas.filter(linea => linea.trim()).map(linea => {
    const celda = /(?:"((?:[^"]|"")*)"|([^",]*))(?=,|$)/y;
    const valores = [];
    while (true) {
      const parte = celda.exec(linea);
      if (!parte) fallo(400, 'Hay una fila inválida en el CSV.');
      valores.push(parte[1]?.replaceAll('""', '"') ?? parte[2]);
      if (celda.lastIndex === linea.length) break;
      celda.lastIndex++;
    }
    const [id, cuenta_origen, cuenta_destino, monto, fecha] = valores;
    if (valores.length !== 5 || !/^\d+(?:\.\d{1,2})?$/.test(monto.trim()))
      fallo(400, 'Hay una fila inválida en el CSV.');
    return datosMovimiento({ id, cuenta_origen, cuenta_destino, monto: Number(monto), fecha: fecha.trim() });
  });
}

const parsers = { [types.NUMERIC]: Number, [types.INT8]: Number, [types.DATE]: valor => valor };
const filas = async (bd, sql, valores) => (await bd.query(sql, valores, { parsers })).rows;

async function abrirBase() {
  const bd = new PGlite({ extensions: { pgcrypto } });
  try {
    for (const nombre of ['local', 'base', 'semilla'])
      await bd.exec(await readFile(new URL(`./db/${nombre}.sql`, import.meta.url), 'utf8'));
    return bd;
  } catch (error) {
    await bd.close();
    throw error;
  }
}

const inventario = (bd, productor) => filas(bd,
  'select producto, libras, precio from inventario where productor = $1 order by producto', [productor]);

async function movimiento(bd, datos) {
  // ON CONFLICT ejecutaría el disparador antes de descartar la referencia repetida.
  const [fila] = await filas(bd, `
    insert into movimientos (id, cuenta_origen, cuenta_destino, monto, fecha)
    select $1, $2, $3, $4, coalesce($5::date, (now() at time zone 'America/Santo_Domingo')::date)
    where not exists (select 1 from movimientos where id = $1)
    returning id, pedido`, datos);
  return fila;
}

const rotos = async bd => (await filas(bd, 'select eslabones_rotos() as id')).map(fila => fila.id);

const rutas = {
  'GET /api/demo': {
    ejecutar: async bd => ({
      productores: await filas(bd, 'select id, nombre, telefono, cuenta from productores order by id'),
      oficiales: await filas(bd, 'select id, nombre, rol from oficiales order by id'),
      compradores: await filas(bd, 'select id, nombre, telefono, rnc, cuenta from compradores order by id'),
    }),
  },
  'GET /api/inventario': {
    ejecutar: (bd, consulta) => inventario(bd, uuid(consulta.get('productor'), 'productor')),
  },
  'PUT /api/inventario': {
    usuario: true, formato: 'json',
    ejecutar: async (bd, consulta, datos, usuario) => {
      await bd.query(`
        insert into inventario (productor, producto, libras, precio)
        values (auth.uid(), $1, $2, $3)
        on conflict (productor, producto) do update set libras = excluded.libras, precio = excluded.precio`,
      [texto(datos.producto, 'producto'), numero(datos.libras, 'libras', true), dinero(datos.precio, 'precio')]);
      return inventario(bd, usuario);
    },
  },
  'POST /api/pedidos': {
    formato: 'json',
    ejecutar: async (bd, consulta, datos) => (await filas(bd, `
      select p.id, p.producto, p.libras, p.monto, pr.cuenta as cuenta_banco_agricola
      from crear_pedido($1, $2, $3, $4, $5) p join productores pr on pr.id = p.productor`,
    [uuid(datos.productor, 'productor'), telefono(datos.telefono), texto(datos.nombre, 'nombre'),
      texto(datos.producto, 'producto'), numero(datos.libras, 'libras')]))[0],
  },
  'GET /api/mis-pedidos': {
    usuario: true, ejecutar: bd => filas(bd, 'select * from mis_pedidos()'),
  },
  'POST /api/movimientos': {
    formato: 'json',
    ejecutar: async (bd, consulta, datos) => {
      const fila = await movimiento(bd, datosMovimiento(datos));
      if (!fila) fallo(400, 'Esa referencia del banco ya existe.');
      return fila;
    },
  },
  'POST /api/movimientos/csv': {
    formato: 'csv',
    ejecutar: async (bd, consulta, datos) => {
      let cuadrados = 0;
      let repetidos = 0;
      for (const dato of datos) {
        const fila = await movimiento(bd, dato);
        if (!fila) repetidos++;
        else if (fila.pedido !== null) cuadrados++;
      }
      return { leidos: datos.length, cuadrados, repetidos };
    },
  },
  'GET /api/perfil': {
    usuario: true,
    ejecutar: (bd, consulta) => filas(bd, 'select * from perfil($1)', [uuid(consulta.get('productor'), 'productor')]),
  },
  'GET /api/permisos': {
    usuario: true,
    ejecutar: bd => filas(bd, `
      select p.oficial, o.nombre, o.rol, p.vence from permisos p
      join oficiales o on o.id = p.oficial order by o.nombre`),
  },
  'POST /api/permisos': {
    usuario: true, formato: 'json',
    ejecutar: async (bd, consulta, datos) => {
      await bd.query('select dar_permiso($1, $2)',
        [uuid(datos.oficial, 'oficial'), Math.min(entero(datos.dias, 'dias'), 90)]);
      return { ok: true };
    },
  },
  'DELETE /api/permisos': {
    usuario: true, formato: 'json',
    ejecutar: async (bd, consulta, datos) => {
      await bd.query('select quitar_permiso($1)', [uuid(datos.oficial, 'oficial')]);
      return { ok: true };
    },
  },
  'GET /api/finca': {
    usuario: true,
    ejecutar: async bd => (await filas(bd, 'select cultivo, tareas, rendimiento, tareas * rendimiento as tope from fincas'))[0] ?? null,
  },
  'POST /api/finca': {
    usuario: true, formato: 'json',
    ejecutar: async (bd, consulta, datos) => {
      await bd.query('select anotar_finca($1, $2, $3, $4)',
        [uuid(datos.productor, 'productor'), texto(datos.cultivo, 'cultivo'),
          numero(datos.tareas, 'tareas'), numero(datos.rendimiento, 'rendimiento')]);
      return { ok: true };
    },
  },
  'GET /api/registro': {
    ejecutar: async bd => ({
      filas: await filas(bd, 'select id, evento, previa, huella, creado from registro order by id'),
      rotos: await rotos(bd),
    }),
  },
  'POST /api/demo/alterar': {
    formato: 'json',
    ejecutar: async (bd, consulta, datos) => {
      const id = entero(datos.id, 'id');
      if (!datos.evento || typeof datos.evento !== 'object' || Array.isArray(datos.evento))
        fallo(400, 'El evento debe ser un objeto JSON.');
      await bd.exec('alter table registro disable trigger solo_agregar');
      const { affectedRows } = await bd.query('update registro set evento = $1 where id = $2',
        [JSON.stringify(datos.evento), id]);
      if (!affectedRows) fallo(400, 'Esa fila del registro no existe.');
      await bd.exec('alter table registro enable trigger solo_agregar');
      return { rotos: await rotos(bd) };
    },
  },
  'POST /api/demo/reiniciar': { reiniciar: true },
};

async function servirWeb(ruta, metodo, respuesta) {
  if (metodo !== 'GET' && metodo !== 'HEAD') fallo(404, 'Ruta no encontrada.');
  const archivo = resolve(raizWeb, '.' + (ruta.endsWith('/') ? ruta + 'index.html' : ruta));
  let destino;
  try {
    destino = await realpath(archivo);
    if (!destino.startsWith(raizWeb + sep) || !(await stat(destino)).isFile())
      fallo(404, 'Ruta no encontrada.');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fallo(404, 'Ruta no encontrada.');
    throw error;
  }
  const tipo = tipos[extname(destino).toLowerCase()] ?? 'application/octet-stream';
  const cuerpo = metodo === 'HEAD' ? undefined : await readFile(destino);
  respuesta.writeHead(200, { 'Content-Type': tipo.includes('text/') ? tipo + '; charset=utf-8' : tipo }).end(cuerpo);
}

function responder(respuesta, estado, datos) {
  respuesta.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(datos));
}

function responderError(respuesta, error) {
  if (error.estado) return responder(respuesta, error.estado, { error: error.message });
  if (error.code === '42501') {
    const mensajes = ['Sin permiso del productor, o ya venció', 'Solo un técnico del banco con permiso del productor'];
    return responder(respuesta, 403, { error: mensajes.includes(error.message) ? error.message : 'No tienes permiso.' });
  }
  if (error.constraint === 'inventario_libras_check')
    return responder(respuesta, 400, { error: 'No hay suficientes libras en inventario.' });
  if (error.constraint === 'permisos_oficial_fkey')
    return responder(respuesta, 400, { error: 'Ese oficial no está en la lista.' });
  if (error.constraint === 'inventario_productor_fkey' || error.constraint === 'permisos_productor_fkey')
    return responder(respuesta, 403, { error: 'Esta acción requiere una cuenta de productor.' });
  if (error.code === 'P0001' && error.message.startsWith('No hay '))
    return responder(respuesta, 400, { error: error.message });
  if (error.code === '23503' || error.code === '23514' || error.code?.startsWith('22'))
    return responder(respuesta, 400, { error: 'Revisa los valores del pedido o del formulario.' });
  responder(respuesta, 500, { error: 'No se pudo completar la operación.' });
}

export async function crearServidor() {
  let bd = await abrirBase();
  let cola = Promise.resolve();
  const servidor = createServer(async (peticion, respuesta) => {
    try {
      let ruta;
      try {
        ruta = decodeURIComponent(peticion.url.split('?', 1)[0]);
      } catch {
        fallo(400, 'La ruta no es válida.');
      }
      if (!ruta.startsWith('/') || ruta.startsWith('//') || ruta.includes('\\')
          || ruta.includes('\0') || ruta.split('/').includes('..')) fallo(404, 'Ruta no encontrada.');
      if (ruta !== '/api' && !ruta.startsWith('/api/')) return await servirWeb(ruta, peticion.method, respuesta);
      const operacion = rutas[`${peticion.method} ${ruta}`];
      if (!operacion) fallo(404, 'Ruta no encontrada.');
      const consulta = new URLSearchParams(peticion.url.split('?').slice(1).join('?'));
      let usuario;
      if (operacion.usuario) {
        // atajo: la cabecera solo identifica en la demo local, reemplazarla por una sesión verificada si se publica.
        if (peticion.headers['x-usuario'] === undefined) fallo(401, 'Falta la cabecera x-usuario.');
        usuario = uuid(peticion.headers['x-usuario'], 'x-usuario');
      }
      const datos = operacion.formato ? await leerCuerpo(peticion, operacion.formato) : undefined;
      // Reiniciar usa la misma cola para que nadie consulte una base que se está cerrando.
      const turno = cola.then(async () => {
        if (operacion.reiniciar) {
          const nueva = await abrirBase();
          await bd.close();
          bd = nueva;
          return { ok: true };
        }
        return bd.transaction(async transaccion => {
          if (usuario) {
            await transaccion.exec('set local role authenticated');
            await transaccion.query("select set_config('t.uid', $1, true)", [usuario]);
          }
          return operacion.ejecutar(transaccion, consulta, datos, usuario);
        });
      });
      cola = turno.catch(() => {});
      responder(respuesta, 200, await turno);
    } catch (error) {
      responderError(respuesta, error);
    }
  });
  servidor.once('close', () => { void cola.then(() => bd.close()); });
  return servidor;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const servidor = await crearServidor();
  servidor.listen(Number(process.env.PUERTO || 8790), '127.0.0.1');
  await once(servidor, 'listening');
  console.log(`Conuco en http://127.0.0.1:${servidor.address().port}`);
}
