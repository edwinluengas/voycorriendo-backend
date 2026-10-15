/**
 * Comandos del dueño para el bot de WhatsApp (OpenClaw, agente `voycorriendo-jefe`)
 * y avisos automáticos (cron de OpenClaw cada minuto).
 *
 *   node src/scripts/bot-admin.js hoy
 *   node src/scripts/bot-admin.js ventas [dias]
 *   node src/scripts/bot-admin.js conectados
 *   node src/scripts/bot-admin.js abiertos
 *   node src/scripts/bot-admin.js pendientes
 *   node src/scripts/bot-admin.js aprobar <telefono>
 *   node src/scripts/bot-admin.js rechazar <telefono> <motivo…>
 *   node src/scripts/bot-admin.js avisos          ← lo corre el cron; imprime NO_REPLY si no hay nada
 *
 * Imprime texto listo para WhatsApp (*negritas*). Aprobar/rechazar pasan por
 * el MISMO servicio que el panel y el bot de Telegram (correo al usuario +
 * bitácora de admin), nunca tocan la tabla a mano.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { Usuario, Negocio, Repartidor } = require('../models');
const aprobaciones = require('../services/aprobaciones.service');
const { nombreDe: nombrePlaza } = require('../config/ciudades');

const TZ = 'America/Mexico_City';
const PENDIENTES = ['pendiente', 'en_revision'];
const ESTADO_AVISOS = path.join(os.homedir(), '.voycorriendo-bot', 'avisos.json');
const $ = (n) => `$${Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const plaza = (slug) => nombrePlaza(slug) || slug || '—';

const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

// ─── Consultas ────────────────────────────────────────────
const hoy = async () => {
  const filas = await q(`
    SELECT p.estado, p.ciudad, COUNT(*)::int n, COALESCE(SUM(p.total),0) total
      FROM pedidos p
     WHERE (p.creado_en AT TIME ZONE :tz)::date = (NOW() AT TIME ZONE :tz)::date
     GROUP BY p.estado, p.ciudad`, { tz: TZ });
  if (!filas.length) return '📭 *Hoy todavía no hay pedidos.*';
  const total = filas.reduce((s, f) => s + f.n, 0);
  const entregados = filas.filter((f) => f.estado === 'entregado');
  const vendido = entregados.reduce((s, f) => s + Number(f.total), 0);
  const porEstado = {};
  const porPlaza = {};
  for (const f of filas) {
    porEstado[f.estado] = (porEstado[f.estado] || 0) + f.n;
    porPlaza[f.ciudad] = (porPlaza[f.ciudad] || 0) + f.n;
  }
  return [
    `📦 *Pedidos de hoy: ${total}*`,
    `💰 Vendido (entregados): *${$(vendido)}*`,
    '',
    '*Por estado:*',
    ...Object.entries(porEstado).map(([e, n]) => `• ${e}: ${n}`),
    '',
    '*Por plaza:*',
    ...Object.entries(porPlaza).map(([c, n]) => `• ${plaza(c)}: ${n}`),
  ].join('\n');
};

const ventas = async (dias = 7) => {
  dias = Math.min(Math.max(parseInt(dias, 10) || 7, 1), 90);
  const filas = await q(`
    SELECT (p.creado_en AT TIME ZONE :tz)::date dia,
           COUNT(*) FILTER (WHERE p.estado = 'entregado')::int entregados,
           COUNT(*) FILTER (WHERE p.estado IN ('cancelado','rechazado'))::int cancelados,
           COALESCE(SUM(p.total) FILTER (WHERE p.estado = 'entregado'),0) vendido
      FROM pedidos p
     WHERE p.creado_en >= NOW() - (:dias || ' days')::interval
     GROUP BY 1 ORDER BY 1 DESC`, { tz: TZ, dias: String(dias) });
  if (!filas.length) return `📭 Sin pedidos en los últimos ${dias} días.`;
  const tot = filas.reduce((s, f) => s + Number(f.vendido), 0);
  const ent = filas.reduce((s, f) => s + f.entregados, 0);
  return [
    `📈 *Ventas últimos ${dias} días: ${$(tot)}* (${ent} entregados)`,
    '',
    ...filas.map((f) => `• ${new Date(f.dia).toISOString().slice(5, 10)}: ${$(f.vendido)} · ${f.entregados} entregados${f.cancelados ? ` · ${f.cancelados} cancelados` : ''}`),
  ].join('\n');
};

const conectados = async () => {
  const filas = await q(`
    SELECT u.nombre, u.apellido, r.ciudad, r.ultimo_latido
      FROM repartidores r JOIN usuarios u ON u.id = r.usuario_id
     WHERE r.conectado = true
     ORDER BY r.ciudad, u.nombre`);
  if (!filas.length) return '🛵 *Ningún repartidor conectado ahora.* Solo se pueden hacer pedidos para recoger.';
  return [`🛵 *Repartidores conectados: ${filas.length}*`, '',
    ...filas.map((f) => `• ${f.nombre} ${f.apellido || ''} — ${plaza(f.ciudad)}`)].join('\n');
};

const abiertos = async () => {
  const filas = await q(`
    SELECT n.nombre, n.ciudad, n.abierto_ahora, (n.matriz_id IS NOT NULL) sucursal
      FROM negocios n
     WHERE n.activo = true AND n.verificacion_estado = 'aprobado'
     ORDER BY n.abierto_ahora DESC, n.ciudad, n.nombre`);
  const ab = filas.filter((f) => f.abierto_ahora);
  return [`🏪 *Negocios abiertos: ${ab.length} de ${filas.length}*`, '',
    ...filas.map((f) => `${f.abierto_ahora ? '🟢' : '⚪'} ${f.nombre}${f.sucursal ? ' (sucursal)' : ''} — ${plaza(f.ciudad)}`)].join('\n');
};

// ─── Aprobaciones ─────────────────────────────────────────
const pendientes = async () => {
  const { repartidores, negocios } = await aprobaciones.listarPendientes();
  if (!repartidores.length && !negocios.length) return '✅ No hay perfiles esperando revisión.';
  const l = ['📋 *Perfiles en revisión*'];
  for (const r of repartidores) {
    const u = r.usuario || {};
    l.push('', `🛵 *${u.nombre || ''} ${u.apellido || ''}* (${r.verificacion_estado})`,
      `   Tel: ${u.telefono} · Placa: ${r.placa_vehiculo || '—'} · ${plaza(r.ciudad)}`);
  }
  for (const n of negocios) {
    const u = n.dueno || {};
    l.push('', `🏪 *${n.nombre || 'sin nombre'}*${n.matriz_id ? ' — SUCURSAL' : ''} (${n.verificacion_estado})`,
      `   Tel: ${u.telefono} · GPS: ${n.latitud && n.longitud ? plaza(n.ciudad) : '⚠️ FALTA'}`,
      `   ${n.direccion || 'sin dirección'}`);
  }
  l.push('', 'Para aprobar: *aprobar TELÉFONO* · Para rechazar: *rechazar TELÉFONO motivo*');
  return l.join('\n');
};

// Qué perfil de esa cuenta está en revisión. Con sucursales, el dueño puede
// tener la matriz aprobada y una sucursal pendiente: se busca entre TODOS sus
// negocios, no solo el primero.
const objetivoDe = async (tel) => {
  const limpio = String(tel || '').replace(/\D/g, '').slice(-10);
  if (limpio.length !== 10) return { error: 'Escribe un teléfono de 10 dígitos.' };
  const usuario = await Usuario.findOne({ where: { telefono: limpio } });
  if (!usuario) return { error: `No encontré ninguna cuenta con el teléfono ${limpio}.` };
  const [rep, negs] = await Promise.all([
    Repartidor.findOne({ where: { usuario_id: usuario.id } }),
    Negocio.findAll({ where: { usuario_id: usuario.id }, order: [['creado_en', 'ASC']] }),
  ]);
  const enRevision = [
    ...(rep && PENDIENTES.includes(rep.verificacion_estado) ? [{ tipo: 'repartidor', entidad: rep }] : []),
    ...negs.filter((n) => PENDIENTES.includes(n.verificacion_estado)).map((n) => ({ tipo: 'negocio', entidad: n })),
  ];
  if (!enRevision.length) {
    const estados = [rep && `repartidor: ${rep.verificacion_estado}`,
      ...negs.map((n) => `${n.matriz_id ? 'sucursal' : 'negocio'}: ${n.verificacion_estado}`)].filter(Boolean).join(' · ');
    return { error: `Esa cuenta no tiene nada en revisión. Estado → ${estados || 'sin perfiles'}` };
  }
  // Primero lo que ya envió a revisión (lo que el dueño está viendo en "pendientes").
  enRevision.sort((a, b) => (a.entidad.verificacion_estado === 'en_revision' ? -1 : 1) - (b.entidad.verificacion_estado === 'en_revision' ? -1 : 1));
  return { usuario, objetivo: enRevision[0], resto: enRevision.length - 1 };
};

const adminId = async () => (await Usuario.findOne({ where: { rol: 'admin' }, order: [['creado_en', 'ASC']], attributes: ['id'] }))?.id || null;

const etiqueta = (o) => (o.tipo === 'negocio' && o.entidad.matriz_id ? 'sucursal' : o.tipo);

const aprobar = async (tel) => {
  const r = await objetivoDe(tel);
  if (r.error) return `⚠️ ${r.error}`;
  const { usuario, objetivo, resto } = r;
  if (objetivo.tipo === 'negocio' && (!objetivo.entidad.latitud || !objetivo.entidad.longitud)) {
    return '⛔ No se puede aprobar: el negocio no tiene ubicación GPS confirmada.';
  }
  const fn = objetivo.tipo === 'repartidor' ? aprobaciones.aprobarRepartidor : aprobaciones.aprobarNegocio;
  try {
    const { avisos } = await fn(objetivo.entidad, { adminId: await adminId(), origen: 'bot de WhatsApp' });
    return `✅ Aprobado: *${etiqueta(objetivo)}* de ${usuario.nombre || ''} (${usuario.telefono})`
      + `${objetivo.tipo === 'negocio' ? ` — ${objetivo.entidad.nombre} en ${plaza(objetivo.entidad.ciudad)}` : ''}.`
      + `\nCorreo al usuario: ${avisos?.email ? 'enviado' : 'no (sin correo o proveedor caído)'}`
      + (resto ? `\nOjo: esa cuenta tiene ${resto} perfil(es) más en revisión; repite el comando.` : '');
  } catch (e) {
    if (e.codigo === 'FUERA_DE_PLAZA') return `⛔ ${e.message}`;
    throw e;
  }
};

const rechazar = async (tel, motivo) => {
  motivo = String(motivo || '').trim();
  if (motivo.length < 5) return '⚠️ Da un motivo claro (mínimo 5 letras): *rechazar 5538969422 la INE no se lee*';
  const r = await objetivoDe(tel);
  if (r.error) return `⚠️ ${r.error}`;
  const { usuario, objetivo } = r;
  await objetivo.entidad.update({ verificacion_estado: 'rechazado', verificacion_nota: motivo, resolucion_en: new Date() });
  try {
    if (usuario.telegram_chat_id) await require('../services/telegram.service').alertaRechazado(usuario.telegram_chat_id, motivo);
  } catch (_) { /* el motivo igual queda visible en su app */ }
  return `🚫 Rechazado: *${etiqueta(objetivo)}* de ${usuario.nombre || ''} (${usuario.telefono}).\nMotivo: ${motivo}`;
};

// ─── Avisos (cron cada minuto) ────────────────────────────
// Solo lo NUEVO desde la última corrida. La primera vez únicamente marca el
// punto de partida, para no soltar de golpe todo el historial.
const avisos = async () => {
  let estado = {};
  try { estado = JSON.parse(fs.readFileSync(ESTADO_AVISOS, 'utf8')); } catch (_) { /* primera vez */ }
  const ahora = (await q('SELECT NOW() ahora'))[0].ahora;
  const desde = estado.desde;
  fs.mkdirSync(path.dirname(ESTADO_AVISOS), { recursive: true });
  fs.writeFileSync(ESTADO_AVISOS, JSON.stringify({ desde: ahora }));
  if (!desde) return 'NO_REPLY';

  const [nuevos, cancelados, revision] = await Promise.all([
    q(`SELECT p.numero, p.total, p.metodo_pago, p.tipo_envio, p.ciudad, n.nombre negocio
         FROM pedidos p JOIN negocios n ON n.id = p.negocio_id
        WHERE p.creado_en > :desde AND p.creado_en <= :ahora ORDER BY p.creado_en`, { desde, ahora }),
    q(`SELECT p.numero, p.ciudad, n.nombre negocio, p.nota_cancelacion
         FROM pedidos p JOIN negocios n ON n.id = p.negocio_id
        WHERE p.estado IN ('cancelado','rechazado') AND p.actualizado_en > :desde AND p.actualizado_en <= :ahora`, { desde, ahora }),
    q(`SELECT 'negocio' tipo, n.nombre, n.matriz_id IS NOT NULL sucursal, u.telefono
         FROM negocios n JOIN usuarios u ON u.id = n.usuario_id
        WHERE n.verificacion_estado = 'en_revision' AND n.enviado_revision_en > :desde AND n.enviado_revision_en <= :ahora
       UNION ALL
       SELECT 'repartidor', u.nombre, false, u.telefono
         FROM repartidores r JOIN usuarios u ON u.id = r.usuario_id
        WHERE r.verificacion_estado = 'en_revision' AND r.enviado_revision_en > :desde AND r.enviado_revision_en <= :ahora`, { desde, ahora }),
  ]);

  const l = [];
  for (const p of nuevos) {
    l.push(`🆕 *Pedido ${p.numero}* — ${p.negocio} (${plaza(p.ciudad)})\n   ${$(p.total)} · ${p.metodo_pago} · ${p.tipo_envio === 'pickup' ? 'para recoger' : 'a domicilio'}`);
  }
  for (const p of cancelados) {
    l.push(`❌ *${p.numero} cancelado* — ${p.negocio} (${plaza(p.ciudad)})${p.nota_cancelacion ? `\n   ${p.nota_cancelacion}` : ''}`);
  }
  for (const r of revision) {
    l.push(`📋 *Nuevo perfil en revisión:* ${r.tipo === 'negocio' ? (r.sucursal ? 'sucursal' : 'negocio') : 'repartidor'} ${r.nombre || ''} (${r.telefono})\n   Responde *aprobar ${r.telefono}* o *rechazar ${r.telefono} motivo*`);
  }
  return l.length ? l.join('\n\n') : 'NO_REPLY';
};

// ─── CLI ──────────────────────────────────────────────────
const COMANDOS = {
  hoy: () => hoy(),
  ventas: (a) => ventas(a[0]),
  conectados: () => conectados(),
  abiertos: () => abiertos(),
  pendientes: () => pendientes(),
  aprobar: (a) => aprobar(a[0]),
  rechazar: (a) => rechazar(a[0], a.slice(1).join(' ')),
  avisos: () => avisos(),
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  const fn = COMANDOS[(cmd || '').toLowerCase()];
  if (!fn) {
    console.log(`Comandos: ${Object.keys(COMANDOS).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  console.log(await fn(args));
})()
  .catch((e) => { console.log(`❌ Error: ${e.message}`); process.exitCode = 1; })
  .finally(() => sequelize.close().catch(() => {}));
