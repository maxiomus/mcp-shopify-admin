import { z } from "zod";
import fs from "fs";
import path from "path";

/**
 * Store configuration schema
 */
const storeSchema = z.object({
  name: z.string().min(1, "Store name is required"),
  domain: z
    .string()
    .min(1, "Domain is required")
    .refine(
      (val) => val.includes(".myshopify.com") || val.includes("."),
      "Domain must be a valid Shopify domain"
    ),
  accessToken: z
    .string()
    .min(1, "Access token is required")
    .refine(
      (val) => val.startsWith("shpat_") || val.length > 20,
      "Access token appears invalid"
    ),
  environment: z.enum(["production", "staging", "development"]),
});

const storesConfigSchema = z.object({
  stores: z.array(storeSchema).min(1, "At least one store must be configured"),
  defaultStore: z.string().optional(),
});

/**
 * Store Registry - manages multi-store configuration
 */
class StoreRegistry {
  constructor() {
    this.stores = new Map();
    this.defaultStoreName = null;
    this.loaded = false;
  }

  /**
   * Load stores from configuration file
   */
  load() {
    if (this.loaded) return;

    // Try to load from stores.json
    const configPaths = [
      path.resolve(process.cwd(), "stores.json"),
      path.resolve(process.cwd(), "../stores.json"),
    ];

    let configData = null;
    let configPath = null;

    for (const p of configPaths) {
      if (fs.existsSync(p)) {
        try {
          const raw = fs.readFileSync(p, "utf-8");
          configData = JSON.parse(raw);
          configPath = p;
          break;
        } catch (e) {
          throw new Error(`Failed to parse stores.json at ${p}: ${e.message}`);
        }
      }
    }

    // Fallback to environment variables for single-store mode
    if (!configData) {
      const envDomain = process.env.SHOPIFY_STORE_DOMAIN;
      const envToken = process.env.SHOPIFY_ACCESS_TOKEN;

      if (envDomain && envToken) {
        configData = {
          stores: [
            {
              name: "default",
              domain: envDomain,
              accessToken: envToken,
              environment: process.env.SHOPIFY_ENVIRONMENT || "production",
            },
          ],
          defaultStore: "default",
        };
      } else {
        throw new Error(
          "No stores configured. Either create stores.json or set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN environment variables."
        );
      }
    }

    // Validate configuration
    const result = storesConfigSchema.safeParse(configData);
    if (!result.success) {
      const errors = result.error.errors
        .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
        .join("\n");
      throw new Error(`Store configuration validation failed:\n${errors}`);
    }

    // Load stores into registry
    for (const store of result.data.stores) {
      if (this.stores.has(store.name)) {
        throw new Error(`Duplicate store name: ${store.name}`);
      }
      this.stores.set(store.name, {
        ...store,
        isProduction: store.environment === "production",
      });
    }

    // Set default store
    if (result.data.defaultStore) {
      if (!this.stores.has(result.data.defaultStore)) {
        throw new Error(
          `Default store "${result.data.defaultStore}" not found in configured stores`
        );
      }
      this.defaultStoreName = result.data.defaultStore;
    } else {
      // Use first non-production store as default, or first store if all are production
      const nonProduction = [...this.stores.values()].find(
        (s) => !s.isProduction
      );
      this.defaultStoreName = nonProduction
        ? nonProduction.name
        : [...this.stores.keys()][0];
    }

    this.loaded = true;
  }

  /**
   * Get a store by name
   * @param {string} name - Store name
   * @returns {object|null} Store configuration or null if not found
   */
  getStore(name) {
    this.load();
    return this.stores.get(name) || null;
  }

  /**
   * List all configured stores
   * @returns {Array} Array of store configurations (without access tokens)
   */
  listStores() {
    this.load();
    return [...this.stores.values()].map((store) => ({
      name: store.name,
      domain: store.domain,
      environment: store.environment,
      isProduction: store.isProduction,
      isDefault: store.name === this.defaultStoreName,
    }));
  }

  /**
   * Get the default store name
   * @returns {string} Default store name
   */
  getDefaultStoreName() {
    this.load();
    return this.defaultStoreName;
  }

  /**
   * Validate that a store exists and optionally check environment
   * @param {string} name - Store name
   * @param {object} options - Validation options
   * @returns {object} Store configuration
   * @throws {Error} If store not found or validation fails
   */
  requireStore(name, options = {}) {
    this.load();
    const store = this.stores.get(name);

    if (!store) {
      const available = [...this.stores.keys()].join(", ");
      throw new Error(
        `Store "${name}" not found. Available stores: ${available}`
      );
    }

    return store;
  }

  /**
   * Check if a store is a production environment
   * @param {string} name - Store name
   * @returns {boolean}
   */
  isProduction(name) {
    const store = this.getStore(name);
    return store ? store.isProduction : false;
  }
}

// Singleton instance
export const registry = new StoreRegistry();

// Export helper functions
export const getStore = (name) => registry.getStore(name);
export const listStores = () => registry.listStores();
export const getDefaultStoreName = () => registry.getDefaultStoreName();
export const requireStore = (name, options) =>
  registry.requireStore(name, options);
export const isProduction = (name) => registry.isProduction(name);
