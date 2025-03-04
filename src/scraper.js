import fs from "fs";
import { chromium } from "playwright";
import axios from "axios";
import xml2js from "xml2js";
import path from "path";
import { setTimeout } from "timers/promises";
import dotenv from "dotenv";
import DataProcessor from "./db/dataProcessor.js";

// Load environment variables
dotenv.config();

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

// Add utility classes for resource management
class ResourceMonitor {
  static async checkSystemResources() {
    const os = require("os");
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const memoryUsage = (totalMem - freeMem) / totalMem;

    if (memoryUsage > 0.8) {
      console.warn(
        "⚠️ Alta utilización de memoria detectada:",
        (memoryUsage * 100).toFixed(1) + "%"
      );
      return false;
    }

    const cpuUsage = os.loadavg()[0];
    if (cpuUsage > os.cpus().length * 0.8) {
      console.warn(
        "⚠️ Alta utilización de CPU detectada:",
        cpuUsage.toFixed(1)
      );
      return false;
    }

    return true;
  }
}

class AdaptiveConcurrency {
  constructor(initialConcurrent = 4, maxConcurrent = 8) {
    this.currentConcurrent = initialConcurrent;
    this.maxConcurrent = maxConcurrent;
    this.errorCount = 0;
    this.successCount = 0;
    this.lastAdjustment = Date.now();
  }

  async adjust() {
    const now = Date.now();
    if (now - this.lastAdjustment < 30000) return;

    const resourcesOK = await ResourceMonitor.checkSystemResources();

    if (!resourcesOK || this.errorCount > 5) {
      this.currentConcurrent = Math.max(2, this.currentConcurrent - 1);
      this.errorCount = 0;
      console.log(`🔽 Reduciendo concurrencia a ${this.currentConcurrent}`);
    } else if (this.errorCount === 0 && this.successCount > 10 && resourcesOK) {
      this.currentConcurrent = Math.min(
        this.maxConcurrent,
        this.currentConcurrent + 1
      );
      console.log(`🔼 Aumentando concurrencia a ${this.currentConcurrent}`);
    }

    this.successCount = 0;
    this.lastAdjustment = now;
  }

  recordError() {
    this.errorCount++;
    this.adjust();
  }

  recordSuccess() {
    this.successCount++;
    this.adjust();
  }

  getCurrentLimit() {
    return this.currentConcurrent;
  }
}

class RequestQueue {
  constructor(adaptiveConcurrency) {
    this.queue = [];
    this.running = 0;
    this.adaptiveConcurrency = adaptiveConcurrency;
  }

  async add(task) {
    if (this.running >= this.adaptiveConcurrency.getCurrentLimit()) {
      await new Promise((resolve) => this.queue.push(resolve));
    }

    this.running++;
    try {
      const result = await task();
      this.adaptiveConcurrency.recordSuccess();
      return result;
    } catch (error) {
      this.adaptiveConcurrency.recordError();
      throw error;
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

// Configuration from environment variables
const CONFIG = {
  concurrentBrowsers: parseInt(process.env.MAX_CONCURRENT_SCRAPES) || 4,
  requestDelay: parseInt(process.env.REQUEST_DELAY) || 1000,
  timeout: 30000,
  maxRetries: 3,
  testMode: process.env.TEST_MODE === "true",
  testProductLimit: parseInt(process.env.TEST_PRODUCT_LIMIT) || 10,
  outputDir: "scraper_results",
  adaptiveConcurrency: new AdaptiveConcurrency(4, 8),
};

// Main scraping function
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

    // Dividir URLs por dominio para manejar concurrencia por sitio
    const urlsByDomain = {};
    for (const urlInfo of allProductUrls) {
      const domain = new URL(urlInfo.url).hostname;
      if (!urlsByDomain[domain]) {
        urlsByDomain[domain] = [];
      }
      urlsByDomain[domain].push(urlInfo);
    }

    // Process each domain
    for (const [domain, urls] of Object.entries(urlsByDomain)) {
      console.log(`🔄 Processing ${urls.length} products from ${domain}`);
      const siteId = urls[0].site;

      try {
        const results = await scrapeProductsForDomain(urls);
        let successCount = 0;
        let errorCount = 0;
        let errorDetails = [];

        // Process and store each product
        for (const product of results) {
          try {
            if (product.error) {
              errorCount++;
              errorDetails.push({
                url: product.link,
                error: product.error,
              });
              continue;
            }

            await DataProcessor.processAndStoreProduct(product);
            successCount++;
          } catch (error) {
            errorCount++;
            errorDetails.push({
              url: product.link,
              error: error.message,
            });
          }
        }

        // Record scraping results
        await DataProcessor.recordScrapingLog(
          siteId,
          "completed",
          successCount,
          errorCount,
          errorDetails.length > 0 ? { errors: errorDetails } : null
        );
      } catch (error) {
        console.error(`❌ Error processing domain ${domain}:`, error);
        await DataProcessor.recordScrapingLog(
          siteId,
          "failed",
          0,
          urls.length,
          { error: error.message }
        );
      }
    }

    console.log("✅ Scraping completed successfully");
  } catch (error) {
    console.error("❌ Fatal error in scraping process:", error);
  }
};

// Export the main function
export default runScraper;

// Función para obtener las URLs de productos desde el sitemap
const getProductUrlsFromSitemap = async (sitemapInfo) => {
  try {
    console.log(
      `🌐 Procesando sitemap de ${sitemapInfo.site}: ${sitemapInfo.url}`
    );
    const response = await axios.get(sitemapInfo.url);
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    if (
      sitemapInfo.url.includes("wp-sitemap.xml") &&
      !sitemapInfo.url.includes("product")
    ) {
      console.log(
        `📋 Procesando índice de sitemap para ${sitemapInfo.site}...`
      );
      return await processIndexSitemap(result, sitemapInfo, parser);
    } else if (sitemapInfo.platform === "jumpseller") {
      return await processJumpSellerSitemap(result, sitemapInfo);
    } else {
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
    const filteredUrls = result.urlset.url.filter((item) => {
      const url = item.loc[0];
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
    for (const item of result.urlset.url) {
      const url = item.loc[0];

      if (
        url === `https://www.${sitemapInfo.site}.cl` ||
        url === `https://www.${sitemapInfo.site}.cl/` ||
        url.includes("/contact") ||
        url.includes("/tienda") ||
        url.endsWith(".cl/acero") ||
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

      const urlPath = new URL(url).pathname;
      const pathSegments = urlPath
        .split("/")
        .filter((segment) => segment.length > 0);

      const isLikelyProductUrl =
        pathSegments.length >= 2 || urlPath.includes("-") || /\d/.test(urlPath);

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
        const hasAddToCartButton = !!document.querySelector(
          'button[name="add-to-cart"], .single_add_to_cart_button, .add_to_cart_button, #add-to-cart, .btn-add_to_cart, [id*="add-to-cart"], [class*="add-to-cart"], form[action*="/cart/add/"]'
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

        const hasJumpSellerProductForm = !!document.querySelector(
          'form[id*="product-form"], form[action*="/cart/add/"], div[id*="product-sku"], .form-group.description'
        );

        const hasWooCommerceProductElements = !!document.querySelector(
          ".woocommerce-product-gallery, .product_meta, .woocommerce-tabs, .related.products"
        );

        const hasStockInfo = !!document.querySelector(
          '.stock, [class*="stock"], [id*="stock"], .product-stock, .product-out-stock, .product-unavailable'
        );

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

        const hasProductForm = !!document.querySelector(
          'form[id*="product-form"], form[action*="/cart/add/"]'
        );

        const hasSku = !!document.querySelector(
          '#product-sku, .product-sku, [id*="sku"]'
        );

        const isOrtotekProduct =
          window.location.href.includes("/product/") &&
          (window.location.href.includes("bracket") ||
            window.location.href.includes("kit") ||
            window.location.href.includes("ortodoncia"));

        let score = 0;
        if (hasAddToCartButton) score += 2;
        if (hasPriceElement) score += 2;
        if (hasProductTitle) score++;
        if (hasProductGallery) score++;
        if (hasJumpSellerProductForm) score += 2;
        if (hasWooCommerceProductElements) score += 2;
        if (hasStockInfo) score++;
        if (hasProductTerms) score++;
        if (hasProductForm) score += 2;
        if (hasSku) score += 2;
        if (isOrtotekProduct) score += 3;

        const htmlSource = document.documentElement.outerHTML;
        if (
          htmlSource.includes("<!-- Out of Stock -->") ||
          htmlSource.includes("<!-- Not Available -->")
        ) {
          score += 2;
        }

        const cartForms = document.querySelectorAll(
          'form[method="post"][action*="/cart/add/"]'
        );
        if (cartForms.length > 0) {
          score += 3;
        }

        if (
          window.location.pathname.includes("/product/") ||
          window.location.pathname.includes("/producto/") ||
          window.location.pathname.match(/\/[a-z0-9-]+\/[a-z0-9-]+\/?$/)
        ) {
          score += 2;
        }

        return score >= 3;
      } catch (error) {
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

    if (i > 0) {
      await setTimeout(CONFIG.requestDelay);
    }

    let retryCount = 0;
    let success = false;

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
      continue;
    }

    while (!success && retryCount <= CONFIG.maxRetries) {
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: CONFIG.timeout,
        });

        await page.waitForTimeout(2000);

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
          await setTimeout(2000 * retryCount);
        }
      }
    }
  }

  await browser.close();
  return results;
};

// Función para extraer datos de productos WooCommerce
const extractWooCommerceProductData = async (page, url, site) => {
  const selectors = getSiteSelectors(site);

  let name = "";
  try {
    name = await page.evaluate((titleSelector) => {
      const titleEl = document.querySelector(titleSelector);
      if (titleEl) return titleEl.innerText.trim();
      const h1El = document.querySelector("h1");
      if (h1El) return h1El.innerText.trim();
      return document.title.split(" - ")[0].trim();
    }, selectors.title);
  } catch (titleError) {
    console.warn(`⚠️ No se pudo obtener el título: ${titleError.message}`);
    const urlParts = url.split("/");
    const lastPart =
      urlParts[urlParts.length - 2] === "producto" ||
      urlParts[urlParts.length - 2] === "product"
        ? urlParts[urlParts.length - 1]
        : urlParts[urlParts.length - 2];
    name = lastPart.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }

  let image = "";
  try {
    image = await page.evaluate((imgSelector) => {
      const imgEl = document.querySelector(imgSelector);
      return imgEl ? imgEl.src : "";
    }, selectors.image);
  } catch (imgError) {
    console.warn(`⚠️ No se pudo obtener la imagen: ${imgError.message}`);
  }

  const stockInfo = await extractStockInfo(page, selectors.stockSelectors);
  let price = await extractPrice(page, selectors.priceSelectors, site);

  if (
    (stockInfo.status.toLowerCase().includes("agotado") ||
      stockInfo.status.toLowerCase().includes("sin stock") ||
      stockInfo.status.toLowerCase().includes("no disponible")) &&
    price === "$0"
  ) {
    price = "No disponible (Agotado)";
  }

  let description = await extractProductDescription(
    page,
    selectors.descriptionSelectors
  );

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
    url: url,
    image,
    site,
    platform: "woocommerce",
    description,
    specifications,
    timestamp: new Date().toISOString(),
  };
};

// Función para extraer datos de productos JumpSeller
const extractJumpSellerProductData = async (page, url, site) => {
  const selectors = getSiteSelectors(site);

  let name = "";
  try {
    name = await page.evaluate((titleSelector) => {
      const titleEl = document.querySelector(titleSelector);
      if (titleEl) return titleEl.innerText.trim();
      const h1El = document.querySelector("h1");
      if (h1El) return h1El.innerText.trim();
      const pageHeaderEl = document.querySelector(".page-header");
      if (pageHeaderEl) return pageHeaderEl.innerText.trim();
      const brandEl = document.querySelector(".brand");
      if (brandEl) return brandEl.innerText.trim();
      return document.title.replace(" - Damus", "").trim();
    }, selectors.title);
  } catch (titleError) {
    console.warn(`⚠️ No se pudo obtener el título: ${titleError.message}`);
    const urlParts = url.split("/");
    name = urlParts[urlParts.length - 1]
      .replace(/-/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  let image = "";
  try {
    image = await page.evaluate((imgSelector) => {
      const imgEl = document.querySelector(imgSelector);
      return imgEl ? imgEl.src : "";
    }, selectors.image);
  } catch (imgError) {
    console.warn(`⚠️ No se pudo obtener la imagen: ${imgError.message}`);
  }

  const stockInfo = await extractStockInfo(page, selectors.stockSelectors);
  let price = await extractPrice(page, selectors.priceSelectors, site);

  if (
    (stockInfo.status.toLowerCase().includes("agotado") ||
      stockInfo.status.toLowerCase().includes("sin stock") ||
      stockInfo.status.toLowerCase().includes("no disponible")) &&
    price === "$0"
  ) {
    price = "No disponible (Agotado)";
  }

  let sku = "";
  try {
    sku = await page.evaluate((skuSelector) => {
      const skuEl = document.querySelector(skuSelector);
      return skuEl ? skuEl.textContent.trim().replace("SKU:", "").trim() : "";
    }, selectors.sku);
  } catch (skuError) {}

  let description = await extractProductDescription(
    page,
    selectors.descriptionSelectors
  );

  let specifications = await extractSpecifications(
    page,
    selectors.specificationSelectors
  );

  let brand = "";
  try {
    brand = await page.evaluate(() => {
      const brandEl = document.querySelector(".brand");
      if (brandEl) return brandEl.textContent.trim();
      const brandTexts = document.body.textContent.match(/Marca:\s*([^\n]*)/);
      return brandTexts ? brandTexts[1].trim() : "";
    });
  } catch (brandError) {}

  let presentation = "";
  try {
    presentation = await page.evaluate(() => {
      const presentationTexts = document.body.textContent.match(
        /Presentacion:\s*([^\n]*)/
      );
      return presentationTexts ? presentationTexts[1].trim() : "";
    });
  } catch (error) {}

  return {
    name,
    price,
    stock: stockInfo.status,
    quantity: stockInfo.quantity,
    link: url,
    url: url,
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
    let cleaned = priceText.trim();
    if (cleaned.includes("\n")) {
      cleaned = cleaned.split("\n")[0].trim();
    }
    cleaned = cleaned.replace("Precio web:", "").replace("Precio:", "").trim();
    if (!cleaned.includes("$")) {
      cleaned = "$" + cleaned;
    }
    cleaned = cleaned.replace(/\$\s+/, "$");
    return cleaned;
  } catch (error) {
    console.error("Error al limpiar el precio:", error);
    return priceText || "";
  }
}

// Función para extraer el precio
async function extractPrice(page, selectors, domain) {
  try {
    if (domain === "damus") {
      const damusprice = await page.evaluate(() => {
        const priceElement = document.querySelector(
          ".product-form-price, #product-form-price, .form-price_desktop"
        );
        return priceElement ? priceElement.textContent.trim() : null;
      });

      if (damusprice) {
        return cleanPrice(damusprice);
      }
    }

    if (domain === "gacchile" || domain === "ortotek") {
      try {
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

    for (const selector of selectors) {
      try {
        const elementExists = await page.evaluate((sel) => {
          return document.querySelector(sel) !== null;
        }, selector);

        if (!elementExists) continue;

        if (
          (domain === "gacchile" || domain === "ortotek") &&
          selector.includes("currencySymbol")
        ) {
          const priceText = await page.evaluate((sel) => {
            const currencyElement = document.querySelector(sel);
            if (!currencyElement) return null;

            let priceValue = "";
            const parentElement = currencyElement.parentElement;
            if (
              parentElement &&
              parentElement.tagName.toLowerCase() === "bdi"
            ) {
              const fullText = parentElement.textContent.trim();
              const match = fullText.match(/\$\s*([0-9.,]+)/);
              if (match && match[1]) {
                return "$" + match[1];
              }
            }

            let nextSibling = currencyElement.nextSibling;
            if (
              nextSibling &&
              nextSibling.nodeType === 3 &&
              nextSibling.textContent.trim()
            ) {
              priceValue = nextSibling.textContent.trim();
              return "$" + priceValue;
            }

            if (currencyElement.parentElement) {
              const parentText =
                currencyElement.parentElement.textContent.trim();
              const match = parentText.match(/\$\s*([0-9.,]+)/);
              if (match && match[1]) {
                return "$" + match[1];
              }
            }

            return currencyElement.textContent;
          }, selector);

          if (priceText && priceText !== "$") {
            return cleanPrice(priceText);
          }
        }

        const priceText = await page.evaluate((sel) => {
          const element = document.querySelector(sel);
          return element ? element.textContent.trim() : null;
        }, selector);

        if (priceText) {
          if (
            (domain === "gacchile" || domain === "ortotek") &&
            priceText === "$"
          ) {
            continue;
          }
          return cleanPrice(priceText);
        }
      } catch (error) {
        console.error(
          `Error al extraer precio con selector ${selector}:`,
          error
        );
      }
    }

    try {
      const priceText = await page.evaluate(() => {
        const priceElements = Array.from(
          document.querySelectorAll(
            ".price, .woocommerce-Price-amount, .product-form-price, #product-form-price, .form-price_desktop"
          )
        ).filter((el) => {
          const text = el.textContent.trim();
          return text.includes("$") && /\$\s*[0-9.,]+/.test(text);
        });

        if (priceElements.length > 0) {
          priceElements.sort(
            (a, b) => a.textContent.length - b.textContent.length
          );
          return priceElements[0].textContent.trim();
        }

        return null;
      });

      if (priceText) {
        return cleanPrice(priceText);
      }
    } catch (error) {
      console.error(
        "Error en estrategia general de extracción de precio:",
        error
      );
    }

    return "$0";
  } catch (error) {
    console.error("Error en extractPrice:", error);
    return "$0";
  }
}

// Función para extraer información de stock
const extractStockInfo = async (page, stockSelectors) => {
  try {
    return await page.evaluate((stockSelectors) => {
      let status = "Desconocido";
      let quantity = null;

      const damusStockElement = document.querySelector(
        ".form-group.product-stock"
      );
      if (damusStockElement) {
        const stockLabel = damusStockElement.querySelector(
          ".form-control-label"
        );
        if (stockLabel) {
          status = stockLabel.textContent.trim();
          return { status, quantity: null };
        }
      }

      for (const selector of stockSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          status = el.textContent.trim();

          const quantityMatch = status.match(/\b\d{1,4}\b/);
          if (quantityMatch) {
            const parsedQuantity = parseInt(quantityMatch[0], 10);
            if (parsedQuantity >= 0 && parsedQuantity < 10000) {
              quantity = parsedQuantity;
            }
          }
          break;
        }
      }

      const addToCartButton = document.querySelector(
        '.single_add_to_cart_button, .add_to_cart_button, [name="add-to-cart"], #add-to-cart, .btn-add-to-cart'
      );
      if (addToCartButton && addToCartButton.disabled) {
        status = "Agotado";
      }

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

      for (const text of stockTexts.agotado) {
        if (document.body.textContent.includes(text)) {
          status = "Agotado";
          quantity = null;
          break;
        }
      }

      for (const text of stockTexts.disponible) {
        if (document.body.textContent.includes(text)) {
          const availabilitySection = Array.from(
            document.querySelectorAll("*")
          ).find((el) => el.textContent.includes(text));

          if (availabilitySection) {
            const quantityText = availabilitySection.textContent;
            const quantityMatch = quantityText.match(/\b\d{1,4}\b/);
            if (quantityMatch) {
              const parsedQuantity = parseInt(quantityMatch[0], 10);
              if (parsedQuantity >= 0 && parsedQuantity < 10000) {
                quantity = parsedQuantity;
              }
            }
            status = "En stock";
          } else {
            status = "En stock";
          }
          break;
        }
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

// Función para extraer descripción del producto
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

// Función para extraer especificaciones técnicas
const extractSpecifications = async (page, specificationSelectors) => {
  try {
    return await page.evaluate((selectors) => {
      const specs = {};

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
        priceSelectors: [
          "p.price span.woocommerce-Price-amount.amount bdi",
          "span.woocommerce-Price-amount.amount bdi",
          ".woocommerce-Price-amount.amount bdi",
          "span.woocommerce-Price-currencySymbol",
          "span.woocommerce-Price-currencySymbol + span",
          "span.woocommerce-Price-amount.amount > bdi > span",
          "span.woocommerce-Price-amount.amount > span",
          "span.woocommerce-Price-amount.amount",
          ".product-grid-item span.woocommerce-Price-amount bdi span",
          ".product-grid-item span.woocommerce-Price-amount bdi",
          ".product-grid-item span.woocommerce-Price-amount",
          "p.price",
          ".price",
          ".woocommerce-Price-amount",
        ],
      };

    case "denteeth":
      return {
        ...defaultSelectors,
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
        title:
          ".product_title, h1.entry-title, .product-name h1, h1.product_title",
        priceSelectors: [
          "p.price span.woocommerce-Price-amount.amount bdi",
          "span.woocommerce-Price-amount.amount bdi",
          ".woocommerce-Price-amount.amount bdi",
          "span.woocommerce-Price-currencySymbol",
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

runScraper();
