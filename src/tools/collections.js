import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore, isProduction } from "../stores/registry.js";
import { workflowEngine, OperationType } from "../workflow/engine.js";

// ============================================
// GraphQL
// ============================================

const COLLECTION_FIELDS = `
  id
  title
  handle
  updatedAt
  sortOrder
  productsCount { count }
  ruleSet {
    appliedDisjunctively
    rules { column relation condition }
  }
`;

const COLLECTION_LIST_QUERY = `
  query ListCollections($first: Int!, $query: String, $after: String) {
    collections(first: $first, query: $query, after: $after) {
      edges {
        node { ${COLLECTION_FIELDS} }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COLLECTION_GET_QUERY = `
  query GetCollection($id: ID!) {
    collection(id: $id) { ${COLLECTION_FIELDS} }
  }
`;

const COLLECTION_BY_HANDLE_QUERY = `
  query GetCollectionByHandle($handle: String!) {
    collectionByHandle(handle: $handle) { ${COLLECTION_FIELDS} }
  }
`;

const COLLECTION_CREATE_MUTATION = `
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { ${COLLECTION_FIELDS} }
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `
  mutation UpdateCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { ${COLLECTION_FIELDS} }
      userErrors { field message }
    }
  }
`;

// ============================================
// Helpers
// ============================================

const RuleColumn = z.enum([
  "TAG",
  "TITLE",
  "TYPE",
  "VENDOR",
  "VARIANT_PRICE",
  "IS_PRICE_REDUCED",
  "VARIANT_COMPARE_AT_PRICE",
  "VARIANT_WEIGHT",
  "VARIANT_INVENTORY",
  "VARIANT_TITLE",
  "PRODUCT_TAXONOMY_NODE_ID",
]);

const RuleRelation = z.enum([
  "EQUALS",
  "NOT_EQUALS",
  "GREATER_THAN",
  "LESS_THAN",
  "STARTS_WITH",
  "ENDS_WITH",
  "CONTAINS",
  "NOT_CONTAINS",
  "IS_SET",
  "IS_NOT_SET",
]);

const ruleSchema = z.object({
  column: RuleColumn.describe("Field the rule applies to (TAG for tag-based collections)"),
  relation: RuleRelation.describe("Comparison operator"),
  condition: z.string().describe("Value to compare against (e.g. the tag name)"),
});

function formatCollection(c) {
  if (!c) return null;
  return {
    id: parseGid(c.id),
    gid: c.id,
    title: c.title,
    handle: c.handle,
    updatedAt: c.updatedAt,
    sortOrder: c.sortOrder,
    productsCount: c.productsCount?.count ?? null,
    // A collection with no ruleSet is MANUAL; with a ruleSet it is AUTOMATED (smart).
    type: c.ruleSet ? "AUTOMATED" : "MANUAL",
    ruleSet: c.ruleSet
      ? {
          appliedDisjunctively: c.ruleSet.appliedDisjunctively,
          rules: c.ruleSet.rules,
        }
      : null,
  };
}

function collectionsMarkdown(items, pageInfo) {
  let md = `# Collections (${items.length})\n\n`;
  if (pageInfo?.hasNextPage) {
    md += `*More available. cursor: \`${pageInfo.endCursor}\`*\n\n`;
  }
  md += "| ID | Title | Handle | Type | Products | Rules |\n";
  md += "|---|---|---|---|---|---|\n";
  items.forEach((c) => {
    const rules = c.ruleSet
      ? c.ruleSet.rules.map((r) => `${r.column} ${r.relation} "${r.condition}"`).join(" · ")
      : "-";
    md += `| ${c.id} | ${c.title} | ${c.handle} | ${c.type} | ${c.productsCount ?? "-"} | ${rules} |\n`;
  });
  return md;
}

// ============================================
// Registration
// ============================================

export function registerCollectionTools(server) {
  // ------------------------------------------
  // READ
  // ------------------------------------------

  server.registerTool(
    "collection_list",
    {
      title: "List Collections",
      description:
        "List collections in a store. Shows whether each collection is MANUAL (hand-picked products) " +
        "or AUTOMATED (rule-based), plus its rules and product count. " +
        "Only AUTOMATED collections propagate their membership to external product feeds such as the Meta catalog.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
        limit: z.number().min(1).max(250).default(50).describe("Number of collections to return"),
        query: z.string().optional().describe("Search query (e.g. 'title:dress')"),
        cursor: z.string().optional().describe("Pagination cursor"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, limit, query, cursor, response_format }) => {
      requireStore(store);
      const data = await shopifyGraphQL(store, COLLECTION_LIST_QUERY, {
        first: limit,
        query: query || null,
        after: cursor || null,
      });
      const items = data.collections.edges.map((e) => formatCollection(e.node));
      if (response_format === "markdown") {
        return { content: [{ type: "text", text: collectionsMarkdown(items, data.collections.pageInfo) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ collections: items, pageInfo: data.collections.pageInfo, total: items.length }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "collection_get",
    {
      title: "Get Collection",
      description:
        "Get one collection by numeric ID, full GID, or handle. Reports MANUAL vs AUTOMATED and the rule set.",
      inputSchema: {
        store: z.string().describe("Store name"),
        id: z.string().optional().describe("Collection ID (numeric or GID). Provide this or handle."),
        handle: z.string().optional().describe("Collection handle, e.g. 'cocktail-dresses'"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, id, handle, response_format }) => {
      requireStore(store);
      if (!id && !handle) {
        return { content: [{ type: "text", text: "Provide either id or handle." }], isError: true };
      }

      const data = id
        ? await shopifyGraphQL(store, COLLECTION_GET_QUERY, { id: buildGid("Collection", id) })
        : await shopifyGraphQL(store, COLLECTION_BY_HANDLE_QUERY, { handle });

      const node = id ? data.collection : data.collectionByHandle;
      if (!node) {
        return { content: [{ type: "text", text: `Collection not found (${id || handle}).` }], isError: true };
      }

      const c = formatCollection(node);
      if (response_format === "markdown") {
        let md = `# ${c.title}\n\n`;
        md += `**ID:** ${c.id}\n**Handle:** ${c.handle}\n**Type:** ${c.type}\n`;
        md += `**Products:** ${c.productsCount ?? "-"}\n**Updated:** ${c.updatedAt}\n\n`;
        if (c.ruleSet) {
          md += `## Rules (${c.ruleSet.appliedDisjunctively ? "ANY" : "ALL"} must match)\n`;
          c.ruleSet.rules.forEach((r) => {
            md += `- ${r.column} ${r.relation} "${r.condition}"\n`;
          });
        } else {
          md += `## Rules\nNone — this is a MANUAL collection. Its membership will NOT reach the Meta catalog.\n`;
        }
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
    }
  );

  // ------------------------------------------
  // UPDATE (staged) — set/replace the rule set, rename, or reorder
  // ------------------------------------------

  server.registerTool(
    "collection_update_plan",
    {
      title: "Plan Collection Update",
      description:
        "Plan an update to a collection. The main use is converting a MANUAL collection into an AUTOMATED one " +
        "by supplying a rule_set (e.g. TAG EQUALS 'or-cocktail-dresses'), which makes its membership visible to " +
        "external product feeds like the Meta catalog. Staged: must be previewed then executed.",
      inputSchema: {
        store: z.string().describe("Store name"),
        id: z.string().optional().describe("Collection ID (numeric or GID). Provide this or handle."),
        handle: z.string().optional().describe("Collection handle"),
        title: z.string().optional().describe("New title"),
        rule_set: z
          .object({
            appliedDisjunctively: z
              .boolean()
              .default(false)
              .describe("false = ALL rules must match (AND), true = ANY rule (OR)"),
            rules: z.array(ruleSchema).min(1).max(60).describe("Rules defining membership"),
          })
          .optional()
          .describe("Rule set. Supplying this converts a manual collection to automated."),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ store, id, handle, title, rule_set, response_format }) => {
      requireStore(store);
      if (!id && !handle) {
        return { content: [{ type: "text", text: "Provide either id or handle." }], isError: true };
      }

      const data = id
        ? await shopifyGraphQL(store, COLLECTION_GET_QUERY, { id: buildGid("Collection", id) })
        : await shopifyGraphQL(store, COLLECTION_BY_HANDLE_QUERY, { handle });
      const node = id ? data.collection : data.collectionByHandle;
      if (!node) {
        return { content: [{ type: "text", text: `Collection not found (${id || handle}).` }], isError: true };
      }

      const current = formatCollection(node);
      const updates = {};
      if (title !== undefined) updates.title = title;
      if (rule_set !== undefined) updates.ruleSet = rule_set;

      if (Object.keys(updates).length === 0) {
        return { content: [{ type: "text", text: "No updates supplied." }], isError: true };
      }

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.COLLECTION_UPDATE,
        payload: { id: current.id, updates, current },
        description: `Update collection "${current.title}" (${current.id})`,
        affectedResources: [`Collection: ${current.title} (${current.id}) — ${current.productsCount ?? "?"} products`],
      });

      if (response_format === "markdown") {
        const warn = isProduction(store) ? "\n\n**WARNING: PRODUCTION store!**" : "";
        let md = `# Collection Update Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${warn}\n\n`;
        md += `## Target\n- **${current.title}** (${current.id}) — currently **${current.type}**, ${current.productsCount ?? "?"} products\n\n`;
        md += `## Changes\n`;
        Object.entries(updates).forEach(([k, v]) => {
          md += `- **${k}:** ${JSON.stringify(v)}\n`;
        });
        if (updates.ruleSet && current.type === "MANUAL") {
          md += `\n**This converts a MANUAL collection to AUTOMATED.** Products that do not match the rules will drop out of the collection.\n`;
        }
        md += `\n## Next Step\nCall \`collection_update_preview\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "collection_update_preview",
    {
      title: "Preview Collection Update",
      description: "Preview a planned collection update, showing current vs new state.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from collection_update_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        const data = await shopifyGraphQL(operation.store, COLLECTION_GET_QUERY, {
          id: buildGid("Collection", operation.payload.id),
        });
        if (!data.collection) throw new Error(`Collection ${operation.payload.id} no longer exists`);
        const current = formatCollection(data.collection);
        const updates = operation.payload.updates;

        const changes = [];
        if (updates.title !== undefined && updates.title !== current.title) {
          changes.push({ field: "title", from: current.title, to: updates.title });
        }
        if (updates.ruleSet !== undefined) {
          changes.push({
            field: "ruleSet",
            from: current.ruleSet ? JSON.stringify(current.ruleSet) : "none (MANUAL)",
            to: JSON.stringify(updates.ruleSet),
          });
        }

        return {
          action: "UPDATE",
          collectionId: current.id,
          collectionTitle: current.title,
          currentType: current.type,
          newType: updates.ruleSet ? "AUTOMATED" : current.type,
          currentProductsCount: current.productsCount,
          changes,
          summary:
            current.type === "MANUAL" && updates.ruleSet
              ? `Converts MANUAL → AUTOMATED. Current members (${current.productsCount ?? "?"}) that do not match the rules will be removed from the collection.`
              : `${changes.length} field(s) will be updated`,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        const p = result.preview;
        let md = `# Collection Update Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store}\n`;
        md += `**Collection:** ${p.collectionTitle} (${p.collectionId})\n`;
        md += `**Type:** ${p.currentType} → ${p.newType}\n\n`;
        md += `## Changes\n\n| Field | Current | New |\n|---|---|---|\n`;
        p.changes.forEach((c) => {
          md += `| ${c.field} | ${c.from} | ${c.to} |\n`;
        });
        md += `\n${p.summary}\n`;
        if (result.warnings?.length) {
          md += `\n## Warnings\n`;
          result.warnings.forEach((w) => (md += `- ${w}\n`));
        }
        md += `\n## Next Step\nCall \`collection_update_execute\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "collection_update_execute",
    {
      title: "Execute Collection Update",
      description:
        "Execute a previewed collection update. Production stores require confirm_production: true. " +
        "Note: Shopify may reject converting an existing manual collection to automated; if so, create a new " +
        "automated collection with collection_create instead.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from collection_update_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const input = { id: buildGid("Collection", operation.payload.id), ...operation.payload.updates };
        const data = await shopifyGraphQL(operation.store, COLLECTION_UPDATE_MUTATION, { input });
        if (data.collectionUpdate.userErrors?.length > 0) {
          const errors = data.collectionUpdate.userErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
          throw new Error(`Failed to update collection: ${errors}`);
        }
        return { success: true, collection: formatCollection(data.collectionUpdate.collection) };
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);
        if (response_format === "markdown") {
          const c = result.result.collection;
          let md = `# Collection Updated\n\n`;
          md += `**Store:** ${result.store}\n**Executed At:** ${result.executedAt}\n\n`;
          md += `**${c.title}** (${c.id}) is now **${c.type}** with ${c.productsCount ?? "?"} products.\n`;
          return { content: [{ type: "text", text: md }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Execution failed: ${error.message}` }], isError: true };
      }
    }
  );

  // ------------------------------------------
  // CREATE (staged) — new automated collection
  // ------------------------------------------

  server.registerTool(
    "collection_create_plan",
    {
      title: "Plan Collection Creation",
      description:
        "Plan creation of a new collection, optionally AUTOMATED via a rule_set. Use this when Shopify refuses " +
        "to convert an existing manual collection: create an automated twin, then point downstream systems at it.",
      inputSchema: {
        store: z.string().describe("Store name"),
        title: z.string().describe("Collection title"),
        handle: z.string().optional().describe("Collection handle (auto-generated if omitted)"),
        descriptionHtml: z.string().optional().describe("Description (HTML)"),
        rule_set: z
          .object({
            appliedDisjunctively: z.boolean().default(false).describe("false = ALL rules (AND), true = ANY (OR)"),
            rules: z.array(ruleSchema).min(1).max(60),
          })
          .optional()
          .describe("Rule set. Omit to create a manual collection."),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ store, title, handle, descriptionHtml, rule_set, response_format }) => {
      requireStore(store);
      const payload = { title, handle, descriptionHtml, ruleSet: rule_set };
      const result = workflowEngine.plan({
        store,
        operationType: OperationType.COLLECTION_CREATE,
        payload,
        description: `Create collection "${title}"`,
        affectedResources: [`Collection: ${title}`],
      });

      if (response_format === "markdown") {
        const warn = isProduction(store) ? "\n\n**WARNING: PRODUCTION store!**" : "";
        let md = `# Collection Creation Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store}${warn}\n\n`;
        md += `- **Title:** ${title}\n- **Type:** ${rule_set ? "AUTOMATED" : "MANUAL"}\n`;
        if (rule_set) {
          rule_set.rules.forEach((r) => (md += `  - ${r.column} ${r.relation} "${r.condition}"\n`));
        }
        md += `\n## Next Step\nCall \`collection_create_preview\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "collection_create_preview",
    {
      title: "Preview Collection Creation",
      description: "Preview a planned collection creation.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from collection_create_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, response_format }) => {
      const result = await workflowEngine.preview(operation_id, async (operation) => ({
        action: "CREATE",
        collection: operation.payload,
        summary: `Will create ${operation.payload.ruleSet ? "AUTOMATED" : "MANUAL"} collection "${operation.payload.title}"`,
      }));

      if (response_format === "markdown") {
        let md = `# Collection Creation Preview\n\n**Operation ID:** \`${result.operationId}\`\n\n`;
        md += "```json\n" + JSON.stringify(result.preview.collection, null, 2) + "\n```\n";
        md += `\n## Next Step\nCall \`collection_create_execute\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "collection_create_execute",
    {
      title: "Execute Collection Creation",
      description: "Execute a previewed collection creation. Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from collection_create_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const input = {
          title: operation.payload.title,
          handle: operation.payload.handle,
          descriptionHtml: operation.payload.descriptionHtml,
        };
        if (operation.payload.ruleSet) input.ruleSet = operation.payload.ruleSet;

        const data = await shopifyGraphQL(operation.store, COLLECTION_CREATE_MUTATION, { input });
        if (data.collectionCreate.userErrors?.length > 0) {
          const errors = data.collectionCreate.userErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
          throw new Error(`Failed to create collection: ${errors}`);
        }
        return { success: true, collection: formatCollection(data.collectionCreate.collection) };
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);
        if (response_format === "markdown") {
          const c = result.result.collection;
          let md = `# Collection Created\n\n**${c.title}** (${c.id}) — ${c.type}, handle \`${c.handle}\`, ${c.productsCount ?? "?"} products\n`;
          return { content: [{ type: "text", text: md }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Execution failed: ${error.message}` }], isError: true };
      }
    }
  );
}
