import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../shopify/client.js";

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

export function registerInventoryTools(server) {
  // Get Inventory Levels
  server.tool(
    "shopify_get_inventory_levels",
    {
      title: "Get Shopify Inventory Levels",
      description:
        "Get inventory levels for products at specific locations. Can filter by location ID or product ID.",
      inputSchema: {
        location_id: z.string().optional().describe("Location ID to filter by (numeric ID or full GID)"),
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
    async ({ location_id, product_id, sku, limit, cursor, response_format }) => {
      // First, get locations
      const locationsQuery = `
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
      const locationsData = await shopifyGraphQL(locationsQuery);
      const locations = locationsData.locations.edges.map((e) => e.node);

      // Build query for inventory items
      let queryParts = [];
      if (sku) {
        queryParts.push(`sku:${sku}`);
      }

      // If product_id is provided, we need to get inventory items for that product's variants
      if (product_id) {
        const productQuery = `
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
        const productData = await shopifyGraphQL(productQuery, {
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

        // Get inventory levels for these items
        const inventoryQuery = `
          query GetInventoryLevels($inventoryItemIds: [ID!]!, $locationId: ID) {
            inventoryItems(first: 100, query: "") {
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
          }
        `;

        // Get inventory items by their IDs
        const itemsQuery = `
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

        const itemsData = await shopifyGraphQL(itemsQuery, {
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

      // General inventory query with location filter
      const targetLocationId = location_id ? buildGid("Location", location_id) : null;

      const inventoryQuery = `
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

      const data = await shopifyGraphQL(inventoryQuery, {
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

  // Update Inventory
  server.tool(
    "shopify_update_inventory",
    {
      title: "Update Shopify Inventory",
      description:
        "Adjust inventory quantity for a specific inventory item at a location. Use positive values to add, negative to subtract.",
      inputSchema: {
        inventory_item_id: z.string().describe("Inventory item ID (numeric ID or full GID)"),
        location_id: z.string().describe("Location ID (numeric ID or full GID)"),
        adjustment: z.number().describe("Quantity adjustment (positive to add, negative to subtract)"),
        reason: z.string().optional().describe("Reason for adjustment"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ inventory_item_id, location_id, adjustment, reason, response_format }) => {
      const mutation = `
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

      const inventoryItemGid = buildGid("InventoryItem", inventory_item_id);
      const locationGid = buildGid("Location", location_id);

      const input = {
        reason: reason || "correction",
        name: "available",
        changes: [
          {
            inventoryItemId: inventoryItemGid,
            locationId: locationGid,
            delta: adjustment,
          },
        ],
      };

      const data = await shopifyGraphQL(mutation, { input });

      if (data.inventoryAdjustQuantities.userErrors?.length > 0) {
        const errors = data.inventoryAdjustQuantities.userErrors
          .map((e) => `${e.field || e.code}: ${e.message}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Failed to adjust inventory: ${errors}` }],
          isError: true,
        };
      }

      const group = data.inventoryAdjustQuantities.inventoryAdjustmentGroup;
      const change = group?.changes?.[0];

      const result = {
        message: "Inventory adjusted successfully",
        inventoryItemId: parseGid(inventoryItemGid),
        locationId: parseGid(locationGid),
        reason: group?.reason,
        adjustment,
        quantityAfterChange: change?.quantityAfterChange,
      };

      if (response_format === "markdown") {
        let md = `# Inventory Adjustment\n\n`;
        md += `**Status:** Success\n`;
        md += `**Inventory Item ID:** ${result.inventoryItemId}\n`;
        md += `**Location ID:** ${result.locationId}\n`;
        md += `**Adjustment:** ${adjustment > 0 ? "+" : ""}${adjustment}\n`;
        md += `**New Available Quantity:** ${result.quantityAfterChange}\n`;
        if (result.reason) {
          md += `**Reason:** ${result.reason}\n`;
        }
        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
