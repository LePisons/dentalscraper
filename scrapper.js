import fs from "fs";
import { chromium } from "playwright";
import axios from "axios";
import xml2js from "xml2js";
import path from "path";

// Lista de sitemaps para diferentes sitios
const SITEMAPS = [
  {
    url: "https://www.ortotek.cl/product-sitemap.xml",
    site: "ortotek",
  },
  {
    url: "https://www.denteeth.cl/wp-sitemap.xml",
    site: "denteeth",
  },
  {
    url: "https://gacchile.cl/wp-sitemap-posts-product-1.xml",
    site: "gacchile",
  },
  {
    url: "https://www.damus.cl/sitemap_1.xml",
    site: "damus",
  },
];

// Función para obtener las URLs de productos desde el sitemap
const getProductUrlsFromSitemap = async (sitemapInfo) => {
  try {
    const response = await axios.get(sitemapInfo.url);
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(response.data);

    // Diferentes sitios pueden tener estructuras de sitemap diferentes
    if (
      sitemapInfo.url.includes("wp-sitemap.xml") &&
      !sitemapInfo.url.includes("product")
    ) {
      // Para sitemaps como denteeth que tienen un índice de sitemaps
      console.log(
        `📋 Procesando índice de sitemap para ${sitemapInfo.site}...`
      );

      // Extraer URLs de submaps que contienen productos
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
    } else {
      // Para sitemaps directos de productos
      if (result.urlset && result.urlset.url) {
        return result.urlset.url.map((item) => ({
          url: item.loc[0],
          site: sitemapInfo.site,
        }));
      }
      return [];
    }
  } catch (error) {
    console.error(
      `❌ Error obteniendo el sitemap de ${sitemapInfo.url}:`,
      error.message
    );
    return [];
  }
};

// Función para scrapear productos desde las URLs obtenidas
const scrapeProductData = async (urlInfos) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let results = [];

  for (const urlInfo of urlInfos) {
    const { url, site } = urlInfo;
    console.log(`🔍 Scrapeando producto de ${site}: ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

      // Configuración de selectores según el sitio
      const selectors = getSiteSelectors(site);

      // Extraer el nombre del producto
      await page.waitForSelector(selectors.title, { timeout: 10000 });
      const name = await page.$eval(selectors.title, (el) =>
        el.innerText.trim()
      );

      // Extraer la imagen del producto
      let image = "";
      try {
        image = await page.$eval(selectors.image, (el) => el.src);
      } catch (imgError) {
        console.warn(`⚠️ No se pudo obtener la imagen: ${imgError.message}`);
      }

      // Extraer el precio
      let price = "";
      try {
        price = await page.evaluate((priceSelectors) => {
          // Intentar cada selector de precio
          for (const selector of priceSelectors) {
            const el = document.querySelector(selector);
            if (el) {
              // Extraer solo el valor numérico y el símbolo de moneda
              let priceText = el.textContent.trim();
              // Si el texto contiene múltiples valores, tomamos el primero
              if (priceText.includes("\n")) {
                priceText = priceText.split("\n")[0].trim();
              }
              return priceText;
            }
          }

          // Buscar por texto de precio
          const priceTexts = ["Precio web:", "Precio:", "$"];
          for (const text of priceTexts) {
            const elements = Array.from(document.querySelectorAll("*"));
            const priceEl = elements.find((el) =>
              el.textContent.includes(text)
            );
            if (priceEl) {
              return priceEl.textContent
                .replace("Precio web:", "")
                .replace("Precio:", "")
                .trim();
            }
          }

          return "";
        }, selectors.priceSelectors);
      } catch (priceError) {
        console.warn(`⚠️ Error al extraer precio: ${priceError.message}`);
      }

      // Extraer información de stock
      let stockInfo = {
        status: "Desconocido",
        quantity: null,
      };

      try {
        stockInfo = await page.evaluate((stockSelectors) => {
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
            ".single_add_to_cart_button, .add_to_cart_button, [name='add-to-cart']"
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
            disponible: ["En stock", "Disponible", "In stock"],
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
              status = "En stock";
              break;
            }
          }

          // Si el producto tiene precio pero ninguna indicación de agotado, asumimos disponible
          if (
            status === "Desconocido" &&
            document.querySelector(".price, .woocommerce-Price-amount")
          ) {
            status = "En stock";
          }

          return { status, quantity };
        }, selectors.stockSelectors);
      } catch (stockError) {
        console.warn(
          `⚠️ Error al extraer información de stock: ${stockError.message}`
        );
      }

      results.push({
        name,
        price,
        stock: stockInfo.status,
        quantity: stockInfo.quantity,
        link: url,
        image,
        site,
      });
    } catch (error) {
      console.warn(
        `⚠️ No se pudo extraer información de: ${url}: ${error.message}`
      );

      // Agregar el producto con información mínima para saber que fue procesado
      results.push({
        name: "Error al extraer datos",
        price: "",
        stock: "Error",
        quantity: null,
        link: url,
        image: "",
        site,
        error: error.message,
      });
    }
  }

  await browser.close();
  return results;
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
  };

  switch (site) {
    case "ortotek":
      return {
        ...defaultSelectors,
        // Selectores específicos para ortotek si los hubiera
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
        title: ".product_title, h1.entry-title, .product-name h1",
      };

    default:
      return defaultSelectors;
  }
}

// Función principal
const runScraper = async () => {
  let allProductUrls = [];

  for (const sitemap of SITEMAPS) {
    console.log(`🌐 Procesando sitemap de ${sitemap.site}: ${sitemap.url}`);
    const urls = await getProductUrlsFromSitemap(sitemap);
    allProductUrls = allProductUrls.concat(urls);
    console.log(`📊 Encontrados ${urls.length} productos en ${sitemap.site}`);
  }

  console.log(`📦 Total de productos encontrados: ${allProductUrls.length}`);

  // Para pruebas, puedes limitar el número de productos a scrapear
  allProductUrls = allProductUrls.slice(0, 5);

  const products = await scrapeProductData(allProductUrls);

  // Guardar todos los productos en un archivo
  fs.writeFileSync("all_products.json", JSON.stringify(products, null, 2));

  // Guardar productos por sitio
  const siteGroups = {};
  for (const product of products) {
    if (!siteGroups[product.site]) {
      siteGroups[product.site] = [];
    }
    siteGroups[product.site].push(product);
  }

  // Crear directorio para resultados
  const resultsDir = "scraper_results";
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
  }

  // Guardar archivos por sitio
  for (const site in siteGroups) {
    fs.writeFileSync(
      path.join(resultsDir, `${site}_products.json`),
      JSON.stringify(siteGroups[site], null, 2)
    );
    console.log(`✅ Guardados ${siteGroups[site].length} productos de ${site}`);
  }

  console.log(
    `✅ Scraping completado. Datos guardados en directorio ${resultsDir}`
  );
};

runScraper();
