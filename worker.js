/**
 * ============================================================================
 * BUSCADOR DE IMÁGENES DYNA + TRUPER — Cloudflare Worker
 * ============================================================================
 * Este worker recibe el nombre y/o código de un producto y hace scraping EN
 * VIVO de:
 *   1) dyna.com.co (tu proveedor) — busca el producto y extrae la(s) foto(s)
 *   2) truper.com/BancoContenidoDigital — busca por clave/código y extrae
 *      la(s) foto(s) directas del banco de imágenes oficial de Truper
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
      const query = (url.searchParams.get('q') || '').trim();
      const truperQuery = (url.searchParams.get('truper') || query || '').trim();

      if (!query && !truperQuery) {
        return jsonResponse({ error: 'Falta el parámetro ?q= (nombre) o ?truper= (código Truper)' }, 400);
      }

      const [dyna, truper] = await Promise.all([
        query ? searchDyna(query).catch((e) => { console.error('Dyna error', e); return []; }) : [],
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
      const title = titleMatch ? titleMatch[1].replace(/-\s*Dyna.*$/i, '').trim() : query;

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
// TRUPER (truper.com/BancoContenidoDigital)
// ============================================================================
async function searchTruper(codeOrName) {
  const results = [];

  // Caso A: si parece una "clave" de Truper (letras+guiones, ej FE-AS-8X-16X),
  // probamos construir la URL de imagen DIRECTAMENTE — es más rápido y no
  // depende de que el buscador encuentre la página.
  const looksLikeClave = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/.test(codeOrName.trim());
  if (looksLikeClave) {
    const clave = codeOrName.trim().toUpperCase();
    const candidates = ['', '+D1', '+D2', '+D3', '+D4'].map(
      (suf) => `https://www.truper.com/media/import/imagenes/${encodeURIComponent(clave + suf)}.jpg`
    );
    const found = [];
    for (const imgUrl of candidates) {
      try {
        const head = await fetch(imgUrl, { method: 'HEAD', headers: FETCH_HEADERS });
        if (head.ok) found.push(imgUrl);
      } catch (e) { /* ignorar */ }
    }
    if (found.length) {
      results.push({ title: codeOrName, clave, codigo: null, images: found });
      return results;
    }
  }

  // Caso B: buscamos en el Banco de Contenido Digital de Truper vía DuckDuckGo
  const links = await ddgSearch(`site:truper.com BancoContenidoDigital ${codeOrName}`, 5);
  const viewLinks = links.filter((l) => /truper\.com\/BancoContenidoDigital/i.test(l));

  for (const link of viewLinks.slice(0, 3)) {
    try {
      const res = await fetch(link, { headers: FETCH_HEADERS });
      if (!res.ok) continue;
      const html = await res.text();

      const claveMatch = html.match(/Clave:\s*([A-Za-z0-9\-]+)/i);
      const codigoMatch = html.match(/C[oó]digo:\s*(\d+)/i);
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);

      const imgMatches = [...html.matchAll(/https:\/\/www\.truper\.com\/media\/import\/imagenes\/[^"'\s)]+\.jpg/g)];
      const images = [...new Set(imgMatches.map((mm) => mm[0]))];

      if (images.length) {
        results.push({
          title: titleMatch ? titleMatch[1].trim() : codeOrName,
          clave: claveMatch ? claveMatch[1] : null,
          codigo: codigoMatch ? codigoMatch[1] : null,
          images,
        });
      }
    } catch (e) {
      console.error('Error leyendo producto Truper', link, e);
    }
  }

  return results;
}
