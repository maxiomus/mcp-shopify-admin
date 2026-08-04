import { z } from "zod";
import { listStores, getDefaultStoreName } from "../stores/registry.js";

/**
 * Register store management tools
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerStoreTools(server) {
  // List configured stores
  server.registerTool(
    "store_list",
    {
      title: "List Configured Stores",
      description:
        "List all configured Shopify stores. Use this to see available stores before performing operations. " +
        "Each store has a name, environment (production/staging/development), and default status.",
      inputSchema: {
        response_format: z
          .enum(["json", "markdown"])
          .default("json")
          .describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      const stores = listStores();
      const defaultStore = getDefaultStoreName();

      const result = {
        stores,
        defaultStore,
        total: stores.length,
      };

      if (response_format === "markdown") {
        let md = `# Configured Stores (${stores.length})\n\n`;
        md += `**Default Store:** ${defaultStore}\n\n`;
        md += "| Name | Domain | Environment | Default |\n";
        md += "|------|--------|-------------|--------|\n";

        stores.forEach((store) => {
          const envBadge =
            store.environment === "production" ? "PRODUCTION" : store.environment;
          const defaultBadge = store.isDefault ? "Yes" : "-";
          md += `| ${store.name} | ${store.domain} | ${envBadge} | ${defaultBadge} |\n`;
        });

        md += "\n---\n";
        md += "*All write operations require explicit store selection and follow a staged workflow:*\n";
        md += "1. **Plan** - Create operation plan\n";
        md += "2. **Preview** - Review changes before execution\n";
        md += "3. **Execute** - Apply changes (requires `confirm_production: true` for production stores)\n";

        return { content: [{ type: "text", text: md }] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
