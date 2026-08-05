/**
 * Eliminación de cuenta a petición del usuario.
 *
 * Google Play lo exige desde 2024 para toda app con registro: tiene que
 * haber una vía DENTRO de la app y una página web pública para pedirlo.
 * También es el derecho de Cancelación de la LFPDPPP (los "derechos ARCO").
 *
 * QUÉ SE BORRA Y QUÉ NO — y por qué:
 *
 *   · Se BORRA de verdad todo dato personal: nombre, apellido, teléfono,
 *     correo, contraseña, foto de perfil, direcciones guardadas, tarjetas,
 *     el cliente en Mercado Pago, el vínculo de Telegram, el token de
 *     notificaciones, y TODOS los documentos de identidad (INE, licencia,
 *     tarjeta de circulación, comprobante de domicilio, RFC) tanto de la
 *     base como del almacenamiento.
 *
 *   · NO se borran los PEDIDOS ni sus asientos contables. Son comprobantes
 *     de operaciones comerciales: el negocio y el repartidor que
 *     participaron tienen derecho a su propio historial de ingresos, y hay
 *     obligaciones fiscales de conservación. La ley de protección de datos
 *     contempla justamente esta excepción al derecho de cancelación. Lo que
 *     sí se hace es DESLIGARLOS de la persona: la fila del usuario se queda
 *     como un tocón anonimizado, sin un solo dato que permita identificarlo.
 *
 *   · La cuenta queda inutilizable: contraseña destruida, sesiones
 *     revocadas y estado 'eliminado'. El teléfono se libera con un valor
 *     interno único, así que esa misma persona puede volver a registrarse
 *     con su número si algún día quiere.
 *
 * CUÁNDO NO SE PUEDE: si hay dinero o entregas de por medio. Borrar a un
 * negocio que debe comisiones, o a un repartidor a media entrega, deja a
 * un tercero colgado. Esos casos se rechazan explicando qué falta.
 */
const { Op } = require('sequelize');
const { Usuario, Negocio, Repartidor, Pedido, FondoRepartidor, TarjetaGuardada } = require('../models');
const { sequelize } = require('../config/database');
const { borrarImagen } = require('./storage.service');
const {
  BUCKET_PUBLICO_NEGOCIOS, BUCKET_PUBLICO_REPARTIDORES,
  BUCKET_PRIVADO_NEGOCIOS, BUCKET_PRIVADO_REPARTIDORES,
} = require('../config/buckets');
const { logAdmin } = require('../utils/audit');

const ESTADOS_TERMINALES = ['entregado', 'cancelado', 'rechazado'];

/**
 * ¿Se puede borrar esta cuenta ahora? Devuelve los impedimentos en lenguaje
 * de persona, para poder enseñárselos ANTES de que confirme.
 */
const revisarImpedimentos = async (usuarioId) => {
  const impedimentos = [];

  const [negocio, repartidor] = await Promise.all([
    Negocio.findOne({ where: { usuario_id: usuarioId } }),
    Repartidor.findOne({ where: { usuario_id: usuarioId } }),
  ]);

  const enCurso = await Pedido.count({
    where: {
      estado: { [Op.notIn]: ESTADOS_TERMINALES },
      [Op.or]: [
        { cliente_id: usuarioId },
        ...(negocio ? [{ negocio_id: negocio.id }] : []),
        ...(repartidor ? [{ repartidor_id: repartidor.id }] : []),
      ],
    },
  });
  if (enCurso > 0) {
    impedimentos.push(`Tienes ${enCurso} pedido(s) en curso. Espera a que terminen o cancélalos.`);
  }

  if (negocio && parseFloat(negocio.deuda_plataforma || 0) > 0) {
    impedimentos.push(`Tu negocio debe $${parseFloat(negocio.deuda_plataforma).toFixed(2)} de comisiones. Liquida antes de cerrar la cuenta.`);
  }

  if (repartidor) {
    const fondo = await FondoRepartidor.findOne({ where: { repartidor_id: repartidor.id } });
    if (fondo) {
      if (parseFloat(fondo.saldo_por_cobrar || 0) > 0) {
        impedimentos.push(`Tienes $${parseFloat(fondo.saldo_por_cobrar).toFixed(2)} pendientes de pagar a la plataforma.`);
      }
      if (parseFloat(fondo.monto_disponible || 0) > 0) {
        impedimentos.push(`Tienes $${parseFloat(fondo.monto_disponible).toFixed(2)} sin retirar. Solicita tu retiro antes de cerrar la cuenta.`);
      }
      if (fondo.retiro_pendiente) {
        impedimentos.push('Tienes un retiro en proceso. Espera a que se confirme.');
      }
    }
  }

  return { puede: impedimentos.length === 0, impedimentos, tieneNegocio: !!negocio, tieneRepartidor: !!repartidor };
};

// En la base se guarda la URL completa; `borrarImagen` espera la RUTA dentro
// del bucket. Sin esta traducción la llamada apuntaba a un objeto inexistente
// y el archivo se quedaba en el almacenamiento aunque la fila se limpiara.
const rutaDesdeUrl = (url, bucket) => {
  if (typeof url !== 'string') return null;
  const limpia = url.split('?')[0];   // los `?t=` para refrescar caché
  for (const marcador of [`/object/public/${bucket}/`, `/object/${bucket}/`]) {
    const i = limpia.indexOf(marcador);
    if (i !== -1) return decodeURIComponent(limpia.slice(i + marcador.length));
  }
  return null;
};

// Borra del almacenamiento las imágenes de una lista de URLs, sin dejar que
// un fallo de red impida cerrar la cuenta: lo importante es que la fila deje
// de apuntar al archivo; si alguno queda huérfano se limpia después.
const borrarArchivos = async (pares) => {
  let borrados = 0, fallidos = 0;
  for (const [bucket, url] of pares) {
    const ruta = rutaDesdeUrl(url, bucket);
    if (!ruta) continue;
    try { (await borrarImagen(bucket, ruta)) ? borrados++ : fallidos++; }
    catch (e) { fallidos++; console.warn('[eliminarCuenta] no se pudo borrar un archivo:', e.message); }
  }
  if (fallidos) console.warn(`[eliminarCuenta] ${fallidos} archivo(s) quedaron en el almacenamiento; la base ya no los referencia.`);
  return { borrados, fallidos };
};

/**
 * Ejecuta la eliminación. Devuelve un resumen de lo hecho.
 * @param {object} usuario  instancia de Usuario ya cargada
 * @param {string} origen   'app' | 'panel admin' | 'soporte'
 */
const eliminarCuenta = async (usuario, { origen = 'app', adminId = null } = {}) => {
  const { puede, impedimentos } = await revisarImpedimentos(usuario.id);
  if (!puede) {
    const e = new Error(impedimentos.join(' '));
    e.codigo = 'CUENTA_CON_PENDIENTES';
    e.impedimentos = impedimentos;
    throw e;
  }

  const negocio = await Negocio.findOne({ where: { usuario_id: usuario.id } });
  const repartidor = await Repartidor.findOne({ where: { usuario_id: usuario.id } });

  // 1. Archivos: identificaciones y fotos. Fuera de la base Y del disco.
  await borrarArchivos([
    [BUCKET_PUBLICO_REPARTIDORES, usuario.foto_perfil],
    ...(negocio ? [
      [BUCKET_PRIVADO_NEGOCIOS, negocio.documento_ine_dueno],
      [BUCKET_PRIVADO_NEGOCIOS, negocio.documento_rfc],
      [BUCKET_PRIVADO_NEGOCIOS, negocio.comprobante_domicilio],
      [BUCKET_PUBLICO_NEGOCIOS, negocio.logo],
      [BUCKET_PUBLICO_NEGOCIOS, negocio.foto_portada],
      [BUCKET_PUBLICO_NEGOCIOS, negocio.foto_local],
    ] : []),
    ...(repartidor ? [
      [BUCKET_PRIVADO_REPARTIDORES, repartidor.foto_ine_frente],
      [BUCKET_PRIVADO_REPARTIDORES, repartidor.foto_ine_reverso],
      [BUCKET_PRIVADO_REPARTIDORES, repartidor.foto_licencia],
      [BUCKET_PRIVADO_REPARTIDORES, repartidor.foto_tarjeta_circulacion],
    ] : []),
  ]);

  // La columna del teléfono es VARCHAR(15): el marcador tiene que caber.
  // En base 36 la marca de tiempo ocupa 8 caracteres, más 3 al azar para
  // que dos bajas en el mismo milisegundo no choquen con el índice único.
  const sello = Date.now().toString(36)
    + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');

  await sequelize.transaction(async (t) => {
    // 2. Tarjetas guardadas (el número nunca estuvo aquí, solo el id de
    //    Mercado Pago y los últimos 4 dígitos — igual se van).
    await TarjetaGuardada.destroy({ where: { usuario_id: usuario.id }, transaction: t });

    // 3. Negocio: deja de operar y pierde todo dato identificable del dueño.
    //    La fila se conserva porque los pedidos históricos apuntan a ella.
    if (negocio) {
      await negocio.update({
        activo: false, abierto_ahora: false,
        verificacion_estado: 'rechazado',
        verificacion_nota: 'Cuenta eliminada a petición del titular.',
        telefono: null, clabe_bancaria: null, banco: null,
        documento_ine_dueno: null, documento_rfc: null, comprobante_domicilio: null,
        logo: null, foto_portada: null, foto_local: null,
        estado_cuenta: 'suspendido',
        estado_motivo: 'Cuenta eliminada por el titular.',
      }, { transaction: t });
    }

    // 4. Repartidor: igual. La placa se libera —la moto puede pasar a otra
    //    persona— salvo que estuviera vetada, que es un candado de seguridad
    //    y vive en su propia tabla (bloqueos_permanentes), no aquí.
    if (repartidor) {
      await repartidor.update({
        conectado: false, disponible: false, ultimo_latido: null,
        verificacion_estado: 'rechazado',
        clabe_bancaria: null, banco: null,
        foto_ine_frente: null, foto_ine_reverso: null,
        foto_licencia: null, foto_tarjeta_circulacion: null,
        placa_vehiculo: null, marca_vehiculo: null, modelo_vehiculo: null, color_vehiculo: null,
        latitud: null, longitud: null,
        estado_cuenta: 'suspendido',
        estado_motivo: 'Cuenta eliminada por el titular.',
      }, { transaction: t });
    }

    // 5. El usuario queda como un tocón sin datos. El teléfono se sustituye
    //    por un valor interno único: libera el número real (esa persona
    //    puede volver a registrarse) y respeta la unicidad de la columna,
    //    que no admite nulos.
    await usuario.update({
      nombre: 'Usuario', apellido: 'eliminado',
      telefono: `ELIM${sello}`.slice(0, 15),
      lada: '00',
      email: null,
      password: null,
      foto_perfil: null,
      token_push: null,
      telegram_chat_id: null,
      direcciones_guardadas: [],
      metodo_pago_default: null,
      mp_customer_id: null,
      otp_codigo: null, otp_expira: null,
      reset_codigo: null, reset_expira: null,
      login2fa_codigo: null, login2fa_expira: null,
      ultimo_login_ip: null,
      acepta_marketing: false, notif_marketing: false, notif_pedidos: false,
      estado: 'eliminado',
      // Revoca cualquier sesión abierta: un token emitido antes deja de valer.
      token_version: (usuario.token_version || 0) + 1,
    }, { transaction: t });
  });

  // 6. Bitácora. Se guarda SOLO el id, nunca el teléfono ni el nombre: el
  //    registro es para poder demostrar que la baja se atendió, no para
  //    conservar por la puerta de atrás lo que se acaba de borrar.
  logAdmin({
    adminId, accion: 'eliminar_cuenta', entidadTipo: 'usuario', entidadId: usuario.id,
    estadoDespues: { origen, tenia_negocio: !!negocio, tenia_repartidor: !!repartidor },
  });

  return { ok: true, tenia_negocio: !!negocio, tenia_repartidor: !!repartidor };
};

module.exports = { revisarImpedimentos, eliminarCuenta };
