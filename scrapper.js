import fs from "fs";
import { chromium } from "playwright";
import axios from "axios";
import xml2js from "xml2js";
import path from "path";
import { setTimeout } from "timers/promises";

// Lista de sitemaps para diferentes sitios
const SITEMAPS = [
  {
    url: "https://www.ortotek.cl/product-sitemap.xml",
    site: "ortotek",
    platform: "woocommerce",
  },
  {
    url: "https://www.denteeth.cl/wp-sitemap.xml",
    site: "denteeth",
    platform: "woocommerce",
  },
  {
    url: "https://gacchile.cl/wp-sitemap-posts-product-1.xml",
    site: "gacchile",
    platform: "woocommerce",
  },
  {
    url: "https://www.damus.cl/sitemap_1.xml",
    site: "damus",
    platform: "jumpseller",
  },
];

// Configuración general
const CONFIG = {
  concurrentBrowsers: 2, // Número de navegadores concurrentes para diferentes sitios
  requestDelay: 1500, // Milisegundos entre solicitudes al mismo sitio
  timeout: 60000, // Timeout para carga de página
  maxRetries: 2, // Intentos máximos para scrapear un producto
  testMode: true, // Modo de prueba (limita el número de productos)
  testProductLimit: 10, // Límite de productos en modo prueba
  outputDir: "scraper_results", // Directorio para resultados
};

// Función para obtener las URLs de productos desde el sitemap
const getProductUrlsFromSitemap = async (sitemapInfo) => {
  try {
    console.log(
      `🌐 Procesando sitemap de ${sitemapInfo.site}: ${sitemapInfo.url}`
    );
    const response = await axios.get(sitemapInfo.url);
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    // Para sitemaps que usan un índice (como denteeth)
    if (
      sitemapInfo.url.includes("wp-sitemap.xml") &&
      !sitemapInfo.url.includes("product")
    ) {
      console.log(
        `📋 Procesando índice de sitemap para ${sitemapInfo.site}...`
      );
      return await processIndexSitemap(result, sitemapInfo, parser);
    }
    // Para JumpSeller (Damus) que podría tener una estructura diferente
    else if (sitemapInfo.platform === "jumpseller") {
      return await processJumpSellerSitemap(result, sitemapInfo);
    }
    // Para sitemaps directos de productos (como ortotek y gacchile)
    else {
      return await processDirectSitemap(result, sitemapInfo);
    }
  } catch (error) {
    console.error(
      `❌ Error obteniendo el sitemap de ${sitemapInfo.url}:`,
      error.message
    );
    return [];
  }
};

// Procesar sitemap tipo índice (como denteeth)
const processIndexSitemap = async (result, sitemapInfo, parser) => {
  const productSitemaps = [];

  if (result.sitemapindex && result.sitemapindex.sitemap) {
    for (const sitemap of result.sitemapindex.sitemap) {
      const submapUrl = sitemap.loc[0];
      if (submapUrl.includes("product")) {
        productSitemaps.push(submapUrl);
      }
    }
  }

  // Obtener URLs de productos de cada submap
  let allProductUrls = [];
  for (const submapUrl of productSitemaps) {
    console.log(`📦 Procesando sub-sitemap: ${submapUrl}`);
    try {
      const subResponse = await axios.get(submapUrl);
      const subResult = await parser.parseStringPromise(subResponse.data);

      if (subResult.urlset && subResult.urlset.url) {
        const urls = subResult.urlset.url.map((item) => ({
          url: item.loc[0],
          site: sitemapInfo.site,
          platform: sitemapInfo.platform,
          lastmod: item.lastmod ? item.lastmod[0] : null,
        }));
        allProductUrls = allProductUrls.concat(urls);
      }
    } catch (subError) {
      console.error(
        `❌ Error procesando sub-sitemap ${submapUrl}:`,
        subError.message
      );
    }
  }

  return allProductUrls;
};

// Procesar sitemap directo (como ortotek y gacchile)
const processDirectSitemap = async (result, sitemapInfo) => {
  if (result.urlset && result.urlset.url) {
    // Filter URLs to exclude non-product pages
    const filteredUrls = result.urlset.url.filter((item) => {
      const url = item.loc[0];

      // Skip URLs that are clearly not product pages
      if (
        url.includes("/tienda") || // Tienda page (Ortotek)
        url.endsWith("/tienda/") ||
        url.includes("/cart") ||
        url.includes("/checkout") ||
        url.includes("/account") ||
        url.includes("/login") ||
        url.includes("/register") ||
        url.includes("/search") ||
        url.includes("/my-account") ||
        url.includes("/wishlist") ||
        url.includes("/contact") ||
        url.includes("/about") ||
        url.includes("/blog")
      ) {
        console.log(`⏭️ Skipping non-product URL in direct sitemap: ${url}`);
        return false;
      }

      return true;
    });

    return filteredUrls.map((item) => ({
      url: item.loc[0],
      site: sitemapInfo.site,
      platform: sitemapInfo.platform,
      lastmod: item.lastmod ? item.lastmod[0] : null,
    }));
  }
  return [];
};

// Procesar sitemap para JumpSeller (Damus)
const processJumpSellerSitemap = async (result, sitemapInfo) => {
  let productUrls = [];

  if (result.urlset && result.urlset.url) {
    // Filter URLs to include only product pages
    for (const item of result.urlset.url) {
      const url = item.loc[0];

      // Skip URLs that are clearly not product pages
      // For Damus: Skip homepage, contact page, and category pages without specific product identifiers
      if (
        url === `https://www.${sitemapInfo.site}.cl` || // Homepage
        url === `https://www.${sitemapInfo.site}.cl/` ||
        url.includes("/contact") || // Contact page
        url.includes("/tienda") || // Tienda page (Ortotek)
        url.endsWith(".cl/acero") || // Category pages
        url.includes("/cart") ||
        url.includes("/checkout") ||
        url.includes("/account") ||
        url.includes("/login") ||
        url.includes("/register") ||
        url.includes("/search") ||
        url.includes("/collections") ||
        url.includes("/pages/")
      ) {
        console.log(`⏭️ Skipping non-product URL: ${url}`);
        continue;
      }

      // For Damus, product URLs typically have a specific pattern or structure
      // They often have multiple segments in the path or include product identifiers
      const urlPath = new URL(url).pathname;
      const pathSegments = urlPath
        .split("/")
        .filter((segment) => segment.length > 0);

      // If the URL has a path with at least 2 segments or contains product identifiers, consider it a product URL
      const isLikelyProductUrl =
        pathSegments.length >= 2 || // URLs with deeper paths are likely product pages
        urlPath.includes("-") || // Product URLs often contain hyphens in the slug
        /\d/.test(urlPath); // Product URLs often contain numbers

      if (isLikelyProductUrl) {
        productUrls.push({
          url,
          site: sitemapInfo.site,
          platform: sitemapInfo.platform,
          lastmod: item.lastmod ? item.lastmod[0] : null,
        });
      } else {
        console.log(`⏭️ Skipping likely non-product URL: ${url}`);
      }
    }
  }

  console.log(
    `📊 Encontrados ${productUrls.length} productos en ${sitemapInfo.site} (JumpSeller)`
  );
  return productUrls;
};

// Función para verificar si una página es realmente una página de producto
const isProductPage = async (page) => {
  try {
    return await page.evaluate(() => {
      try {
        // Verificar elementos comunes en páginas de producto
        const hasAddToCartButton = !!document.querySelector(
          'button[name="add-to-cart"], .single_add_to_cart_button, .add_to_cart_button, #add-to-cart, .btn-add-to-cart, [id*="add-to-cart"], [class*="add-to-cart"], form[action*="/cart/add/"]'
        );

        const hasPriceElement = !!document.querySelector(
          '.price, .woocommerce-Price-amount, .product-price, .product-form-price, [class*="price"], [id*="price"], span.product-form-price, .form-price_desktop'
        );

        const hasProductTitle = !!document.querySelector(
          '.product_title, h1.entry-title, .product-name, h1.page-header, [class*="product-title"], [class*="product-name"], h1.page-header'
        );

        const hasProductGallery = !!document.querySelector(
          '.woocommerce-product-gallery, .product-images, .product-gallery, .carousel-inner, [class*="product-gallery"], [class*="product-image"]'
        );

        // Verificar elementos específicos de JumpSeller (Damus)
        const hasJumpSellerProductForm = !!document.querySelector(
          'form[id*="product-form"], form[action*="/cart/add/"], div[id*="product-sku"], .form-group.description'
        );

        // Verificar elementos específicos de WooCommerce
        const hasWooCommerceProductElements = !!document.querySelector(
          ".woocommerce-product-gallery, .product_meta, .woocommerce-tabs, .related.products"
        );

        // Verificar elementos de stock
        const hasStockInfo = !!document.querySelector(
          '.stock, [class*="stock"], [id*="stock"], .product-stock, .product-out-stock, .product-unavailable'
        );

        // Verificar textos comunes en páginas de producto
        const pageText = document.body.textContent.toLowerCase();
        const hasProductTerms =
          pageText.includes("añadir al carrito") ||
          pageText.includes("add to cart") ||
          pageText.includes("agregar al carrito") ||
          pageText.includes("comprar ahora") ||
          pageText.includes("buy now") ||
          pageText.includes("out of stock") ||
          pageText.includes("agotado") ||
          pageText.includes("sin stock") ||
          pageText.includes("no disponible") ||
          (pageText.includes("stock") &&
            (pageText.includes("precio") || pageText.includes("price")));

        // Verificar si hay un formulario de producto con ID de producto
        const hasProductForm = !!document.querySelector(
          'form[id*="product-form"], form[action*="/cart/add/"]'
        );

        // Verificar si hay un SKU de producto
        const hasSku = !!document.querySelector(
          '#product-sku, .product-sku, [id*="sku"]'
        );

        // Verificar URL para productos de Ortotek
        const isOrtotekProduct =
          window.location.href.includes("/product/") &&
          (window.location.href.includes("bracket") ||
            window.location.href.includes("kit") ||
            window.location.href.includes("ortodoncia"));

        // Considerar una página de producto si tiene suficientes indicadores
        let score = 0;
        if (hasAddToCartButton) score += 2; // Mayor peso para botón de compra
        if (hasPriceElement) score += 2; // Mayor peso para elemento de precio
        if (hasProductTitle) score++;
        if (hasProductGallery) score++;
        if (hasJumpSellerProductForm) score += 2;
        if (hasWooCommerceProductElements) score += 2;
        if (hasStockInfo) score++;
        if (hasProductTerms) score++;
        if (hasProductForm) score += 2;
        if (hasSku) score += 2;
        if (isOrtotekProduct) score += 3; // Fuerte indicador para productos de Ortotek

        // Verificar comentarios HTML que indican stock
        const htmlSource = document.documentElement.outerHTML;
        if (
          htmlSource.includes("<!-- Out of Stock -->") ||
          htmlSource.includes("<!-- Not Available -->")
        ) {
          score += 2;
        }

        // Verificar si hay un formulario con método POST y acción que incluye /cart/add/
        const cartForms = document.querySelectorAll(
          'form[method="post"][action*="/cart/add/"]'
        );
        if (cartForms.length > 0) {
          score += 3; // Muy fuerte indicador de página de producto
        }

        // Verificar si la URL contiene patrones comunes de productos
        if (
          window.location.pathname.includes("/product/") ||
          window.location.pathname.includes("/producto/") ||
          window.location.pathname.match(/\/[a-z0-9-]+\/[a-z0-9-]+\/?$/) // Patrón de URL de producto
        ) {
          score += 2;
        }

        return score >= 3; // Requiere al menos 3 puntos para ser considerado producto
      } catch (error) {
        // Si hay algún error en la evaluación, asumimos que no es una página de producto
        console.error("Error en la evaluación de página de producto:", error);
        return false;
      }
    });
  } catch (error) {
    console.warn(`⚠️ Error verificando página de producto: ${error.message}`);
    return false;
  }
};

// Función para scrapear productos desde las URLs obtenidas
const scrapeProductData = async (urlInfos) => {
  // Dividir URLs por sitio para manejar concurrencia por sitio
  const urlsByDomain = {};
  for (const urlInfo of urlInfos) {
    const domain = new URL(urlInfo.url).hostname;
    if (!urlsByDomain[domain]) {
      urlsByDomain[domain] = [];
    }
    urlsByDomain[domain].push(urlInfo);
  }

  // Iniciar navegadores concurrentes por dominio
  const results = [];
  const domainPromises = Object.entries(urlsByDomain).map(
    async ([domain, urls]) => {
      const domainResults = await scrapeProductsForDomain(urls);
      results.push(...domainResults);
    }
  );

  await Promise.all(domainPromises);
  return results;
};

// Función para scrapear productos de un dominio específico
const scrapeProductsForDomain = async (urlInfos) => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  let results = [];

  for (let i = 0; i < urlInfos.length; i++) {
    const urlInfo = urlInfos[i];
    const { url, site, platform } = urlInfo;
    console.log(
      `🔍 [${i + 1}/${urlInfos.length}] Scrapeando producto de ${site}: ${url}`
    );

    // Añadir delay entre solicitudes al mismo sitio para evitar bloqueos
    if (i > 0) {
      await setTimeout(CONFIG.requestDelay);
    }

    let retryCount = 0;
    let success = false;

    // Verificar si la URL contiene patrones de páginas no-producto
    if (
      url.includes("/tienda") ||
      url.endsWith("/tienda/") ||
      url.includes("/cart") ||
      url.includes("/checkout") ||
      url.includes("/account") ||
      url.includes("/login") ||
      url.includes("/register") ||
      url.includes("/search") ||
      url.includes("/my-account") ||
      url.includes("/wishlist") ||
      url.includes("/contact") ||
      url.includes("/about") ||
      url.includes("/blog")
    ) {
      console.warn(`⚠️ Omitiendo URL que no es de producto: ${url}`);
      results.push({
        name: "No es una página de producto",
        price: "",
        stock: "N/A",
        quantity: null,
        link: url,
        image: "",
        site,
        platform,
        timestamp: new Date().toISOString(),
        error: "URL no corresponde a una página de producto",
      });
      continue; // Saltar al siguiente producto
    }

    while (!success && retryCount <= CONFIG.maxRetries) {
      try {
        // Configurar timeout y opciones de navegación
        await page.goto(url, {
          waitUntil: "domcontentloaded", // Cambiar a domcontentloaded para ser más rápido
          timeout: CONFIG.timeout,
        });

        // Esperar un poco para que la página cargue elementos dinámicos
        await page.waitForTimeout(2000);

        // Verificar si es realmente una página de producto
        const isProduct = await isProductPage(page);
        if (!isProduct) {
          console.warn(
            `⚠️ La URL ${url} no parece ser una página de producto. Omitiendo.`
          );
          results.push({
            name: "No es una página de producto",
            price: "",
            stock: "N/A",
            quantity: null,
            link: url,
            image: "",
            site,
            platform,
            timestamp: new Date().toISOString(),
            error: "URL no corresponde a una página de producto",
          });
          success = true;
          break;
        }

        // Extraer datos según la plataforma del sitio
        let productData;
        if (platform === "jumpseller") {
          productData = await extractJumpSellerProductData(page, url, site);
        } else {
          productData = await extractWooCommerceProductData(page, url, site);
        }

        results.push(productData);
        success = true;
      } catch (error) {
        retryCount++;
        console.warn(
          `⚠️ Intento ${retryCount}/${
            CONFIG.maxRetries + 1
          } falló para ${url}: ${error.message}`
        );

        if (retryCount > CONFIG.maxRetries) {
          console.error(`❌ Fallaron todos los intentos para: ${url}`);
          results.push({
            name: "Error al extraer datos",
            price: "",
            stock: "Error",
            quantity: null,
            link: url,
            image: "",
            site,
            platform,
            timestamp: new Date().toISOString(),
            error: error.message,
          });
        } else {
          // Esperar antes de reintentar
          await setTimeout(2000 * retryCount);
        }
      }
    }
  }

  await browser.close();
  return results;
};

// Función para extraer datos de productos WooCommerce (Ortotek, Denteeth, GACChile)
const extractWooCommerceProductData = async (page, url, site) => {
  // Configuración de selectores según el sitio
  const selectors = getSiteSelectors(site);

  // Extraer el nombre del producto sin esperar a que sea visible
  let name = "";
  try {
    // Intentar extraer el nombre sin esperar a que sea visible
    name = await page.evaluate((titleSelector) => {
      const titleEl = document.querySelector(titleSelector);
      if (titleEl) return titleEl.innerText.trim();

      // Si no se encuentra el título con el selector, buscar en h1
      const h1El = document.querySelector("h1");
      if (h1El) return h1El.innerText.trim();

      // Extraer del título de la página como último recurso
      return document.title.split(" - ")[0].trim();
    }, selectors.title);
  } catch (titleError) {
    console.warn(`⚠️ No se pudo obtener el título: ${titleError.message}`);
    // Usar la última parte de la URL como nombre
    const urlParts = url.split("/");
    const lastPart =
      urlParts[urlParts.length - 2] === "producto" ||
      urlParts[urlParts.length - 2] === "product"
        ? urlParts[urlParts.length - 1]
        : urlParts[urlParts.length - 2];
    name = lastPart.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }

  // Extraer la imagen del producto
  let image = "";
  try {
    image = await page.evaluate((imgSelector) => {
      const imgEl = document.querySelector(imgSelector);
      return imgEl ? imgEl.src : "";
    }, selectors.image);
  } catch (imgError) {
    console.warn(`⚠️ No se pudo obtener la imagen: ${imgError.message}`);
  }

  // Extraer información de stock primero
  const stockInfo = await extractStockInfo(page, selectors.stockSelectors);

  // Extraer el precio
  let price = await extractPrice(page, selectors.priceSelectors, site);

  // Si el producto está agotado y el precio es "$0", actualizar el mensaje de precio
  if (
    (stockInfo.status.toLowerCase().includes("agotado") ||
      stockInfo.status.toLowerCase().includes("sin stock") ||
      stockInfo.status.toLowerCase().includes("no disponible")) &&
    price === "$0"
  ) {
    price = "No disponible (Agotado)";
  }

  // Extraer descripción adicional (común para todos)
  let description = await extractProductDescription(
    page,
    selectors.descriptionSelectors
  );

  // Extraer especificaciones técnicas si están disponibles
  let specifications = await extractSpecifications(
    page,
    selectors.specificationSelectors
  );

  return {
    name,
    price,
    stock: stockInfo.status,
    quantity: stockInfo.quantity,
    link: url,
    image,
    site,
    platform: "woocommerce",
    description,
    specifications,
    timestamp: new Date().toISOString(),
  };
};

// Función para extraer datos de productos JumpSeller (Damus)
const extractJumpSellerProductData = async (page, url, site) => {
  // Configuración de selectores específicos para JumpSeller
  const selectors = getSiteSelectors(site);

  // Extraer el nombre del producto - sin esperar a que sea visible
  let name = "";
  try {
    // Intentar extraer el nombre sin esperar a que sea visible
    name = await page.evaluate((titleSelector) => {
      const titleEl = document.querySelector(titleSelector);
      if (titleEl) return titleEl.innerText.trim();

      // Si no se encuentra el título con el selector, buscar en h1 o elementos con clase que contenga 'title'
      const h1El = document.querySelector("h1");
      if (h1El) return h1El.innerText.trim();

      // Buscar en el elemento .page-header que es común en Damus
      const pageHeaderEl = document.querySelector(".page-header");
      if (pageHeaderEl) return pageHeaderEl.innerText.trim();

      // Buscar en el elemento .brand que es común en Damus
      const brandEl = document.querySelector(".brand");
      if (brandEl) return brandEl.innerText.trim();

      // Extraer del título de la página como último recurso
      return document.title.replace(" - Damus", "").trim();
    }, selectors.title);
  } catch (titleError) {
    console.warn(`⚠️ No se pudo obtener el título: ${titleError.message}`);
    // Usar la última parte de la URL como nombre
    const urlParts = url.split("/");
    name = urlParts[urlParts.length - 1]
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  // Extraer la imagen del producto
  let image = "";
  try {
    image = await page.evaluate((imgSelector) => {
      const imgEl = document.querySelector(imgSelector);
      return imgEl ? imgEl.src : "";
    }, selectors.image);
  } catch (imgError) {
    console.warn(`⚠️ No se pudo obtener la imagen: ${imgError.message}`);
  }

  // Extraer información de stock específica para JumpSeller primero
  const stockInfo = await extractStockInfo(page, selectors.stockSelectors);

  // Extraer el precio
  let price = await extractPrice(page, selectors.priceSelectors, site);

  // Si el producto está agotado y el precio es "$0", actualizar el mensaje de precio
  if (
    (stockInfo.status.toLowerCase().includes("agotado") ||
      stockInfo.status.toLowerCase().includes("sin stock") ||
      stockInfo.status.toLowerCase().includes("no disponible")) &&
    price === "$0"
  ) {
    price = "No disponible (Agotado)";
  }

  // Extraer SKU si está disponible
  let sku = "";
  try {
    sku = await page.evaluate((skuSelector) => {
      const skuEl = document.querySelector(skuSelector);
      return skuEl ? skuEl.textContent.trim().replace("SKU:", "").trim() : "";
    }, selectors.sku);
  } catch (skuError) {
    // SKU podría no estar disponible
  }

  // Extraer descripción específica para JumpSeller
  let description = await extractProductDescription(
    page,
    selectors.descriptionSelectors
  );

  // Extraer características técnicas específicas para JumpSeller
  let specifications = await extractSpecifications(
    page,
    selectors.specificationSelectors
  );

  // Extraer marca si está disponible
  let brand = "";
  try {
    // Buscar específicamente la marca
    brand = await page.evaluate(() => {
      const brandEl = document.querySelector(".brand");
      if (brandEl) return brandEl.textContent.trim();

      const brandTexts = document.body.textContent.match(/Marca:\s*([^\n]*)/);
      return brandTexts ? brandTexts[1].trim() : "";
    });
  } catch (brandError) {
    // La marca podría no estar disponible
  }

  // Extraer presentación si está disponible
  let presentation = "";
  try {
    presentation = await page.evaluate(() => {
      const presentationTexts = document.body.textContent.match(
        /Presentacion:\s*([^\n]*)/
      );
      return presentationTexts ? presentationTexts[1].trim() : "";
    });
  } catch (error) {
    // La presentación podría no estar disponible
  }

  return {
    name,
    price,
    stock: stockInfo.status,
    quantity: stockInfo.quantity,
    link: url,
    image,
    site,
    platform: "jumpseller",
    sku,
    brand,
    presentation,
    description,
    specifications,
    timestamp: new Date().toISOString(),
  };
};

// Función para limpiar el texto del precio
function cleanPrice(priceText) {
  if (!priceText) return "";

  try {
    // Eliminar espacios en blanco y caracteres no deseados
    let cleaned = priceText.trim();

    // Si hay múltiples líneas, tomar solo la primera
    if (cleaned.includes("\n")) {
      cleaned = cleaned.split("\n")[0].trim();
    }

    // Eliminar texto adicional como "Precio:" o "Precio web:"
    cleaned = cleaned.replace("Precio web:", "").replace("Precio:", "").trim();

    // Asegurarse de que el precio tenga el formato correcto
    // Si no tiene símbolo de moneda, agregar "$"
    if (!cleaned.includes("$")) {
      cleaned = "$" + cleaned;
    }

    // Eliminar espacios entre el símbolo de moneda y el valor
    cleaned = cleaned.replace(/\$\s+/, "$");

    return cleaned;
  } catch (error) {
    console.error("Error al limpiar el precio:", error);
    return priceText || "";
  }
}

// Extraer precio de producto
async function extractPrice(page, selectors, domain) {
  try {
    // Verificar primero si el producto está agotado
    const stockStatus = await page.evaluate(() => {
      // Buscar indicadores de agotado
      const stockTexts = [
        "Agotado",
        "Out of stock",
        "Sin stock",
        "No disponible",
        "Sold out",
      ];
      for (const text of stockTexts) {
        if (document.body.textContent.includes(text)) {
          return "Agotado";
        }
      }

      // Verificar elementos de stock
      const stockElement = document.querySelector(
        ".stock, .availability, .product-stock, .inventory_status"
      );
      if (
        stockElement &&
        stockElement.textContent
          .trim()
          .match(/agotado|out of stock|sin stock|no disponible|sold out/i)
      ) {
        return "Agotado";
      }

      return null;
    });

    // Si el producto está agotado, devolver un mensaje indicativo
    if (stockStatus === "Agotado") {
      return "No disponible (Agotado)";
    }

    // Caso especial para GAC y Ortotek - intentar primero con un selector específico
    if (domain === "gacchile" || domain === "ortotek") {
      try {
        // Extraer directamente el precio completo con un selector específico
        const specificPrice = await page.evaluate((domain) => {
          const priceElement = document.querySelector(
            "p.price span.woocommerce-Price-amount.amount bdi"
          );
          if (priceElement) {
            return priceElement.textContent.trim();
          }
          return null;
        }, domain);

        if (specificPrice && specificPrice !== "$") {
          return cleanPrice(specificPrice);
        }
      } catch (specificError) {
        console.warn(
          `⚠️ Error al extraer precio específico de ${domain}: ${specificError.message}`
        );
      }
    }

    // Intentar extraer el precio usando los selectores proporcionados
    for (const selector of selectors) {
      try {
        // Verificar si el selector existe en la página
        const elementExists = await page.evaluate((sel) => {
          return document.querySelector(sel) !== null;
        }, selector);

        if (!elementExists) continue;

        // Caso especial para GAC y Ortotek donde el símbolo de moneda y el valor pueden estar en elementos separados
        if (
          (domain === "gacchile" || domain === "ortotek") &&
          selector.includes("currencySymbol")
        ) {
          const priceText = await page.evaluate((sel) => {
            const currencyElement = document.querySelector(sel);
            if (!currencyElement) return null;

            // Intentar obtener el valor del precio del elemento hermano
            let priceValue = "";

            // Verificar si el elemento padre es un <bdi>
            const parentElement = currencyElement.parentElement;
            if (
              parentElement &&
              parentElement.tagName.toLowerCase() === "bdi"
            ) {
              // Obtener el contenido de texto completo del bdi y extraer el valor numérico
              const fullText = parentElement.textContent.trim();
              // Extraer la parte numérica después del símbolo de moneda
              const match = fullText.match(/\$\s*([0-9.,]+)/);
              if (match && match[1]) {
                return "$" + match[1];
              }
            }

            // Si no encontramos el precio en el bdi, intentar con el siguiente nodo
            let nextSibling = currencyElement.nextSibling;

            // Si el siguiente nodo es un nodo de texto, obtener su valor
            if (
              nextSibling &&
              nextSibling.nodeType === Node.TEXT_NODE &&
              nextSibling.textContent.trim()
            ) {
              priceValue = nextSibling.textContent.trim();
              return "$" + priceValue;
            }

            // Si no hay texto en el siguiente nodo, buscar en el elemento padre
            if (currencyElement.parentElement) {
              // Obtener todo el texto del elemento padre
              const parentText =
                currencyElement.parentElement.textContent.trim();
              // Extraer la parte numérica después del símbolo de moneda
              const match = parentText.match(/\$\s*([0-9.,]+)/);
              if (match && match[1]) {
                return "$" + match[1];
              }
            }

            return currencyElement.textContent; // Devolver solo el símbolo si no encontramos el valor
          }, selector);

          if (priceText && priceText !== "$") {
            return cleanPrice(priceText);
          }
        }

        // Extracción normal del precio
        const priceText = await page.evaluate((sel) => {
          const element = document.querySelector(sel);
          return element ? element.textContent.trim() : null;
        }, selector);

        if (priceText) {
          // Para GAC y Ortotek, verificar si solo tenemos el símbolo de moneda
          if (
            (domain === "gacchile" || domain === "ortotek") &&
            priceText === "$"
          ) {
            continue; // Intentar con el siguiente selector
          }
          return cleanPrice(priceText);
        }
      } catch (error) {
        console.error(
          `Error al extraer precio con selector ${selector}:`,
          error
        );
        // Continuar con el siguiente selector
      }
    }

    // Si llegamos aquí, intentar una estrategia más general para GAC y Ortotek
    if (domain === "gacchile" || domain === "ortotek") {
      try {
        const priceText = await page.evaluate(() => {
          // Estrategia 1: Buscar el precio en la estructura específica
          const bdiElement = document.querySelector(
            "p.price span.woocommerce-Price-amount.amount bdi"
          );
          if (bdiElement) {
            return bdiElement.textContent.trim();
          }

          // Estrategia 2: Buscar cualquier elemento que contenga un precio con formato de moneda
          const priceElements = Array.from(
            document.querySelectorAll("*")
          ).filter((el) => {
            const text = el.textContent.trim();
            return text.includes("$") && /\$\s*[0-9.,]+/.test(text);
          });

          if (priceElements.length > 0) {
            // Tomar el elemento con el texto más corto, que probablemente sea solo el precio
            priceElements.sort(
              (a, b) => a.textContent.length - b.textContent.length
            );
            return priceElements[0].textContent.trim();
          }

          // Estrategia 3: Buscar específicamente en elementos con clase price o woocommerce-Price-amount
          const priceContainer = document.querySelector(
            ".price, .woocommerce-Price-amount"
          );
          if (priceContainer) {
            return priceContainer.textContent.trim();
          }

          return null;
        });

        if (priceText && priceText !== "$") {
          return cleanPrice(priceText);
        }
      } catch (error) {
        console.error(
          `Error al extraer precio con estrategia general para ${domain}:`,
          error
        );
      }
    }

    // Verificar nuevamente el stock antes de devolver un valor predeterminado
    const finalStockCheck = await page.evaluate(() => {
      // Buscar indicadores de agotado más exhaustivamente
      const pageText = document.body.textContent.toLowerCase();
      return (
        pageText.includes("agotado") ||
        pageText.includes("out of stock") ||
        pageText.includes("sin stock") ||
        pageText.includes("no disponible") ||
        pageText.includes("sold out")
      );
    });

    if (finalStockCheck) {
      return "No disponible (Agotado)";
    }

    return "$0"; // Devolver "$0" en lugar de null para mantener consistencia
  } catch (error) {
    console.error("Error en extractPrice:", error);
    return "$0";
  }
}

// Extraer información de stock
const extractStockInfo = async (page, stockSelectors) => {
  try {
    return await page.evaluate((stockSelectors) => {
      let status = "Desconocido";
      let quantity = null;

      // Verificar selectores específicos de stock
      for (const selector of stockSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          status = el.textContent.trim();

          // Intentar extraer cantidad si está disponible
          const quantityMatch = status.match(/\d+/);
          if (quantityMatch) {
            quantity = parseInt(quantityMatch[0], 10);
          }

          break;
        }
      }

      // Verificar estado del botón de compra
      const addToCartButton = document.querySelector(
        ".single_add_to_cart_button, .add_to_cart_button, [name='add-to-cart'], #add-to-cart, .btn-add-to-cart"
      );
      if (addToCartButton && addToCartButton.disabled) {
        status = "Agotado";
      }

      // Verificar textos comunes de stock
      const stockTexts = {
        agotado: [
          "Agotado",
          "Out of stock",
          "Sin stock",
          "No disponible",
          "Sold out",
        ],
        disponible: ["En stock", "Disponible", "In stock", "Disponibilidad:"],
      };

      // Buscar textos de agotado en la página
      for (const text of stockTexts.agotado) {
        if (document.body.textContent.includes(text)) {
          status = "Agotado";
          break;
        }
      }

      // Buscar textos de disponibilidad en la página
      for (const text of stockTexts.disponible) {
        if (document.body.textContent.includes(text)) {
          // Si encontramos un texto de disponibilidad, buscamos un número cercano
          const availabilitySection = Array.from(
            document.querySelectorAll("*")
          ).find((el) => el.textContent.includes(text));

          if (availabilitySection) {
            const quantityText = availabilitySection.textContent;
            const quantityMatch = quantityText.match(/\d+/);
            if (quantityMatch) {
              quantity = parseInt(quantityMatch[0], 10);
            }
            status = "En stock";
          } else {
            status = "En stock";
          }
          break;
        }
      }

      // Si el producto tiene precio pero ninguna indicación de agotado, asumimos disponible
      if (
        status === "Desconocido" &&
        document.querySelector(
          ".price, .woocommerce-Price-amount, .product-form-price"
        )
      ) {
        status = "En stock";
      }

      return { status, quantity };
    }, stockSelectors);
  } catch (stockError) {
    console.warn(
      `⚠️ Error al extraer información de stock: ${stockError.message}`
    );
    return { status: "Desconocido", quantity: null };
  }
};

// Extraer descripción del producto
const extractProductDescription = async (page, descriptionSelectors) => {
  try {
    return await page.evaluate((selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          return el.innerText.trim();
        }
      }
      return "";
    }, descriptionSelectors);
  } catch (error) {
    console.warn(`⚠️ Error al extraer descripción: ${error.message}`);
    return "";
  }
};

// Extraer especificaciones técnicas
const extractSpecifications = async (page, specificationSelectors) => {
  try {
    return await page.evaluate((selectors) => {
      const specs = {};

      // Buscar tabla de especificaciones
      for (const tableSelector of selectors.tables) {
        const table = document.querySelector(tableSelector);
        if (table) {
          const rows = table.querySelectorAll("tr");
          rows.forEach((row) => {
            const cells = row.querySelectorAll("td, th");
            if (cells.length >= 2) {
              const key = cells[0].textContent.trim().replace(":", "");
              const value = cells[1].textContent.trim();
              if (key && value) {
                specs[key] = value;
              }
            }
          });
        }
      }

      // Buscar listas de especificaciones
      for (const listSelector of selectors.lists) {
        const listItems = document.querySelectorAll(listSelector);
        listItems.forEach((item) => {
          const text = item.textContent.trim();
          const parts = text.split(":");
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join(":").trim();
            if (key && value) {
              specs[key] = value;
            }
          }
        });
      }

      return Object.keys(specs).length > 0 ? specs : null;
    }, specificationSelectors);
  } catch (error) {
    console.warn(`⚠️ Error al extraer especificaciones: ${error.message}`);
    return null;
  }
};

// Función para obtener selectores específicos según el sitio
function getSiteSelectors(site) {
  const defaultSelectors = {
    title: ".product_title, .entry-title, h1",
    image:
      ".woocommerce-product-gallery img, .product-images img, img.wp-post-image",
    priceSelectors: [
      ".woocommerce-Price-amount",
      "p.price",
      ".price",
      ".product-price",
    ],
    stockSelectors: [
      ".stock",
      ".availability",
      ".product-stock",
      ".inventory_status",
    ],
    descriptionSelectors: [
      ".woocommerce-product-details__short-description",
      ".description",
      "#tab-description",
      ".product-description",
    ],
    specificationSelectors: {
      tables: [
        ".woocommerce-product-attributes",
        ".shop_attributes",
        ".specifications-table",
      ],
      lists: [".specifications li", ".product-attributes li"],
    },
  };

  switch (site) {
    case "ortotek":
      return {
        ...defaultSelectors,
        // Selectores específicos para ortotek
        priceSelectors: [
          // Selectores específicos para la estructura de precio de Ortotek
          "p.price span.woocommerce-Price-amount.amount bdi",
          "span.woocommerce-Price-amount.amount bdi",
          ".woocommerce-Price-amount.amount bdi",
          // Selectores para el símbolo de moneda (para extraer el valor del nodo hermano)
          "span.woocommerce-Price-currencySymbol",
          // Selectores originales
          "span.woocommerce-Price-currencySymbol + span",
          "span.woocommerce-Price-amount.amount > bdi > span",
          "span.woocommerce-Price-amount.amount > span",
          "span.woocommerce-Price-amount.amount",
          ".product-grid-item span.woocommerce-Price-amount bdi span",
          ".product-grid-item span.woocommerce-Price-amount bdi",
          ".product-grid-item span.woocommerce-Price-amount",
          // Selectores generales
          "p.price",
          ".price",
          ".woocommerce-Price-amount",
        ],
      };

    case "denteeth":
      return {
        ...defaultSelectors,
        // Añadir o sobrescribir selectores específicos para denteeth
        title: ".product_title, h1.entry-title",
        priceSelectors: [
          "p.price .woocommerce-Price-amount bdi",
          "p.price .woocommerce-Price-amount",
          ".woocommerce-Price-amount bdi",
          ".woocommerce-Price-amount",
          ".price bdi",
          "p.price",
          ".price",
        ],
      };

    case "gacchile":
      return {
        ...defaultSelectors,
        // Añadir o sobrescribir selectores específicos para gacchile
        title:
          ".product_title, h1.entry-title, .product-name h1, h1.product_title",
        priceSelectors: [
          // Selectores específicos para la estructura de precio de GAC
          "p.price span.woocommerce-Price-amount.amount bdi",
          "span.woocommerce-Price-amount.amount bdi",
          ".woocommerce-Price-amount.amount bdi",
          // Selectores para el símbolo de moneda (para extraer el valor del nodo hermano)
          "span.woocommerce-Price-currencySymbol",
          // Selectores generales
          "p.price",
          ".price",
          ".woocommerce-Price-amount",
          ".summary .price .woocommerce-Price-amount",
          ".summary p.price",
          ".product-content .woocommerce-Price-amount",
          ".single-product-info-wrapper .woocommerce-Price-amount",
        ],
      };

    case "damus":
      return {
        // Selectores específicos para Damus (JumpSeller)
        title: "h1.page-header, h1.text-left, div.brand, .form-group h1",
        image:
          ".product-image img, .product-information img, .carousel-inner img",
        sku: "#product-sku, .product-sku, [id*='sku'], div.sku",
        priceSelectors: [
          "span.product-form-price",
          ".product-form-price",
          "#product-form-price",
          ".form-price_desktop",
          ".form-price_desktop span",
          ".price",
          "[id*='product-form-price']",
          ".form-price",
          "[class*='price']",
        ],
        stockSelectors: [
          "#stock",
          ".stock",
          ".form-control-label",
          ".availability",
          "[for='stock']",
          "[id*='stock']",
          "[class*='stock']",
          ".product-stock",
          ".product-out-stock",
          ".product-unavailable",
          "div.form-group.product-stock",
        ],
        descriptionSelectors: [
          ".form-group.description",
          "#description",
          ".product-description",
          ".description",
          "[id*='description']",
          "div.form-group.description",
        ],
        specificationSelectors: {
          tables: [
            ".product-specs table",
            ".specs-table",
            ".specifications table",
            "table.specs",
          ],
          lists: [
            ".product-specs li",
            ".specifications li",
            ".product-details li",
            ".specs li",
          ],
        },
      };

    default:
      return defaultSelectors;
  }
}

// Función para guardar los resultados
const saveResults = (products) => {
  // Crear directorio para resultados si no existe
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir);
  }

  // Guardar todos los productos en un archivo
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(CONFIG.outputDir, `all_products_${timestamp}.json`),
    JSON.stringify(products, null, 2)
  );

  // Guardar productos por sitio
  const siteGroups = {};
  for (const product of products) {
    if (!siteGroups[product.site]) {
      siteGroups[product.site] = [];
    }
    siteGroups[product.site].push(product);
  }

  // Guardar archivos por sitio
  for (const site in siteGroups) {
    fs.writeFileSync(
      path.join(CONFIG.outputDir, `${site}_products_${timestamp}.json`),
      JSON.stringify(siteGroups[site], null, 2)
    );
    console.log(`✅ Guardados ${siteGroups[site].length} productos de ${site}`);
  }
};

// Función principal
const runScraper = async () => {
  try {
    let allProductUrls = [];

    // Obtener URLs de productos de todos los sitemaps
    for (const sitemap of SITEMAPS) {
      const urls = await getProductUrlsFromSitemap(sitemap);
      allProductUrls = allProductUrls.concat(urls);
      console.log(`📊 Encontrados ${urls.length} productos en ${sitemap.site}`);
    }

    console.log(`📦 Total de productos encontrados: ${allProductUrls.length}`);

    // Para pruebas, limitar el número de productos a scrapear
    if (CONFIG.testMode) {
      console.log(
        `🧪 Modo de prueba activado: Limitando a ${CONFIG.testProductLimit} productos por sitio`
      );

      // Agrupar por sitio para tomar muestras equilibradas
      const urlsBySite = {};
      for (const urlInfo of allProductUrls) {
        if (!urlsBySite[urlInfo.site]) {
          urlsBySite[urlInfo.site] = [];
        }
        urlsBySite[urlInfo.site].push(urlInfo);
      }

      // Tomar muestra limitada de cada sitio
      allProductUrls = [];
      for (const site in urlsBySite) {
        const siteSample = urlsBySite[site].slice(0, CONFIG.testProductLimit);
        allProductUrls = allProductUrls.concat(siteSample);
      }

      console.log(
        `🧪 Total de productos en modo prueba: ${allProductUrls.length}`
      );
    }

    // Scrapear productos
    const products = await scrapeProductData(allProductUrls);

    // Guardar resultados
    saveResults(products);

    console.log(
      `✅ Scraping completado. Datos guardados en directorio ${CONFIG.outputDir}`
    );

    // Estadísticas finales
    const successCount = products.filter((p) => !p.error).length;
    const errorCount = products.filter((p) => p.error).length;
    console.log(
      `📊 Estadísticas: ${successCount} productos scrapeados exitosamente, ${errorCount} con errores.`
    );
  } catch (error) {
    console.error(`❌ Error en el proceso de scraping: ${error.message}`);
  }
};

runScraper();
