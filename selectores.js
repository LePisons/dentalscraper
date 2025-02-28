const { chromium } = require("playwright");

const detectSelectors = async (url, productSelector) => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Encuentra el primer producto para analizarlo
  const product = await page.$(productSelector);
  if (!product) {
    console.log("No se encontró el producto en la página.");
    return;
  }

  // Busca el selector del nombre, precio y enlace
  const possibleSelectors = ["h2", "h3", "h4", "span", "div", "p", "a"];

  let name = "No encontrado";
  let price = "No encontrado";

  for (let selector of possibleSelectors) {
    try {
      const element = await product.$(selector);
      if (element) {
        const text = await element.innerText();
        if (text.length > 2) {
          name = text;
          console.log(`Posible selector para el nombre: ${selector}`);
          break;
        }
      }
    } catch (e) {}
  }

  for (let selector of possibleSelectors) {
    try {
      const element = await product.$(selector);
      if (element) {
        const text = await element.innerText();
        if (text.includes("$")) {
          price = text;
          console.log(`Posible selector para el precio: ${selector}`);
          break;
        }
      }
    } catch (e) {}
  }

  console.log(`Nombre detectado: ${name}`);
  console.log(`Precio detectado: ${price}`);

  await browser.close();
};

// Usa esta función para Denteeth o GAC Chile
detectSelectors(
  "https://www.denteeth.cl/categoria-producto/ortodoncia/brackets/",
  ".product"
);
