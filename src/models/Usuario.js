const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const bcrypt = require('bcryptjs');

const Usuario = sequelize.define('Usuario', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  nombre: {
    type: DataTypes.STRING(100),
    allowNull: false,
    validate: { notEmpty: true, len: [2, 100] },
  },
  apellido: {
    type: DataTypes.STRING(100),
    allowNull: false,
    validate: { notEmpty: true },
  },
  // Número NACIONAL (sin código de país). La unicidad real es el par
  // (lada, telefono) — ver índice compuesto en migrarDB(). Puerto Escondido
  // recibe mucho turismo extranjero, así que un mismo número nacional puede
  // repetirse legítimamente entre países distintos.
  telefono: {
    type: DataTypes.STRING(15),
    allowNull: false,
    validate: { notEmpty: true },
  },
  // Código de país para marcar (sin '+'): 52 México, 1 EUA/Canadá, 34 España…
  lada: {
    type: DataTypes.STRING(5),
    allowNull: false,
    defaultValue: '52',
  },
  // ISO-3166 alpha-2 del país elegido — solo informativo/para la bandera.
  pais: {
    type: DataTypes.STRING(2),
    allowNull: false,
    defaultValue: 'MX',
  },
  email: {
    type: DataTypes.STRING(150),
    allowNull: true,
    unique: true,
    validate: { isEmail: true },
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true, // null si usa solo OTP por SMS
  },
  // 'rol' se mantiene por compatibilidad. Representa el rol PRIMARIO con el
  // que el usuario se registro originalmente. Para saber si tiene activos
  // otros roles, consultar la presencia de filas en 'repartidores' / 'negocios'.
  rol: {
    type: DataTypes.ENUM('cliente', 'repartidor', 'negocio', 'admin'),
    defaultValue: 'cliente',
  },
  // 'modo_activo' es el modo en el que el usuario esta operando AHORA.
  // Cambia con el switch del menu (estilo Rappi/Uber). El frontend lo
  // usa para decidir que tabs mostrar y a que endpoints llamar.
  modo_activo: {
    type: DataTypes.ENUM('cliente', 'repartidor', 'negocio', 'admin'),
    defaultValue: 'cliente',
  },
  estado: {
    type: DataTypes.ENUM('activo', 'inactivo', 'suspendido', 'pendiente'),
    defaultValue: 'pendiente',
  },
  foto_perfil: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  token_push: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  telegram_chat_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  ultima_conexion: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  telefono_verificado: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  otp_codigo: {
    type: DataTypes.STRING(100), // bcrypt hash
    allowNull: true,
  },
  otp_expira: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  otp_intentos: {
    type: DataTypes.SMALLINT,
    defaultValue: 0,
    allowNull: false,
  },
  token_version: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  // Recuperación de contraseña — código de un solo uso, hasheado con bcrypt.
  // Separado de otp_codigo a propósito: si el usuario está verificando su
  // número al mismo tiempo que pide un reset, un solo par de columnas haría
  // que un flujo pisara al otro.
  reset_codigo: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  reset_expira: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  reset_intentos: {
    type: DataTypes.SMALLINT,
    defaultValue: 0,
    allowNull: false,
  },
  // ─── Candados de seguridad (ver services/seguridadAdmin.service.js) ──
  // Bloqueo de la CUENTA por intentos fallidos. El límite por IP no basta:
  // un atacante con muchas IPs lo esquiva sin despeinarse.
  intentos_fallidos: {
    type: DataTypes.SMALLINT,
    defaultValue: 0,
    allowNull: false,
  },
  bloqueado_hasta: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  ultimo_login_ip: {
    type: DataTypes.STRING(45),   // cabe una IPv6 completa
    allowNull: true,
  },
  // Segundo factor obligatorio para cuentas admin (se puede apagar por
  // cuenta SOLO desde scripts/admin-seguridad.js, nunca por la API).
  admin_2fa_activo: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
  },
  login2fa_codigo: {
    type: DataTypes.STRING(100),  // bcrypt
    allowNull: true,
  },
  login2fa_expira: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  login2fa_intentos: {
    type: DataTypes.SMALLINT,
    defaultValue: 0,
    allowNull: false,
  },
  // Consentimiento legal (LFPDPPP México)
  acepto_terminos: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  terminos_aceptados_en: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  acepta_marketing: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  // Customer ID en Mercado Pago — permite guardar tarjetas (Customers & Cards API)
  mp_customer_id: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  // Perfil de usuario: direcciones guardadas, método de pago default, prefs
  // notificaciones — existían como columnas en la DB (migración en
  // server.js) pero nunca se declararon aquí. Sequelize ni las selecciona ni
  // las persiste si no están en el modelo: usuariosController ya las lee y
  // las escribe (direcciones guardadas, método de pago default,
  // preferencias de notificación), pero esas operaciones eran no-ops
  // silenciosos — el usuario nunca veía sus cambios guardados.
  direcciones_guardadas: {
    type: DataTypes.JSONB,
    defaultValue: [],
    allowNull: false,
  },
  metodo_pago_default: {
    type: DataTypes.STRING(30),
    allowNull: true,
  },
  notif_pedidos: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
  },
  notif_marketing: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  // Saldo de crédito de plataforma (2026-07-24): otorgado por un admin,
  // manual o por un pedido no entregado, usable en cualquier tienda al
  // pagar. Ver services/creditos.service.js — nunca modificar directo,
  // siempre vía otorgarCredito/consumirCredito para que quede el journal.
  credito_disponible: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
    allowNull: false,
  },
}, {
  tableName: 'usuarios',
  timestamps: true,
  createdAt: 'creado_en',
  updatedAt: 'actualizado_en',
  hooks: {
    beforeCreate: async (usuario) => {
      if (usuario.password) {
        usuario.password = await bcrypt.hash(usuario.password, 12);
      }
    },
    beforeUpdate: async (usuario) => {
      if (usuario.changed('password') && usuario.password) {
        usuario.password = await bcrypt.hash(usuario.password, 12);
      }
    },
  },
});

// Método para verificar contraseña
Usuario.prototype.verificarPassword = async function(passwordPlano) {
  return bcrypt.compare(passwordPlano, this.password);
};

// No devolver campos sensibles en JSON
Usuario.prototype.toJSON = function() {
  const values = { ...this.get() };
  delete values.password;
  delete values.otp_codigo;
  delete values.otp_expira;
  delete values.otp_intentos;
  delete values.token_version;
  delete values.reset_codigo;
  delete values.reset_expira;
  delete values.reset_intentos;
  delete values.login2fa_codigo;
  delete values.login2fa_expira;
  delete values.login2fa_intentos;
  delete values.intentos_fallidos;
  delete values.bloqueado_hasta;
  return values;
};

module.exports = Usuario;
