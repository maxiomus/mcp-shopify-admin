import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../shopify/client.js";

/**
 * Format products response
 */
function formatProducts(products, pageInfo, format) {
  const items = products.map((edge) => {
    const node = edge.node;
    return {
      id: parseGid(node.id),
      title: node.title,
      handle: node.handle,
      status: node.status,
      vendor: node.vendor,
      productType: node.productType,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      totalInventory: node.totalInventory,
      variantsCount: node.variants?.edges?.length || 0,
      priceRange: node.priceRangeV2
        ? {
            min: `${node.priceRangeV2.minVariantPrice.amount} ${node.priceRangeV2.minVariantPrice.currencyCode}`,
            max: `${node.priceRangeV2.maxVariantPrice.amount} ${node.priceRangeV2.maxVariantPrice.currencyCode}`,
          }
        : null,
    };
  });

  const result = {
    products: items,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      hasPreviousPage: pageInfo.hasPreviousPage,
      endCursor: pageInfo.endCursor,
      startCursor: pageInfo.startCursor,
    },
    total: items.length,
  };

  if (format === "markdown") {
    let md = `# Products (${items.length} results)\n\n`;
    if (pageInfo.hasNextPage) {
      md += `*More results available. Use cursor: \`${pageInfo.endCursor}\`*\n\n`;
    }
    md += "| ID | Title | Status | Vendor | Inventory |\n";
    md += "|---|---|---|---|---|\n";
    items.forEach((p) => {
      md += `| ${p.id} | ${p.title} | ${p.status} | ${p.vendor || "-"} | ${p.totalInventory} |\n`;
    });
    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/**
 * Format single product response
 */
function formatProduct(product, format) {
  const p = {
    id: parseGid(product.id),
    title: product.title,
    handle: product.handle,
    descriptionHtml: product.descriptionHtml,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    totalInventory: product.totalInventory,
    variants: product.variants?.edges?.map((e) => ({
      id: parseGid(e.node.id),
      title: e.node.title,
      sku: e.node.sku,
      price: e.node.price,
      inventoryQuantity: e.node.inventoryQuantity,
      inventoryItemId: e.node.inventoryItem
        ? parseGid(e.node.inventoryItem.id)
        : null,
    })),
    images: product.images?.edges?.map((e) => ({
      id: parseGid(e.node.id),
      url: e.node.url,
      altText: e.node.altText,
    })),
  };

  if (format === "markdown") {
    let md = `# ${p.title}\n\n`;
    md += `**ID:** ${p.id}\n`;
    md += `**Handle:** ${p.handle}\n`;
    md += `**Status:** ${p.status}\n`;
    md += `**Vendor:** ${p.vendor || "-"}\n`;
    md += `**Type:** ${p.productType || "-"}\n`;
    md += `**Tags:** ${p.tags?.join(", ") || "-"}\n`;
    md += `**Total Inventory:** ${p.totalInventory}\n\n`;

    if (p.descriptionHtml) {
      md += `## Description\n${p.descriptionHtml}\n\n`;
    }

    if (p.variants?.length) {
      md += `## Variants (${p.variants.length})\n\n`;
      md += "| ID | Title | SKU | Price | Qty |\n";
      md += "|---|---|---|---|---|\n";
      p.variants.forEach((v) => {
        md += `| ${v.id} | ${v.title} | ${v.sku || "-"} | ${v.price} | ${v.inventoryQuantity} |\n`;
      });
    }

    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
}

export function registerProductTools(server) {
  // List Products
  server.tool(
    "shopify_list_products",
    {
      title: "List Shopify Products",
      description:
        "List products from your Shopify store with optional filtering and pagination. Supports search queries and cursor-based pagination.",
      inputSchema: {
        limit: z.number().min(1).max(250).default(50).describe("Number of products to return (1-250)"),
        query: z.string().optional().describe("Search query to filter products (e.g., 'title:shirt' or 'vendor:Nike')"),
        cursor: z.string().optional().describe("Pagination cursor from previous response"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, query, cursor, response_format }) => {
      const gqlQuery = `
        query ListProducts($first: Int!, $query: String, $after: String) {
          products(first: $first, query: $query, after: $after) {
            edges {
              node {
                id
                title
                handle
                status
                vendor
                productType
                createdAt
                updatedAt
                totalInventory
                priceRangeV2 {
                  minVariantPrice { amount currencyCode }
                  maxVariantPrice { amount currencyCode }
                }
                variants(first: 10) {
                  edges { node { id } }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `;

      const data = await shopifyGraphQL(gqlQuery, {
        first: limit,
        query: query || null,
        after: cursor || null,
      });

      return formatProducts(
        data.products.edges,
        data.products.pageInfo,
        response_format
      );
    }
  );

  // Get Product
  server.tool(
    "shopify_get_product",
    {
      title: "Get Shopify Product",
      description:
        "Get detailed information about a specific product by ID, including variants, images, and inventory.",
      inputSchema: {
        id: z.string().describe("Product ID (numeric ID or full GID)"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, response_format }) => {
      const gqlQuery = `
        query GetProduct($id: ID!) {
          product(id: $id) {
            id
            title
            handle
            descriptionHtml
            status
            vendor
            productType
            tags
            createdAt
            updatedAt
            totalInventory
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  inventoryItem { id }
                }
              }
            }
            images(first: 20) {
              edges {
                node {
                  id
                  url
                  altText
                }
              }
            }
          }
        }
      `;

      const data = await shopifyGraphQL(gqlQuery, {
        id: buildGid("Product", id),
      });

      if (!data.product) {
        return {
          content: [{ type: "text", text: `Product with ID ${id} not found.` }],
          isError: true,
        };
      }

      return formatProduct(data.product, response_format);
    }
  );

  // Create Product
  server.tool(
    "shopify_create_product",
    {
      title: "Create Shopify Product",
      description:
        "Create a new product in your Shopify store. Returns the created product details.",
      inputSchema: {
        title: z.string().describe("Product title"),
        descriptionHtml: z.string().optional().describe("Product description (HTML)"),
        vendor: z.string().optional().describe("Product vendor"),
        productType: z.string().optional().describe("Product type"),
        tags: z.array(z.string()).optional().describe("Product tags"),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).default("DRAFT").describe("Product status"),
        variants: z
          .array(
            z.object({
              title: z.string().optional().describe("Variant title"),
              price: z.string().describe("Variant price"),
              sku: z.string().optional().describe("SKU"),
              inventoryQuantity: z.number().optional().describe("Initial inventory quantity"),
            })
          )
          .optional()
          .describe("Product variants"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      title,
      descriptionHtml,
      vendor,
      productType,
      tags,
      status,
      variants,
      response_format,
    }) => {
      const mutation = `
        mutation CreateProduct($input: ProductInput!) {
          productCreate(input: $input) {
            product {
              id
              title
              handle
              descriptionHtml
              status
              vendor
              productType
              tags
              createdAt
              updatedAt
              totalInventory
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity
                    inventoryItem { id }
                  }
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const input = {
        title,
        descriptionHtml,
        vendor,
        productType,
        tags,
        status,
      };

      if (variants && variants.length > 0) {
        input.variants = variants.map((v) => ({
          title: v.title,
          price: v.price,
          sku: v.sku,
        }));
      }

      const data = await shopifyGraphQL(mutation, { input });

      if (data.productCreate.userErrors?.length > 0) {
        const errors = data.productCreate.userErrors
          .map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Failed to create product: ${errors}` }],
          isError: true,
        };
      }

      return formatProduct(data.productCreate.product, response_format);
    }
  );

  // Update Product
  server.tool(
    "shopify_update_product",
    {
      title: "Update Shopify Product",
      description:
        "Update an existing product in your Shopify store. Only provided fields will be updated.",
      inputSchema: {
        id: z.string().describe("Product ID (numeric ID or full GID)"),
        title: z.string().optional().describe("New product title"),
        descriptionHtml: z.string().optional().describe("New product description (HTML)"),
        vendor: z.string().optional().describe("New vendor"),
        productType: z.string().optional().describe("New product type"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().describe("New status"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      id,
      title,
      descriptionHtml,
      vendor,
      productType,
      tags,
      status,
      response_format,
    }) => {
      const mutation = `
        mutation UpdateProduct($input: ProductInput!) {
          productUpdate(input: $input) {
            product {
              id
              title
              handle
              descriptionHtml
              status
              vendor
              productType
              tags
              createdAt
              updatedAt
              totalInventory
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity
                    inventoryItem { id }
                  }
                }
              }
              images(first: 20) {
                edges {
                  node {
                    id
                    url
                    altText
                  }
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const input = {
        id: buildGid("Product", id),
      };

      if (title !== undefined) input.title = title;
      if (descriptionHtml !== undefined) input.descriptionHtml = descriptionHtml;
      if (vendor !== undefined) input.vendor = vendor;
      if (productType !== undefined) input.productType = productType;
      if (tags !== undefined) input.tags = tags;
      if (status !== undefined) input.status = status;

      const data = await shopifyGraphQL(mutation, { input });

      if (data.productUpdate.userErrors?.length > 0) {
        const errors = data.productUpdate.userErrors
          .map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Failed to update product: ${errors}` }],
          isError: true,
        };
      }

      return formatProduct(data.productUpdate.product, response_format);
    }
  );
}
