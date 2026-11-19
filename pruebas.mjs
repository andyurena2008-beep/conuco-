import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { Duplex } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { crearServidor } from './servidor.mjs';

function comprobar(nombre, condicion) {
  console.log((condicion ? 'BIEN ' : 'MAL  ') + nombre);
  if (!condicion) process.exitCode = 1;
}

const bd = new PGlite({ extensions: { pgcrypto } });
const consultar = async (sql, valores) => (await bd.query(sql, valores)).rows;
for (const archivo of ['local', 'base'])
  await bd.exec(readFileSync(new URL('./db/' + archivo + '.sql', import.meta.url), 'utf8'));

const Y='11111111-1111-1111-1111-111111111111', O='22222222-2222-2222-2222-222222222222', T='33333333-3333-3333-3333-333333333333', PR='44444444-4444-4444-4444-444444444444';
await bd.exec(`
insert into productores values ('${Y}','Yurisbel','8091','A1');
insert into fincas values ('${Y}','plátano',40,250);
insert into compradores (nombre,telefono) values ('Colmado','8092'),('Primo','8091'),('Super','8093'),('Restaurante','8094');
insert into pedidos (productor,comprador,producto,libras,monto) values
 ('${Y}',1,'plátano',300,4500),('${Y}',2,'plátano',200,3000),('${Y}',3,'plátano',100,1500),('${Y}',4,'plátano',20000,9999);
insert into movimientos (id,cuenta_origen,cuenta_destino,monto,fecha) values
 ('m1','C1','A1',4500,current_date),('m2','P1','A1',3000,current_date),
 ('m3','S1','A1',1500,current_date),('m4','R1','A1',9999,current_date),
 ('m5','A1','S1',1400,current_date+2),('m6','X9','A1',777,current_date);`);
const h = await consultar('select id, comprador, estado, alarmas from historial order by id');
comprobar('colmado verificada', h[0].estado==='verificada');
comprobar('primo retenido por teléfono', h[1].alarmas.includes('mismo teléfono que el productor'));
comprobar('dinero que vuelve', h[2].alarmas.includes('el dinero volvió al comprador'));
comprobar('tope', h[3].alarmas.includes('pasa lo que la finca puede producir'));
comprobar('pago sin pedido no suma', (await consultar("select pedido from movimientos where id='m6'"))[0].pedido===null);
comprobar('cuenta del comprador aprendida', (await consultar('select cuenta from compradores where id=1'))[0].cuenta==='C1');
let e; try { await bd.exec("insert into movimientos values ('m1','C1','A1',4500,current_date,null)"); } catch (x) { e = x; }
comprobar('mismo movimiento dos veces falla', !!e);
comprobar('registro sin duplicado tras fallo', (await consultar('select count(*)::int n from registro'))[0].n===6);
comprobar('cadena intacta', (await consultar('select eslabones_rotos()')).length===0);
e=null; try { await bd.exec("update registro set evento='{}' where id=2"); } catch (x) { e = x; }
comprobar('update bloqueado', !!e);
e=null; try { await bd.exec("delete from registro"); } catch (x) { e = x; }
comprobar('delete bloqueado', !!e);
await bd.exec("alter table registro disable trigger solo_agregar; update registro set evento='{\"pago\":\"m2\",\"monto\":30000}' where id=2; alter table registro enable trigger solo_agregar;");
const rotos = (await consultar('select eslabones_rotos() id')).map(r=>Number(r.id));
comprobar('cadena rota se ve en la fila 2: '+rotos, rotos[0]===2);
const perfil = async (uid) => { await bd.exec(`set t.uid = '${uid}'`); try { return (await consultar(`select * from perfil('${Y}')`)).length; } catch { return 'negado'; } };
comprobar('anónimo negado', await perfil('')==='negado');
comprobar('oficial sin permiso negado', await perfil(O)==='negado');
await bd.exec(`insert into oficiales values ('${O}','Oficial','credito'), ('${T}','Técnico','tecnico')`);
await bd.exec(`set t.uid = '${Y}'`); await consultar(`select dar_permiso('${O}', 7)`);
comprobar('oficial con permiso ve 4', await perfil(O)===4);
await bd.exec(`update permisos set vence = now() - interval '1 minute'`);
comprobar('permiso vencido negado', await perfil(O)==='negado');
comprobar('el productor se ve a sí mismo', await perfil(Y)===4);
await bd.exec(`set t.uid = ''; insert into pedidos (productor,comprador,producto,libras,monto) values ('${Y}',1,'plátano',100,20000);
insert into movimientos (id,cuenta_origen,cuenta_destino,monto,fecha) values ('m7','C1','A1',20000,current_date);`);
const h2 = await consultar("select comprador, alarmas from historial where comprador='Colmado'");
comprobar('colmado pasa de la mitad con 5 ventas', h2.every(r => r.alarmas.includes('un solo comprador pasa de la mitad')));

await bd.exec(`set t.uid = ''; insert into inventario values ('${Y}','plátano',500,15);`);
const nuevo = (await consultar(`select * from crear_pedido('${Y}','8099','Colmado Nuevo','plátano',100)`))[0];
comprobar('pedido con precio de la tabla: '+nuevo.monto, Number(nuevo.monto)===1500);
comprobar('inventario descontado', Number((await consultar('select libras from inventario'))[0].libras)===400);
e=null; try { await consultar(`select * from crear_pedido('${Y}','8099','Colmado Nuevo','plátano',1000)`); } catch (x) { e = x; }
comprobar('sin inventario suficiente falla', !!e && Number((await consultar('select libras from inventario'))[0].libras)===400);
e=null; try { await consultar(`select * from crear_pedido('${Y}','8099','X','yuca',1)`); } catch (x) { e = x; }
comprobar('producto que no hay falla', !!e);
comprobar('mismo comprador no se duplica', (await consultar("select count(*)::int n from compradores where telefono='8099'"))[0].n===1);
comprobar('cadena intacta al final salvo la fila 2', (await consultar('select eslabones_rotos() id')).map(r=>Number(r.id)).join()==='2');

const anotar = async (uid) => { await bd.exec(`set t.uid = '${uid}'`); try { await consultar(`select anotar_finca('${Y}','plátano',40,300)`); return 'si'; } catch { return 'no'; } };
comprobar('técnico sin permiso no anota', await anotar(T)==='no');
await bd.exec(`set t.uid = '${Y}'`); await consultar(`select dar_permiso('${T}', 500)`);
comprobar('permiso topado a 90 días', (await consultar(`select vence < now() + interval '91 days' as b from permisos where oficial='${T}'`))[0].b);
comprobar('oficial de crédito no anota finca', await anotar(O)==='no');
comprobar('técnico con permiso anota', await anotar(T)==='si' && Number((await consultar('select rendimiento from fincas'))[0].rendimiento)===300);
await bd.exec(`set t.uid = '${Y}'`); e=null; try { await consultar(`select dar_permiso('${PR}', 30)`); } catch (x) { e = x; }
comprobar('no se le puede dar permiso al primo', !!e);
await bd.exec(`set t.uid = ''`); e=null; try { await consultar(`select dar_permiso('${O}', 30)`); } catch (x) { e = x; }
comprobar('anónimo no da permisos', !!e);

const otro = '55555555-5555-5555-5555-555555555555';
const como = (usuario, sql, valores) => bd.transaction(async turno => {
  await turno.exec('set local role authenticated');
  await turno.query("select set_config('t.uid', $1, true)", [usuario]);
  return (await turno.query(sql, valores)).rows;
});
const consultas = async () => (await consultar("select count(*)::int as total from registro where evento ? 'consulta'"))[0].total;
const consultasAntes = await consultas();
const propio = await como(Y, 'select * from perfil($1)', [Y]);
comprobar('perfil propio no se registra', propio.length === 5 && await consultas() === consultasAntes);
await como(Y, 'select dar_permiso($1, 7)', [O]);
await como(O, 'select * from perfil($1)', [Y]);
const [consultaOficial] = await consultar("select evento from registro where evento ? 'consulta' order by id desc limit 1");
comprobar('perfil consultado por un tercero queda registrado',
  await consultas() === consultasAntes + 1 && consultaOficial.evento.por === O);

await bd.query("insert into productores values ($1, 'Otra productora', '8098', 'A2')", [otro]);
await bd.query("insert into inventario values ($1, 'yuca', 10, 10)", [otro]);
await como(otro, 'select dar_permiso($1, 7)', [O]);
comprobar('authenticated ve la lista de oficiales', (await como(Y, 'select id from oficiales')).length === 2);
const permisosPropios = await como(Y, 'select productor from permisos');
comprobar('RLS de permisos deja ver solo los propios', permisosPropios.length === 2 && permisosPropios.every(p => p.productor === Y));
await como(Y, 'select quitar_permiso($1)', [O]);
const [retiro] = await consultar('select evento from registro order by id desc limit 1');
comprobar('quitar permiso registra el retiro y conserva el de otra productora',
  retiro.evento.quitar_permiso === Y && retiro.evento.a === O
  && (await como(otro, 'select oficial from permisos')).some(p => p.oficial === O));
comprobar('retirar el permiso bloquea el perfil', await perfil(O) === 'negado');

const pedidoAjeno = await bd.transaction(async turno => {
  await turno.exec('set local role service_role');
  const { rows: [pedido] } = await turno.query("select id from crear_pedido($1, '8097', 'Otro comprador', 'yuca', 2)", [otro]);
  await turno.exec(`insert into movimientos (id, cuenta_origen, cuenta_destino, monto, fecha)
    values ('sin-visita','C7','A2',20,(now() at time zone 'America/Santo_Domingo')::date)`);
  return pedido.id;
});
const pedidosPropios = await como(Y, 'select id, productor from pedidos');
comprobar('RLS de pedidos no permite ver los de otra productora',
  pedidosPropios.length > 0 && pedidosPropios.every(p => p.productor === Y)
  && (await como(Y, 'select id from pedidos where id = $1', [pedidoAjeno])).length === 0);
const pedidos = await como(Y, 'select * from mis_pedidos()');
comprobar('mis_pedidos ordena y muestra el pendiente sin fecha ni alarmas',
  pedidos[0].id === nuevo.id && pedidos[0].estado === 'pendiente'
  && pedidos[0].fecha_pago === null && pedidos[0].alarmas.length === 0);
comprobar('mis_pedidos devuelve las alarmas del historial y solo pedidos propios',
  pedidos.length === pedidosPropios.length && pedidos.every(p => p.id !== pedidoAjeno)
  && pedidos.find(p => p.id === h[1].id).alarmas.includes('mismo teléfono que el productor'));
const [sinVisita] = await como(otro, 'select * from mis_pedidos()');
comprobar('un pago cuadrado sin visita queda retenido',
  sinVisita.id === pedidoAjeno && sinVisita.estado === 'retenida'
  && sinVisita.alarmas.includes('falta la visita del técnico'));
await bd.close();

// atajo: en cajas sin puertos, se usa el mismo parser HTTP con dos extremos en memoria.
function enlaceMemoria(servidor) {
  const lado = otro => new Duplex({
    read() {},
    write(parte, codificacion, listo) { otro().push(parte); listo(); },
    final(listo) { otro().push(null); listo(); },
  });
  const cliente = lado(() => enlace);
  const enlace = lado(() => cliente);
  cliente.setTimeout = enlace.setTimeout = () => {};
  servidor.emit('connection', enlace);
  return cliente;
}

const servidor = await crearServidor();
const agente = new Agent({ keepAlive: false });
let puerto;
try {
  const escuchando = once(servidor, 'listening');
  try {
    servidor.listen(0, '127.0.0.1');
    await escuchando;
    puerto = servidor.address().port;
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    agente.createConnection = () => enlaceMemoria(servidor);
  }

  const pedir = (ruta, { metodo = 'GET', usuario, datos, csv } = {}) => new Promise((resolver, rechazar) => {
    const cabeceras = {};
    const cuerpo = csv ?? (datos === undefined ? undefined : JSON.stringify(datos));
    if (usuario !== undefined) cabeceras['x-usuario'] = usuario;
    if (cuerpo !== undefined) {
      cabeceras['Content-Type'] = csv === undefined ? 'application/json' : 'text/csv';
      cabeceras['Content-Length'] = Buffer.byteLength(cuerpo);
    }
    const peticion = request({
      host: '127.0.0.1', port: puerto, path: ruta, method: metodo, headers: cabeceras, agent: agente,
    }, async respuesta => {
      try {
        const partes = [];
        for await (const parte of respuesta) partes.push(parte);
        resolver({ estado: respuesta.statusCode, datos: JSON.parse(Buffer.concat(partes).toString()) });
      } catch (error) {
        rechazar(error);
      }
    });
    peticion.on('error', rechazar).end(cuerpo);
  });

  const demo = await pedir('/api/demo');
  comprobar(`HTTP ${puerto ? 'en un puerto libre' : 'en memoria por restricción de puertos'} devuelve la demo`,
    demo.estado === 200 && demo.datos.productores.length === 1 && demo.datos.compradores.length === 4
    && demo.datos.oficiales.length === 2 && demo.datos.compradores.some(c => c.rnc === 'DEMO-001'));
  const { productores: [productora], oficiales: [carmen, luis], compradores: [colmado] } = demo.datos;
  const usuario = productora.id;
  const misPedidos = () => pedir('/api/mis-pedidos', { usuario });
  const verPerfil = () => pedir('/api/perfil?productor=' + usuario, { usuario: carmen.id });
  const registro = () => pedir('/api/registro');
  const inventarioDemo = await pedir('/api/inventario?productor=' + usuario);
  const iniciales = Object.fromEntries(inventarioDemo.datos.map(p => [p.producto, [p.libras, p.precio]]));
  comprobar('HTTP inventario inicial y números del contrato', inventarioDemo.estado === 200
    && iniciales.plátano.join() === '3000,15' && iniciales.yuca.join() === '1200,22'
    && iniciales['ají cubanela'].join() === '400,45' && typeof iniciales.plátano[0] === 'number');
  const [pedidosIniciales, pedidosOficial, finca, permisos] = await Promise.all([
    misPedidos(), pedir('/api/mis-pedidos', { usuario: luis.id }),
    pedir('/api/finca', { usuario }), pedir('/api/permisos', { usuario }),
  ]);
  const pendiente = pedidosIniciales.datos.find(p => p.estado === 'pendiente');
  comprobar('HTTP la semilla muestra seis verificadas, una retenida y una pendiente',
    pedidosIniciales.datos.filter(p => p.estado === 'verificada').length === 6
    && pedidosIniciales.datos.filter(p => p.estado === 'retenida').length === 1
    && pendiente?.comprador === colmado.nombre && pedidosOficial.datos.length === 0);
  comprobar('HTTP solo Luis tiene permiso inicial y la finca tiene tope numérico',
    permisos.datos.length === 1 && permisos.datos[0].oficial === luis.id
    && finca.datos.tareas === 40 && finca.datos.rendimiento === 250 && finca.datos.tope === 10000);
  comprobar('HTTP la sesión ausente da 401 y el UUID inválido da 400',
    (await pedir('/api/mis-pedidos')).estado === 401
    && (await pedir('/api/mis-pedidos', { usuario: 'no-es-uuid' })).estado === 400);
  comprobar('HTTP rutas inexistentes y rutas fuera de web dan 404',
    (await pedir('/api/desconocida')).estado === 404
    && (await pedir('/%2e%2e%2fdb/base.sql')).estado === 404);

  const subida = await pedir('/api/inventario', {
    metodo: 'PUT', usuario, datos: { producto: 'auyama', libras: 25, precio: 50 },
  });
  const ajuste = await pedir('/api/inventario', {
    metodo: 'PUT', usuario, datos: { producto: 'auyama', libras: 0, precio: 40 },
  });
  comprobar('HTTP inventario agrega, actualiza y devuelve todas las filas',
    subida.estado === 200 && subida.datos.length === 4
    && ajuste.datos.some(p => p.producto === 'auyama' && p.libras === 0 && p.precio === 40));

  const pedido = await pedir('/api/pedidos', {
    metodo: 'POST', datos: { productor: usuario, telefono: colmado.telefono, nombre: colmado.nombre,
      producto: 'yuca', libras: 12 },
  });
  comprobar('HTTP crear pedido devuelve id, libras, monto y cuenta',
    pedido.estado === 200 && Number.isInteger(pedido.datos.id) && pedido.datos.libras === 12
    && pedido.datos.monto === 264 && pedido.datos.cuenta_banco_agricola === productora.cuenta);
  const pago = await pedir('/api/movimientos', {
    metodo: 'POST', datos: { cuenta_origen: colmado.cuenta, cuenta_destino: productora.cuenta, monto: pedido.datos.monto },
  });
  const vendido = (await misPedidos()).datos.find(p => p.id === pedido.datos.id);
  comprobar('HTTP pedido, movimiento y mis-pedidos terminan en verificada',
    pago.estado === 200 && pago.datos.id.startsWith('TR-') && pago.datos.pedido === pedido.datos.id
    && vendido?.estado === 'verificada' && /^\d{4}-\d{2}-\d{2}$/.test(vendido.fecha_pago));

  const filasAntes = (await registro()).datos.filas.length;
  const csv = [
    'id,cuenta_origen,cuenta_destino,monto,fecha',
    `${pago.datos.id},${colmado.cuenta},${productora.cuenta},264,${vendido.fecha_pago}`,
    `"CSV,1",${colmado.cuenta},${productora.cuenta},${pendiente.monto},${vendido.fecha_pago}`,
    `"CSV,1",${colmado.cuenta},${productora.cuenta},${pendiente.monto},${vendido.fecha_pago}`,
    `CSV-SUELTA,${colmado.cuenta},${productora.cuenta},1.50,${vendido.fecha_pago}`,
  ].join('\r\n');
  const carga = await pedir('/api/movimientos/csv', { metodo: 'POST', csv });
  comprobar('HTTP CSV cuenta las repetidas sin duplicar su registro',
    carga.estado === 200 && carga.datos.leidos === 4 && carga.datos.cuadrados === 1
    && carga.datos.repetidos === 2 && (await registro()).datos.filas.length === filasAntes + 2);
  comprobar('HTTP rechaza CSV mal formado y JSON con monto de texto',
    (await pedir('/api/movimientos/csv', { metodo: 'POST', csv: 'cuentas,fecha\nuna,fila' })).estado === 400
    && (await pedir('/api/movimientos', { metodo: 'POST',
      datos: { cuenta_origen: colmado.cuenta, cuenta_destino: productora.cuenta, monto: '50' } })).estado === 400);

  const sinPermiso = await verPerfil();
  const permiso = { oficial: carmen.id, dias: 7 };
  const dado = await pedir('/api/permisos', { metodo: 'POST', usuario, datos: permiso });
  const conPermiso = await verPerfil();
  const visita = { productor: usuario, cultivo: 'plátano', tareas: 40, rendimiento: 250 };
  comprobar('HTTP anotar finca exige un técnico con permiso',
    (await pedir('/api/finca', { metodo: 'POST', usuario: carmen.id, datos: visita })).estado === 403
    && (await pedir('/api/finca', { metodo: 'POST', usuario: luis.id, datos: visita })).datos.ok === true);
  const quitado = await pedir('/api/permisos', { metodo: 'DELETE', usuario, datos: { oficial: carmen.id } });
  comprobar('HTTP perfil da 403, pasa a 200 con permiso y vuelve a 403 al quitarlo',
    sinPermiso.estado === 403 && dado.datos.ok === true && conPermiso.estado === 200 && conPermiso.datos.length > 0
    && quitado.datos.ok === true && (await verPerfil()).estado === 403);

  const antes = await registro();
  const id = antes.datos.filas[0].id;
  const alterar = await pedir('/api/demo/alterar', { metodo: 'POST', datos: { id, evento: { cambiado: true } } });
  comprobar('HTTP alterar deja visible el eslabón roto',
    antes.datos.rotos.length === 0 && alterar.estado === 200 && alterar.datos.rotos.includes(id)
    && (await registro()).datos.rotos.includes(id));
  const reinicio = await pedir('/api/demo/reiniciar', { metodo: 'POST' });
  comprobar('HTTP reiniciar devuelve una semilla intacta',
    reinicio.datos.ok === true && (await registro()).datos.rotos.length === 0
    && (await misPedidos()).datos.filter(p => p.estado === 'pendiente').length === 1
    && (await verPerfil()).estado === 403);
} catch (error) {
  comprobar('recorrido HTTP: ' + error.message, false);
} finally {
  agente.destroy();
  servidor.close();
}
