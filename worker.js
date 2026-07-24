/**
 * ============================================================================
 * BUSCADOR DE IMÁGENES DYNA + TRUPER — Cloudflare Worker
 * ============================================================================
 * Este worker recibe el nombre y/o código de un producto y hace scraping EN
 * VIVO de:
 *   1) dyna.com.co (tu proveedor) — busca el producto y extrae la(s) foto(s)
 *   2) truper.com — busca por palabra/código/clave en el catálogo público
 *      vigente y extrae la(s) foto(s) directas del catálogo oficial de Truper
 *
 * Por qué esto vive en un Worker y no en el navegador:
 * Los navegadores no pueden hacer fetch() a dominios externos que no lo
 * permitan explícitamente (política CORS). Un servidor sí puede, así que
 * este Worker actúa de "puente": tu app le pide algo, él va a internet,
 * y te devuelve el resultado ya armado en JSON.
 *
 * DESPLIEGUE (una sola vez):
 *   1. Crea una cuenta gratis en https://dash.cloudflare.com (no pide tarjeta
 *      para el plan gratuito de Workers).
 *   2. Ve a Workers & Pages → Create → Create Worker.
 *   3. Ponle un nombre, por ejemplo "buscador-imagenes-ferreteria".
 *   4. Pega TODO el contenido de este archivo reemplazando el código de
 *      ejemplo que trae por defecto.
 *   5. Dale "Deploy". Te va a dar una URL parecida a:
 *        https://buscador-imagenes-ferreteria.TU-USUARIO.workers.dev
 *   6. Esa URL es la que debes pegar en la constante IMAGE_SEARCH_WORKER_URL
 *      dentro de tu archivo login.html (búscala, está cerca del inicio del
 *      <script>).
 *
 * USO (una vez desplegado):
 *   GET https://tu-worker.workers.dev/?q=NOMBRE_DEL_PRODUCTO
 *   GET https://tu-worker.workers.dev/?truper=CODIGO_O_CLAVE_TRUPER
 *   (puedes mandar ambos parámetros a la vez)
 *
 * RESPUESTA:
 *   {
 *     "dyna":   [ { "title": "...", "code": "...", "productUrl": "...", "images": ["...jpg", ...] }, ... ],
 *     "truper": [ { "title": "...", "clave": "...", "codigo": "...", "images": ["...jpg", ...] }, ... ]
 *   }
 * ============================================================================
 */

// Cabeceras CORS: permiten que tu app (Firebase Hosting) llame a este Worker
// directamente desde el navegador del usuario.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// User-Agent "normal" para que los sitios no bloqueen la petición por
// pensar que es un bot obvio. Esto es scraping estándar de páginas públicas,
// no un intento de saltar ningún login ni acceder a datos privados.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'es-CO,es;q=0.9',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);
      const q = (url.searchParams.get('q') || '').trim();
      const dynaQuery = (url.searchParams.get('dyna') || q).trim();
      const truperQuery = (url.searchParams.get('truper') || q).trim();

      if (!dynaQuery && !truperQuery) {
        return jsonResponse({ error: 'Falta el parámetro ?q=, ?dyna= o ?truper=' }, 400);
      }

      const [dyna, truper] = await Promise.all([
        dynaQuery ? searchDyna(dynaQuery).catch((e) => { console.error('Dyna error', e); return []; }) : [],
        truperQuery ? searchTruper(truperQuery).catch((e) => { console.error('Truper error', e); return []; }) : [],
      ]);

      return jsonResponse({ dyna, truper });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ============================================================================
// BÚSQUEDA WEB GENÉRICA (DuckDuckGo HTML) — no requiere API key
// ============================================================================
// DuckDuckGo tiene una versión HTML simple (sin JS) pensada para navegadores
// antiguos / lectores. Es perfecta para scraping de resultados de búsqueda
// porque no exige ejecutar JavaScript para ver los links.
// NOTA: esta función ya solo la usa searchDyna(). searchTruper() dejó de
// necesitarla porque ahora consulta directamente el buscador oficial de
// Truper (ver más abajo).
async function ddgSearch(query, maxResults = 5) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, { headers: FETCH_HEADERS });
  const html = await res.text();

  const links = [];
  // Los resultados en la versión HTML usan <a class="result__a" href="...">
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && links.length < maxResults) {
    let href = m[1];
    // DuckDuckGo a veces envuelve el link real dentro de una redirección
    // tipo /l/?uddg=<url-encoded>. Si es así, lo desenvolvemos.
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
    links.push(href);
  }
  return links;
}

// ============================================================================
// DYNA (dyna.com.co)
// ============================================================================
async function searchDyna(query) {
  // 1) Buscamos en DuckDuckGo restringido al dominio de Dyna
  const links = await ddgSearch(`site:dyna.com.co ${query}`, 5);
  const productLinks = links.filter((l) => /dyna\.com\.co\/(public\/)?producto\//i.test(l));

  const results = [];
  for (const link of productLinks.slice(0, 3)) {
    try {
      const res = await fetch(link, { headers: FETCH_HEADERS });
      if (!res.ok) continue;
      const html = await res.text();

      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      let title = titleMatch ? titleMatch[1].replace(/-\s*Dyna.*$/i, '').trim() : '';
      if (!title) {
        const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        title = metaMatch ? metaMatch[1].trim() : query;
      }

      const codeMatch = html.match(/C[oó]digo:\s*<\/[^>]+>\s*([A-Za-z0-9\-]+)|C[oó]digo:\s*([A-Za-z0-9\-]+)/i);
      const code = codeMatch ? (codeMatch[1] || codeMatch[2]) : (link.match(/producto\/(\d+)/) || [])[1] || null;

      // Imágenes: Dyna sirve las fotos vía su CDN phpThumb.php?src=/img/CODIGO.jpg
      const imgMatches = [...html.matchAll(/https:\/\/cdn\.laferreteria\.online\/thumb\/phpThumb\.php\?src=\/img\/([A-Za-z0-9_\-.]+)/g)];
      const images = [...new Set(imgMatches.map((mm) => mm[0]))];

      if (images.length) {
        results.push({ title, code, productUrl: link, images });
      }
    } catch (e) {
      console.error('Error leyendo producto Dyna', link, e);
    }
  }
  return results;
}

// ============================================================================
// TRUPER — Catálogo Vigente oficial (truper.com/CatVigente/buscador)
// ============================================================================
// NUEVO (reemplaza la versión anterior basada en DuckDuckGo + Banco de
// Contenido Digital):
//
// Truper tiene un buscador PÚBLICO y OFICIAL de su catálogo nacional en:
//   https://www.truper.com/CatVigente/buscador?palabra=CONSULTA&page=1
//
// Ahí adentro acepta indistintamente: texto libre ("martillo"), código
// numérico interno ("16702") o clave comercial ("MTR-16"), y siempre
// devuelve una tabla HTML con columnas fijas en este orden:
//   Núm. | Marca | Código | Clave | Descripción | Módulo(foto) | Ficha técnica | Página
//
// Ventajas frente al método viejo:
//   - No depende de que DuckDuckGo haya indexado la página (antes fallaba
//     seguido porque el Banco de Contenido Digital es un sitio chico).
//   - Funciona con código, clave O nombre libre, no solo con la clave exacta.
//   - La imagen se puede armar de forma 100% determinística a partir del
//     código: https://www.truper.com/admin/images/ch/{codigo}.jpg
//     (ya no hay que "adivinar" sufijos +D1/+D2/+D3 con peticiones HEAD).
async function searchTruper(query) {
  const searchUrl = `https://www.truper.com/CatVigente/buscador?palabra=${encodeURIComponent(query)}&page=1`;
  const res = await fetch(searchUrl, { headers: FETCH_HEADERS });
  if (!res.ok) return [];

  const html = await res.text();

  // El sitio muestra este mensaje literal cuando no hay coincidencias.
  if (/No hay productos que concuerden/i.test(html)) return [];

  // Nos quedamos solo con la primera tabla de resultados para no arrastrar
  // basura del menú/encabezado de la página (que también trae <td>/<tr>
  // en algunos casos, ej. el menú de marcas).
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/i);
  if (!tableMatch) return [];
  const tableHtml = tableMatch[0];

  // Partimos la tabla en filas. El primer trozo (antes del primer <tr>) se
  // descarta porque es solo la apertura de la tabla.
  const rowChunks = tableHtml.split(/<tr[^>]*>/i).slice(1);

  const stripText = (cellHtml) => cellHtml
    .replace(/<[^>]+>/g, ' ')   // quitamos etiquetas
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const results = [];
  const seenCodigos = new Set();

  for (const rowHtml of rowChunks) {
    // Cada fila trae 8 columnas: Núm, Marca, Código, Clave, Descripción,
    // Módulo(foto), Ficha técnica, Página — en ese orden.
    const cellChunks = rowHtml.split(/<td[^>]*>/i).slice(1).map((c) => c.split(/<\/td>/i)[0]);
    if (cellChunks.length < 5) continue; // no es una fila de producto (ej. fila de cabecera/filtros)

    const codigo = stripText(cellChunks[2] || '');
    const clave = stripText(cellChunks[3] || '');
    const descripcion = stripText(cellChunks[4] || '');

    // Si la columna "Código" no es puramente numérica, esta fila no es un
    // producto real (puede ser una fila de agrupación u otra cosa rara).
    if (!/^\d+$/.test(codigo) || seenCodigos.has(codigo)) continue;
    seenCodigos.add(codigo);

    results.push({
      title: descripcion || null,
      clave: clave || null,
      codigo,
      productUrl: searchUrl,
      // Patrón de imagen oficial del catálogo Truper, armado directo desde
      // el código — no requiere peticiones extra para confirmar que existe;
      // el <img onerror> del frontend ya oculta la miniatura si no carga.
      images: [`https://www.truper.com/admin/images/ch/${codigo}.jpg`],
    });
  }

  return results;
}
