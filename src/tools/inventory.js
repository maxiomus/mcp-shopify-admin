import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore, isProduction } from "../stores/registry.js";
import { workflowEngine, OperationType } from "../workflow/engine.js";

/**
 * Format inventory levels response
 */
function formatInventoryLevels(inventoryLevels, locations, pageInfo, format) {
  const items = inventoryLevels.map((edge) => {
    const node = edge.node;
    const location = node.location;
    return {
      id: parseGid(node.id),
      inventoryItemId: parseGid(node.item.id),
      sku: node.item.sku,
      available: node.quantities.find((q) => q.name === "available")?.quantity || 0,
      onHand: node.quantities.find((q) => q.name === "on_hand")?.quantity || 0,
      committed: node.quantities.find((q) => q.name === "committed")?.quantity || 0,
      incoming: node.quantities.find((q) => q.name === "incoming")?.quantity || 0,
      location: {
        id: parseGid(location.id),
        name: location.name,
      },
      variant: node.item.variant
        ? {
            id: parseGid(node.item.variant.id),
            title: node.item.variant.title,
            product: node.item.variant.product
              ? {
                  id: parseGid(node.item.variant.product.id),
                  title: node.item.variant.product.title,
                }
              : null,
          }
        : null,
    };
  });

  const result = {
    inventoryLevels: items,
    locations: locations.map((l) => ({
      id: parseGid(l.id),
      name: l.name,
    })),
    pageInfo: pageInfo
      ? {
          hasNextPage: pageInfo.hasNextPage,
          endCursor: pageInfo.endCursor,
        }
      : null,
    total: items.length,
  };

  if (format === "markdown") {
    let md = `# Inventory Levels (${items.length} items)\n\n`;

    if (pageInfo?.hasNextPage) {
      md += `*More results available. Use cursor: \`${pageInfo.endCursor}\`*\n\n`;
    }

    md += "| Product | Variant | SKU | Location | Available | On Hand |\n";
    md += "|---|---|---|---|---|---|\n";
    items.forEach((i) => {
      const productTitle = i.variant?.product?.title || "-";
      const variantTitle = i.variant?.title || "-";
      md += `| ${productTitle} | ${variantTitle} | ${i.sku || "-"} | ${i.location.name} | ${i.available} | ${i.onHand} |\n`;
    });

    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

// GraphQL Queries
const LOCATIONS_QUERY = `
  query GetLocations {
    locations(first: 50) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `
  query GetProductVariants($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        edges {
          node {
            id
            inventoryItem {
              id
            }
          }
        }
      }
    }
  }
`;

const INVENTORY_ITEMS_QUERY = `
  query GetInventoryItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        sku
        variant {
          id
          title
          product {
            id
            title
          }
        }
        inventoryLevels(first: 50) {
          edges {
            node {
              id
              location {
                id
                name
              }
              quantities(names: ["available", "on_hand", "committed", "incoming"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const INVENTORY_LEVELS_QUERY = `
  query GetInventoryLevels($first: Int!, $after: String, $query: String) {
    inventoryItems(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          sku
          variant {
            id
            title
            product {
              id
              title
            }
          }
          inventoryLevels(first: 10) {
            edges {
              node {
                id
                location {
                  id
                  name
                }
                quantities(names: ["available", "on_hand", "committed", "incoming"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const INVENTORY_ADJUST_MUTATION = `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export function registerInventoryTools(server) {
  // ============================================
  // READ TOOLS (require store parameter)
  // ============================================

  // Get Inventory Levels
  server.registerTool(
    "inventory_levels",
    {
      title: "Get Inventory Levels",
      description:
        "Get inventory levels for products at specific locations. Can filter by location, product, or SKU.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
        location_id: z.string().optional().describe("Location ID to filter by"),
        product_id: z.string().optional().describe("Product ID to get inventory for all variants"),
        sku: z.string().optional().describe("SKU to search for"),
        limit: z.number().min(1).max(250).default(50).describe("Number of results (1-250)"),
        cursor: z.string().optional().describe("Pagination cursor"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ store, location_id, product_id, sku, limit, cursor, response_format }) => {
      requireStore(store);

      // Get locations
      const locationsData = await shopifyGraphQL(store, LOCATIONS_QUERY);
      const locations = locationsData.locations.edges.map((e) => e.node);

      // If product_id is provided, get inventory for that product's variants
      if (product_id) {
        const productData = await shopifyGraphQL(store, PRODUCT_VARIANTS_QUERY, {
          id: buildGid("Product", product_id),
        });

        if (!productData.product) {
          return {
            content: [{ type: "text", text: `Product with ID ${product_id} not found.` }],
            isError: true,
          };
        }

        const inventoryItemIds = productData.product.variants.edges
          .map((e) => e.node.inventoryItem?.id)
          .filter(Boolean);

        if (inventoryItemIds.length === 0) {
          return {
            content: [{ type: "text", text: `No inventory items found for product ${product_id}.` }],
            isError: true,
          };
        }

        const itemsData = await shopifyGraphQL(store, INVENTORY_ITEMS_QUERY, {
          ids: inventoryItemIds,
        });

        // Flatten inventory levels
        const inventoryLevels = [];
        itemsData.nodes.forEach((item) => {
          if (item && item.inventoryLevels) {
            item.inventoryLevels.edges.forEach((levelEdge) => {
              // Filter by location if specified
              if (location_id) {
                const targetLocationGid = buildGid("Location", location_id);
                if (levelEdge.node.location.id !== targetLocationGid) {
                  return;
                }
              }
              inventoryLevels.push({
                node: {
                  id: levelEdge.node.id,
                  item: {
                    id: item.id,
                    sku: item.sku,
                    variant: item.variant,
                  },
                  location: levelEdge.node.location,
                  quantities: levelEdge.node.quantities,
                },
              });
            });
          }
        });

        return formatInventoryLevels(inventoryLevels, locations, null, response_format);
      }

      // General inventory query
      const targetLocationId = location_id ? buildGid("Location", location_id) : null;
      let queryParts = [];
      if (sku) {
        queryParts.push(`sku:${sku}`);
      }

      const data = await shopifyGraphQL(store, INVENTORY_LEVELS_QUERY, {
        first: limit,
        after: cursor || null,
        query: queryParts.length > 0 ? queryParts.join(" AND ") : null,
      });

      // Flatten and filter by location
      const inventoryLevels = [];
      data.inventoryItems.edges.forEach((itemEdge) => {
        const item = itemEdge.node;
        item.inventoryLevels.edges.forEach((levelEdge) => {
          if (targetLocationId && levelEdge.node.location.id !== targetLocationId) {
            return;
          }
          inventoryLevels.push({
            node: {
              id: levelEdge.node.id,
              item: {
                id: item.id,
                sku: item.sku,
                variant: item.variant,
              },
              location: levelEdge.node.location,
              quantities: levelEdge.node.quantities,
            },
          });
        });
      });

      return formatInventoryLevels(
        inventoryLevels,
        locations,
        data.inventoryItems.pageInfo,
        response_format
      );
    }
  );

  // ============================================
  // INVENTORY ADJUST - STAGED WORKFLOW
  // ============================================

  // Step 1: Plan inventory adjustment
  server.registerTool(
    "inventory_adjust_plan",
    {
      title: "Plan Inventory Adjustment",
      description:
        "Plan an inventory adjustment. Creates a staged operation that must be previewed and executed.",
      inputSchema: {
        store: z.string().describe("Store name"),
        inventory_item_id: z.string().describe("Inventory item ID"),
        location_id: z.string().describe("Location ID"),
        adjustment: z.number().describe("Quantity adjustment (positive to add, negative to subtract)"),
        reason: z.string().optional().describe("Reason for adjustment"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ store, inventory_item_id, location_id, adjustment, reason, response_format }) => {
      requireStore(store);

      // Get current inventory level
      const inventoryItemGid = buildGid("InventoryItem", inventory_item_id);
      const locationGid = buildGid("Location", location_id);

      const itemsData = await shopifyGraphQL(store, INVENTORY_ITEMS_QUERY, {
        ids: [inventoryItemGid],
      });

      if (!itemsData.nodes || itemsData.nodes.length === 0 || !itemsData.nodes[0]) {
        return {
          content: [{ type: "text", text: `Inventory item ${inventory_item_id} not found.` }],
          isError: true,
        };
      }

      const item = itemsData.nodes[0];
      const level = item.inventoryLevels?.edges?.find(
        (e) => e.node.location.id === locationGid
      )?.node;

      if (!level) {
        return {
          content: [
            {
              type: "text",
              text: `Inventory item ${inventory_item_id} is not tracked at location ${location_id}.`,
            },
          ],
          isError: true,
        };
      }

      const currentAvailable = level.quantities.find((q) => q.name === "available")?.quantity || 0;

      const payload = {
        inventoryItemId: inventory_item_id,
        locationId: location_id,
        adjustment,
        reason: reason || "correction",
        currentState: {
          sku: item.sku,
          variant: item.variant?.title,
          product: item.variant?.product?.title,
          location: level.location.name,
          currentAvailable,
          newAvailable: currentAvailable + adjustment,
        },
      };

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.INVENTORY_ADJUST,
        payload,
        description: `Adjust inventory for ${item.sku || item.variant?.title || inventory_item_id} by ${adjustment > 0 ? "+" : ""}${adjustment}`,
        affectedResources: [
          `Inventory Item: ${item.sku || inventory_item_id}`,
          `Location: ${level.location.name}`,
        ],
      });

      if (response_format === "markdown") {
        const prodWarning = isProduction(store)
          ? "\n\n**WARNING: This targets a PRODUCTION store!**"
          : "";

        let md = `# Inventory Adjustment Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${prodWarning}\n`;
        md += `**State:** ${result.state}\n\n`;
        md += `## Item Details\n`;
        if (payload.currentState.product) md += `- **Product:** ${payload.currentState.product}\n`;
        if (payload.currentState.variant) md += `- **Variant:** ${payload.currentState.variant}\n`;
        if (payload.currentState.sku) md += `- **SKU:** ${payload.currentState.sku}\n`;
        md += `- **Location:** ${payload.currentState.location}\n\n`;
        md += `## Adjustment\n`;
        md += `- **Current Available:** ${currentAvailable}\n`;
        md += `- **Adjustment:** ${adjustment > 0 ? "+" : ""}${adjustment}\n`;
        md += `- **New Available:** ${currentAvailable + adjustment}\n`;
        if (reason) md += `- **Reason:** ${reason}\n`;
        md += `\n## Next Step\n`;
        md += `Call \`inventory_adjust_preview\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 2: Preview inventory adjustment
  server.registerTool(
    "inventory_adjust_preview",
    {
      title: "Preview Inventory Adjustment",
      description: "Preview a planned inventory adjustment. Shows the before and after quantities.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from inventory_adjust_plan"),
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
        const inventoryItemGid = buildGid("InventoryItem", operation.payload.inventoryItemId);
        const locationGid = buildGid("Location", operation.payload.locationId);

        const itemsData = await shopifyGraphQL(operation.store, INVENTORY_ITEMS_QUERY, {
          ids: [inventoryItemGid],
        });

        const item = itemsData.nodes?.[0];
        const level = item?.inventoryLevels?.edges?.find(
          (e) => e.node.location.id === locationGid
        )?.node;

        const freshCurrentAvailable = level?.quantities.find((q) => q.name === "available")?.quantity || 0;

        return {
          action: "ADJUST",
          inventoryItemId: operation.payload.inventoryItemId,
          locationId: operation.payload.locationId,
          sku: item?.sku,
          product: item?.variant?.product?.title,
          variant: item?.variant?.title,
          location: level?.location?.name,
          adjustment: operation.payload.adjustment,
          reason: operation.payload.reason,
          currentState: {
            available: freshCurrentAvailable,
          },
          newState: {
            available: freshCurrentAvailable + operation.payload.adjustment,
          },
          summary: `Adjust available quantity from ${freshCurrentAvailable} to ${freshCurrentAvailable + operation.payload.adjustment}`,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        let md = `# Inventory Adjustment Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store}\n\n`;
        md += `## Item\n`;
        if (result.preview.product) md += `- **Product:** ${result.preview.product}\n`;
        if (result.preview.variant) md += `- **Variant:** ${result.preview.variant}\n`;
        if (result.preview.sku) md += `- **SKU:** ${result.preview.sku}\n`;
        md += `- **Location:** ${result.preview.location}\n\n`;
        md += `## Change\n`;
        md += "| Quantity | Current | After |\n";
        md += "|----------|---------|-------|\n";
        md += `| Available | ${result.preview.currentState.available} | ${result.preview.newState.available} |\n`;
        md += `\n**Adjustment:** ${result.preview.adjustment > 0 ? "+" : ""}${result.preview.adjustment}\n`;
        md += `**Reason:** ${result.preview.reason}\n`;

        if (result.warnings?.length > 0) {
          md += `\n## Warnings\n`;
          result.warnings.forEach((w) => {
            md += `- ${w}\n`;
          });
        }

        md += `\n## Next Step\n`;
        md += `If approved, call \`inventory_adjust_execute\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 3: Execute inventory adjustment
  server.registerTool(
    "inventory_adjust_execute",
    {
      title: "Execute Inventory Adjustment",
      description:
        "Execute a previewed inventory adjustment. This actually changes the inventory. " +
        "Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from inventory_adjust_plan"),
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
        const inventoryItemGid = buildGid("InventoryItem", operation.payload.inventoryItemId);
        const locationGid = buildGid("Location", operation.payload.locationId);

        const input = {
          reason: operation.payload.reason,
          name: "available",
          changes: [
            {
              inventoryItemId: inventoryItemGid,
              locationId: locationGid,
              delta: operation.payload.adjustment,
            },
          ],
        };

        const data = await shopifyGraphQL(operation.store, INVENTORY_ADJUST_MUTATION, { input });

        if (data.inventoryAdjustQuantities.userErrors?.length > 0) {
          const errors = data.inventoryAdjustQuantities.userErrors
            .map((e) => `${e.field || e.code}: ${e.message}`)
            .join("; ");
          throw new Error(`Failed to adjust inventory: ${errors}`);
        }

        const group = data.inventoryAdjustQuantities.inventoryAdjustmentGroup;
        const change = group?.changes?.[0];

        return {
          success: true,
          inventoryItemId: parseGid(inventoryItemGid),
          locationId: parseGid(locationGid),
          reason: group?.reason,
          adjustment: operation.payload.adjustment,
          quantityAfterChange: change?.quantityAfterChange,
        };
      };

      // Fresh preview for state check
      const freshPreviewGenerator = async (operation) => {
        const inventoryItemGid = buildGid("InventoryItem", operation.payload.inventoryItemId);
        const locationGid = buildGid("Location", operation.payload.locationId);

        const itemsData = await shopifyGraphQL(operation.store, INVENTORY_ITEMS_QUERY, {
          ids: [inventoryItemGid],
        });

        const item = itemsData.nodes?.[0];
        const level = item?.inventoryLevels?.edges?.find(
          (e) => e.node.location.id === locationGid
        )?.node;

        return {
          currentState: {
            available: level?.quantities.find((q) => q.name === "available")?.quantity || 0,
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
          let md = `# Inventory Adjusted Successfully\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Store:** ${result.store}\n`;
          md += `**Executed At:** ${result.executedAt}\n\n`;
          md += `## Adjustment Details\n`;
          md += `- **Inventory Item ID:** ${result.result.inventoryItemId}\n`;
          md += `- **Location ID:** ${result.result.locationId}\n`;
          md += `- **Adjustment:** ${result.result.adjustment > 0 ? "+" : ""}${result.result.adjustment}\n`;
          md += `- **New Available Quantity:** ${result.result.quantityAfterChange}\n`;
          if (result.result.reason) {
            md += `- **Reason:** ${result.result.reason}\n`;
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
