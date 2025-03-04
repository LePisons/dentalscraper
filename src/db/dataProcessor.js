import supabase from "../config/supabase.js";

class DataProcessor {
  // Category definitions with keywords and rules
  static CATEGORY_RULES = {
    orthodontics: {
      name: "Ortodoncia",
      keywords: [
        "bracket",
        "ortodoncia",
        "autoligado",
        "arco",
        "alambre",
        "retenedor",
        "alineador",
        "elástico",
        "banda",
        "tubo",
        "slot",
      ],
      subcategories: {
        brackets: {
          name: "Brackets",
          keywords: [
            "bracket",
            "autoligado",
            "metalico",
            "ceramico",
            "zafiro",
            "slot",
            "roth",
            "mbt",
          ],
        },
        wires: {
          name: "Arcos y Alambres",
          keywords: ["arco", "alambre", "niti", "acero", "beta", "titanio"],
        },
        elastics: {
          name: "Elásticos",
          keywords: ["elastico", "cadena", "ligadura", "power chain"],
        },
      },
    },
    surgical: {
      name: "Instrumental Quirúrgico",
      keywords: [
        "forcep",
        "fórcep",
        "pinza",
        "tijera",
        "bisturí",
        "sutura",
        "elevador",
        "osteotomo",
        "cureta",
        "periostotomo",
      ],
      subcategories: {
        forceps: {
          name: "Fórceps",
          keywords: ["forcep", "fórcep", "extracción"],
        },
        "surgical-instruments": {
          name: "Instrumental",
          keywords: [
            "pinza",
            "tijera",
            "bisturí",
            "sutura",
            "elevador",
            "osteotomo",
          ],
        },
      },
    },
    restorative: {
      name: "Materiales de Restauración",
      keywords: [
        "resina",
        "composite",
        "ionomero",
        "cemento",
        "adhesivo",
        "ácido",
        "grabador",
        "amalgama",
      ],
      subcategories: {
        composites: {
          name: "Resinas y Composites",
          keywords: ["resina", "composite", "bulk", "fluida", "nanohíbrida"],
        },
        cements: {
          name: "Cementos",
          keywords: [
            "cemento",
            "ionomero",
            "ionómero",
            "adhesivo",
            "provisional",
          ],
        },
        acids: {
          name: "Ácidos y Grabadores",
          keywords: ["ácido", "acido", "grabador", "fosfórico", "fluorhídrico"],
        },
      },
    },
    impression: {
      name: "Materiales de Impresión",
      keywords: [
        "alginato",
        "silicona",
        "impresión",
        "cubeta",
        "registro",
        "mordida",
      ],
      subcategories: {
        alginates: {
          name: "Alginatos",
          keywords: ["alginato", "hidrocoloide"],
        },
        silicones: {
          name: "Siliconas",
          keywords: [
            "silicona",
            "polivinilsiloxano",
            "putty",
            "liviana",
            "pesada",
          ],
        },
      },
    },
    endodontics: {
      name: "Endodoncia",
      keywords: [
        "lima",
        "endodoncia",
        "gutapercha",
        "resilon",
        "sellador",
        "irrigación",
        "hipoclorito",
      ],
      subcategories: {
        files: {
          name: "Limas",
          keywords: ["lima", "rotatorio", "reciprocante", "manual", "niti"],
        },
        obturation: {
          name: "Obturación",
          keywords: ["gutapercha", "resilon", "sellador", "cemento"],
        },
      },
    },
    prevention: {
      name: "Prevención e Higiene",
      keywords: [
        "fluoruro",
        "sellante",
        "profilaxis",
        "cepillo",
        "pasta",
        "hilo dental",
      ],
      subcategories: {
        fluorides: {
          name: "Fluoruros",
          keywords: ["fluoruro", "barniz", "gel"],
        },
        prophylaxis: {
          name: "Profilaxis",
          keywords: ["profilaxis", "pasta", "pulido", "cepillo"],
        },
      },
    },
  };

  static async detectProductCategories(product) {
    try {
      const searchText = [
        product.name,
        product.description,
        product.brand,
        product.specifications ? JSON.stringify(product.specifications) : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const detectedCategories = new Set();
      const categoryScores = new Map();

      // First pass: detect main categories
      for (const [categoryKey, category] of Object.entries(
        this.CATEGORY_RULES
      )) {
        let score = 0;
        const keywords = category.keywords;

        for (const keyword of keywords) {
          const regex = new RegExp(`\\b${keyword}\\b`, "gi");
          const matches = (searchText.match(regex) || []).length;
          if (matches > 0) {
            score += matches;
          }
        }

        if (score > 0) {
          categoryScores.set(categoryKey, score);
          detectedCategories.add(categoryKey);

          // Check subcategories
          for (const [subKey, subcategory] of Object.entries(
            category.subcategories
          )) {
            let subScore = 0;
            for (const keyword of subcategory.keywords) {
              const regex = new RegExp(`\\b${keyword}\\b`, "gi");
              const matches = (searchText.match(regex) || []).length;
              if (matches > 0) {
                subScore += matches;
              }
            }
            if (subScore > 0) {
              categoryScores.set(`${categoryKey}_${subKey}`, subScore);
              detectedCategories.add(`${categoryKey}_${subKey}`);
            }
          }
        }
      }

      // If no categories detected, assign to "others"
      if (detectedCategories.size === 0) {
        return ["others"];
      }

      // Sort categories by score and return top matches
      const sortedCategories = Array.from(categoryScores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([category]) => category);

      return sortedCategories;
    } catch (error) {
      console.error("Error detecting categories:", error);
      return ["others"];
    }
  }

  static async ensureCategories() {
    try {
      // Create main categories first
      const mainCategories = new Map();

      for (const [categoryKey, category] of Object.entries(
        this.CATEGORY_RULES
      )) {
        const { data: mainCategory } = await supabase
          .from("categories")
          .select("id")
          .eq("slug", categoryKey)
          .single();

        if (!mainCategory) {
          const newCategory = await this.createCategory(category.name, {
            slug: categoryKey,
            description: `Categoría principal para productos de ${category.name.toLowerCase()}`,
          });
          mainCategories.set(categoryKey, newCategory.id);
        } else {
          mainCategories.set(categoryKey, mainCategory.id);
        }

        // Create subcategories
        for (const [subKey, subcategory] of Object.entries(
          category.subcategories
        )) {
          const { data: existingSubcategory } = await supabase
            .from("categories")
            .select("id")
            .eq("slug", `${categoryKey}-${subKey}`)
            .single();

          if (!existingSubcategory) {
            await this.createCategory(subcategory.name, {
              slug: `${categoryKey}-${subKey}`,
              parentId: mainCategories.get(categoryKey),
              description: `Subcategoría de ${category.name.toLowerCase()}`,
            });
          }
        }
      }

      // Create "others" category if it doesn't exist
      const { data: othersCategory } = await supabase
        .from("categories")
        .select("id")
        .eq("slug", "others")
        .single();

      if (!othersCategory) {
        await this.createCategory("Otros", {
          slug: "others",
          description: "Productos sin categoría específica",
        });
      }
    } catch (error) {
      console.error("Error ensuring categories:", error);
      throw error;
    }
  }

  static async processAndStoreProduct(productData) {
    try {
      // Clean and normalize the data
      const normalizedProduct = this.normalizeProductData(productData);

      // Check if product already exists
      const { data: existingProduct } = await supabase
        .from("products")
        .select("id, current_price")
        .eq("site_id", normalizedProduct.site_id)
        .eq("url", normalizedProduct.url)
        .single();

      let productId;

      if (existingProduct) {
        // Update existing product
        const { data: updatedProduct, error: updateError } = await supabase
          .from("products")
          .update(normalizedProduct)
          .eq("id", existingProduct.id)
          .select()
          .single();

        if (updateError) throw updateError;
        productId = existingProduct.id;

        // If price has changed, add to price history
        if (existingProduct.current_price !== normalizedProduct.current_price) {
          await this.recordPriceHistory(
            existingProduct.id,
            normalizedProduct.current_price
          );
        }
      } else {
        // Insert new product
        const { data: newProduct, error: insertError } = await supabase
          .from("products")
          .insert(normalizedProduct)
          .select()
          .single();

        if (insertError) throw insertError;
        productId = newProduct.id;

        // Record initial price
        if (normalizedProduct.current_price) {
          await this.recordPriceHistory(
            newProduct.id,
            normalizedProduct.current_price
          );
        }
      }

      // Detect and assign categories
      const detectedCategories = await this.detectProductCategories(
        normalizedProduct
      );

      // Get category IDs
      const { data: categoryIds } = await supabase
        .from("categories")
        .select("id")
        .in("slug", detectedCategories);

      if (categoryIds && categoryIds.length > 0) {
        await this.assignProductToCategories(
          productId,
          categoryIds.map((cat) => cat.id)
        );
      }

      return { id: productId, categories: detectedCategories };
    } catch (error) {
      console.error("Error processing product:", error);
      throw error;
    }
  }

  static normalizeProductData(productData) {
    // Extract site_id from the URL or use the provided site
    const site_id =
      productData.site || new URL(productData.url).hostname.replace("www.", "");

    // Convert price string to decimal
    let current_price = null;
    if (productData.price && productData.price !== "No disponible (Agotado)") {
      const priceMatch = productData.price.match(/\d+([.,]\d+)?/);
      if (priceMatch) {
        current_price = parseFloat(priceMatch[0].replace(",", "."));
      }
    }

    // Normalize stock status
    let status = "unknown";
    if (productData.stock) {
      const stockLower = productData.stock.toLowerCase();
      if (
        stockLower.includes("en stock") ||
        stockLower.includes("disponible")
      ) {
        status = "in_stock";
      } else if (
        stockLower.includes("agotado") ||
        stockLower.includes("sin stock") ||
        stockLower.includes("no disponible")
      ) {
        status = "out_of_stock";
      }
    }

    return {
      site_id,
      platform: productData.platform,
      name: productData.name,
      sku: productData.sku || null,
      url: productData.url,
      image_url: productData.image || null,
      description: productData.description || null,
      specifications: productData.specifications || null,
      brand: productData.brand || null,
      presentation: productData.presentation || null,
      current_price,
      status,
      quantity: productData.quantity || null,
      last_checked: new Date().toISOString(),
    };
  }

  static async recordPriceHistory(productId, price) {
    try {
      const { error } = await supabase.from("price_history").insert({
        product_id: productId,
        price: price,
      });

      if (error) throw error;
    } catch (error) {
      console.error("Error recording price history:", error);
      throw error;
    }
  }

  static async recordScrapingLog(
    siteId,
    status,
    productsProcessed,
    errorsCount,
    errorDetails = null
  ) {
    try {
      const startedAt = new Date();
      const { error } = await supabase.from("scraping_logs").insert({
        site_id: siteId,
        status: status,
        products_processed: productsProcessed,
        errors_count: errorsCount,
        error_details: errorDetails,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        duration: new Date() - startedAt,
      });

      if (error) throw error;
    } catch (error) {
      console.error("Error recording scraping log:", error);
      throw error;
    }
  }

  static async createCategory(name, options = {}) {
    try {
      const {
        parentId = null,
        description = null,
        slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      } = options;

      const { data: category, error } = await supabase
        .from("categories")
        .insert({
          name,
          slug,
          parent_id: parentId,
          description,
        })
        .select()
        .single();

      if (error) throw error;
      return category;
    } catch (error) {
      console.error("Error creating category:", error);
      throw error;
    }
  }

  static async assignProductToCategories(productId, categoryIds) {
    try {
      const categoryAssignments = categoryIds.map((categoryId) => ({
        product_id: productId,
        category_id: categoryId,
      }));

      const { error } = await supabase
        .from("product_categories")
        .upsert(categoryAssignments);

      if (error) throw error;
    } catch (error) {
      console.error("Error assigning product to categories:", error);
      throw error;
    }
  }

  static async getProductCategories(productId) {
    try {
      const { data: categories, error } = await supabase
        .from("categories")
        .select("*")
        .innerJoin(
          "product_categories",
          "categories.id = product_categories.category_id"
        )
        .eq("product_categories.product_id", productId);

      if (error) throw error;
      return categories;
    } catch (error) {
      console.error("Error getting product categories:", error);
      throw error;
    }
  }

  static async searchProducts(query, options = {}) {
    try {
      const {
        site_id = null,
        status = null,
        minPrice = null,
        maxPrice = null,
        categoryId = null,
        limit = 20,
        offset = 0,
        sortBy = "name",
        sortOrder = "asc",
      } = options;

      let supabaseQuery = supabase
        .from("products")
        .select(
          `
          *,
          categories:product_categories(
            category:categories(*)
          )
        `
        )
        .textSearch("search_vector", query)
        .limit(limit)
        .order(sortBy, { ascending: sortOrder === "asc" })
        .range(offset, offset + limit - 1);

      // Apply filters if provided
      if (site_id) {
        supabaseQuery = supabaseQuery.eq("site_id", site_id);
      }
      if (status) {
        supabaseQuery = supabaseQuery.eq("status", status);
      }
      if (minPrice !== null) {
        supabaseQuery = supabaseQuery.gte("current_price", minPrice);
      }
      if (maxPrice !== null) {
        supabaseQuery = supabaseQuery.lte("current_price", maxPrice);
      }
      if (categoryId) {
        supabaseQuery = supabaseQuery.eq(
          "product_categories.category_id",
          categoryId
        );
      }

      const { data, error, count } = await supabaseQuery;

      if (error) throw error;

      return {
        products: data,
        total: count,
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil(count / limit),
      };
    } catch (error) {
      console.error("Error searching products:", error);
      throw error;
    }
  }

  static async getCategoryHierarchy(categoryId = null) {
    try {
      let query = supabase
        .from("categories")
        .select("*, subcategories:categories(*)");

      if (categoryId) {
        query = query.eq("id", categoryId);
      } else {
        query = query.is("parent_id", null);
      }

      const { data: categories, error } = await query;

      if (error) throw error;
      return categories;
    } catch (error) {
      console.error("Error getting category hierarchy:", error);
      throw error;
    }
  }
}

export default DataProcessor;
