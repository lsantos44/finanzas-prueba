// ============================================================
//  Backend de la app de finanzas — Cloudflare Worker
//   · Proxy de IA (oculta la clave, añade CORS) → rutas normales (POST /chat/completions)
//   · Enable Banking (firma JWT, conecta el banco)  → rutas /bank/*
// ============================================================
//  Variables (Cloudflare → tu Worker → Settings → Variables and Secrets):
//   -- IA --
//   UPSTREAM_KEY   (Secret)    clave del proveedor (OpenRouter "sk-or-…")
//   UPSTREAM_BASE  (Text, opc) URL del proveedor; por defecto OpenRouter
//   ALLOW_ORIGIN   (Text)      tu web; admite varios separados por comas
//   DB             (D1)        base de datos del almacenamiento (binding, no variable)
//   PROXY_TOKEN    (Secret,opc) token que la app manda como "clave" para autorizar
//   -- Enable Banking --
//   EB_APP_ID      (Text)      tu Application ID de Enable Banking
//   EB_PRIVATE_KEY (Secret)    contenido completo del .pem (con las líneas BEGIN/END)
// ============================================================

const EB_BASE = "https://api.enablebanking.com";

/* ---------- Firma JWT (RS256) para Enable Banking ---------- */
function b64urlStr(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBuf(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToBuf(pem) {
  const b64 = String(pem || "").replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function ebJwt(env) {
  if (!env.EB_APP_ID) throw new Error("Falta EB_APP_ID");
  if (!env.EB_PRIVATE_KEY) throw new Error("Falta EB_PRIVATE_KEY");
  const header = { typ: "JWT", alg: "RS256", kid: env.EB_APP_ID };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 };
  const data = b64urlStr(JSON.stringify(header)) + "." + b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("pkcs8", pemToBuf(env.EB_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return data + "." + b64urlBuf(sig);
}
async function ebFetch(env, path, init = {}) {
  const jwt = await ebJwt(env);
  return fetch(EB_BASE + path, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + jwt } });
}

// Cabeceras del usuario final. Varios bancos exigen saber desde qué IP pide sus datos la persona
// (ING lo declara en `required_psu_headers`) y rechazan la petición si no llegan. No las
// mandábamos nunca. Se desactivan con ?psu_headers=0 para poder comparar.
function psuHeaders(request, url) {
  if (url.searchParams.get("psu_headers") === "0") return {};
  const h = {};
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  if (ip) h["psu-ip-address"] = ip;
  if (ua) h["psu-user-agent"] = ua.slice(0, 200);
  return h;
}

// Ficha del banco en Enable Banking: nos dice cuánto puede durar el consentimiento
// (`maximum_consent_validity`, en segundos) y qué tipos de usuario admite. Pedir a ciegas
// se paga caro: si te pasas del máximo, /auth falla; si te quedas corto, el permiso muere
// a los pocos días y la sincronización se apaga en silencio.
async function ebFindAspsp(env, name, country) {
  try {
    const r = await ebFetch(env, "/aspsps?country=" + encodeURIComponent(country));
    if (!r.ok) return null;
    const list = (await r.json()).aspsps || [];
    return list.find((a) => a.name === name && a.country === country) || list.find((a) => a.name === name) || null;
  } catch { return null; }
}

/* ---------- Rutas /bank/* (Enable Banking) ---------- */
function jsonResp(text, status) { return new Response(text, { status, headers: { "Content-Type": "application/json; charset=utf-8" } }); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Página de error legible CON vuelta a la app. /bank/auth y /bank/callback escupían JSON crudo
// o HTML sin enlace: al fallar la autorización te quedabas tirado en el dominio del Worker,
// sin saber qué había pasado y sin camino de vuelta.
function errorPage(env, titulo, detalle, status) {
  const app = (env.ALLOW_ORIGIN || "").replace(/\/+$/, "");
  const volver = app ? `<p><a href="${escapeHtml(app)}">&larr; Volver a la app</a></p>` : "";
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font:15px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1e293b">' +
    `<h2>${escapeHtml(titulo)}</h2>` +
    `<pre style="white-space:pre-wrap;word-break:break-word;background:#f1f5f9;padding:1rem;border-radius:8px;font-size:13px">${escapeHtml(detalle)}</pre>` +
    volver + "</body>",
    { status: status || 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Hash corto y determinista (FNV-1a). Solo para fabricar una clave cuando el banco no da ninguna.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// Convierte una transacción de Enable Banking al esquema de la app.
function mapEbTransaction(tx, uid) {
  const amt = parseFloat((tx.transaction_amount && tx.transaction_amount.amount) || "0") || 0;
  const sign = tx.credit_debit_indicator === "DBIT" ? -1 : 1; // DBIT = sale (gasto); CRDT = entra (ingreso)
  const amount = Math.round(sign * Math.abs(amt) * 100) / 100;
  const date = tx.booking_date || tx.value_date || tx.transaction_date || null;
  const cp = tx.credit_debit_indicator === "DBIT" ? tx.creditor : tx.debtor; // la contraparte útil
  const cpName = (cp && cp.name) || "";
  const remit = Array.isArray(tx.remittance_information) ? tx.remittance_information.join(" ") : (tx.remittance_information || "");
  const concept = (cpName || remit || "Movimiento").toString().replace(/\s+/g, " ").trim().slice(0, 140);
  const ref = tx.entry_reference || tx.transaction_id || null;
  // Sin referencia del banco no hay deduplicación posible: el mismo movimiento entraba en cada
  // sincronización. Se fabrica una clave determinista con lo que sí es estable (cuenta, fecha,
  // importe, concepto), legible para poder depurarla. `hasId:false` deja constancia.
  const bankId = ref || `h:${String(uid || "").slice(0, 8)}:${date || "?"}:${Math.round(amount * 100)}:${fnv1a(concept.toLowerCase())}`;
  return { bankId, hasId: !!ref, date, amount, currency: tx.transaction_amount && tx.transaction_amount.currency, concept };
}

// Baja los movimientos de una cuenta para UNA ventana de fechas (paginando con continuation_key).
// `budget` limita el nº total de peticiones (Cloudflare free = 50 subrequests por invocación).
async function ebAccountTransactions(env, uid, from, to, budget, psuH, txStatus) {
  let all = [], cont = null, pages = 0;
  do {
    if (budget && budget.left <= 0) break;
    let path = `/accounts/${uid}/transactions?date_from=${from}&date_to=${to}`;
    // No pedíamos estado y luego descartábamos lo que no fuera BOOK. Muchos bancos exigen que el
    // filtro venga en la petición y rechazan con 400 el valor por defecto que ponga el proveedor.
    if (txStatus) path += `&transaction_status=${encodeURIComponent(txStatus)}`;
    if (cont) path += `&continuation_key=${encodeURIComponent(cont)}`;
    const r = await ebFetch(env, path, { headers: psuH || {} });
    if (budget) budget.left--;
    // El rango va en el mensaje: sin él, un 400 del banco no dice qué ventana lo ha provocado
    // y no se puede distinguir "no llega tan atrás" de "la petición está mal formada".
    if (!r.ok) throw new Error(`transactions ${from}..${to} HTTP ` + r.status + ": " + (await r.text()).slice(0, 200));
    const j = await r.json();
    all = all.concat(j.transactions || []);
    cont = j.continuation_key || null;
    pages++;
  } while (cont && pages < 25);
  return all;
}

// Baja el histórico troceando en ventanas de 90 días (muchos bancos, p. ej. CaixaBank, rechazan
// rangos largos con 422 "Wrong transactions period"). Camina hacia atrás desde `to` hasta `from`,
// y para si el banco rechaza una ventana (4xx = ya no deja ir más atrás) o se agota el presupuesto.
async function ebAccountHistory(env, uid, fromISO, toISO, budget, psuH, txStatus) {
  const DAY = 86400000, WIN = 90 * DAY;
  const start = Date.parse(fromISO + "T00:00:00Z");
  let winEnd = Date.parse(toISO + "T00:00:00Z");
  let all = [], guard = 0;
  while (winEnd > start && guard < 20 && (!budget || budget.left > 0)) {
    guard++;
    let winStart = Math.max(start, winEnd - WIN);
    try {
      all = all.concat(await ebAccountTransactions(env, uid, new Date(winStart).toISOString().slice(0, 10), new Date(winEnd).toISOString().slice(0, 10), budget, psuH, txStatus));
    } catch (e) {
      const msg = String((e && e.message) || e);
      const auth = /HTTP (401|403)/.test(msg); // consentimiento muerto: no hay reintento que valga
      // Hay bancos que rechazan la ventana de 90 días aunque el consentimiento esté vivo. Antes
      // de dar la sincronización por perdida, se reintenta la ventana más reciente con 30 días:
      // así se distingue "el rango es demasiado ancho" de "la conexión está rota".
      if (guard === 1 && !auth && /HTTP 4\d\d/.test(msg) && winEnd - winStart > 30 * DAY && (!budget || budget.left > 0)) {
        winStart = Math.max(start, winEnd - 30 * DAY);
        all = all.concat(await ebAccountTransactions(env, uid, new Date(winStart).toISOString().slice(0, 10), new Date(winEnd).toISOString().slice(0, 10), budget, psuH, txStatus));
      } else {
        // Un 4xx en la PRIMERA ventana (la más reciente) NO es "ya no hay más histórico": es la
        // conexión rota. Tragárselo aquí era lo que hacía que la app devolviese 0 movimientos
        // con un 200 y cantase "sin novedades" durante meses.
        if (guard === 1) throw e;
        if (/HTTP 4\d\d/.test(msg)) break; // el banco no deja ir más atrás
        throw e;
      }
    }
    winEnd = winStart - DAY; // siguiente ventana, un día antes para no solapar
  }
  return all;
}
function allowedOrigins(env) {
  return String(env.ALLOW_ORIGIN || "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
}
function corsFor(request, env, methods = "GET, OPTIONS") {
  const list = allowedOrigins(env);
  const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
  const ok = list.includes(origin) || origin === "http://localhost:4173";
  return {
    "Access-Control-Allow-Origin": ok ? origin : (list[0] || "*"),
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}
function bankCors(request, env) { return corsFor(request, env); }

async function handleBank(request, env, url) {
  const callback = url.origin + "/bank/callback";
  const psuH = psuHeaders(request, url); // van en todas las llamadas de datos al banco

  // Endpoint que llama la APP: devuelve los movimientos ya mapeados de la sesión.
  if (url.pathname === "/bank/transactions") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const sid = url.searchParams.get("session");
    if (!sid) return new Response(JSON.stringify({ error: "falta ?session=" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    // `date_to` iba dos días en el FUTURO. Varios bancos españoles rechazan de plano un rango
    // que pide movimientos que aún no existen, y CaixaBank contesta 400 ASPSP_ERROR "Unknown
    // error", que no dice nada. Se recorta a hoy salvo que se pida otra cosa a mano.
    const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
    // Por defecto NO se manda filtro de estado: así sincronizaba correctamente el 2026-09-07 con
    // una sesión válida, y no se mete una variable nueva en un camino que ya funciona. Queda
    // disponible para diagnóstico: ?tx_status=BOOK / PDNG / ALL.
    const txStatus = url.searchParams.get("tx_status") === "none" ? "" : (url.searchParams.get("tx_status") || "");
    const from = url.searchParams.get("from") || new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
    const sr = await ebFetch(env, `/sessions/${sid}`);
    if (!sr.ok) return new Response(await sr.text(), { status: sr.status, headers: { ...cors, "Content-Type": "application/json" } });
    const sess = await sr.json();
    // Filtro opcional por cuenta: ?account=<uid> trae SOLO esa cuenta (para no mezclar cuentas).
    const wantUid = url.searchParams.get("account") || null;
    const uids = (sess.accounts || []).map((a) => (typeof a === "string" ? a : (a && a.uid))).filter(Boolean).filter((u) => !wantUid || u === wantUid);
    const movements = [];
    const errors = [];
    let noId = 0; // movimientos a los que el banco no ha dado referencia (clave fabricada)
    const budget = { left: 44 }; // margen bajo el límite de 50 subrequests de Cloudflare
    for (const uid of uids) {
      try {
        const txs = await ebAccountHistory(env, uid, from, to, budget, psuH, txStatus);
        // Dos movimientos idénticos el mismo día (dos cafés iguales) sin referencia del banco
        // compartirían clave fabricada y el segundo se perdería. Se numeran dentro de la
        // respuesta (#2, #3…): el conjunto de claves es el mismo aunque el banco cambie el orden.
        const seen = new Map();
        for (const t of txs) if (t.status === "BOOK") {
          const m = mapEbTransaction(t, uid); m.accountUid = uid;
          if (!m.hasId) { const n = (seen.get(m.bankId) || 0) + 1; seen.set(m.bankId, n); if (n > 1) m.bankId += "#" + n; noId++; }
          movements.push(m);
        }
      } catch (e) {
        // Un fallo en una cuenta no debe tumbar toda la sincronización: lo registramos y seguimos.
        errors.push({ uid, error: String((e && e.message) || e).slice(0, 200) });
      }
    }
    // Éxito parcial (una cuenta falla, otra no) sigue siendo 200: hay datos que ingerir.
    // Pero "ninguna cuenta ha respondido" es un fallo, y devolverlo como 200 con la lista vacía
    // es exactamente lo que hacía invisible el permiso caducado. Se propaga el estado real.
    if (!movements.length && (errors.length || !uids.length)) {
      // Si el filtro de cuenta no casa, decir CUÁLES hay: los uid cambian al renovar la sesión,
      // y un "no contiene esa cuenta" a secas no deja claro que solo hay que reelegirla.
      const todos = (sess.accounts || []).map((a) => (typeof a === "string" ? a : (a && a.uid))).filter(Boolean);
      const first = errors.length ? errors[0].error
        : (wantUid ? `la sesión no contiene la cuenta ${wantUid}. Las de esta sesión son: ${todos.join(", ") || "(ninguna)"}. Vuelve a elegir la cuenta en Ajustes.`
          : "la sesión no tiene ninguna cuenta");
      const m = /HTTP (\d{3})/.exec(first);
      const status = m ? Number(m[1]) : 502;
      return new Response(JSON.stringify({ movements, errors, error: first }), { status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ movements, errors, noId }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Lista las cuentas de la sesión (uid, nombre, IBAN) para que la app deje elegir cuál seguir.
  if (url.pathname === "/bank/accounts") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const sid = url.searchParams.get("session");
    if (!sid) return new Response(JSON.stringify({ error: "falta ?session=" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const sr = await ebFetch(env, `/sessions/${sid}`);
    if (!sr.ok) return new Response(await sr.text(), { status: sr.status, headers: { ...cors, "Content-Type": "application/json" } });
    const sess = await sr.json();
    const accounts = [];
    for (const a of (sess.accounts || [])) {
      const uid = typeof a === "string" ? a : (a && a.uid);
      if (!uid) continue;
      let name = typeof a === "object" ? (a.name || a.product || "") : "";
      let iban = typeof a === "object" ? (a.account_id && a.account_id.iban) : null;
      let type = typeof a === "object" ? a.cash_account_type : null;
      // El fallo de `details` se tragaba en silencio y la cuenta salía llamándose como su uid.
      // Es la llamada de datos más simple que hay (sin fechas ni filtros): si ESTA falla, el
      // problema no es la ventana de transacciones sino el acceso al banco entero.
      let detailsError = null;
      if (!name || !iban) {
        try {
          const dr = await ebFetch(env, `/accounts/${uid}/details`, { headers: psuH });
          if (dr.ok) { const d = await dr.json(); name = name || d.name || d.product || ""; iban = iban || (d.account_id && d.account_id.iban) || null; type = type || d.cash_account_type || null; }
          else detailsError = "HTTP " + dr.status + ": " + (await dr.text()).slice(0, 200);
        } catch (e) { detailsError = String((e && e.message) || e).slice(0, 200); }
      }
      // Saldo por cuenta. Cuando el banco no da nombre ni IBAN (details falla), el saldo es lo
      // único que permite distinguir una cuenta de otra en el desplegable: sin esto, elegir
      // "la buena" entre dos uid hexadecimales es adivinar.
      let balance = null, currency = null;
      try {
        const br = await ebFetch(env, `/accounts/${uid}/balances`, { headers: psuH });
        if (br.ok) {
          const list = (await br.json()).balances || [];
          const pick = list.find((x) => /ITAV|available/i.test(x.balance_type || "")) || list.find((x) => /CLBD|booked/i.test(x.balance_type || "")) || list[0];
          if (pick && pick.balance_amount) { balance = Number(pick.balance_amount.amount); currency = pick.balance_amount.currency || null; }
        }
      } catch { /* el saldo es orientativo */ }
      accounts.push({ uid, name: name || uid.slice(0, 8), iban, type, balance, currency, ...(detailsError ? { detailsError } : {}) });
    }
    return new Response(JSON.stringify({ accounts }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Saldo REAL actual de la cuenta (lo que ves en tu banco). Enable Banking lo da en /balances.
  if (url.pathname === "/bank/balance") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const sid = url.searchParams.get("session");
    if (!sid) return new Response(JSON.stringify({ error: "falta ?session=" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const wantUid = url.searchParams.get("account") || null;
    const sr = await ebFetch(env, `/sessions/${sid}`);
    if (!sr.ok) return new Response(await sr.text(), { status: sr.status, headers: { ...cors, "Content-Type": "application/json" } });
    const sess = await sr.json();
    const uids = (sess.accounts || []).map((a) => (typeof a === "string" ? a : (a && a.uid))).filter(Boolean).filter((u) => !wantUid || u === wantUid);
    const balances = [];
    for (const uid of uids) {
      try {
        const br = await ebFetch(env, `/accounts/${uid}/balances`, { headers: psuH });
        if (!br.ok) { balances.push({ uid, error: "HTTP " + br.status }); continue; }
        const list = (await br.json()).balances || [];
        // Preferimos el saldo "disponible" (ITAV); si no, el "contable" (CLBD); si no, el primero.
        const pick = list.find((b) => /ITAV|available/i.test(b.balance_type || "")) ||
                     list.find((b) => /CLBD|booked/i.test(b.balance_type || "")) || list[0];
        const amt = pick && pick.balance_amount;
        balances.push({ uid, amount: amt ? Number(amt.amount) : null, currency: amt ? amt.currency : null,
          type: pick ? pick.balance_type : null, at: pick ? (pick.reference_date || pick.last_change_date_time || null) : null });
      } catch (e) { balances.push({ uid, error: String((e && e.message) || e).slice(0, 120) }); }
    }
    return new Response(JSON.stringify({ balances }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Diagnóstico: confirma que la firma JWT y la clave funcionan. Devuelve los datos de tu app.
  // Iba sin autorizar: cualquiera con la URL del Worker veía los datos de tu aplicación de
  // Enable Banking. Ahora pide el mismo token que el resto, así que se llama desde la app
  // (Ajustes → Probar backend), no escribiendo la URL en el navegador.
  if (url.pathname === "/bank/ping") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const r = await ebFetch(env, "/application");
    return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Listar bancos disponibles del país. La APP lo llama para el selector de banco (CORS + token).
  if (url.pathname === "/bank/aspsps") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const country = url.searchParams.get("country") || "ES";
    const r = await ebFetch(env, "/aspsps?country=" + encodeURIComponent(country));
    return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Revocar una sesión en Enable Banking. Al quitar un banco la app solo borraba su copia local:
  // la sesión seguía viva en EB y el consentimiento colgado en el banco. Con bancos que solo
  // admiten un consentimiento activo por proveedor, esa basura bloquea las reconexiones.
  if (url.pathname === "/bank/revoke") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const sid = url.searchParams.get("session");
    if (!sid) return new Response(JSON.stringify({ error: "falta ?session=" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    const r = await ebFetch(env, `/sessions/${sid}`, { method: "DELETE" });
    return new Response(await r.text() || JSON.stringify({ ok: r.ok, status: r.status }), { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Ficha completa de UN banco: validez máxima del consentimiento, tipos de usuario y métodos
  // de autorización. Es lo que hay que mirar cuando el banco contesta "invalid_request".
  if (url.pathname === "/bank/aspsp") {
    const cors = bankCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return new Response(JSON.stringify({ error: "No autorizado" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const info = await ebFindAspsp(env, url.searchParams.get("name") || "", url.searchParams.get("country") || "ES");
    return new Response(JSON.stringify(info || { error: "banco no encontrado" }), { status: info ? 200 : 404, headers: { ...cors, "Content-Type": "application/json" } });
  }

  // Iniciar la conexión: abre sesión y te redirige al banco para el login/SCA.
  if (url.pathname === "/bank/auth") {
    const name = url.searchParams.get("aspsp");
    const country = url.searchParams.get("country") || "ES";
    if (!name) return errorPage(env, "Falta el banco", "Llama a /bank/auth?aspsp=NOMBRE&country=CC (los nombres válidos están en /bank/aspsps).", 400);
    // Pedíamos 10 días de consentimiento: la conexión se moría sola cada semana y media y la app
    // seguía diciendo que todo iba bien. PSD2 permite 90; algunos bancos menos, así que pedimos
    // lo máximo que admita ESTE banco sin pasarnos (pasarse hace que /auth falle).
    const info = await ebFindAspsp(env, name, country);
    const maxSecs = Number(info && info.maximum_consent_validity) || 90 * 86400;
    // Los tres parámetros se pueden forzar por query (?days= ?psu= ?auth_method=) para poder
    // bisecar un "invalid_request" del banco sin tocar el código ni volver a desplegar.
    const qDays = Number(url.searchParams.get("days")) || 0;
    const secs = qDays ? qDays * 86400 : Math.max(86400, Math.min(90 * 86400, maxSecs) - 600); // 10 min de margen
    // Hay bancos que solo existen como "business" en Enable Banking; mandarles "personal" a
    // ciegas era un error garantizado al conectar.
    const psuTypes = (info && Array.isArray(info.psu_types)) ? info.psu_types : [];
    const psu = url.searchParams.get("psu") || (psuTypes.length ? (psuTypes.includes("personal") ? "personal" : psuTypes[0]) : "personal");
    // Bancos con varios métodos de autorización: si no eliges, Enable Banking coge uno por
    // defecto que el banco puede rechazar. Permitimos fijarlo a mano.
    const authMethod = url.searchParams.get("auth_method") || "";
    // `state` vuelve del banco tal cual, también cuando la cosa falla. Metemos ahí lo que hemos
    // pedido para que la página de error pueda enseñarlo: sin esto, un "invalid_request" pelado
    // no dice contra qué parámetros se ha estrellado.
    // Con ?state=uuid se manda un UUID pelado, como antes de meterle datos dentro. Sirve para
    // reproducir byte a byte la petición que sí funcionaba en julio y poder afirmar, sin
    // suposiciones, si algo de NUESTRO lado cambió el resultado.
    const state = url.searchParams.get("state") === "uuid"
      ? crypto.randomUUID()
      : b64urlStr(JSON.stringify({ n: name, c: country, p: psu, d: Math.round(secs / 86400), m: authMethod, r: Math.random().toString(36).slice(2, 8) }));
    // `access` va con solo `valid_until`, que es lo que el banco viene aceptando: llega a mostrar
    // su login y admite la firma. Declarar balances/transactions (?access=full) queda como
    // variante a mano; ponerlo por defecto sería mover una variable que sabemos que no falla.
    const access = { valid_until: new Date(Date.now() + secs * 1000).toISOString() };
    if (url.searchParams.get("access") === "full") { access.balances = true; access.transactions = true; }
    const body = {
      access,
      aspsp: { name, country },
      state,
      redirect_url: callback,
      psu_type: psu,
      ...(authMethod ? { auth_method: authMethod } : {}),
    };
    const r = await ebFetch(env, "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const raw = await r.text();
    // ?debug=1 enseña la petición y la respuesta enteras en vez de redirigir. Es la única
    // manera de ver qué acepta Enable Banking sin pasar por el login del banco.
    if (url.searchParams.get("debug")) {
      return errorPage(env, `Diagnóstico de /auth — Enable Banking respondió ${r.status}`,
        "PETICIÓN enviada a POST /auth:\n" + JSON.stringify(body, null, 2) + "\n\nRESPUESTA:\n" + raw.slice(0, 1500), 200);
    }
    if (!r.ok) {
      return errorPage(env, "El banco no ha aceptado la conexión",
        `Banco: ${name} (${country})\nTipo de usuario: ${psu}\nConsentimiento pedido: ${Math.round(secs / 86400)} días\nEnable Banking respondió ${r.status}:\n\n` + raw.slice(0, 1200), 200);
    }
    let data = {};
    try { data = JSON.parse(raw); } catch { /* respuesta no JSON */ }
    if (data.url) return Response.redirect(data.url, 302);
    return errorPage(env, "Enable Banking no ha devuelto URL de login", raw.slice(0, 1200), 200);
  }

  // Vuelta del banco: crea la sesión con el "code" y REDIRIGE a la app con el session_id.
  if (url.pathname === "/bank/callback") {
    const code = url.searchParams.get("code");
    // Cuando el usuario cancela el SCA o el banco rechaza, vuelve con ?error= en vez de ?code=.
    // Antes eso caía en el mismo mensaje seco de "no devolvió code" y parecía un fallo nuestro.
    const bankErr = url.searchParams.get("error");
    // Un "invalid_request" sin descripción no permite arreglar nada. Enseñamos TODO lo que ha
    // vuelto y, desde `state`, contra qué parámetros se ha estrellado la petición.
    if (bankErr || !code) {
      const params = [...url.searchParams.entries()].map(([k, v]) => `  ${k} = ${v}`).join("\n") || "  (ninguno)";
      let pedido = "  (no se ha podido leer el state)";
      try {
        const s = JSON.parse(atob(String(url.searchParams.get("state") || "").replace(/-/g, "+").replace(/_/g, "/")));
        pedido = `  banco = ${s.n} (${s.c})\n  psu_type = ${s.p}\n  consentimiento = ${s.d} días\n  auth_method = ${s.m || "(por defecto)"}`;
      } catch { /* state ajeno o ilegible */ }
      return errorPage(env,
        bankErr ? "El banco no ha autorizado la conexión" : "El banco no ha devuelto el código de autorización",
        `Lo que respondió Enable Banking:\n${params}\n\nLo que le habíamos pedido:\n${pedido}\n\n` +
        "Para probar variantes, abre a mano (cambiando NOMBRE):\n" +
        `  ${url.origin}/bank/auth?aspsp=NOMBRE&country=ES&days=10\n` +
        `  ${url.origin}/bank/auth?aspsp=NOMBRE&country=ES&psu=business\n` +
        "Y para ver la ficha del banco en Enable Banking (métodos de autorización, validez máxima):\n" +
        `  ${url.origin}/bank/aspsp?name=NOMBRE&country=ES  (desde Ajustes → Probar backend, necesita el token)`, 200);
    }
    const sr = await ebFetch(env, "/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!sr.ok) return errorPage(env, "Error creando la sesión", `Enable Banking respondió ${sr.status}:\n\n` + (await sr.text()).slice(0, 1200), 200);
    const sess = await sr.json();
    const app = (env.ALLOW_ORIGIN || "").replace(/\/+$/, "");
    // Sin session_id no hay conexión posible: redirigir con el parámetro vacío dejaba a la app
    // sin hacer nada y sin decir nada, que es la peor de las salidas.
    if (!sess.session_id) return errorPage(env, "Enable Banking no ha devuelto session_id", JSON.stringify(sess, null, 2).slice(0, 1200), 200);
    if (!app) return errorPage(env, "Falta ALLOW_ORIGIN en el Worker", "No sé a qué URL devolverte. Tu sesión se ha creado igualmente:\n\nsession_id = " + sess.session_id, 200);
    return Response.redirect(app + "/?bank_session=" + encodeURIComponent(sess.session_id), 302);
  }

  return new Response("Ruta de banco no encontrada", { status: 404 });
}

/* ============================================================
   ALMACENAMIENTO (Cloudflare D1) — sustituye a Google Drive
   ------------------------------------------------------------
   Por qué D1 y no KV: KV es de consistencia eventual, así que una escritura desde el móvil
   podía no verse al leer desde el PC y se volvía a abrir la misma carrera que ya nos borró
   datos con Drive. D1 es de consistencia fuerte y su plan gratuito permite dos órdenes de
   magnitud más de escrituras.

   Requiere un binding D1 llamado DB (Cloudflare → Worker → Settings → Bindings → D1).
   Si no está, las rutas responden con un mensaje claro en vez de romperse.
   ============================================================ */
const STORE_MAX_BYTES = 4 * 1024 * 1024; // un error no debe poder llenar la base
const STORE_HISTORY = 10;                // versiones anteriores que se conservan

// La clave se DERIVA del token en vez de ser fija: si algún día dos personas comparten un
// Worker, sus datos quedan separados sin tener que construir un sistema de usuarios.
async function storeKey(env) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("finz:" + (env.PROXY_TOKEN || "sin-token")));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Las tablas se crean al vuelo: desplegar el Worker no debe exigir ejecutar migraciones a
// mano, que es justo donde se atasca quien lo instala por primera vez.
async function storeInit(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, payload TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS store_history (k TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (k, version))").run();
}

async function handleStore(request, env, url) {
  const cors = corsFor(request, env, "GET, PUT, OPTIONS");
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (env.PROXY_TOKEN && request.headers.get("Authorization") !== "Bearer " + env.PROXY_TOKEN) return json({ error: "No autorizado" }, 401);

  // Estado de la configuracion: que ve el Worker realmente. Sin esto, "no se guarda el binding"
  // es indistinguible de "el binding esta pero falla la base", y se depura a ciegas desde el
  // panel. Solo booleanos: no expone ningun secreto.
  if (url.pathname === "/store/status") {
    const out = {
      bindingDB: !!env.DB,
      tieneToken: !!env.PROXY_TOKEN,
      allowOrigin: env.ALLOW_ORIGIN || "(sin definir)",
      enableBanking: !!env.EB_APP_ID && !!env.EB_PRIVATE_KEY,
      proxyIA: !!env.UPSTREAM_KEY,
    };
    if (env.DB) {
      try { await storeInit(env.DB); const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM store").first(); out.baseDatos = "responde"; out.filas = r ? r.n : 0; }
      catch (e) { out.baseDatos = "ERROR: " + ((e && e.message) || e); }
    } else {
      out.baseDatos = "sin binding";
    }
    return json(out);
  }

  if (!env.DB) return json({ error: "Falta el binding D1 llamado DB. Cloudflare → tu Worker → Settings → Bindings → D1 database. Comprueba con /store/status que el Worker lo ve." }, 503);

  const db = env.DB;
  await storeInit(db);
  const k = await storeKey(env);

  // Historial: lista de versiones guardadas, o una versión concreta para recuperarla.
  if (url.pathname === "/store/history") {
    const want = url.searchParams.get("version");
    if (want) {
      const row = await db.prepare("SELECT payload, version, updated_at FROM store_history WHERE k = ? AND version = ?").bind(k, Number(want)).first();
      if (!row) return json({ error: "esa versión ya no está guardada" }, 404);
      return json({ payload: JSON.parse(row.payload), version: row.version, updatedAt: row.updated_at });
    }
    const rs = await db.prepare("SELECT version, updated_at, length(payload) AS bytes FROM store_history WHERE k = ? ORDER BY version DESC").bind(k).all();
    return json({ versions: (rs.results || []).map((r) => ({ version: r.version, updatedAt: r.updated_at, bytes: r.bytes })) });
  }

  if (request.method === "GET") {
    const row = await db.prepare("SELECT payload, version, updated_at FROM store WHERE k = ?").bind(k).first();
    if (!row) return json({ empty: true, version: 0 });
    return json({ payload: JSON.parse(row.payload), version: row.version, updatedAt: row.updated_at });
  }

  if (request.method === "PUT") {
    const raw = await request.text();
    if (raw.length > STORE_MAX_BYTES) return json({ error: `la copia pesa ${Math.round(raw.length / 1024)} KB y el máximo es ${Math.round(STORE_MAX_BYTES / 1024)} KB` }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: "cuerpo no es JSON válido" }, 400); }
    if (!body || typeof body.payload !== "object" || body.payload === null) return json({ error: "falta payload" }, 400);

    const cur = await db.prepare("SELECT version, updated_at FROM store WHERE k = ?").bind(k).first();
    const curVersion = cur ? cur.version : 0;
    // Rechazo de escritura obsoleta. Es la pieza que impide que un dispositivo con datos
    // viejos pise lo que otro acaba de guardar: exactamente lo que nos pasó con Drive.
    // El cliente recibe 409 con la versión real y decide (ya tiene pantalla de conflicto).
    if (Number(body.baseVersion) !== curVersion) {
      return json({ error: "conflicto", conflict: true, version: curVersion, updatedAt: cur ? cur.updated_at : null }, 409);
    }
    const next = curVersion + 1, now = Date.now();
    const payloadStr = JSON.stringify(body.payload);
    await db.batch([
      db.prepare("INSERT INTO store (k, payload, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET payload = excluded.payload, version = excluded.version, updated_at = excluded.updated_at").bind(k, payloadStr, next, now),
      db.prepare("INSERT OR REPLACE INTO store_history (k, version, payload, updated_at) VALUES (?, ?, ?, ?)").bind(k, next, payloadStr, now),
      // Poda: el historial es una red de seguridad, no un archivo histórico.
      db.prepare("DELETE FROM store_history WHERE k = ? AND version <= ?").bind(k, next - STORE_HISTORY),
    ]);
    return json({ ok: true, version: next, updatedAt: now });
  }

  return json({ error: "método no permitido" }, 405);
}

/* ---------- Proxy de IA (rutas normales) ---------- */
async function handleAI(request, env) {
  const list = allowedOrigins(env);
  const origin = (request.headers.get("Origin") || "").replace(/\/+$/, "");
  const okOrigin = list.includes(origin) || origin === "http://localhost:4173";
  const cors = { ...corsFor(request, env, "POST, OPTIONS"), "Access-Control-Max-Age": "86400" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("Solo POST", { status: 405, headers: cors });
  if (list.length && origin && !okOrigin) return new Response("Origen no permitido", { status: 403, headers: cors });
  if (env.PROXY_TOKEN) {
    const auth = request.headers.get("Authorization") || "";
    if (auth !== "Bearer " + env.PROXY_TOKEN) return new Response("No autorizado", { status: 401, headers: cors });
  }
  const base = (env.UPSTREAM_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const path = new URL(request.url).pathname.replace(/^\/v1(?=\/)/, "");
  const target = base + (path.startsWith("/") ? path : "/" + path);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + (env.UPSTREAM_KEY || "") },
      body: await request.text(),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "El proxy no pudo contactar con el proveedor: " + e.message } }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const body = await upstream.text();
  return new Response(body, { status: upstream.status, headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/bank/")) {
      try { return await handleBank(request, env, url); }
      catch (e) { return new Response("Error banco: " + (e && e.message ? e.message : e), { status: 500 }); }
    }
    if (url.pathname === "/store" || url.pathname === "/store/history" || url.pathname === "/store/status") {
      try { return await handleStore(request, env, url); }
      catch (e) {
        // El motivo real importa: "no such table" o un binding mal puesto no se distinguen
        // de un fallo de red si solo devolvemos 500 sin cuerpo.
        return new Response(JSON.stringify({ error: "Error de almacenamiento: " + (e && e.message ? e.message : e) }), { status: 500, headers: { ...corsFor(request, env, "GET, PUT, OPTIONS"), "Content-Type": "application/json" } });
      }
    }
    return handleAI(request, env);
  },
};
