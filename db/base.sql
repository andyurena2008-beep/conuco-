-- Conuco: toda la confianza vive aquí, en la base de datos.
-- La app, el agente y el portal solo leen y agregan. Si una regla estuviera en la app,
-- bastaría con saltarse la app; en la base no se puede.

create extension if not exists pgcrypto with schema extensions;

create table productores (
  id       uuid primary key,          -- el mismo id del login (auth.uid())
  nombre   text not null,
  telefono text not null,
  cuenta   text not null unique        -- su cuenta en el Banco Agrícola
);

create table fincas (                  -- lo anota el técnico del banco en su visita
  productor   uuid primary key references productores,
  cultivo     text not null,
  tareas      numeric not null check (tareas > 0),
  rendimiento numeric not null check (rendimiento > 0)   -- libras por tarea en la temporada
);

create table compradores (
  id       bigint generated always as identity primary key,
  nombre   text not null,
  telefono text not null unique,      -- su WhatsApp
  rnc      text,
  cuenta   text                        -- se llena sola con su primer pago
);

create table pedidos (                 -- lo crea el agente cuando el comprador dice que sí
  id        bigint generated always as identity primary key,
  productor uuid not null references productores,
  comprador bigint not null references compradores,
  producto  text not null,
  libras    numeric not null check (libras > 0),
  monto     numeric(12,2) not null check (monto > 0),
  creado    timestamptz not null default now()
);

create table inventario (
  productor uuid not null references productores,
  producto  text not null,
  libras    numeric not null check (libras >= 0),   -- si no alcanza, el pedido falla aquí
  precio    numeric(10,2) not null check (precio > 0),   -- por libra
  primary key (productor, producto)
);

create table mensajes (                -- la conversación de WhatsApp, para que el agente recuerde
  id       text primary key default gen_random_uuid()::text,   -- el id de Meta: si reenvía, no se repite
  telefono text not null,
  rol      text not null check (rol in ('user', 'assistant')),
  texto    text not null,
  creado   timestamptz not null default now()
);

create table movimientos (             -- lo que manda el banco; en la demo, un CSV
  id             text primary key,     -- la referencia del banco: el mismo archivo dos veces no duplica
  cuenta_origen  text not null,
  cuenta_destino text not null,
  monto          numeric(12,2) not null,
  fecha          date not null,
  pedido         bigint unique references pedidos
);

create table oficiales (               -- gente del Banco Agrícola; la llena el banco, nunca la app
  id     uuid primary key,             -- su id de login
  nombre text not null,
  rol    text not null check (rol in ('credito', 'tecnico'))
);

create table permisos (                -- el joven deja ver su perfil a un oficial, por un tiempo
  productor uuid not null references productores,
  oficial   uuid not null references oficiales,   -- así no se le puede dar permiso al primo
  vence     timestamptz not null,
  primary key (productor, oficial)
);

-- 1. Registro encadenado ---------------------------------------------------
-- Cada fila guarda la huella de la anterior. Si alguien cambia una fila vieja,
-- la cadena deja de cuadrar desde ahí.
create table registro (
  id     bigint generated always as identity primary key,
  evento jsonb not null,
  previa text,
  huella text,
  creado timestamptz not null default now()
);

create function encadenar() returns trigger
language plpgsql set search_path = public, extensions, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext('registro'));   -- de uno en uno, si no la cadena se bifurca
  new.previa := coalesce((select huella from registro order by id desc limit 1), 'inicio');
  new.huella := encode(digest(new.previa || new.evento::text, 'sha256'), 'hex');
  return new;
end $$;

create trigger encadenar before insert on registro
  for each row execute function encadenar();

create function solo_agregar() returns trigger language plpgsql as $$
begin
  raise exception 'El registro solo acepta agregar';
end $$;

create trigger solo_agregar before update or delete or truncate on registro
  for each statement execute function solo_agregar();

-- Devuelve las filas donde la cadena se rompió. Vacío = nadie tocó nada.
create function eslabones_rotos() returns setof bigint
language sql stable set search_path = public, extensions, pg_temp as $$
  select id from (
    select id, evento, previa, huella,
           coalesce(lag(huella) over (order by id), 'inicio') as esperada
    from registro
  ) r
  where previa <> esperada
     or huella <> encode(digest(esperada || evento::text, 'sha256'), 'hex')
  order by id
$$;

-- 2. Crear el pedido -------------------------------------------------------
-- El precio sale de la tabla para que el comprador no lo pueda fijar.
-- El inventario se descuenta en el mismo paso que crea el pedido.
create function crear_pedido(p_productor uuid, p_telefono text, p_nombre text,
                             p_producto text, p_libras numeric)
returns pedidos language plpgsql as $$
declare i inventario; c bigint; r pedidos;
begin
  update inventario set libras = libras - p_libras
  where productor = p_productor and producto = p_producto
  returning * into i;
  if not found then raise exception 'No hay % en inventario', p_producto; end if;

  insert into compradores (nombre, telefono) values (p_nombre, p_telefono)
  on conflict (telefono) do update set nombre = excluded.nombre
  returning id into c;

  insert into pedidos (productor, comprador, producto, libras, monto)
  values (p_productor, c, p_producto, p_libras, round(p_libras * i.precio, 2))
  returning * into r;
  insert into registro (evento) values (jsonb_build_object('pedido', r.id, 'monto', r.monto));
  return r;
end $$;

-- 3. Cuadrar cada pago con su pedido ---------------------------------------
-- Mismo monto, a la cuenta del productor, desde la cuenta del comprador
-- (o la primera vez, desde cualquiera) y a 3 días o menos del pedido.
create function cuadrar() returns trigger language plpgsql as $$
declare p pedidos;
begin
  select pe.* into p
  from pedidos pe
  join productores pr on pr.id = pe.productor
  join compradores co on co.id = pe.comprador
  where pr.cuenta = new.cuenta_destino
    and coalesce(co.cuenta, new.cuenta_origen) = new.cuenta_origen
    and pe.monto = new.monto
    and new.fecha between (pe.creado at time zone 'America/Santo_Domingo')::date
                      and (pe.creado at time zone 'America/Santo_Domingo')::date + 3
    and not exists (select 1 from movimientos m where m.pedido = pe.id)
  order by pe.creado
  limit 1;

  if found then
    new.pedido := p.id;
    update compradores set cuenta = new.cuenta_origen where id = p.comprador and cuenta is null;
  end if;
  insert into registro (evento) values
    (jsonb_build_object('pago', new.id, 'monto', new.monto, 'pedido', new.pedido));
  return new;                          -- un pago sin pedido se guarda, pero no suma
end $$;

create trigger cuadrar before insert on movimientos
  for each row execute function cuadrar();

-- 4. El historial que ve el banco: tope y alarmas --------------------------
-- No se guarda «verificado» en ningún lado: se calcula cada vez. Si mañana el
-- dinero vuelve al comprador, la venta pasa sola a retenida.
-- atajo: una sola temporada por finca; cuando haya varias, se parte por temporada.
create view historial as
with pagadas as (
  select pe.id, pe.productor, pe.comprador, pe.libras, pe.monto, m.fecha, m.cuenta_origen,
         pr.cuenta as cuenta_productor, pr.telefono as telefono_productor,
         f.tareas * f.rendimiento as tope,
         sum(pe.libras) over (partition by pe.productor order by m.fecha, pe.id) as acumulado,
         sum(pe.monto) over (partition by pe.productor, pe.comprador)
           / sum(pe.monto) over (partition by pe.productor) as parte,
         count(*) over (partition by pe.productor) as ventas
  from pedidos pe
  join movimientos m on m.pedido = pe.id
  join productores pr on pr.id = pe.productor
  left join fincas f on f.productor = pe.productor
)
select p.id, p.productor, c.nombre as comprador, p.libras, p.monto, p.fecha,
       a.alarmas,
       case when cardinality(a.alarmas) = 0 then 'verificada' else 'retenida' end as estado
from pagadas p
join compradores c on c.id = p.comprador
cross join lateral (select array_remove(array[
  -- El pago aparece de una vez, pero sin visita no se puede comprobar el tope.
  case when p.tope is null then 'falta la visita del técnico' end,
  case when p.acumulado > p.tope then 'pasa lo que la finca puede producir' end,
  -- con menos de 5 ventas, uno de dos compradores siempre pasa de la mitad
  case when p.ventas >= 5 and p.parte > 0.5 then 'un solo comprador pasa de la mitad' end,
  case when exists (select 1 from movimientos v
                    where v.cuenta_origen = p.cuenta_productor
                      and v.cuenta_destino = p.cuenta_origen
                      and v.fecha between p.fecha and p.fecha + 7)
       then 'el dinero volvió al comprador' end,
  case when c.telefono = p.telefono_productor then 'mismo teléfono que el productor' end
], null) as alarmas) a;

-- 5. Portal del banco -------------------------------------------------------
-- Las consultas de terceros se registran sin llenar la cadena con las visitas propias.
create function perfil(p uuid) returns setof historial
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p is distinct from auth.uid() and not exists (
       select 1 from permisos
       where productor = p and oficial = auth.uid() and vence > now()) then
    raise exception 'Sin permiso del productor, o ya venció' using errcode = '42501';
  end if;
  if p is distinct from auth.uid() then
    insert into registro (evento) values (jsonb_build_object('consulta', p, 'por', auth.uid()));
  end if;
  return query select * from historial where productor = p;
end $$;

-- El joven da permiso a un oficial del banco. Vence solo, a los 90 días como mucho.
create function dar_permiso(p_oficial uuid, p_dias int default 30)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into permisos values (auth.uid(), p_oficial, now() + make_interval(days => least(p_dias, 90)))
  on conflict (productor, oficial) do update set vence = excluded.vence;
  insert into registro (evento) values
    (jsonb_build_object('permiso', auth.uid(), 'a', p_oficial, 'dias', least(p_dias, 90)));
$$;

create function quitar_permiso(p_oficial uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  with quitado as (
    delete from permisos where productor = auth.uid() and oficial = p_oficial
    returning productor, oficial
  )
  insert into registro (evento)
    select jsonb_build_object('quitar_permiso', productor, 'a', oficial) from quitado;
$$;

create function mis_pedidos()
returns table(id bigint, comprador text, telefono text, producto text, libras numeric,
              monto numeric, creado timestamptz, fecha_pago date, estado text, alarmas text[])
language sql stable security definer set search_path = public, pg_temp as $$
  select pe.id, co.nombre, co.telefono, pe.producto, pe.libras, pe.monto, pe.creado,
         h.fecha, coalesce(h.estado, 'pendiente'), coalesce(h.alarmas, array[]::text[])
  from pedidos pe
  join compradores co on co.id = pe.comprador
  left join historial h on h.id = pe.id
  where pe.productor = auth.uid()
  order by pe.creado desc, pe.id desc;
$$;

-- El técnico anota la finca en su visita. Solo un técnico del banco con permiso vigente.
create function anotar_finca(p uuid, p_cultivo text, p_tareas numeric, p_rendimiento numeric)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from permisos pe join oficiales o on o.id = pe.oficial
                 where pe.productor = p and pe.oficial = auth.uid()
                   and o.rol = 'tecnico' and pe.vence > now()) then
    raise exception 'Solo un técnico del banco con permiso del productor' using errcode = '42501';
  end if;
  insert into fincas values (p, p_cultivo, p_tareas, p_rendimiento)
  on conflict (productor) do update
    set cultivo = excluded.cultivo, tareas = excluded.tareas, rendimiento = excluded.rendimiento;
  insert into registro (evento) values (jsonb_build_object('finca', p, 'tareas', p_tareas,
    'rendimiento', p_rendimiento, 'por', auth.uid()));
end $$;

-- 6. Quién ve qué -----------------------------------------------------------
-- En Supabase, una tabla sin RLS se puede leer desde la web pública. Todas la llevan:
-- el productor ve lo suyo y lo demás solo pasa por las funciones de arriba.
alter table productores enable row level security;
alter table fincas      enable row level security;
alter table compradores enable row level security;
alter table inventario  enable row level security;
alter table pedidos     enable row level security;
alter table movimientos enable row level security;
alter table oficiales   enable row level security;
alter table permisos    enable row level security;
alter table mensajes    enable row level security;
alter table registro    enable row level security;

create policy suyo on productores for select using (id = auth.uid());
create policy suyo on fincas      for select using (productor = auth.uid());
create policy suyo on inventario  for all    using (productor = auth.uid()) with check (productor = auth.uid());
create policy suyo on pedidos     for select using (productor = auth.uid());
create policy suyo on compradores for select using (exists
  (select 1 from pedidos where comprador = compradores.id and productor = auth.uid()));
create policy lista on oficiales for select to authenticated using (true);
create policy suyo on permisos for select to authenticated using (productor = auth.uid());

revoke all on historial from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function perfil(uuid), dar_permiso(uuid, int), quitar_permiso(uuid),
  mis_pedidos(), anotar_finca(uuid, text, numeric, numeric)
  to authenticated;

-- El acceso del agente y del portal no depende de los permisos automáticos del proyecto.
grant select on productores, fincas, compradores, pedidos, oficiales, permisos to authenticated;
grant select, insert, update, delete on inventario to authenticated;
grant execute on function crear_pedido(uuid, text, text, text, numeric) to service_role;
grant select on productores, inventario, compradores, pedidos, movimientos, mensajes, registro to service_role;
grant insert on compradores, pedidos, movimientos, mensajes, registro to service_role;
grant update on inventario, compradores to service_role;
