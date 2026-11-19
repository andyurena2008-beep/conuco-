# Conuco

**Una venta solo cuenta si el dinero pasó por el Banco Agrícola.**

El historial de ventas de Conuco solo le sirve al banco si nadie lo puede inventar. Un
productor y un primo con un supermercado podrían fingir ventas. Por eso la prueba no la
da el productor: sale sola del dinero.

1. El comprador pide por WhatsApp y el agente cierra el pedido con el inventario real.
2. Paga por transferencia a la cuenta del productor en el Banco Agrícola. El efectivo se
   puede usar, pero no suma.
3. El banco pasa los movimientos de esa cuenta (archivo diario o API).
4. Conuco cuadra cada pago con su pedido por monto, fecha y cuenta, y revisa el tope de la
   finca y las alarmas.
5. El banco consulta el perfil en Conuco, con permiso del productor. Cada consulta queda
   en un registro encadenado con SHA-256 que no se puede editar.

## Probarlo en tu computadora

Hace falta Node 20 o más nuevo.

```bash
npm install
npm start        # abre http://localhost:8790
npm test         # las pruebas de la base y de la API
```

La base corre en memoria con [PGlite](https://pglite.dev) (Postgres de verdad, sin
instalar nada) y se vuelve a crear cada vez que arranca. El botón «Reiniciar demo» la
deja como al principio.

## La demo, en tres minutos

1. **Comprador**: el Colmado pide 100 lb de plátano y transfiere. En **Productora** aparece
   el pedido y pasa a *verificada*.
2. **Comprador**: escoge al Primo, pide y transfiere. La venta queda *retenida*: tiene el
   mismo teléfono que la productora.
3. **Banco**: Carmen (crédito) consulta y se le niega. En **Productora**, Yurisbel le da
   permiso con el interruptor. Carmen vuelve a consultar y ve el historial.
4. **Registro**: el botón rojo cambia un pago viejo y la cadena se rompe en esa fila.

## Cómo está hecho

| Parte | Archivo |
|---|---|
| Las reglas de confianza: tablas, cuadre, tope, alarmas, permisos, registro | `db/base.sql` |
| Lo que Supabase ya trae y en local hay que simular (roles, `auth.uid()`) | `db/local.sql` |
| Los datos de la demo | `db/semilla.sql` |
| La API local y el servidor de la web | `servidor.mjs` |
| La web: productora, comprador, banco y registro | `web/` |
| El agente de WhatsApp (Meta + Claude) para Supabase | `supabase/functions/whatsapp/index.ts` |
| Las pruebas | `pruebas.mjs` |

**Toda la confianza vive en la base de datos**, no en la app: si una regla estuviera en
la app, bastaría con saltarse la app. La web solo pinta lo que la base decide. Nada de
«verificada» se guarda: se calcula cada vez, así que si mañana el dinero vuelve al
comprador, la venta pasa sola a retenida.

### Las alarmas que retienen una venta

- Pasa lo que la finca puede producir (tareas por rendimiento, lo anota el técnico del banco).
- Un solo comprador pasa de la mitad de las ventas (desde 5 ventas).
- El dinero volvió al comprador en los 7 días siguientes.
- El comprador tiene el mismo teléfono que el productor.
- Falta la visita del técnico: sin finca anotada no hay tope contra qué medir.

## Pasarlo a Supabase

1. Crear el proyecto y correr `db/base.sql` en el editor de SQL (no `local.sql`: eso ya lo
   trae Supabase).
2. Subir el agente: `supabase functions deploy whatsapp --no-verify-jwt` con estos
   secretos: `META_TOKEN`, `META_PHONE_ID`, `META_VERIFY`, `META_APP_SECRET`,
   `ANTHROPIC_API_KEY` y `PRODUCTOR_DEMO`.
3. En la web, cambiar las llamadas a `/api/...` por el cliente de Supabase: las funciones
   de la base se llaman igual (`perfil`, `dar_permiso`, `quitar_permiso`, `mis_pedidos`,
   `anotar_finca`) y el login real reemplaza la cabecera `x-usuario`.

## Lo que hay que preguntarle al banco

- ¿Su factoring aplica a un productor pequeño?
- ¿Puede pagarle el préstamo directo al proveedor de insumos?
- ¿Compartiría los movimientos de la cuenta, con permiso del productor, por archivo diario o API?

Mientras no contesten, los movimientos se simulan (botón «Transferir» y el archivo CSV del
portal del banco).

---

AgroDevs · Hackathon 2.0 Agro Tecnológico
