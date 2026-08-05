/**
 * Conversor mínimo de Markdown a HTML para las páginas legales.
 *
 * Es a propósito diminuto: los documentos legales solo usan encabezados,
 * negritas, cursivas, listas, enlaces y separadores. Meter una dependencia
 * de Markdown completa para esto sería cargar miles de líneas (y su
 * superficie de vulnerabilidades) por cinco reglas.
 *
 * El HTML se escapa ANTES de aplicar formato: el texto viene de archivos del
 * repo, pero si algún día se sirve contenido editable desde la base, esto ya
 * está del lado seguro.
 */
// Se escapan también las COMILLAS, no solo < y >: sin eso, un enlace como
// [x](http://a" onmouseover="alert(1)) cerraba el atributo href e inyectaba
// un manejador de eventos en la etiqueta. Escapar solo <> no alcanza cuando
// el texto termina DENTRO de un atributo.
const escapar = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Solo se permiten esquemas navegables. `javascript:` y `data:text/html`
// en un href ejecutan código con solo hacer clic, así que un enlace con un
// esquema raro se degrada a texto plano en vez de volverse un enlace vivo.
const ESQUEMA_SEGURO = /^(https?:\/\/|mailto:|#|\/)/i;

const enLinea = (s) => s
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    (completo, texto, url) => (ESQUEMA_SEGURO.test(url.trim())
      ? `<a href="${url.trim()}" rel="noopener">${texto}</a>`
      : texto))
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

// Fila de tabla: `| a | b | c |`. Se parte por las barras y se tiran los
// extremos vacíos que dejan la primera y la última.
const celdas = (linea) => linea.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const esFilaTabla    = (l) => /^\|.*\|$/.test(l);
const esSeparadorTabla = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-');

const mdAHtml = (md) => {
  const salida = [];
  let enLista = false;
  let enTabla = false;

  const cerrarLista = () => { if (enLista) { salida.push('</ul>'); enLista = false; } };
  const cerrarTabla = () => { if (enTabla) { salida.push('</tbody></table></div>'); enTabla = false; } };

  const lineas = escapar(md).split('\n');

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i].trim();

    if (!linea) { cerrarLista(); cerrarTabla(); continue; }

    // ── Tablas ────────────────────────────────────────────────────
    // El aviso de privacidad lista en una tabla con qué terceros se
    // comparten los datos — justo lo que revisa una autoridad o la tienda
    // de aplicaciones. Sin esto salía como texto con barras: ilegible.
    if (esFilaTabla(linea)) {
      // La línea de guiones solo separa el encabezado; no se dibuja.
      if (esSeparadorTabla(linea)) continue;
      cerrarLista();
      const cols = celdas(linea);
      // Es encabezado si la SIGUIENTE línea es el separador de guiones.
      const esEncabezado = !enTabla && esSeparadorTabla((lineas[i + 1] || '').trim());
      if (!enTabla) {
        salida.push('<div class="tabla-scroll"><table>');
        enTabla = true;
        if (esEncabezado) {
          salida.push('<thead><tr>' + cols.map((c) => `<th>${enLinea(c)}</th>`).join('') + '</tr></thead>');
          salida.push('<tbody>');
          continue;
        }
        salida.push('<tbody>');
      }
      salida.push('<tr>' + cols.map((c) => `<td>${enLinea(c)}</td>`).join('') + '</tr>');
      continue;
    }
    cerrarTabla();

    if (/^---+$/.test(linea)) { cerrarLista(); salida.push('<hr>'); continue; }

    const enc = linea.match(/^(#{1,4})\s+(.*)$/);
    if (enc) {
      cerrarLista();
      const n = enc[1].length;
      salida.push(`<h${n}>${enLinea(enc[2])}</h${n}>`);
      continue;
    }

    const item = linea.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!enLista) { salida.push('<ul>'); enLista = true; }
      salida.push(`<li>${enLinea(item[1])}</li>`);
      continue;
    }

    cerrarLista();
    salida.push(`<p>${enLinea(linea)}</p>`);
  }
  cerrarLista();
  return salida.join('\n');
};

module.exports = { mdAHtml };
