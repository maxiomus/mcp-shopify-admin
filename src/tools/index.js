import { registerProductTools } from "./products.js";
import { registerOrderTools } from "./orders.js";
import { registerCustomerTools } from "./customers.js";
import { registerInventoryTools } from "./inventory.js";

/**
 * Register all Shopify tools with the MCP server
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerTools(server) {
  registerProductTools(server);
  registerOrderTools(server);
  registerCustomerTools(server);
  registerInventoryTools(server);
}
