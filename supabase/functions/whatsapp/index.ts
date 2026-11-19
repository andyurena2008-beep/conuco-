// supabase/functions/whatsapp/index.ts
// Meta manda aquí cada mensaje de WhatsApp. El agente contesta con el inventario real y,
// cuando el comprador confirma, pasa el pedido a la base para que ella decida el precio.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k)!;
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const agente = new Anthropic();
const PRODUCTOR = env("PRODUCTOR_DEMO"); // atajo: un productor por número; con más, se busca por phone_number_id

const SISTEMA = `Vendes por WhatsApp lo que produce una finca dominicana. Ofrece solo lo que
devuelve ver_inventario. Cuando el comprador confirme producto y libras, usa crear_pedido y
dile el monto y que transfiera a la cuenta del Banco Agrícola que te devuelve. Mensajes cortos.`;

const herramientas = [
  { name: "ver_inventario", description: "Lo que hay hoy, con libras y precio por libra.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "crear_pedido", description: "Crea el pedido cuando el comprador confirmó producto y libras.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["producto", "libras"],
      properties: { producto: { type: "string" }, libras: { type: "number" } } } },
];

async function usar(nombre: string, entrada: any, tel: string, perfil: string) {
  if (nombre === "ver_inventario")
    return (await db.from("inventario").select("producto, libras, precio").eq("productor", PRODUCTOR)).data;
  const { data, error } = await db.rpc("crear_pedido", { p_productor: PRODUCTOR, p_telefono: tel,
    p_nombre: perfil, p_producto: entrada.producto, p_libras: entrada.libras });
  if (error) return { error: error.message };
  const { data: p } = await db.from("productores").select("cuenta").eq("id", PRODUCTOR).single();
  return { pedido: data.id, monto: data.monto, cuenta_banco_agricola: p!.cuenta };
}

async function atender(tel: string, perfil: string, id: string, texto: string) {
  // Si Meta reenvía un mensaje, el id ya existe y no lo contestamos dos veces
  if ((await db.from("mensajes").insert({ id, telefono: tel, rol: "user", texto })).error) return;
  const { data } = await db.from("mensajes").select("rol, texto").eq("telefono", tel)
    .order("creado", { ascending: false }).limit(20);
  const mensajes: any[] = data!.reverse().map((m) => ({ role: m.rol, content: m.texto }));

  let r;
  while (true) {
    r = await agente.beta.messages.create({
      model: "claude-opus-5-5", max_tokens: 8000, output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      system: SISTEMA, tools: herramientas as any, messages: mensajes,
    });
    if (r.stop_reason !== "tool_use") break;
    mensajes.push({ role: "assistant", content: r.content });
    mensajes.push({ role: "user", content: await Promise.all(r.content
      .filter((b) => b.type === "tool_use")
      .map(async (b: any) => ({ type: "tool_result", tool_use_id: b.id,
        content: JSON.stringify(await usar(b.name, b.input, tel, perfil)) }))) });
  }
  const respuesta = r.stop_reason === "refusal" ? "Ahora te escribe el productor."
    : r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

  await db.from("mensajes").insert({ telefono: tel, rol: "assistant", texto: respuesta });
  await fetch(`https://graph.facebook.com/v24.0/${env("META_PHONE_ID")}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("META_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: tel, text: { body: respuesta } }),
  });
}

// Solo aceptamos lo que firmó Meta con nuestra clave; cualquiera puede llamar a esta URL.
async function firmaValida(cuerpo: string, firma: string | null) {
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("META_APP_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(firma?.replace("sha256=", "").match(/../g) ?? [], (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", clave, bytes, new TextEncoder().encode(cuerpo));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") { // Meta comprueba la URL una sola vez
    const ok = url.searchParams.get("hub.verify_token") === env("META_VERIFY");
    return new Response(ok ? url.searchParams.get("hub.challenge") : "no", { status: ok ? 200 : 403 });
  }
  const cuerpo = await req.text();
  if (!(await firmaValida(cuerpo, req.headers.get("x-hub-signature-256"))))
    return new Response("no", { status: 401 });

  const valor = JSON.parse(cuerpo).entry?.[0]?.changes?.[0]?.value;
  const msg = valor?.messages?.[0];
  if (msg?.type === "text") // Meta recibe el acuse sin esperar la respuesta al comprador.
    EdgeRuntime.waitUntil(atender(msg.from, valor.contacts?.[0]?.profile?.name ?? msg.from, msg.id, msg.text.body));
  return new Response("ok");
});
