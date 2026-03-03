// src/handlers/flows/falla.js
const { hasMinLen } = require("../../utils/validators");
const { createReport } = require("../../services/reportsService");
const { notifyAdmin } = require("../../services/notifyService");

function intro() {
  return (
    "Claro, te apoyo con la falla.\n" +
    "Para ubicarlo rápido: ¿estás *sin internet* o está *lento/intermitente*?"
  );
}

function isYes(text) {
  return /^(si|sí|simon|simón|ok|vale|va|listo|correcto|ya|afirmativo)$/i.test(
    String(text || "").trim()
  );
}
function isNo(text) {
  return /^(no|nel|nop|nope|negativo|aun no|aún no)$/i.test(String(text || "").trim());
}

function parseTipo(text) {
  const t = String(text || "").toLowerCase();
  if (/(sin internet|no hay internet|no tengo internet|sin servicio)/i.test(t)) return "SIN_INTERNET";
  if (/(lento|intermit|se va|se corta|inestable|muy lento)/i.test(t)) return "LENTO_INTERMITENTE";
  return "OTRO";
}

function askYesNo(q) {
  return `${q}\nResponde *sí* o *no*.`;
}

// Mensaje final corto (ya sin “lista” larga)
function buildFallaCierreMsg({ folio }) {
  return (
    `✅ *Reporte levantado*\n` +
    `Folio: *${folio}*\n\n` +
    `Estamos trabajando para restablecer tu servicio en un lapso de *24 a 48 hrs*.\n` +
    `Si necesitas seguimiento, responde a este chat con tu *folio* 🙌`
  );
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const txt = String(inbound.text || "").trim();

  const phoneE164 = session.phone_e164 || inbound.phoneE164 || null;

  // STEP 1: tipo de falla
  if (step === 1) {
    if (!hasMinLen(txt, 2)) {
      await send("¿Me confirmas si estás *sin internet* o está *lento/intermitente*?");
      return;
    }

    const tipo = parseTipo(txt);

    await updateSession({ step: 2, data: { ...data, tipo } });
    await send("Perfecto. ¿A nombre de quién está el servicio?");
    return;
  }

  // STEP 2: nombre
  if (step === 2) {
    if (!hasMinLen(txt, 3)) {
      await send("¿A nombre de quién está el servicio?");
      return;
    }

    await updateSession({ step: 3, data: { ...data, nombre: txt } });

    // Arrancamos checklist interactivo (pregunta 1)
    await send(
      askYesNo("1/3) ¿El módem/router está *conectado a la luz* y tiene *luces encendidas*?")
    );
    return;
  }

  // STEP 3: checklist Q1 (luces)
  if (step === 3) {
    if (!hasMinLen(txt, 1) || (!isYes(txt) && !isNo(txt))) {
      await send(askYesNo("¿El módem/router está *conectado* y con *luces encendidas*?"));
      return;
    }

    // Si dice NO, damos instrucción y pasamos a Q2
    await updateSession({ step: 4, data: { ...data, q1_luces: isYes(txt) } });

    if (isNo(txt)) {
      await send(
        "Ok 👍 Conéctalo bien a la luz y revisa que encienda.\n" +
          "Cuando esté encendido, avísame y seguimos."
      );
      return;
    }

    await send(askYesNo("2/3) ¿Ya lo *reiniciaste*? (desconéctalo 30 segundos y vuelve a conectar)"));
    return;
  }

  // STEP 4: checklist Q2 (reinicio)
  if (step === 4) {
    // Si venimos de “q1 NO” pedimos confirmación simple para continuar
    // (“ya está encendido” puede no ser sí/no). Aceptamos texto libre y lo interpretamos.
    if (data.q1_luces === false) {
      // si no está encendido aún, insistimos
      if (/no|aun no|aún no|sigue apagado|no prende/i.test(txt)) {
        await send("Entendido. Cuando encienda y tenga luces, avísame por aquí 🙂");
        return;
      }
      // asumimos que ya está listo
      await updateSession({ step: 4, data: { ...data, q1_luces: true } });
      await send(
        askYesNo("2/3) ¿Ya lo *reiniciaste*? (desconéctalo 30 segundos y vuelve a conectar)")
      );
      return;
    }

    if (!hasMinLen(txt, 1) || (!isYes(txt) && !isNo(txt))) {
      await send(askYesNo("¿Ya lo *reiniciaste*? (30 segundos desconectado y vuelves a conectar)"));
      return;
    }

    await updateSession({ step: 5, data: { ...data, q2_reinicio: isYes(txt) } });

    if (isNo(txt)) {
      await send(
        "Va 👍 Haz esto:\n" +
          "1) Desconecta el módem 30 segundos\n" +
          "2) Vuélvelo a conectar\n\n" +
          "Cuando termine de encender (1–2 min), dime si *ya regresó el internet*."
      );
      // Aquí NO avanzamos; el siguiente mensaje nos dirá si regresó.
      return;
    }

    await send(askYesNo("3/3) Después de reiniciarlo, ¿*ya regresó el internet*?"));
    return;
  }

  // STEP 5: checklist Q3 (¿regresó?)
  if (step === 5) {
    // si venimos de “q2 NO” aceptamos texto libre y lo llevamos a sí/no
    if (/ya regreso|ya regresó|si ya|ya quedo|ya quedó|funciona|ya tengo|listo/i.test(txt)) {
      await closeSession();
      await send("¡Excelente! ✅ Me alegra. Si vuelve a pasar, escríbenos por aquí y te ayudamos.");
      return;
    }

    if (/no|aun no|aún no|sigue igual|no funciona|sin internet/i.test(txt)) {
      // levanta reporte
      if (!phoneE164) {
        await closeSession();
        await send("Uy 😅 no pude identificar tu número. Escribe *agente* por favor.");
        return;
      }

      const desc =
        data.tipo === "LENTO_INTERMITENTE"
          ? "Lento / intermitente. Checklist aplicado y continúa sin funcionar."
          : "Sin internet. Checklist aplicado y continúa sin funcionar.";

      const r = await createReport({
        phoneE164,
        nombre: data.nombre,
        descripcion: desc,
      });

      await notifyAdmin(
        `🛠️ REPORTE DE FALLA ${r.folio}\n` +
          `Nombre: ${data.nombre || "N/A"}\n` +
          `Tel: ${phoneE164}\n` +
          `Tipo: ${data.tipo || "N/A"}\n` +
          `Checklist: luces=${data.q1_luces ? "SI" : "NO"} reinicio=${data.q2_reinicio ? "SI" : "NO"}\n` +
          `Descripción: ${desc}`
      );

      await closeSession();
      await send(buildFallaCierreMsg({ folio: r.folio }));
      return;
    }

    // Validación sí/no estándar
    if (!hasMinLen(txt, 1) || (!isYes(txt) && !isNo(txt))) {
      await send(askYesNo("Después de reiniciarlo, ¿*ya regresó el internet*?"));
      return;
    }

    if (isYes(txt)) {
      await closeSession();
      await send("¡Excelente! ✅ Me alegra. Si vuelve a pasar, escríbenos por aquí y te ayudamos.");
      return;
    }

    // NO => levanta reporte
    if (!phoneE164) {
      await closeSession();
      await send("Uy 😅 no pude identificar tu número. Escribe *agente* por favor.");
      return;
    }

    const desc =
      data.tipo === "LENTO_INTERMITENTE"
        ? "Lento / intermitente. Checklist aplicado y continúa sin funcionar."
        : "Sin internet. Checklist aplicado y continúa sin funcionar.";

    const r = await createReport({
      phoneE164,
      nombre: data.nombre,
      descripcion: desc,
    });

    await notifyAdmin(
      `🛠️ REPORTE DE FALLA ${r.folio}\n` +
        `Nombre: ${data.nombre || "N/A"}\n` +
        `Tel: ${phoneE164}\n` +
        `Tipo: ${data.tipo || "N/A"}\n` +
        `Checklist: luces=${data.q1_luces ? "SI" : "NO"} reinicio=${data.q2_reinicio ? "SI" : "NO"}\n` +
        `Descripción: ${desc}`
    );

    await closeSession();
    await send(buildFallaCierreMsg({ folio: r.folio }));
    return;
  }

  // fallback
  await closeSession();
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };