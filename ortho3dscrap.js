import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// Define main category URLs - corrected per your requirements
const CATEGORIES = [
  {
    name: "ortodoncia",
    url: "https://ortho3.cl/1000-ortodoncia?resultsPerPage=99999",
    // Define subcategories to track the detailed category hierarchy
    subcategories: [
      { name: "brackets", pattern: /\/brackets\// },
      { name: "brackets-ceramicos", pattern: /\/ceramicos\// },
      // Add other subcategories as needed
    ],
  },
  {
    name: "alineadores",
    url: "https://ortho3.cl/2990-alineador?resultsPerPage=99999",
    subcategories: [],
  },
];

// Function to scrape products from category pages
const scrapeCategory = async (category) => {
  console.log(`🔍 Scraping main category: ${category.name}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // Navigate to the category page
    await page.goto(category.url, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for products to load
    await page
      .waitForSelector(".js-product-miniature-wrapper, .product-miniature", {
        timeout: 10000,
      })
      .catch(() =>
        console.log(`⚠️ No product elements found in ${category.name}`)
      );

    // Extract basic product data from category page
    const products = await page.evaluate((category) => {
      return Array.from(
        document.querySelectorAll(
          ".js-product-miniature-wrapper, .product-miniature"
        )
      ).map((el) => {
        // Extract basic price info (will be enhanced later)
        let price = "No price";
        const priceElement = el.querySelector(
          ".product-price-and-shipping .price, .product-price"
        );

        if (priceElement) {
          price = priceElement.innerText.trim();
        }

        // Check if product is available
        const outOfStock = el.querySelector(
          ".product-unavailable, .out-of-stock, .product-flags .product-flag.out_of_stock"
        );
        const availability = !outOfStock;

        // Get SKU if available on listing page
        const sku =
          el.querySelector(".product-reference span")?.innerText.trim() || "";

        // Get product details
        const link = el.querySelector(".product-title a")?.href || "No link";

        return {
          name:
            el.querySelector(".product-title a")?.innerText.trim() || "Unknown",
          price: price,
          image: el.querySelector(".product-thumbnail img")?.src || "No image",
          link: link,
          mainCategory: category.name, // Add main category
          category: category.name, // Will be refined with subcategory if detected
          available: availability,
          sku: sku,
        };
      });
    }, category.name);

    // Visit individual product pages to get more details
    const enrichedProducts = [];

    for (const product of products) {
      try {
        console.log(`  📄 Getting details for: ${product.name}`);
        await page.goto(product.link, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });

        // Determine subcategory based on URL patterns
        let detectedSubcategory = product.category; // Default to main category

        // Check if this product URL matches any subcategory pattern
        for (const subcat of category.subcategories) {
          if (subcat.pattern.test(product.link)) {
            detectedSubcategory = subcat.name;
            break;
          }
        }

        // Extract detailed product information including accurate price
        const details = await page.evaluate(() => {
          // Get more accurate price using multiple selectors to handle different formats
          let price = "No price";
          let rawPrice = null;

          // Try content attribute first (most accurate)
          const priceContentElement = document.querySelector(
            ".product-price[content], .current-price-value[content], [itemprop='price'][content]"
          );
          if (
            priceContentElement &&
            priceContentElement.getAttribute("content")
          ) {
            rawPrice = priceContentElement.getAttribute("content");
          }

          // If no content attribute, try the displayed price text
          if (!rawPrice) {
            const priceTextElement = document.querySelector(
              ".current-price, .product-price, .current-price-value"
            );
            if (priceTextElement) {
              price = priceTextElement.innerText.trim();
            }
          } else {
            // Format the raw price with currency symbol
            const currencySymbol =
              document.querySelector(".currency-symbol")?.innerText || "$";
            price = `${currencySymbol} ${rawPrice}`;
          }

          // Get product reference/SKU
          const reference =
            document
              .querySelector("[itemprop='sku']")
              ?.getAttribute("content") ||
            document
              .querySelector(".product-reference span")
              ?.innerText.trim() ||
            document
              .querySelector("*[id*='product-reference'] span")
              ?.innerText.trim();

          // Get availability
          const outOfStock = document.querySelector(
            ".product-unavailable, .out-of-stock, .badge-danger, .product-unavailable"
          );
          const availability = !outOfStock;

          // Get manufacturer
          const manufacturer =
            document
              .querySelector("[itemprop='brand'] [itemprop='name']")
              ?.getAttribute("content") ||
            document
              .querySelector(
                ".product-manufacturer a, .product-manufacturer-name"
              )
              ?.innerText.trim();

          // Get product description
          const description =
            document
              .querySelector(
                ".product-description, [id*='product-description']"
              )
              ?.innerText.trim() || "";

          // Get product variants (slot, hook, etc.)
          const variants = {};
          const variantGroups = document.querySelectorAll(
            ".product-variants-item"
          );
          variantGroups.forEach((group) => {
            const label = group
              .querySelector(".form-control-label, .control-label")
              ?.innerText.trim();
            if (label) {
              const selectedOption =
                group
                  .querySelector("select option:checked")
                  ?.innerText.trim() ||
                group
                  .querySelector("input:checked + .radio-label")
                  ?.innerText.trim() ||
                group.querySelector(".selected")?.innerText.trim();
              if (selectedOption) {
                variants[label] = selectedOption;
              }
            }
          });

          // Get breadcrumb info to determine category when possible
          const breadcrumbItems = Array.from(
            document.querySelectorAll(".breadcrumb-item")
          );
          const breadcrumbs = breadcrumbItems.map((item) =>
            item.textContent.trim()
          );

          return {
            reference,
            price,
            rawPrice,
            manufacturer,
            description,
            availability,
            variants,
            breadcrumbs,
          };
        });

        // Use breadcrumbs for more accurate subcategory detection when available
        if (details.breadcrumbs && details.breadcrumbs.length > 1) {
          // Usually breadcrumbs would be [Home, Main Category, Subcategory, Product]
          // Try to find a more specific subcategory if present in breadcrumbs
          for (let i = 2; i < details.breadcrumbs.length - 1; i++) {
            const breadcrumb = details.breadcrumbs[i]
              .toLowerCase()
              .replace(/\s+/g, "-");
            // Check if this breadcrumb value matches any known subcategory name
            const matchingSubcat = category.subcategories.find(
              (sc) =>
                sc.name.toLowerCase() === breadcrumb ||
                breadcrumb.includes(sc.name.toLowerCase())
            );

            if (matchingSubcat) {
              detectedSubcategory = matchingSubcat.name;
              break;
            }
          }
        }

        // Enrich the product with additional details
        enrichedProducts.push({
          ...product,
          category: detectedSubcategory, // Use the detected subcategory
          mainCategory: product.mainCategory, // Keep the main category
          reference: details.reference || product.sku || "No reference",
          price: details.price || product.price,
          rawPrice: details.rawPrice,
          manufacturer: details.manufacturer || "Unknown",
          description: details.description || "",
          available:
            details.availability !== undefined
              ? details.availability
              : product.available,
          variants: details.variants || {},
        });
      } catch (e) {
        console.log(
          `  ⚠️ Error getting details for ${product.name}: ${e.message}`
        );
        enrichedProducts.push(product);
      }
    }

    console.log(`✅ Found ${products.length} products in ${category.name}`);
    return enrichedProducts;
  } catch (error) {
    console.error(`❌ Error scraping ${category.name}:`, error);
    return [];
  } finally {
    await browser.close();
  }
};

// Main function to scrape all categories
const scrapeAllCategories = async () => {
  try {
    let allProducts = [];
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const resultsDir = path.join("results", timestamp);

    // Create directories
    fs.mkdirSync(resultsDir, { recursive: true });

    for (const category of CATEGORIES) {
      const products = await scrapeCategory(category);

      // Save individual category results
      fs.writeFileSync(
        path.join(resultsDir, `${category.name}.json`),
        JSON.stringify(products, null, 2)
      );

      allProducts = allProducts.concat(products);
    }

    // Save consolidated results
    fs.writeFileSync(
      path.join(resultsDir, "all_products.json"),
      JSON.stringify(allProducts, null, 2)
    );

    console.log(
      `📦 Scraping complete. Found ${allProducts.length} total products.`
    );
    console.log(`💾 Data saved in results/${timestamp}/`);
  } catch (error) {
    console.error("Error in main scraping process:", error);
  }
};

// Scrape a single product (for testing)
const scrapeSingleProduct = async (url) => {
  console.log(`🔍 Scraping single product: ${url}`);

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    const productData = await page.evaluate(() => {
      // Try all possible price selectors
      const priceSelectors = [
        ".current-price-value[content]",
        ".product-price[content]",
        "[itemprop='price'][content]",
        ".current-price",
        ".product-price",
      ];

      let price = "No price";
      let rawPrice = null;

      for (const selector of priceSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          if (selector.includes("[content]") && el.getAttribute("content")) {
            rawPrice = el.getAttribute("content");
            price = `$ ${rawPrice}`;
            break;
          } else if (el.innerText) {
            price = el.innerText.trim();
            break;
          }
        }
      }

      // Get SKU
      const skuSelectors = [
        "[itemprop='sku']",
        ".product-reference span",
        "*[id*='product-reference'] span",
      ];

      let sku = "No SKU";
      for (const selector of skuSelectors) {
        const el = document.querySelector(selector);
        if (el) {
          if (selector === "[itemprop='sku']" && el.getAttribute("content")) {
            sku = el.getAttribute("content");
            break;
          } else if (el.innerText) {
            sku = el.innerText.trim();
            break;
          }
        }
      }

      // Get breadcrumb info to determine category
      const breadcrumbItems = Array.from(
        document.querySelectorAll(".breadcrumb-item")
      );
      const breadcrumbs = breadcrumbItems.map((item) =>
        item.textContent.trim()
      );

      return {
        name:
          document.querySelector("h1.page-title")?.innerText.trim() ||
          "Unknown",
        price: price,
        rawPrice: rawPrice,
        sku: sku,
        available: !document.querySelector(
          ".product-unavailable, .badge-danger"
        ),
        url: window.location.href,
        breadcrumbs: breadcrumbs,
        // Include all HTML that contains price info for debugging
        priceHTML:
          document.querySelector(".product-prices")?.outerHTML || "Not found",
      };
    });

    console.log("Product data:", productData);
    fs.writeFileSync(
      "single_product.json",
      JSON.stringify(productData, null, 2)
    );
  } catch (error) {
    console.error("Error scraping single product:", error);
  } finally {
    await browser.close();
  }
};

// Run the appropriate function
const productToTest = "https://ortho3.cl/ceramicos/336-2737-glacier-ii.html";

// Choose which function to run
if (process.argv.includes("--test")) {
  scrapeSingleProduct(productToTest);
} else {
  scrapeAllCategories();
}
