import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore, isProduction } from "../stores/registry.js";
import { workflowEngine, OperationType } from "../workflow/engine.js";

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

// GraphQL Queries
const PRODUCT_LIST_QUERY = `
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

const PRODUCT_GET_QUERY = `
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

const PRODUCT_CREATE_MUTATION = `
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

const PRODUCT_UPDATE_MUTATION = `
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

export function registerProductTools(server) {
  // ============================================
  // READ TOOLS (require store parameter)
  // ============================================

  // List Products
  server.registerTool(
    "product_list",
    {
      title: "List Products",
      description:
        "List products from a Shopify store with optional filtering and pagination.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
        limit: z.number().min(1).max(250).default(50).describe("Number of products to return (1-250)"),
        query: z.string().optional().describe("Search query (e.g., 'title:shirt' or 'vendor:Nike')"),
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
    async ({ store, limit, query, cursor, response_format }) => {
      requireStore(store);

      const data = await shopifyGraphQL(store, PRODUCT_LIST_QUERY, {
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
  server.registerTool(
    "product_get",
    {
      title: "Get Product",
      description:
        "Get detailed information about a specific product including variants, images, and inventory.",
      inputSchema: {
        store: z.string().describe("Store name"),
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
    async ({ store, id, response_format }) => {
      requireStore(store);

      const data = await shopifyGraphQL(store, PRODUCT_GET_QUERY, {
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

  // Search Products
  server.registerTool(
    "product_search",
    {
      title: "Search Products",
      description: "Search for products using Shopify's search syntax.",
      inputSchema: {
        store: z.string().describe("Store name"),
        query: z.string().describe("Search query (e.g., 'blue shirt', 'sku:ABC123')"),
        limit: z.number().min(1).max(50).default(20).describe("Number of results"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ store, query, limit, response_format }) => {
      requireStore(store);

      const data = await shopifyGraphQL(store, PRODUCT_LIST_QUERY, {
        first: limit,
        query,
        after: null,
      });

      return formatProducts(
        data.products.edges,
        data.products.pageInfo,
        response_format
      );
    }
  );

  // ============================================
  // CREATE PRODUCT - STAGED WORKFLOW
  // ============================================

  // Step 1: Plan product creation
  server.registerTool(
    "product_create_plan",
    {
      title: "Plan Product Creation",
      description:
        "Plan a new product creation. This creates a staged operation that must be previewed and then executed. " +
        "No changes are made until execution.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
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
            })
          )
          .optional()
          .describe("Product variants"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ store, title, descriptionHtml, vendor, productType, tags, status, variants, response_format }) => {
      requireStore(store);

      const payload = {
        title,
        descriptionHtml,
        vendor,
        productType,
        tags,
        status,
        variants,
      };

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.PRODUCT_CREATE,
        payload,
        description: `Create product "${title}"`,
        affectedResources: [`Product: ${title}`],
      });

      if (response_format === "markdown") {
        const prodWarning = isProduction(store)
          ? "\n\n**WARNING: This targets a PRODUCTION store!**"
          : "";

        let md = `# Product Creation Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${prodWarning}\n`;
        md += `**State:** ${result.state}\n`;
        md += `**Expires In:** ${result.expiresIn}\n\n`;
        md += `## Product Details\n`;
        md += `- **Title:** ${title}\n`;
        md += `- **Status:** ${status}\n`;
        if (vendor) md += `- **Vendor:** ${vendor}\n`;
        if (productType) md += `- **Type:** ${productType}\n`;
        if (variants?.length) md += `- **Variants:** ${variants.length}\n`;
        md += `\n## Next Step\n`;
        md += `Call \`product_create_preview\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 2: Preview product creation
  server.registerTool(
    "product_create_preview",
    {
      title: "Preview Product Creation",
      description:
        "Preview a planned product creation. Shows exactly what will be created. " +
        "Must be called before execution.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_create_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        return {
          action: "CREATE",
          product: operation.payload,
          summary: `Will create product "${operation.payload.title}" with status ${operation.payload.status}`,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        let md = `# Product Creation Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store}\n`;
        md += `**State:** ${result.state}\n\n`;
        md += `## Changes to Apply\n`;
        md += `**Action:** Create new product\n\n`;
        md += `### Product Details\n`;
        md += "```json\n";
        md += JSON.stringify(result.preview.product, null, 2);
        md += "\n```\n";

        if (result.warnings?.length > 0) {
          md += `\n## Warnings\n`;
          result.warnings.forEach((w) => {
            md += `- ${w}\n`;
          });
        }

        md += `\n## Next Step\n`;
        md += `If approved, call \`product_create_execute\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 3: Execute product creation
  server.registerTool(
    "product_create_execute",
    {
      title: "Execute Product Creation",
      description:
        "Execute a previewed product creation. This actually creates the product. " +
        "Requires prior preview. Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_create_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const input = {
          title: operation.payload.title,
          descriptionHtml: operation.payload.descriptionHtml,
          vendor: operation.payload.vendor,
          productType: operation.payload.productType,
          tags: operation.payload.tags,
          status: operation.payload.status,
        };

        if (operation.payload.variants?.length > 0) {
          input.variants = operation.payload.variants.map((v) => ({
            title: v.title,
            price: v.price,
            sku: v.sku,
          }));
        }

        const data = await shopifyGraphQL(operation.store, PRODUCT_CREATE_MUTATION, { input });

        if (data.productCreate.userErrors?.length > 0) {
          const errors = data.productCreate.userErrors
            .map((e) => `${e.field}: ${e.message}`)
            .join("; ");
          throw new Error(`Failed to create product: ${errors}`);
        }

        return {
          success: true,
          product: formatProduct(data.productCreate.product, "json").content[0].text,
        };
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);

        if (response_format === "markdown") {
          let md = `# Product Created Successfully\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Store:** ${result.store}\n`;
          md += `**Executed At:** ${result.executedAt}\n\n`;
          md += `## Created Product\n`;
          md += "```json\n";
          md += result.result.product;
          md += "\n```\n";

          return { content: [{ type: "text", text: md }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Execution failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // UPDATE PRODUCT - STAGED WORKFLOW
  // ============================================

  // Step 1: Plan product update
  server.registerTool(
    "product_update_plan",
    {
      title: "Plan Product Update",
      description:
        "Plan a product update. Creates a staged operation that must be previewed and executed. " +
        "Only provided fields will be updated.",
      inputSchema: {
        store: z.string().describe("Store name"),
        id: z.string().describe("Product ID to update"),
        title: z.string().optional().describe("New title"),
        descriptionHtml: z.string().optional().describe("New description (HTML)"),
        vendor: z.string().optional().describe("New vendor"),
        productType: z.string().optional().describe("New product type"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
        status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional().describe("New status"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ store, id, title, descriptionHtml, vendor, productType, tags, status, response_format }) => {
      requireStore(store);

      // Fetch current product state for preview
      const currentData = await shopifyGraphQL(store, PRODUCT_GET_QUERY, {
        id: buildGid("Product", id),
      });

      if (!currentData.product) {
        return {
          content: [{ type: "text", text: `Product with ID ${id} not found.` }],
          isError: true,
        };
      }

      const updates = {};
      if (title !== undefined) updates.title = title;
      if (descriptionHtml !== undefined) updates.descriptionHtml = descriptionHtml;
      if (vendor !== undefined) updates.vendor = vendor;
      if (productType !== undefined) updates.productType = productType;
      if (tags !== undefined) updates.tags = tags;
      if (status !== undefined) updates.status = status;

      const payload = {
        id,
        updates,
        currentProduct: {
          id: parseGid(currentData.product.id),
          title: currentData.product.title,
          status: currentData.product.status,
          vendor: currentData.product.vendor,
          productType: currentData.product.productType,
        },
      };

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.PRODUCT_UPDATE,
        payload,
        description: `Update product "${currentData.product.title}" (ID: ${id})`,
        affectedResources: [`Product: ${currentData.product.title} (${id})`],
      });

      if (response_format === "markdown") {
        const prodWarning = isProduction(store)
          ? "\n\n**WARNING: This targets a PRODUCTION store!**"
          : "";

        let md = `# Product Update Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${prodWarning}\n`;
        md += `**State:** ${result.state}\n\n`;
        md += `## Target Product\n`;
        md += `- **ID:** ${id}\n`;
        md += `- **Title:** ${currentData.product.title}\n\n`;
        md += `## Fields to Update\n`;
        Object.entries(updates).forEach(([key, value]) => {
          md += `- **${key}:** ${JSON.stringify(value)}\n`;
        });
        md += `\n## Next Step\n`;
        md += `Call \`product_update_preview\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 2: Preview product update
  server.registerTool(
    "product_update_preview",
    {
      title: "Preview Product Update",
      description: "Preview a planned product update. Shows the diff between current and new values.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_update_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        // Fetch fresh current state
        const currentData = await shopifyGraphQL(operation.store, PRODUCT_GET_QUERY, {
          id: buildGid("Product", operation.payload.id),
        });

        if (!currentData.product) {
          throw new Error(`Product ${operation.payload.id} no longer exists`);
        }

        const changes = [];
        const current = currentData.product;
        const updates = operation.payload.updates;

        if (updates.title !== undefined && updates.title !== current.title) {
          changes.push({ field: "title", from: current.title, to: updates.title });
        }
        if (updates.status !== undefined && updates.status !== current.status) {
          changes.push({ field: "status", from: current.status, to: updates.status });
        }
        if (updates.vendor !== undefined && updates.vendor !== current.vendor) {
          changes.push({ field: "vendor", from: current.vendor, to: updates.vendor });
        }
        if (updates.productType !== undefined && updates.productType !== current.productType) {
          changes.push({ field: "productType", from: current.productType, to: updates.productType });
        }
        if (updates.tags !== undefined) {
          changes.push({ field: "tags", from: current.tags, to: updates.tags });
        }
        if (updates.descriptionHtml !== undefined) {
          changes.push({
            field: "descriptionHtml",
            from: current.descriptionHtml?.slice(0, 100) + "...",
            to: updates.descriptionHtml?.slice(0, 100) + "...",
          });
        }

        return {
          action: "UPDATE",
          productId: operation.payload.id,
          productTitle: current.title,
          changes,
          currentState: {
            title: current.title,
            status: current.status,
            vendor: current.vendor,
            productType: current.productType,
          },
          summary: changes.length > 0
            ? `${changes.length} field(s) will be updated`
            : "No changes detected",
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        let md = `# Product Update Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store}\n`;
        md += `**Product:** ${result.preview.productTitle} (${result.preview.productId})\n\n`;

        if (result.preview.changes.length === 0) {
          md += `## No Changes\n`;
          md += `The product already has the requested values.\n`;
        } else {
          md += `## Changes (${result.preview.changes.length})\n\n`;
          md += "| Field | Current Value | New Value |\n";
          md += "|-------|--------------|----------|\n";
          result.preview.changes.forEach((c) => {
            const from = typeof c.from === "object" ? JSON.stringify(c.from) : c.from || "-";
            const to = typeof c.to === "object" ? JSON.stringify(c.to) : c.to;
            md += `| ${c.field} | ${from} | ${to} |\n`;
          });
        }

        if (result.warnings?.length > 0) {
          md += `\n## Warnings\n`;
          result.warnings.forEach((w) => {
            md += `- ${w}\n`;
          });
        }

        md += `\n## Next Step\n`;
        md += `If approved, call \`product_update_execute\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 3: Execute product update
  server.registerTool(
    "product_update_execute",
    {
      title: "Execute Product Update",
      description:
        "Execute a previewed product update. Requires prior preview. " +
        "Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_update_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const input = {
          id: buildGid("Product", operation.payload.id),
          ...operation.payload.updates,
        };

        const data = await shopifyGraphQL(operation.store, PRODUCT_UPDATE_MUTATION, { input });

        if (data.productUpdate.userErrors?.length > 0) {
          const errors = data.productUpdate.userErrors
            .map((e) => `${e.field}: ${e.message}`)
            .join("; ");
          throw new Error(`Failed to update product: ${errors}`);
        }

        return {
          success: true,
          product: formatProduct(data.productUpdate.product, "json").content[0].text,
        };
      };

      // Fresh preview generator for state check
      const freshPreviewGenerator = async (operation) => {
        const currentData = await shopifyGraphQL(operation.store, PRODUCT_GET_QUERY, {
          id: buildGid("Product", operation.payload.id),
        });
        return {
          currentState: {
            title: currentData.product?.title,
            status: currentData.product?.status,
            vendor: currentData.product?.vendor,
            productType: currentData.product?.productType,
          },
        };
      };

      try {
        const result = await workflowEngine.execute(
          operation_id,
          confirm_production,
          executor,
          freshPreviewGenerator
        );

        if (response_format === "markdown") {
          let md = `# Product Updated Successfully\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Store:** ${result.store}\n`;
          md += `**Executed At:** ${result.executedAt}\n\n`;
          md += `## Updated Product\n`;
          md += "```json\n";
          md += result.result.product;
          md += "\n```\n";

          return { content: [{ type: "text", text: md }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Execution failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // BULK UPDATE PRODUCTS - STAGED WORKFLOW
  // ============================================

  // Step 1: Plan bulk update
  server.registerTool(
    "product_bulk_update_plan",
    {
      title: "Plan Bulk Product Update",
      description:
        "Plan a bulk update of multiple products. Each product can have different updates.",
      inputSchema: {
        store: z.string().describe("Store name"),
        updates: z
          .array(
            z.object({
              id: z.string().describe("Product ID"),
              title: z.string().optional(),
              status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
              vendor: z.string().optional(),
              productType: z.string().optional(),
              tags: z.array(z.string()).optional(),
            })
          )
          .min(1)
          .max(100)
          .describe("Array of product updates (max 100)"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ store, updates, response_format }) => {
      requireStore(store);

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.PRODUCT_BULK_UPDATE,
        payload: { updates },
        description: `Bulk update ${updates.length} products`,
        affectedResources: updates.map((u) => `Product ID: ${u.id}`),
      });

      if (response_format === "markdown") {
        const prodWarning = isProduction(store)
          ? "\n\n**WARNING: This targets a PRODUCTION store!**"
          : "";

        let md = `# Bulk Product Update Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${prodWarning}\n`;
        md += `**Products to Update:** ${updates.length}\n\n`;
        md += `## Next Step\n`;
        md += `Call \`product_bulk_update_preview\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 2: Preview bulk update
  server.registerTool(
    "product_bulk_update_preview",
    {
      title: "Preview Bulk Product Update",
      description: "Preview all changes in a bulk product update operation.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_bulk_update_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        const items = [];

        for (const update of operation.payload.updates) {
          try {
            const currentData = await shopifyGraphQL(operation.store, PRODUCT_GET_QUERY, {
              id: buildGid("Product", update.id),
            });

            if (!currentData.product) {
              items.push({
                id: update.id,
                status: "NOT_FOUND",
                title: "Unknown",
                changes: [],
              });
              continue;
            }

            const changes = [];
            const current = currentData.product;

            if (update.title !== undefined && update.title !== current.title) {
              changes.push({ field: "title", from: current.title, to: update.title });
            }
            if (update.status !== undefined && update.status !== current.status) {
              changes.push({ field: "status", from: current.status, to: update.status });
            }
            if (update.vendor !== undefined && update.vendor !== current.vendor) {
              changes.push({ field: "vendor", from: current.vendor, to: update.vendor });
            }

            items.push({
              id: update.id,
              status: "READY",
              title: current.title,
              changes,
            });
          } catch (error) {
            items.push({
              id: update.id,
              status: "ERROR",
              title: "Unknown",
              error: error.message,
              changes: [],
            });
          }
        }

        return {
          action: "BULK_UPDATE",
          totalItems: items.length,
          readyItems: items.filter((i) => i.status === "READY").length,
          notFoundItems: items.filter((i) => i.status === "NOT_FOUND").length,
          errorItems: items.filter((i) => i.status === "ERROR").length,
          items,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        let md = `# Bulk Product Update Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store}\n\n`;
        md += `## Summary\n`;
        md += `- **Total Products:** ${result.preview.totalItems}\n`;
        md += `- **Ready to Update:** ${result.preview.readyItems}\n`;
        md += `- **Not Found:** ${result.preview.notFoundItems}\n`;
        md += `- **Errors:** ${result.preview.errorItems}\n\n`;

        md += `## Changes by Product\n\n`;
        result.preview.items.forEach((item) => {
          md += `### ${item.title} (${item.id})\n`;
          md += `**Status:** ${item.status}\n`;
          if (item.changes.length > 0) {
            item.changes.forEach((c) => {
              md += `- ${c.field}: \`${c.from}\` → \`${c.to}\`\n`;
            });
          } else if (item.status === "READY") {
            md += `- No changes\n`;
          }
          if (item.error) {
            md += `- Error: ${item.error}\n`;
          }
          md += "\n";
        });

        if (result.warnings?.length > 0) {
          md += `## Warnings\n`;
          result.warnings.forEach((w) => {
            md += `- ${w}\n`;
          });
        }

        md += `## Next Step\n`;
        md += `If approved, call \`product_bulk_update_execute\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 3: Execute bulk update
  server.registerTool(
    "product_bulk_update_execute",
    {
      title: "Execute Bulk Product Update",
      description:
        "Execute a previewed bulk product update. Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_bulk_update_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const results = {
          total: operation.payload.updates.length,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          items: [],
        };

        for (const update of operation.payload.updates) {
          try {
            const input = {
              id: buildGid("Product", update.id),
            };

            if (update.title !== undefined) input.title = update.title;
            if (update.status !== undefined) input.status = update.status;
            if (update.vendor !== undefined) input.vendor = update.vendor;
            if (update.productType !== undefined) input.productType = update.productType;
            if (update.tags !== undefined) input.tags = update.tags;

            const data = await shopifyGraphQL(operation.store, PRODUCT_UPDATE_MUTATION, { input });

            if (data.productUpdate.userErrors?.length > 0) {
              results.failed++;
              results.items.push({
                id: update.id,
                status: "FAILED",
                error: data.productUpdate.userErrors.map((e) => e.message).join("; "),
              });
            } else {
              results.succeeded++;
              results.items.push({
                id: update.id,
                status: "SUCCEEDED",
                title: data.productUpdate.product.title,
              });
            }
          } catch (error) {
            results.failed++;
            results.items.push({
              id: update.id,
              status: "FAILED",
              error: error.message,
            });
          }
        }

        return results;
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);

        if (response_format === "markdown") {
          let md = `# Bulk Product Update Complete\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Store:** ${result.store}\n`;
          md += `**Executed At:** ${result.executedAt}\n\n`;
          md += `## Results\n`;
          md += `- **Total:** ${result.result.total}\n`;
          md += `- **Succeeded:** ${result.result.succeeded}\n`;
          md += `- **Failed:** ${result.result.failed}\n\n`;

          if (result.result.items.length > 0) {
            md += `## Details\n\n`;
            md += "| ID | Status | Details |\n";
            md += "|----|--------|--------|\n";
            result.result.items.forEach((item) => {
              const details = item.error || item.title || "-";
              md += `| ${item.id} | ${item.status} | ${details} |\n`;
            });
          }

          return { content: [{ type: "text", text: md }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Execution failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
