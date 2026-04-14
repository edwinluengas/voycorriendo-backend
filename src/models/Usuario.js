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
  rol: {
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
  token_push: {   // Firebase FCM token para notificaciones
    type: DataTypes.TEXT,
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
    type: DataTypes.STRING(6),
    allowNull: true,
  },
  otp_expira: {
    type: DataTypes.DATE,
    allowNull: true,
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
  return values;
};

module.exports = Usuario;
