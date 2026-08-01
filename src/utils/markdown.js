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
const escapar = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const enLinea = (s) => s
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');

const mdAHtml = (md) => {
  const salida = [];
  let enLista = false;

  const cerrarLista = () => { if (enLista) { salida.push('</ul>'); enLista = false; } };

  for (const cruda of escapar(md).split('\n')) {
    const linea = cruda.trim();

    if (!linea) { cerrarLista(); continue; }

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
