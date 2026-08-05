/**
 * Páginas legales públicas (sin token): aviso de privacidad y términos.
 *
 * Existen porque Google Play EXIGE una URL pública de política de privacidad
 * para publicar la app — no basta con tenerla dentro de la aplicación.
 *
 * CANDADO IMPORTANTE: el borrador tiene marcadores `[PENDIENTE: ...]` que
 * solo el dueño puede llenar (razón social, domicilio fiscal, plazo de
 * respuesta ARCO). Mientras falte cualquiera de ellos la página NO se
 * publica: responde 503 explicando qué falta. Publicar un aviso de
 * privacidad con huecos visibles es peor que no publicarlo — Google lo
 * rechaza y, frente al INAI, un aviso incompleto no protege a nadie.
 *
 * Para publicarlo, definir en Railway:
 *   LEGAL_RAZON_SOCIAL     ej. "Edwin Melton Rojas Luengas"
 *   LEGAL_DOMICILIO_FISCAL ej. "Calle X 123, Col. Centro, Puerto Escondido, Oaxaca, CP 71980"
 *   LEGAL_PLAZO_ARCO_DIAS  ej. "20"
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { mdAHtml } = require('../utils/markdown');

const router = express.Router();

const DATOS = () => ({
  razonSocial: process.env.LEGAL_RAZON_SOCIAL,
  domicilio:   process.env.LEGAL_DOMICILIO_FISCAL,
  plazoArco:   process.env.LEGAL_PLAZO_ARCO_DIAS,
});

const faltantes = () => {
  const d = DATOS();
  return [
    !d.razonSocial && 'LEGAL_RAZON_SOCIAL',
    !d.domicilio   && 'LEGAL_DOMICILIO_FISCAL',
    !d.plazoArco   && 'LEGAL_PLAZO_ARCO_DIAS',
  ].filter(Boolean);
};

// Rellena los marcadores del borrador y le quita el encabezado interno de
// "BORRADOR", que es una nota para el equipo, no para el público.
const prepararTexto = (md) => {
  const d = DATOS();
  return md
    .replace(/^>.*$/gm, '')                                   // encabezado de borrador
    .replace(/\[PENDIENTE — fecha de publicación real\]/g,
      new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' }))
    .replace(/\[PENDIENTE: razón social completa \/ persona física con actividad empresarial\]/g, d.razonSocial)
    .replace(/\[PENDIENTE: domicilio fiscal completo\]/g, d.domicilio)
    .replace(/\[PENDIENTE — definir plazo conforme al artículo 32 del Reglamento[^\]]*\]/g,
      `${d.plazoArco} días hábiles`)
    .replace(/\*?\[PENDIENTE[^\]]*\]\*?/g, '')                // cualquier otro marcador
    .trim();
};

const PLANTILLA = (titulo, cuerpo) => `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} — VoyCorriendo</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0 auto; padding:24px 20px 64px; max-width:760px;
         font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:#1a1a1a; background:#fff; }
  h1 { font-size:1.75rem; line-height:1.25; margin:.5em 0 .3em; }
  h2 { font-size:1.2rem; margin:1.8em 0 .4em; }
  h3 { font-size:1rem; margin:1.4em 0 .3em; }
  a { color:#FF5C00; }
  hr { border:0; border-top:1px solid #e5e7eb; margin:2em 0; }
  ul { padding-left:1.2em; }
  .marca { color:#FF5C00; font-weight:800; letter-spacing:-.5px; }
  /* La tabla de terceros con los que se comparten datos es de lo primero
     que revisa una autoridad o la tienda de aplicaciones. En un teléfono
     no cabe a lo ancho, así que se deja desplazar sola en vez de romper
     el diseño de la página. */
  .tabla-scroll { overflow-x:auto; margin:1em 0; }
  table { border-collapse:collapse; width:100%; font-size:.92rem; }
  th, td { border:1px solid #e5e7eb; padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#faf5f0; font-weight:700; }
  @media (prefers-color-scheme: dark) {
    body { background:#111; color:#e8e8e8; } hr { border-color:#333; }
    th, td { border-color:#333; } th { background:#1d1a17; }
  }
</style></head>
<body>
<p class="marca">VoyCorriendo</p>
${cuerpo}
<hr>
<p style="font-size:.85rem;color:#6b7280">
  Contacto para temas de privacidad y derechos ARCO:
  <a href="mailto:voycorriendoadmin@gmail.com">voycorriendoadmin@gmail.com</a>
</p>
</body></html>`;

const servir = (archivo, titulo) => (req, res) => {
  const falta = faltantes();
  if (falta.length) {
    return res.status(503).type('html').send(PLANTILLA(titulo,
      `<h1>${titulo}</h1><p>Este documento todavía no está publicado.</p>
       <p style="font-size:.9rem;color:#6b7280">Faltan por configurar: ${falta.join(', ')}.</p>`));
  }
  try {
    const md = fs.readFileSync(path.join(__dirname, '..', 'legal', archivo), 'utf8');
    res.type('html').send(PLANTILLA(titulo, mdAHtml(prepararTexto(md))));
  } catch (e) {
    console.error('[legal] No se pudo servir', archivo, e.message);
    res.status(500).type('html').send(PLANTILLA(titulo, `<h1>${titulo}</h1><p>No disponible por ahora.</p>`));
  }
};

router.get('/privacidad', servir('aviso-privacidad-integral.md', 'Aviso de Privacidad'));
router.get('/terminos',   servir('terminos-consentimiento-servicio.md', 'Términos del Servicio'));

module.exports = router;
