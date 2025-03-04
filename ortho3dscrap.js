import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// Configuration
const CONFIG = {
  categories: [
    {
      name: "ortodoncia",
      url: "https://ortho3.cl/1000-ortodoncia",
      subcategories: [
        { name: "brackets", pattern: /\/brackets\// },
        { name: "brackets-ceramicos", pattern: /\/ceramicos\// },
      ],
    },
    {
      name: "alineadores",
      url: "https://ortho3.cl/2990-alineador",
      subcategories: [],
    },
  ],
  scraping: {
    concurrency: 2,
    rateLimit: 2000,
    timeout: 45000,
    retries: 3,
    testMode: true, // Set to false for full scraping
    productsPerCategory: 5, // Number of products to scrape in test mode
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
  },
  selectors: {
    listing: {
      productCard: ".js-product-miniature-wrapper, .product-miniature",
      productLink: ".product-title a",
      productPrice: ".product-price-and-shipping .price, .product-price",
      productImage: ".product-thumbnail img",
      outOfStock:
        ".product-unavailable, .out-of-stock, .product-flags .product-flag.out_of_stock",
    },
    product: {
      price: [
        ".product-price[content]",
        ".current-price-value[content]",
        "[itemprop='price'][content]",
        ".current-price",
        ".product-price",
      ],
      sku: [
        "[itemprop='sku']",
        ".product-reference span",
        "*[id*='product-reference'] span",
      ],
      description: ".product-description, [id*='product-description']",
      manufacturer:
        "[itemprop='brand'] [itemprop='name'], .product-manufacturer a",
      availability: ".product-unavailable, .out-of-stock, .badge-danger",
      breadcrumbs: ".breadcrumb-item",
    },
  },
};

// Utility functions
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = {
  info: (msg) => console.log(`ℹ️ ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  warning: (msg) => console.log(`⚠️ ${msg}`),
  error: (msg, error) => console.error(`❌ ${msg}`, error?.message || ""),
};

// Retry mechanism
async function withRetry(fn, retries = CONFIG.scraping.retries) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      log.warning(
        `Attempt ${i + 1} failed, retrying in ${CONFIG.scraping.rateLimit}ms...`
      );
      await sleep(CONFIG.scraping.rateLimit);
    }
  }
}

// Function to scrape products from category pages
async function scrapeCategory(category, browser) {
  log.info(`Scraping category: ${category.name}`);

  const page = await browser.newPage();
  let products = [];

  try {
    // Navigate to category page with retry
    await withRetry(async () => {
      await page.goto(
        `${category.url}${
          CONFIG.scraping.testMode
            ? "?resultsPerPage=5"
            : "?resultsPerPage=99999"
        }`,
        {
          waitUntil: "networkidle",
          timeout: CONFIG.scraping.timeout,
        }
      );
    });

    // Wait for products to load
    await page
      .waitForSelector(CONFIG.selectors.listing.productCard, {
        timeout: CONFIG.scraping.timeout,
      })
      .catch(() => {
        log.warning(`No products found in ${category.name}`);
        return [];
      });

    // Extract basic product data
    products = await page.evaluate((config) => {
      return Array.from(
        document.querySelectorAll(config.selectors.listing.productCard)
      ).map((el) => ({
        name:
          el
            .querySelector(config.selectors.listing.productLink)
            ?.innerText.trim() || "Unknown",
        price:
          el
            .querySelector(config.selectors.listing.productPrice)
            ?.innerText.trim() || "No price",
        image:
          el.querySelector(config.selectors.listing.productImage)?.src ||
          "No image",
        link:
          el.querySelector(config.selectors.listing.productLink)?.href ||
          "No link",
        mainCategory: config.categories[0].name,
        category: config.categories[0].name,
        available: !el.querySelector(config.selectors.listing.outOfStock),
        sku:
          el.querySelector(".product-reference span")?.innerText.trim() || "",
      }));
    }, CONFIG);

    // Limit products in test mode
    if (CONFIG.scraping.testMode) {
      products = products.slice(0, CONFIG.scraping.productsPerCategory);
    }

    // Enrich products with details
    const enrichedProducts = [];
    for (const product of products) {
      try {
        log.info(`Processing: ${product.name}`);
        const enrichedProduct = await scrapeProductDetails(
          page,
          product,
          category
        );
        enrichedProducts.push(enrichedProduct);
        log.success(`Processed: ${product.name}`);

        // Rate limiting between products
        await sleep(CONFIG.scraping.rateLimit);
      } catch (error) {
        log.error(`Failed to process ${product.name}`, error);
        enrichedProducts.push({
          ...product,
          error: error.message,
        });
      }
    }

    log.success(
      `Found ${enrichedProducts.length} products in ${category.name}`
    );
    return enrichedProducts;
  } catch (error) {
    log.error(`Error scraping ${category.name}`, error);
    return products;
  } finally {
    await page.close();
  }
}

// Function to scrape individual product details
async function scrapeProductDetails(page, product, category) {
  return await withRetry(async () => {
    await page.goto(product.link, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.scraping.timeout,
    });

    // Determine subcategory
    let detectedSubcategory = product.category;
    for (const subcat of category.subcategories) {
      if (subcat.pattern.test(product.link)) {
        detectedSubcategory = subcat.name;
        break;
      }
    }

    const details = await page.evaluate((config) => {
      const getPrice = () => {
        for (const selector of config.selectors.product.price) {
          const el = document.querySelector(selector);
          if (el) {
            if (selector.includes("[content]")) {
              const content = el.getAttribute("content");
              if (content) return `$ ${content}`;
            }
            return el.innerText.trim();
          }
        }
        return "No price";
      };

      const getSku = () => {
        for (const selector of config.selectors.product.sku) {
          const el = document.querySelector(selector);
          if (el) {
            if (selector === "[itemprop='sku']") {
              const content = el.getAttribute("content");
              if (content) return content;
            }
            return el.innerText.trim();
          }
        }
        return "";
      };

      return {
        price: getPrice(),
        sku: getSku(),
        manufacturer:
          document
            .querySelector(config.selectors.product.manufacturer)
            ?.innerText.trim() || "Unknown",
        description:
          document
            .querySelector(config.selectors.product.description)
            ?.innerText.trim() || "",
        available: !document.querySelector(
          config.selectors.product.availability
        ),
        breadcrumbs: Array.from(
          document.querySelectorAll(config.selectors.product.breadcrumbs)
        ).map((item) => item.textContent.trim()),
      };
    }, CONFIG);

    return {
      ...product,
      ...details,
      category: detectedSubcategory,
    };
  });
}

// Main scraping function
async function scrapeAll() {
  const startTime = Date.now();
  let totalProducts = 0;
  let successCount = 0;
  let errorCount = 0;

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const resultsDir = path.join("results", timestamp);
    fs.mkdirSync(resultsDir, { recursive: true });

    log.info(
      `Starting scraper${CONFIG.scraping.testMode ? " in TEST MODE" : ""}`
    );

    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: CONFIG.scraping.userAgent,
      viewport: { width: 1920, height: 1080 },
    });

    for (const category of CONFIG.categories) {
      const products = await scrapeCategory(category, context);

      // Save category results
      fs.writeFileSync(
        path.join(resultsDir, `${category.name}.json`),
        JSON.stringify(products, null, 2)
      );

      totalProducts += products.length;
      successCount += products.filter((p) => !p.error).length;
      errorCount += products.filter((p) => p.error).length;
    }

    // Save scraping report
    const report = {
      timestamp,
      duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
      mode: CONFIG.scraping.testMode ? "TEST" : "FULL",
      totalProducts,
      successCount,
      errorCount,
      successRate: `${((successCount / totalProducts) * 100).toFixed(2)}%`,
    };

    fs.writeFileSync(
      path.join(resultsDir, "scraping_report.json"),
      JSON.stringify(report, null, 2)
    );

    log.success(`Scraping complete. Results saved in results/${timestamp}/`);
    log.info(`Summary: ${successCount} successful, ${errorCount} failed`);

    await browser.close();
  } catch (error) {
    log.error("Fatal error in scraping process", error);
  }
}

// Run the scraper
scrapeAll();
