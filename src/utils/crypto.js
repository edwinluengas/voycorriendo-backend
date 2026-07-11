const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ENC_PREFIX = 'enc:';

const getKey = () => {
  const hex = process.env.CLABE_ENCRYPTION_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    console.warn('[crypto] CLABE_ENCRYPTION_KEY inválida — debe ser 64 chars hex. Datos sin cifrar.');
    return null;
  }
  return key;
};

// AES-256-GCM: encrypt(plaintext) → "enc:iv_b64:tag_b64:ct_b64"
const encrypt = (plaintext) => {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
};

// Descifra o devuelve el valor tal cual si es texto plano (migración transparente)
const decrypt = (value) => {
  if (!value || !value.startsWith(ENC_PREFIX)) return value;
  const key = getKey();
  if (!key) return value;
  try {
    const rest = value.slice(ENC_PREFIX.length);
    const i1 = rest.indexOf(':');
    const i2 = rest.indexOf(':', i1 + 1);
    const iv  = Buffer.from(rest.slice(0, i1), 'base64');
    const tag = Buffer.from(rest.slice(i1 + 1, i2), 'base64');
    const ct  = Buffer.from(rest.slice(i2 + 1), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final('utf8');
  } catch {
    return value; // fallback graceful — no exponer error al cliente
  }
};

module.exports = { encrypt, decrypt };
