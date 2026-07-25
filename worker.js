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

      const debug = url.searchParams.get('debug') === '1';

      const [dyna, truper] = await Promise.all([
        dynaQuery ? searchDyna(dynaQuery, debug).catch((e) => { console.error('Dyna error', e); return debug ? { error: String(e) } : []; }) : [],
        truperQuery ? searchTruper(truperQuery, debug).catch((e) => { console.error('Truper error', e); return debug ? { error: String(e) } : []; }) : [],
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
// BÚSQUEDA WEB GENÉRICA (Bing) — no requiere API key
// ============================================================================
// NOTA: antes usábamos html.duckduckgo.com aquí, pero confirmamos con
// debug=1 que DuckDuckGo le está devolviendo al Worker un HTTP 202 sin
// resultados (un bloqueo/página de verificación típica contra tráfico
// automatizado desde IPs de datacenter como las de Cloudflare). Bing sirve
// HTML estático más simple para resultados orgánicos y tolera mejor este
// tipo de scraping servidor-a-servidor, así que lo usamos en su lugar.
async function webSearch(query, maxResults = 5, debug = false) {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, { headers: FETCH_HEADERS });
  const html = await res.text();

  const links = [];
  // Bing envuelve cada resultado orgánico en <h2><a href="...">Título</a></h2>
  const re = /<h2><a[^>]+href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && links.length < maxResults) {
    links.push(m[1]);
  }

  if (debug) {
    // Probamos varios marcadores candidatos de resultados/orgánicos que
    // Bing ha usado históricamente, para ver cuál (si alguno) está presente
    // hoy en la respuesta real.
    const markers = ['b_algo', 'b_results', 'b_title', 'b_caption', 'b_no_results', 'No obtuvimos resultados', 'No se encontraron'];
    const markerPresence = {};
    for (const mk of markers) markerPresence[mk] = html.includes(mk);

    // Tomamos un pedazo del cuerpo real (después de </head>) para ver el
    // marcado tal cual, sin importar qué clase esté usando.
    const bodyStart = html.indexOf('</head>');
    const bodySample = bodyStart >= 0 ? html.slice(bodyStart, bodyStart + 3000) : html.slice(0, 3000);

    return {
      links,
      httpStatus: res.status,
      htmlLength: html.length,
      markerPresence,
      bodySample,
    };
  }
  return links;
}

// ============================================================================
// DYNA (dyna.com.co)
// ============================================================================
async function searchDyna(query, debug = false) {
  // 1) Buscamos en Bing restringido al dominio de Dyna
  const searchResult = await webSearch(`site:dyna.com.co ${query}`, 5, debug);
  const links = debug ? searchResult.links : searchResult;
  const productLinks = links.filter((l) => /dyna\.com\.co\/(public\/)?producto\//i.test(l));

  if (debug && productLinks.length === 0) {
    return {
      webSearchHttpStatus: searchResult.httpStatus,
      webSearchHtmlLength: searchResult.htmlLength,
      webSearchMarkerPresence: searchResult.markerPresence,
      webSearchBodySample: searchResult.bodySample,
      webSearchLinksFound: links,
      productLinksFound: productLinks,
      results: [],
    };
  }

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
        results.push({ title, code, codigo: code, marca: null, proveedor: 'Dyna', productUrl: link, images });
      }
    } catch (e) {
      console.error('Error leyendo producto Dyna', link, e);
    }
  }

  if (debug) {
    return {
      webSearchHttpStatus: searchResult.httpStatus,
      webSearchHtmlLength: searchResult.htmlLength,
      webSearchLinksFound: links,
      productLinksFound: productLinks,
      resultsParsed: results.length,
      results,
    };
  }

  return results;
}

// Cuando el usuario busca por un código o clave EXACTO (no texto libre),
// Truper suele tener más de una foto del mismo producto en su banco de
// imágenes por clave (foto principal + ángulos adicionales D1, D2, D3, D4).
// Probamos cuáles existen de verdad con peticiones HEAD (rápidas, no traen
// el contenido de la imagen) y devolvemos solo las que sí responden 200.
async function fetchExistingImages(candidateUrls) {
  const checks = await Promise.all(candidateUrls.map(async (imgUrl) => {
    try {
      const head = await fetch(imgUrl, { method: 'HEAD', headers: FETCH_HEADERS });
      return head.ok ? imgUrl : null;
    } catch (e) {
      return null;
    }
  }));
  return checks.filter(Boolean);
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
//
// NUEVO (esta versión): si la consulta coincide EXACTO con el código o la
// clave de uno de los resultados (ej. escribiste "9524" o "MARG-21X"), le
// agregamos a ESE resultado todas las fotos adicionales del mismo producto
// que encontremos en el banco de imágenes por clave (foto principal +
// ángulos D1-D4), para que puedas elegir cuál usar. Esto NO se hace para
// búsquedas de texto libre con muchos resultados (sería lento pedir 5 fotos
// x 20 productos), solo para el caso "un código/clave específico".
async function searchTruper(query, debug = false) {
  const searchUrl = `https://www.truper.com/CatVigente/buscador?palabra=${encodeURIComponent(query)}&page=1`;
  const res = await fetch(searchUrl, { headers: FETCH_HEADERS });

  if (!res.ok) {
    return debug ? { httpStatus: res.status, results: [] } : [];
  }

  const html = await res.text();

  // El sitio muestra este mensaje literal cuando no hay coincidencias.
  const noMatches = /No hay productos que concuerden/i.test(html);
  const tableMatch = html.match(/<table[^>]*>[\s\S]*?<\/table>/i);

  if (noMatches || !tableMatch) {
    if (debug) {
      return {
        httpStatus: res.status,
        htmlLength: html.length,
        noMatchesMessageFound: noMatches,
        tableFound: !!tableMatch,
        // Primeros 1500 caracteres del HTML crudo tal cual lo recibió el
        // Worker, para ver si realmente trae la tabla o si el sitio exige
        // JavaScript / cookies / bloquea el fetch.
        htmlSample: html.slice(0, 1500),
        results: [],
      };
    }
    return [];
  }

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

  // Cada celda envuelve su contenido en <a class="search-mod ..."> seguido
  // de un <div name="..." class="hidden ...">...</div> con la lista oculta
  // de variantes (código+sku) para el tooltip de "Ficha técnica". Ese div
  // oculto NO es lo que queremos mostrar como Código/Clave/Descripción —
  // nos quedamos solo con lo que está ANTES de que empiece ese div.
  const visibleCellText = (cellHtml) => {
    const beforeHiddenDiv = cellHtml.split(/<div\s+(?:name=|[^>]*class="hidden)/i)[0];
    return stripText(beforeHiddenDiv);
  };

  const results = [];
  const seenCodigos = new Set();

  for (const rowHtml of rowChunks) {
    // Cada fila trae 8 columnas: Núm, Marca, Código, Clave, Descripción,
    // Módulo(foto), Ficha técnica, Página — en ese orden.
    const cellChunks = rowHtml.split(/<td[^>]*>/i).slice(1).map((c) => c.split(/<\/td>/i)[0]);
    if (cellChunks.length < 5) continue; // no es una fila de producto (ej. fila de cabecera/filtros)

    const codigo = visibleCellText(cellChunks[2] || '');
    const clave = visibleCellText(cellChunks[3] || '');
    const descripcion = visibleCellText(cellChunks[4] || '');

    // Si la columna "Código" no es puramente numérica, esta fila no es un
    // producto real (puede ser una fila de agrupación u otra cosa rara).
    if (!/^\d+$/.test(codigo) || seenCodigos.has(codigo)) continue;
    seenCodigos.add(codigo);

    // La columna "Marca" (índice 1) no trae texto, trae el LOGO de la marca
    // como imagen (ej. ".../images/marcas/old/TRUPER-EXPERT.svg"). Sacamos
    // el nombre de la marca del propio nombre de archivo del logo.
    const marcaMatch = (cellChunks[1] || '').match(/marcas\/(?:old\/)?([A-Za-z0-9\-]+)\.(?:svg|png|jpg)/i);
    const marca = marcaMatch ? marcaMatch[1].replace(/-/g, ' ').trim() : null;

    // Imagen de alta calidad: el Banco de Contenido Digital de Truper sirve
    // la foto real del producto (hasta 1800x1800px) en esta ruta, armada
    // directo desde la CLAVE — no requiere ningún "id" interno del sitio.
    // Es MUCHO mejor calidad que la miniatura pequeña que usa la tabla del
    // buscador (admin/images/ch/{codigo}.jpg), así que la ponemos primero;
    // dejamos la miniatura como segunda opción de respaldo por si la clave
    // no tiene foto en el banco (el <img onerror> del frontend la oculta
    // sola si no carga, así que no hay riesgo de mostrar un roto).
    const images = [];
    if (clave) {
      images.push(`https://www.truper.com/media/import/imagenes/${encodeURIComponent(clave.toUpperCase())}.jpg`);
    }
    images.push(`https://www.truper.com/admin/images/ch/${codigo}.jpg`);

    results.push({
      title: descripcion || null,
      clave: clave || null,
      codigo,
      marca,
      // "proveedor" es fijo (Truper) — sirve para que el sistema interno
      // sepa de dónde salió el producto, sin mostrarlo necesariamente al
      // cliente final en el catálogo.
      proveedor: 'Truper',
      productUrl: searchUrl,
      images,
    });
  }

  // NUEVO: antes solo buscábamos fotos extra (ángulos/características) cuando
  // la consulta coincidía EXACTO con un código/clave. Ahora lo hacemos para
  // varios productos de la lista (para que cada resultado muestre sus ~4
  // fotos reales, no solo la principal). OJO: Cloudflare Workers en el plan
  // gratis permite máximo ~50 subrequests por ejecución, así que limitamos
  // cuántos productos enriquecemos y cuántos candidatos probamos por cada
  // uno para no pasarnos ese límite.
  const trimmedQuery = query.trim().toUpperCase();
  const exactMatch = results.find(
    (r) => r.codigo === query.trim() || (r.clave && r.clave.toUpperCase() === trimmedQuery)
  );

  // Si hay una coincidencia exacta (buscaste un código/clave puntual), solo
  // enriquecemos ESE producto pero a fondo (D1-D4 y FC1-FC4). Si buscaste
  // texto libre con varios resultados, enriquecemos los primeros de la
  // lista con menos candidatos cada uno, para repartir el presupuesto de
  // peticiones entre más productos en vez de agotarlo en el primero.
  const productsToEnrich = exactMatch ? [exactMatch] : results.slice(0, 8);
  const suffixesPerProduct = exactMatch ? ['D1', 'D2', 'D3', 'D4', 'FC1', 'FC2', 'FC3', 'FC4'] : ['D1', 'D2', 'D3', 'D4'];

  await Promise.all(productsToEnrich.map(async (product) => {
    if (!product.clave) return;
    const claveUp = encodeURIComponent(product.clave.toUpperCase());
    const candidates = [
      `https://www.truper.com/media/import/imagenes/${claveUp}.jpg`,
      ...suffixesPerProduct.map((suf) => `https://www.truper.com/media/import/imagenes/${claveUp}+${suf}.jpg`),
    ];
    const confirmedImages = await fetchExistingImages(candidates);
    if (confirmedImages.length) {
      product.images = [...new Set([...product.images, ...confirmedImages])];
    }
  }));

  if (debug) {
    return {
      httpStatus: res.status,
      htmlLength: html.length,
      rowChunksFound: rowChunks.length,
      resultsParsed: results.length,
      exactMatchFound: !!exactMatch,
      // Diagnóstico fino: cuántas celdas <td> detectamos en las primeras
      // filas, y el HTML crudo de la primera fila para ver la estructura
      // real (por si el orden de columnas no es el que asumimos).
      cellCountsPerRow: rowChunks.slice(0, 5).map((r) => r.split(/<td[^>]*>/i).length - 1),
      firstRowRawSample: (rowChunks[0] || '').slice(0, 3000),
      results,
    };
  }

  return results;
}
