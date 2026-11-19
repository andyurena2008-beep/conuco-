-- Datos ficticios. Las cuentas BA y el RNC DEMO no representan cuentas ni registros reales.
insert into productores values
  ('11111111-1111-1111-1111-111111111111', 'Yurisbel Rosario', '18095550101', 'BA-0001');

insert into compradores (nombre, telefono, rnc, cuenta) values
  ('Colmado La Esquina', '18095550202', null, 'BA-0002'),
  ('Supermercado El Valle', '18095550303', 'DEMO-001', 'BA-0003'),
  ('Restaurante Sabor Criollo', '18095550404', null, 'BA-0004'),
  ('El Primo', '18095550101', null, 'BA-0005');

insert into oficiales values
  ('22222222-2222-2222-2222-222222222222', 'Carmen Díaz', 'credito'),
  ('33333333-3333-3333-3333-333333333333', 'Luis Méndez', 'tecnico');

do $$
declare
  productora constant uuid := '11111111-1111-1111-1111-111111111111';
  tecnico constant uuid := '33333333-3333-3333-3333-333333333333';
  hoy constant date := (now() at time zone 'America/Santo_Domingo')::date;
  venta record;
  pedido pedidos;
begin
  perform set_config('t.uid', productora::text, true);
  perform dar_permiso(tecnico, 30);
  perform set_config('t.uid', tecnico::text, true);
  perform anotar_finca(productora, 'plátano', 40, 250);

  -- Incluye lo que se vendió o reservó para llegar a las existencias de hoy.
  insert into inventario values
    (productora, 'plátano', 3650, 15),
    (productora, 'yuca', 1380, 22),
    (productora, 'ají cubanela', 450, 45);

  for venta in
    select v.*, c.nombre, c.telefono, c.cuenta
    from (values
      (21, 'BA-0002', 'plátano', 160),
      (18, 'BA-0003', 'yuca', 100),
      (15, 'BA-0004', 'ají cubanela', 50),
      (11, 'BA-0002', 'plátano', 120),
      (8,  'BA-0003', 'plátano', 180),
      (4,  'BA-0004', 'yuca', 80),
      (2,  'BA-0005', 'plátano', 60),
      (0,  'BA-0002', 'plátano', 130)
    ) v(dias, cuenta, producto, libras)
    join compradores c on c.cuenta = v.cuenta
    order by v.dias desc
  loop
    pedido := crear_pedido(productora, venta.telefono, venta.nombre, venta.producto, venta.libras);
    if venta.dias > 0 then
      update pedidos set creado = (hoy - venta.dias + time '10:00') at time zone 'America/Santo_Domingo'
      where id = pedido.id;
      insert into movimientos (id, cuenta_origen, cuenta_destino, monto, fecha)
      values ('DEMO-TR-' || pedido.id, venta.cuenta, 'BA-0001', pedido.monto, hoy - venta.dias);
    end if;
  end loop;

  insert into movimientos (id, cuenta_origen, cuenta_destino, monto, fecha)
  values ('DEMO-TR-SUELTA', 'BA-0004', 'BA-0001', 777, hoy);
end $$;
