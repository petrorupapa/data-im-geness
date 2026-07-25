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
      const fichaTecnicaCodigo = (url.searchParams.get('fichaTecnica') || '').trim();
      const dynaDetalleUrl = (url.searchParams.get('dynaDetalle') || '').trim();

      const debug = url.searchParams.get('debug') === '1';

      // NUEVO: modo de diagnóstico directo de una página de producto Dyna.
      // Uso: ?dynaDetalle=https://www.dyna.com.co/producto/42641/.../C12/&debug=1
      if (dynaDetalleUrl) {
        const result = await fetchDynaProductDetail(dynaDetalleUrl, true);
        return jsonResponse(result);
      }

      // NUEVO: modo de diagnóstico directo de la Ficha Técnica, sin pasar
      // por toda la búsqueda — para probar puntualmente por qué no está
      // saliendo la descripción de un código específico.
      // Uso: ?fichaTecnica=104076&debug=1
      if (fichaTecnicaCodigo) {
        const result = await fetchTruperFichaTecnica(fichaTecnicaCodigo, true);
        return jsonResponse(result);
      }

      if (!dynaQuery && !truperQuery) {
        return jsonResponse({ error: 'Falta el parámetro ?q=, ?dyna=, ?truper=, ?fichaTecnica= o ?dynaDetalle=' }, 400);
      }

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

// ============================================================================
// DYNA (dyna.com.co) — buscador real del sitio
// ============================================================================
// NUEVO: antes usábamos Bing/DuckDuckGo con "site:dyna.com.co" para intentar
// adivinar productos — poco confiable (bloqueos, indexación incompleta).
// Encontramos el buscador REAL y público de Dyna, que no requiere
// JavaScript ni sesión:
//   https://www.dyna.com.co/productos?search=CONSULTA
// Devuelve tarjetas de producto en HTML plano con nombre, código, imagen
// (vía su CDN phpThumb) y link a la ficha del producto. Las páginas de
// producto (dyna.com.co/producto/{codigo}/{slug}/{empaque}/) además traen
// Marca y una descripción real (sección "CARACTERÍSTICAS").
async function searchDyna(query, debug = false) {
  const searchUrl = `https://www.dyna.com.co/productos?search=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, { headers: FETCH_HEADERS });
  if (!res.ok) return debug ? { httpStatus: res.status, results: [] } : [];

  const html = await res.text();

  // Cada tarjeta de producto trae un link con el nombre visible apuntando a
  // su ficha (dyna.com.co/producto/{codigo}/{slug}/{empaque}/). El mismo
  // producto puede repetirse varias veces por distintas presentaciones de
  // empaque (Unidad, Caja x N, etc.) — nos quedamos con la primera.
  const productRegex = /href="(https:\/\/(?:www\.)?dyna\.com\.co\/(?:public\/)?producto\/(\d+)\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  const seenCodigos = new Set();
  const results = [];
  let m;
  while ((m = productRegex.exec(html))) {
    const [, link, codigo, nameRaw] = m;
    if (seenCodigos.has(codigo)) continue;
    seenCodigos.add(codigo);
    const title = decodeHtmlEntities(nameRaw).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    results.push({
      title,
      code: codigo,
      codigo,
      marca: null,
      proveedor: 'Dyna',
      productUrl: link,
      images: [`https://cdn.laferreteria.online/thumb/phpThumb.php?src=/img/${codigo}.jpg`],
    });
  }

  // Enriquecemos los primeros resultados con Marca + descripción real,
  // sacadas de la página de cada producto (límite por el tope de ~50
  // subrequests del plan gratis de Cloudflare Workers).
  const productsToEnrich = results.slice(0, 8);
  await Promise.all(productsToEnrich.map(async (product) => {
    const extra = await fetchDynaProductDetail(product.productUrl);
    if (extra.marca) product.marca = extra.marca;
    if (extra.description) product.description = extra.description;
  }));

  if (debug) {
    return {
      httpStatus: res.status,
      htmlLength: html.length,
      resultsParsed: results.length,
      results,
    };
  }

  return results.slice(0, 20);
}

// Página de detalle de un producto Dyna: trae "Marca: XXX" y una sección
// "CARACTERÍSTICAS" con la descripción real del producto.
async function fetchDynaProductDetail(productUrl, debug = false) {
  try {
    const res = await fetch(productUrl, { headers: FETCH_HEADERS });
    if (!res.ok) return debug ? { httpStatus: res.status, marca: null, description: null } : { marca: null, description: null };
    const html = await res.text();

    const marcaMatch = html.match(/Marca:?\s*<\/[^>]+>\s*([^<]+)</i);
    const marca = marcaMatch ? decodeHtmlEntities(marcaMatch[1]).replace(/\s+/g, ' ').trim() : null;

    let description = null;
    const startIdx = html.search(/CARACTER[IÍ]STICAS/i);
    if (startIdx >= 0) {
      let chunk = html.slice(startIdx, startIdx + 2000)
        .replace(/CARACTER[IÍ]STICAS/i, '')
        .replace(/FICHA T[EÉ]CNICA/i, '');
      const paragraphMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const raw = paragraphMatch ? paragraphMatch[1] : chunk;
      let cleaned = decodeHtmlEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (cleaned.length > 700) cleaned = cleaned.slice(0, 700).trim();
      if (cleaned.length >= 5) description = cleaned;
    }

    if (debug) return { httpStatus: res.status, htmlLength: html.length, marca, description };
    return { marca, description };
  } catch (e) {
    return debug ? { error: String(e), marca: null, description: null } : { marca: null, description: null };
  }
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
//
// CAMBIO IMPORTANTE: ahora consultamos el catálogo de "95/24 Colombia S.A.S"
// (colombia9524.com), el distribuidor oficial de Truper para Colombia — NO
// el catálogo de Truper México (truper.com). Ambos corren sobre la misma
// plataforma (mismo formato de tabla), pero el catálogo de Colombia tiene
// su propio surtido de productos (hay cosas que México no maneja acá y
// viceversa) y sus propias fotos alojadas en su propio dominio.
const TRUPER_CATALOG_BASE = 'https://www.colombia9524.com/colombia-Catalogo';

async function searchTruper(query, debug = false) {
  const searchUrl = `${TRUPER_CATALOG_BASE}/buscador?palabra=${encodeURIComponent(query)}&page=1`;
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

    // El sitio marca cada foto de módulo con una clase tipo "modulo-28601"
    // en el <a> que envuelve la celda — ese número es el ID de módulo LOCAL
    // de colombia9524.com, que sirve para armar la ruta de imagen propia de
    // Colombia (colombia-Catalogo/images/modulos/{id}.jpg). La ponemos como
    // opción principal porque es la que sabemos que existe para lo que
    // Colombia sí tiene en su catálogo; dejamos también la ruta del banco
    // de imágenes de Truper (por clave, alta resolución) como respaldo, por
    // si el producto comparte foto con el catálogo de México.
    const moduloMatch = rowHtml.match(/modulo-(\d+)/);
    const moduloId = moduloMatch ? moduloMatch[1] : null;

    const images = [];
    if (moduloId) {
      images.push(`${TRUPER_CATALOG_BASE}/images/modulos/${moduloId}.jpg`);
    }
    if (clave) {
      images.push(`https://www.truper.com/media/import/imagenes/${encodeURIComponent(clave.toUpperCase())}.jpg`);
    }
    // NOTA: quitamos admin/images/ch/{codigo}.jpg de aquí — es la miniatura
    // chiquita y pixelada que usa la tablita del buscador, pensada para
    // verse pequeña, no como foto de catálogo. Preferimos no mostrar nada
    // antes que mostrar una foto de mala calidad para escoger.

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

  // NUEVO: en vez de "adivinar" qué fotos adicionales existen probando
  // sufijos (+D1, +FC1, etc.) con peticiones HEAD, consultamos la Ficha
  // Técnica real de Truper (truper.com/ficha_tecnica/...) — es un sistema
  // compartido de Truper a nivel corporativo, funciona con el mismo código
  // sin importar si el producto salió del catálogo de México o del de
  // Colombia (95/24). Esa página trae TODAS las fotos reales del producto
  // (no solo 4: puede traer +FC1, +FC2, +A1, +E1, +EI1, +EM1, etc. según el
  // producto) y una descripción real en viñetas de sus características.
  //
  // Solo lo hacemos para los primeros resultados (por el límite de ~50
  // subrequests del plan gratis de Cloudflare Workers): si hay coincidencia
  // exacta con un código/clave, solo ese producto; si es texto libre con
  // varios resultados, los primeros 8.
  const trimmedQuery = query.trim().toUpperCase();
  const exactMatch = results.find(
    (r) => r.codigo === query.trim() || (r.clave && r.clave.toUpperCase() === trimmedQuery)
  );
  const productsToEnrich = exactMatch ? [exactMatch] : results.slice(0, 8);

  await Promise.all(productsToEnrich.map(async (product) => {
    const extra = await fetchTruperFichaTecnica(product.codigo);
    if (extra.images.length) {
      product.images = [...new Set([...product.images, ...extra.images])];
    }
    if (extra.description) {
      product.description = extra.description;
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

// Decodifica las entidades HTML más comunes en texto en español. Antes solo
// se decodificaba &amp;, por lo que tildes y eñes salían literalmente como
// "&eacute;", "&ntilde;", etc. en la descripción guardada.
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', oacute: 'ó', aacute: 'á', iacute: 'í', uacute: 'ú', uuml: 'ü',
  Eacute: 'É', Oacute: 'Ó', Aacute: 'Á', Iacute: 'Í', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª',
};
function decodeHtmlEntities(str) {
  return str
    .replace(/&([a-zA-Z]+);/g, (match, name) => (name in HTML_ENTITIES ? HTML_ENTITIES[name] : match))
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ============================================================================
// FICHA TÉCNICA DE TRUPER — descripción real + todas las fotos del producto
// ============================================================================
// https://www.truper.com/ficha_tecnica/controllers/index.php?codigo={codigo}
// Esta página trae, para un código dado: el nombre de la clave, varias
// líneas de descripción/características reales (ej. "Cuerpo fabricado en
// acero...", "Base de ABS y terminales de aluminio...") y TODAS las fotos
// reales del producto (bajo la ruta media/import/imagenes/{CLAVE}...jpg,
// con distintos sufijos según el producto — no siempre los mismos).
async function fetchTruperFichaTecnica(codigo, debug = false) {
  const url = `https://www.truper.com/ficha_tecnica/controllers/index.php?codigo=${encodeURIComponent(codigo)}`;
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) return debug ? { httpStatus: res.status, images: [], description: null } : { images: [], description: null };
    const html = await res.text();

    // Todas las fotos reales: cualquier URL de imagen bajo media/import/imagenes/
    // que aparezca en la página (aparecen repetidas por el carrusel/miniaturas,
    // por eso las deduplicamos con un Set).
    const images = [...new Set([...html.matchAll(/https:\/\/www\.truper\.com\/media\/import\/imagenes\/[^"'\s)]+\.jpg/gi)].map((m) => m[0]))];

    // Descripción: confirmamos con datos reales que cada viñeta de
    // características viene en esta estructura específica y consistente:
    //   <div class="row fs-6">
    //     <div class="col-1 col_list"><span class="lista">•</span></div>
    //     <div class="col-11 especs_margen"><p class="lh-2">TEXTO</p></div>
    //   </div>
    // Antes intentábamos ubicar el bloque con marcadores de texto sueltos
    // ("Ir a página del catálogo" / "Archivos descargables"), pero esa
    // ventana no siempre contenía las viñetas reales (quedaban más abajo
    // en la página, en la versión "completa" duplicada), lo que a veces
    // devolvía texto de otra sección (ej. "Especificaciones técnicas ·
    // Incluye") o nada. Apuntar directo a la clase real es mucho más
    // confiable, sin depender de en qué posición del HTML caiga.
    const rawBullets = [...html.matchAll(/especs_margen[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    const cleaned = [...new Set(
      rawBullets
        .map((b) => decodeHtmlEntities(b.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
        .filter((b) =>
          b.length > 3 &&
          !/^ir a p[aá]gina/i.test(b) &&
          !/^especificaciones t[eé]cnicas?$/i.test(b) &&
          !/^(certificaciones y garant[ií]a|informaci[oó]n de empaque|videos del producto|inclu[iy]e:?)$/i.test(b)
        )
    )];
    const description = cleaned.length ? cleaned.join(' · ') : null;
    const bulletsDebug = cleaned;

    if (debug) {
      return {
        httpStatus: res.status,
        htmlLength: html.length,
        images,
        description,
        rawBulletsFound: rawBullets.length,
        bulletsFound: bulletsDebug,
      };
    }
    return { images, description };
  } catch (e) {
    return debug ? { error: String(e), images: [], description: null } : { images: [], description: null };
  }
}
