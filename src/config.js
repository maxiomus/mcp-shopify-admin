import { z } from "zod";

const configSchema = z.object({
  shopifyStoreDomain: z
    .string()
    .min(1, "SHOPIFY_STORE_DOMAIN is required")
    .refine(
      (val) => val.includes(".myshopify.com") || val.includes("."),
      "SHOPIFY_STORE_DOMAIN must be a valid Shopify domain"
    ),
  shopifyAccessToken: z
    .string()
    .min(1, "SHOPIFY_ACCESS_TOKEN is required")
    .refine(
      (val) => val.startsWith("shpat_") || val.length > 20,
      "SHOPIFY_ACCESS_TOKEN appears invalid"
    ),
});

function loadConfig() {
  const raw = {
    shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN,
    shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data;
}

export const config = loadConfig();
