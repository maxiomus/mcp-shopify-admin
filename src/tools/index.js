import { registerProductTools } from "./products.js";
import { registerOrderTools } from "./orders.js";
import { registerCustomerTools } from "./customers.js";
import { registerInventoryTools } from "./inventory.js";
import { registerStoreTools } from "./stores.js";
import { registerOperationTools } from "./operations.js";
import { registerCollectionTools } from "./collections.js";
import { registerPublicationTools } from "./publications.js";
import { registerTagTools } from "./tags.js";
import { registerSalesWindowTools } from "./sales-window.js";

/**
 * Register all Shopify tools with the MCP server
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerTools(server) {
  registerStoreTools(server);
  registerOperationTools(server);
  registerProductTools(server);
  registerTagTools(server);
  registerCollectionTools(server);
  registerPublicationTools(server);
  registerOrderTools(server);
  registerCustomerTools(server);
  registerInventoryTools(server);
  registerSalesWindowTools(server);
}
