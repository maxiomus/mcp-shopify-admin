import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore, isProduction } from "../stores/registry.js";
import { workflowEngine, OperationType } from "../workflow/engine.js";

// ============================================
// GraphQL
// ============================================

const PUBLICATION_LIST_QUERY = `
  query ListPublications($first: Int!) {
    publications(first: $first) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const RESOURCE_PUBLICATIONS_QUERY = `
  query ResourcePublications($id: ID!) {
    product(id: $id) {
      id
      title
      status
      resourcePublicationsV2(first: 25) {
        edges {
          node {
            isPublished
            publishDate
            publication { id name }
          }
        }
      }
    }
  }
`;

const PUBLISHABLE_PUBLISH_MUTATION = `
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product { id title }
      }
      userErrors { field message }
    }
  }
`;

// ============================================
// Registration
// ============================================

export function registerPublicationTools(server) {
  server.registerTool(
    "publication_list",
    {
      title: "List Publications (Sales Channels)",
      description:
        "List the store's publications (sales channels) — Online Store, Facebook & Instagram, Point of Sale, etc. " +
        "You need a publication ID before you can publish a product to a channel.",
      inputSchema: {
        store: z.string().describe("Store name"),
        limit: z.number().min(1).max(50).default(25).describe("Number of publications"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, limit, response_format }) => {
      requireStore(store);
      const data = await shopifyGraphQL(store, PUBLICATION_LIST_QUERY, { first: limit });
      const items = data.publications.edges.map((e) => ({
        id: parseGid(e.node.id),
        gid: e.node.id,
        name: e.node.name,
      }));

      if (response_format === "markdown") {
        let md = `# Publications / Sales Channels (${items.length})\n\n`;
        md += "| ID | Name |\n|---|---|\n";
        items.forEach((p) => (md += `| ${p.id} | ${p.name} |\n`));
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ publications: items }, null, 2) }] };
    }
  );

  server.registerTool(
    "product_publications_get",
    {
      title: "Get Product Publication Status",
      description:
        "Show which sales channels a product is published to. Useful for diagnosing products that exist in a " +
        "collection but never appear on the storefront or in an external feed.",
      inputSchema: {
        store: z.string().describe("Store name"),
        id: z.string().describe("Product ID (numeric or GID)"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, id, response_format }) => {
      requireStore(store);
      const data = await shopifyGraphQL(store, RESOURCE_PUBLICATIONS_QUERY, {
        id: buildGid("Product", id),
      });
      if (!data.product) {
        return { content: [{ type: "text", text: `Product ${id} not found.` }], isError: true };
      }

      const rows = data.product.resourcePublicationsV2.edges.map((e) => ({
        publicationId: parseGid(e.node.publication.id),
        publicationGid: e.node.publication.id,
        name: e.node.publication.name,
        isPublished: e.node.isPublished,
        publishDate: e.node.publishDate,
      }));

      const result = {
        productId: parseGid(data.product.id),
        title: data.product.title,
        status: data.product.status,
        publications: rows,
      };

      if (response_format === "markdown") {
        let md = `# ${result.title}\n\n**Product Status:** ${result.status}\n\n`;
        md += "| Channel | Published | Date |\n|---|---|---|\n";
        rows.forEach((r) => (md += `| ${r.name} | ${r.isPublished ? "Yes" : "**No**"} | ${r.publishDate || "-"} |\n`));
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ------------------------------------------
  // PUBLISH (staged)
  // ------------------------------------------

  server.registerTool(
    "product_publish_plan",
    {
      title: "Plan Product Publish",
      description:
        "Plan publishing one or more products to one or more sales channels. Use publication_list to get channel IDs. " +
        "Staged: must be previewed then executed.",
      inputSchema: {
        store: z.string().describe("Store name"),
        product_ids: z.array(z.string()).min(1).max(100).describe("Product IDs (numeric or GID), max 100"),
        publication_ids: z.array(z.string()).min(1).max(10).describe("Publication IDs from publication_list"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ store, product_ids, publication_ids, response_format }) => {
      requireStore(store);
      const result = workflowEngine.plan({
        store,
        operationType: OperationType.PRODUCT_PUBLISH,
        payload: { productIds: product_ids, publicationIds: publication_ids },
        description: `Publish ${product_ids.length} product(s) to ${publication_ids.length} channel(s)`,
        affectedResources: product_ids.map((id) => `Product ID: ${id}`),
      });

      if (response_format === "markdown") {
        const warn = isProduction(store) ? "\n\n**WARNING: PRODUCTION store!**" : "";
        let md = `# Product Publish Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store}${warn}\n`;
        md += `**Products:** ${product_ids.length}\n**Channels:** ${publication_ids.length}\n\n`;
        md += `## Next Step\nCall \`product_publish_preview\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "product_publish_preview",
    {
      title: "Preview Product Publish",
      description: "Preview which products will change publication state, and on which channels.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_publish_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        const targets = new Set(operation.payload.publicationIds.map((p) => parseGid(p)));
        const items = [];

        for (const pid of operation.payload.productIds) {
          try {
            const data = await shopifyGraphQL(operation.store, RESOURCE_PUBLICATIONS_QUERY, {
              id: buildGid("Product", pid),
            });
            if (!data.product) {
              items.push({ id: pid, status: "NOT_FOUND", title: "Unknown", willPublishTo: [] });
              continue;
            }
            const already = data.product.resourcePublicationsV2.edges
              .filter((e) => e.node.isPublished)
              .map((e) => parseGid(e.node.publication.id));
            const willPublishTo = [...targets].filter((t) => !already.includes(t));
            items.push({
              id: pid,
              status: "READY",
              title: data.product.title,
              productStatus: data.product.status,
              alreadyPublishedTo: already.length,
              willPublishTo,
              noChange: willPublishTo.length === 0,
            });
          } catch (e) {
            items.push({ id: pid, status: "ERROR", error: e.message, willPublishTo: [] });
          }
        }

        return {
          action: "PUBLISH",
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
        let md = `# Product Publish Preview\n\n**Operation ID:** \`${result.operationId}\`\n**Store:** ${result.store}\n\n`;
        md += `## Summary\n- Total: ${p.totalItems}\n- Will change: ${p.changing}\n- Already published: ${p.noChange}\n- Not found: ${p.notFound}\n- Errors: ${p.errors}\n\n`;
        md += "| ID | Title | Status | Channels to add |\n|---|---|---|---|\n";
        p.items.forEach((i) => {
          md += `| ${i.id} | ${i.title || "-"} | ${i.productStatus || i.status} | ${i.willPublishTo.length} |\n`;
        });
        md += `\n## Next Step\nCall \`product_publish_execute\` with \`operation_id: "${result.operationId}"\`\n`;
        return { content: [{ type: "text", text: md }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "product_publish_execute",
    {
      title: "Execute Product Publish",
      description:
        "Execute a previewed publish. Publishing is additive — it never unpublishes a product from a channel it is " +
        "already on. Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from product_publish_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const input = operation.payload.publicationIds.map((p) => ({
          publicationId: buildGid("Publication", p),
        }));
        const results = { total: operation.payload.productIds.length, succeeded: 0, failed: 0, items: [] };

        for (const pid of operation.payload.productIds) {
          try {
            const data = await shopifyGraphQL(operation.store, PUBLISHABLE_PUBLISH_MUTATION, {
              id: buildGid("Product", pid),
              input,
            });
            if (data.publishablePublish.userErrors?.length > 0) {
              results.failed++;
              results.items.push({
                id: pid,
                status: "FAILED",
                error: data.publishablePublish.userErrors.map((e) => e.message).join("; "),
              });
            } else {
              results.succeeded++;
              results.items.push({
                id: pid,
                status: "SUCCEEDED",
                title: data.publishablePublish.publishable?.title,
              });
            }
          } catch (e) {
            results.failed++;
            results.items.push({ id: pid, status: "FAILED", error: e.message });
          }
        }
        return results;
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);
        if (response_format === "markdown") {
          const r = result.result;
          let md = `# Publish Complete\n\n**Store:** ${result.store}\n**Executed At:** ${result.executedAt}\n\n`;
          md += `- Total: ${r.total}\n- Succeeded: ${r.succeeded}\n- Failed: ${r.failed}\n\n`;
          if (r.failed > 0) {
            md += "| ID | Error |\n|---|---|\n";
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
}
