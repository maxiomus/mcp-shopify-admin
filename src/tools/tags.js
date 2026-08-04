import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore, isProduction } from "../stores/registry.js";
import { workflowEngine, OperationType } from "../workflow/engine.js";

/**
 * Additive / subtractive tag tools.
 *
 * WHY THIS EXISTS: `productUpdate(input: {tags: [...]})` REPLACES the entire tag
 * array. Any concurrent tagging job therefore silently clobbers the other's tags
 * (last writer wins), and a stale read destroys pre-existing tags. Shopify's
 * `tagsAdd` / `tagsRemove` mutations are additive/subtractive and carry no such
 * race. Always prefer these tools over product_update for tag changes.
 */

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const PRODUCT_TAGS_QUERY = `
  query ProductTags($id: ID!) {
    product(id: $id) { id title tags }
  }
`;

function buildTargetSchema() {
  return z
    .array(
      z.object({
        id: z.string().describe("Product ID (numeric or GID)"),
        tags: z.array(z.string()).min(1).describe("Tags for this product"),
      })
    )
    .min(1)
    .max(250)
    .describe("Per-product tag targets (max 250)");
}

export function registerTagTools(server) {
  // ------------------------------------------
  // ADD TAGS (staged)
  // ------------------------------------------

  server.registerTool(
    "product_tags_add_plan",
    {
      title: "Plan Add Product Tags",
      description:
        "Plan an ADDITIVE tag operation across products. Uses Shopify's tagsAdd mutation, which appends tags " +
        "without touching existing ones — safe to run concurrently and immune to the stale-snapshot tag loss that " +
        "productUpdate causes. Use this instead of product_update whenever you only need to add tags. " +
        "Supply either `targets` (per-product tags) or `product_ids` + `tags` (same tags for all).",
      inputSchema: {
        store: z.string().describe("Store name"),
        targets: buildTargetSchema().optional(),
        product_ids: z
          .array(z.string())
          .min(1)
          .max(250)
          .optional()
          .describe("Product IDs to tag, when every product gets the same tags"),
        tags: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Tags to add to every product in product_ids"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, targets, product_ids, tags, response_format }) => {
      requireStore(store);

      let resolved = targets;
      if (!resolved) {
        if (!product_ids || !tags) {
          return {
            content: [{ type: "text", text: "Provide either `targets`, or both `product_ids` and `tags`." }],
            isError: true,
          };
        }
        resolved = product_ids.map((id) => ({ id, tags }));
      }

      const distinctTags = [...new Set(resolved.flatMap((t) => t.tags))];

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.PRODUCT_TAGS_ADD,
        payload: { targets: resolved },
        description: `Add tags to ${resolved.length} product(s): ${distinctTags.join(", ")}`,
        affectedResources: resolved.map((t) => `Product ID: ${t.id}`),
      });

      if (response_format === "markdown") {
        const warn = isProduction(store) ? "\n\n**WARNING: PRODUCTION store!**" : "";
        let md = `# Add Tags Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store} (${result.storeEnvironment})${warn}\n`;
        md += `**Products:** ${resolved.length}\n**Distinct tags:** ${distinctTags.join(", ")}\n\n`;
        md += `Additive — no existing tag will be removed.\n\n`;
        md += `## Next Step\nCall \`product_tags_add_preview\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "product_tags_add_preview",
    {
      title: "Preview Add Product Tags",
      description:
        "Preview an additive tag operation. Shows, per product, which tags are genuinely new versus already present.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_tags_add_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        const items = [];
        for (const target of operation.payload.targets) {
          try {
            const data = await shopifyGraphQL(operation.store, PRODUCT_TAGS_QUERY, {
              id: buildGid("Product", target.id),
            });
            if (!data.product) {
              items.push({ id: target.id, status: "NOT_FOUND", title: "Unknown", newTags: [], existingTags: [] });
              continue;
            }
            const current = data.product.tags || [];
            const newTags = target.tags.filter((t) => !current.includes(t));
            items.push({
              id: target.id,
              status: "READY",
              title: data.product.title,
              currentTagCount: current.length,
              newTags,
              alreadyPresent: target.tags.filter((t) => current.includes(t)),
              noChange: newTags.length === 0,
            });
          } catch (e) {
            items.push({ id: target.id, status: "ERROR", error: e.message, newTags: [] });
          }
        }

        return {
          action: "TAGS_ADD",
          totalItems: items.length,
          changing: items.filter((i) => i.status === "READY" && !i.noChange).length,
          noChange: items.filter((i) => i.noChange).length,
          notFound: items.filter((i) => i.status === "NOT_FOUND").length,
          errors: items.filter((i) => i.status === "ERROR").length,
          items,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        const p = result.preview;
        let md = `# Add Tags Preview\n\n**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store}\n\n`;
        md += `## Summary\n- Total: ${p.totalItems}\n- Will change: ${p.changing}\n- Already tagged: ${p.noChange}\n- Not found: ${p.notFound}\n- Errors: ${p.errors}\n\n`;
        md += "| ID | Title | Current tags | Tags to add |\n|---|---|---|---|\n";
        p.items.forEach((i) => {
          md += `| ${i.id} | ${i.title || "-"} | ${i.currentTagCount ?? "-"} | ${i.newTags.join(", ") || "-"} |\n`;
        });
        md += `\n## Next Step\nCall \`product_tags_add_execute\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "product_tags_add_execute",
    {
      title: "Execute Add Product Tags",
      description:
        "Execute a previewed additive tag operation via Shopify's tagsAdd mutation. Existing tags are never removed. " +
        "Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_tags_add_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const results = { total: operation.payload.targets.length, succeeded: 0, failed: 0, items: [] };
        for (const target of operation.payload.targets) {
          try {
            const data = await shopifyGraphQL(operation.store, TAGS_ADD_MUTATION, {
              id: buildGid("Product", target.id),
              tags: target.tags,
            });
            if (data.tagsAdd.userErrors?.length > 0) {
              results.failed++;
              results.items.push({
                id: target.id,
                status: "FAILED",
                error: data.tagsAdd.userErrors.map((e) => e.message).join("; "),
              });
            } else {
              results.succeeded++;
              results.items.push({ id: target.id, status: "SUCCEEDED", tags: target.tags });
            }
          } catch (e) {
            results.failed++;
            results.items.push({ id: target.id, status: "FAILED", error: e.message });
          }
        }
        return results;
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);
        if (response_format === "markdown") {
          const r = result.result;
          let md = `# Tags Added\n\n**Store:** ${result.store}\n**Executed At:** ${result.executedAt}\n\n`;
          md += `- Total: ${r.total}\n- Succeeded: ${r.succeeded}\n- Failed: ${r.failed}\n`;
          if (r.failed > 0) {
            md += `\n| ID | Error |\n|---|---|\n`;
            r.items.filter((i) => i.status === "FAILED").forEach((i) => (md += `| ${i.id} | ${i.error} |\n`));
          }
          return { content: [{ type: "text", text: md }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Execution failed: ${error.message}` }], isError: true };
      }
    }
  );

  // ------------------------------------------
  // REMOVE TAGS (staged)
  // ------------------------------------------

  server.registerTool(
    "product_tags_remove_plan",
    {
      title: "Plan Remove Product Tags",
      description:
        "Plan a SUBTRACTIVE tag operation using Shopify's tagsRemove mutation. Removes only the named tags and " +
        "leaves every other tag untouched.",
      inputSchema: {
        store: z.string().describe("Store name"),
        targets: buildTargetSchema().optional(),
        product_ids: z.array(z.string()).min(1).max(250).optional().describe("Product IDs"),
        tags: z.array(z.string()).min(1).optional().describe("Tags to remove from every product in product_ids"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, targets, product_ids, tags, response_format }) => {
      requireStore(store);

      let resolved = targets;
      if (!resolved) {
        if (!product_ids || !tags) {
          return {
            content: [{ type: "text", text: "Provide either `targets`, or both `product_ids` and `tags`." }],
            isError: true,
          };
        }
        resolved = product_ids.map((id) => ({ id, tags }));
      }

      const distinctTags = [...new Set(resolved.flatMap((t) => t.tags))];
      const result = workflowEngine.plan({
        store,
        operationType: OperationType.PRODUCT_TAGS_REMOVE,
        payload: { targets: resolved },
        description: `Remove tags from ${resolved.length} product(s): ${distinctTags.join(", ")}`,
        affectedResources: resolved.map((t) => `Product ID: ${t.id}`),
      });

      if (response_format === "markdown") {
        const warn = isProduction(store) ? "\n\n**WARNING: PRODUCTION store!**" : "";
        let md = `# Remove Tags Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store}${warn}\n`;
        md += `**Products:** ${resolved.length}\n**Tags to remove:** ${distinctTags.join(", ")}\n\n`;
        md += `## Next Step\nCall \`product_tags_remove_preview\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "product_tags_remove_preview",
    {
      title: "Preview Remove Product Tags",
      description: "Preview a subtractive tag operation — shows which named tags are actually present per product.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_tags_remove_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        const items = [];
        for (const target of operation.payload.targets) {
          try {
            const data = await shopifyGraphQL(operation.store, PRODUCT_TAGS_QUERY, {
              id: buildGid("Product", target.id),
            });
            if (!data.product) {
              items.push({ id: target.id, status: "NOT_FOUND", willRemove: [] });
              continue;
            }
            const current = data.product.tags || [];
            const willRemove = target.tags.filter((t) => current.includes(t));
            items.push({
              id: target.id,
              status: "READY",
              title: data.product.title,
              currentTagCount: current.length,
              willRemove,
              noChange: willRemove.length === 0,
            });
          } catch (e) {
            items.push({ id: target.id, status: "ERROR", error: e.message, willRemove: [] });
          }
        }
        return {
          action: "TAGS_REMOVE",
          totalItems: items.length,
          changing: items.filter((i) => i.status === "READY" && !i.noChange).length,
          noChange: items.filter((i) => i.noChange).length,
          items,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        const p = result.preview;
        let md = `# Remove Tags Preview\n\n**Operation ID:** \`${result.operationId}\`\n\n`;
        md += `- Total: ${p.totalItems}\n- Will change: ${p.changing}\n- No change: ${p.noChange}\n\n`;
        md += "| ID | Title | Tags to remove |\n|---|---|---|\n";
        p.items.forEach((i) => (md += `| ${i.id} | ${i.title || "-"} | ${i.willRemove.join(", ") || "-"} |\n`));
        md += `\n## Next Step\nCall \`product_tags_remove_execute\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "product_tags_remove_execute",
    {
      title: "Execute Remove Product Tags",
      description:
        "Execute a previewed subtractive tag operation via tagsRemove. Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_tags_remove_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const results = { total: operation.payload.targets.length, succeeded: 0, failed: 0, items: [] };
        for (const target of operation.payload.targets) {
          try {
            const data = await shopifyGraphQL(operation.store, TAGS_REMOVE_MUTATION, {
              id: buildGid("Product", target.id),
              tags: target.tags,
            });
            if (data.tagsRemove.userErrors?.length > 0) {
              results.failed++;
              results.items.push({
                id: target.id,
                status: "FAILED",
                error: data.tagsRemove.userErrors.map((e) => e.message).join("; "),
              });
            } else {
              results.succeeded++;
              results.items.push({ id: target.id, status: "SUCCEEDED", tags: target.tags });
            }
          } catch (e) {
            results.failed++;
            results.items.push({ id: target.id, status: "FAILED", error: e.message });
          }
        }
        return results;
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);
        if (response_format === "markdown") {
          const r = result.result;
          let md = `# Tags Removed\n\n- Total: ${r.total}\n- Succeeded: ${r.succeeded}\n- Failed: ${r.failed}\n`;
          return { content: [{ type: "text", text: md }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Execution failed: ${error.message}` }], isError: true };
      }
    }
  );
}
