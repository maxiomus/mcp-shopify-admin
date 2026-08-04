import { z } from "zod";
import { workflowEngine } from "../workflow/engine.js";

/**
 * Register operation management tools
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 */
export function registerOperationTools(server) {
  // List pending operations
  server.registerTool(
    "operation_list",
    {
      title: "List Pending Operations",
      description:
        "List all pending operations that are waiting for preview or execution. " +
        "Operations expire after 30 minutes if not executed.",
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
      const operations = workflowEngine.listPending();

      const result = {
        operations,
        total: operations.length,
      };

      if (response_format === "markdown") {
        if (operations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "# Pending Operations\n\nNo pending operations.",
              },
            ],
          };
        }

        let md = `# Pending Operations (${operations.length})\n\n`;
        md += "| Operation ID | Type | Store | State | Created |\n";
        md += "|--------------|------|-------|-------|--------|\n";

        operations.forEach((op) => {
          const created = new Date(op.createdAt).toLocaleString();
          md += `| \`${op.operationId.slice(0, 8)}...\` | ${op.operationType} | ${op.store} | ${op.state} | ${created} |\n`;
        });

        md += "\n---\n";
        md += "*Use `operation_status(operation_id)` to see full details*\n";

        return { content: [{ type: "text", text: md }] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Get operation status
  server.registerTool(
    "operation_status",
    {
      title: "Get Operation Status",
      description:
        "Get detailed status of a specific operation including its current state, preview data, and result.",
      inputSchema: {
        operation_id: z.string().describe("The operation ID to look up"),
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
    async ({ operation_id, response_format }) => {
      const status = workflowEngine.getStatus(operation_id);

      if (!status) {
        return {
          content: [
            {
              type: "text",
              text: `Operation "${operation_id}" not found or expired.`,
            },
          ],
          isError: true,
        };
      }

      if (response_format === "markdown") {
        let md = `# Operation Status\n\n`;
        md += `**Operation ID:** \`${status.operationId}\`\n`;
        md += `**State:** ${status.state}\n`;
        md += `**Store:** ${status.store}\n`;
        md += `**Type:** ${status.operationType}\n`;
        md += `**Description:** ${status.description}\n\n`;

        md += `## Timeline\n`;
        md += `- **Created:** ${status.createdAt}\n`;
        md += `- **Updated:** ${status.updatedAt}\n`;
        if (status.executedAt) {
          md += `- **Executed:** ${status.executedAt}\n`;
        }

        if (status.affectedResources?.length > 0) {
          md += `\n## Affected Resources\n`;
          status.affectedResources.forEach((r) => {
            md += `- ${r}\n`;
          });
        }

        if (status.preview) {
          md += `\n## Preview\n`;
          md += "```json\n";
          md += JSON.stringify(status.preview, null, 2);
          md += "\n```\n";
        }

        if (status.result) {
          md += `\n## Result\n`;
          md += "```json\n";
          md += JSON.stringify(status.result, null, 2);
          md += "\n```\n";
        }

        // Next steps based on state
        md += `\n## Next Steps\n`;
        switch (status.state) {
          case "PLANNED":
            md += `Call the corresponding \`_preview\` tool with \`operation_id: "${status.operationId}"\`\n`;
            break;
          case "PREVIEWED":
            md += `Review the preview above. If approved, call the corresponding \`_execute\` tool.\n`;
            if (status.store.includes("PRODUCTION")) {
              md += `**Note:** This targets a production store. You must pass \`confirm_production: true\` to execute.\n`;
            }
            break;
          case "EXECUTED":
            md += `This operation has been completed.\n`;
            break;
          case "CANCELLED":
            md += `This operation was cancelled.\n`;
            break;
        }

        return { content: [{ type: "text", text: md }] };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  // Cancel operation
  server.registerTool(
    "operation_cancel",
    {
      title: "Cancel Pending Operation",
      description:
        "Cancel a pending operation that has not yet been executed. " +
        "This is useful if you want to discard a planned operation.",
      inputSchema: {
        operation_id: z.string().describe("The operation ID to cancel"),
        response_format: z
          .enum(["json", "markdown"])
          .default("json")
          .describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id, response_format }) => {
      try {
        const result = workflowEngine.cancel(operation_id);

        if (response_format === "markdown") {
          let md = `# Operation Cancelled\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Status:** ${result.state}\n`;
          md += `**Message:** ${result.message}\n`;

          return { content: [{ type: "text", text: md }] };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to cancel operation: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
