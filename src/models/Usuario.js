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
  telefono: {
    type: DataTypes.STRING(15),
    allowNull: false,
    unique: true,
    validate: { notEmpty: true },
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
  voytokens: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
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
  return values;
};

module.exports = Usuario;
