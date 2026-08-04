import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore } from "../stores/registry.js";

/**
 * Format customers list response
 */
function formatCustomers(customers, pageInfo, format) {
  const items = customers.map((edge) => {
    const node = edge.node;
    return {
      id: parseGid(node.id),
      displayName: node.displayName,
      email: node.email,
      phone: node.phone,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      ordersCount: node.ordersCount,
      totalSpentV2: node.totalSpentV2
        ? `${node.totalSpentV2.amount} ${node.totalSpentV2.currencyCode}`
        : null,
      state: node.state,
      tags: node.tags,
    };
  });

  const result = {
    customers: items,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      hasPreviousPage: pageInfo.hasPreviousPage,
      endCursor: pageInfo.endCursor,
      startCursor: pageInfo.startCursor,
    },
    total: items.length,
  };

  if (format === "markdown") {
    let md = `# Customers (${items.length} results)\n\n`;
    if (pageInfo.hasNextPage) {
      md += `*More results available. Use cursor: \`${pageInfo.endCursor}\`*\n\n`;
    }
    md += "| ID | Name | Email | Orders | Total Spent |\n";
    md += "|---|---|---|---|---|\n";
    items.forEach((c) => {
      md += `| ${c.id} | ${c.displayName} | ${c.email || "-"} | ${c.ordersCount} | ${c.totalSpentV2 || "-"} |\n`;
    });
    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/**
 * Format single customer response
 */
function formatCustomer(customer, format) {
  const c = {
    id: parseGid(customer.id),
    displayName: customer.displayName,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    ordersCount: customer.ordersCount,
    totalSpentV2: customer.totalSpentV2
      ? `${customer.totalSpentV2.amount} ${customer.totalSpentV2.currencyCode}`
      : null,
    state: customer.state,
    tags: customer.tags,
    note: customer.note,
    verifiedEmail: customer.verifiedEmail,
    taxExempt: customer.taxExempt,
    defaultAddress: customer.defaultAddress
      ? {
          address1: customer.defaultAddress.address1,
          address2: customer.defaultAddress.address2,
          city: customer.defaultAddress.city,
          province: customer.defaultAddress.province,
          country: customer.defaultAddress.country,
          zip: customer.defaultAddress.zip,
          phone: customer.defaultAddress.phone,
        }
      : null,
    recentOrders: customer.orders?.edges?.map((e) => ({
      id: parseGid(e.node.id),
      name: e.node.name,
      createdAt: e.node.createdAt,
      displayFinancialStatus: e.node.displayFinancialStatus,
      displayFulfillmentStatus: e.node.displayFulfillmentStatus,
      totalPriceSet: e.node.totalPriceSet?.shopMoney
        ? `${e.node.totalPriceSet.shopMoney.amount} ${e.node.totalPriceSet.shopMoney.currencyCode}`
        : null,
    })),
  };

  if (format === "markdown") {
    let md = `# ${c.displayName}\n\n`;
    md += `**ID:** ${c.id}\n`;
    md += `**Email:** ${c.email || "-"}${c.verifiedEmail ? " (verified)" : ""}\n`;
    md += `**Phone:** ${c.phone || "-"}\n`;
    md += `**State:** ${c.state}\n`;
    md += `**Created:** ${c.createdAt}\n\n`;

    md += `## Summary\n`;
    md += `- **Orders:** ${c.ordersCount}\n`;
    md += `- **Total Spent:** ${c.totalSpentV2 || "-"}\n`;
    md += `- **Tax Exempt:** ${c.taxExempt ? "Yes" : "No"}\n`;
    if (c.tags?.length) {
      md += `- **Tags:** ${c.tags.join(", ")}\n`;
    }
    md += "\n";

    if (c.note) {
      md += `## Notes\n${c.note}\n\n`;
    }

    if (c.defaultAddress) {
      md += `## Default Address\n`;
      md += `${c.defaultAddress.address1}\n`;
      if (c.defaultAddress.address2) md += `${c.defaultAddress.address2}\n`;
      md += `${c.defaultAddress.city}, ${c.defaultAddress.province} ${c.defaultAddress.zip}\n`;
      md += `${c.defaultAddress.country}\n`;
      if (c.defaultAddress.phone) md += `Phone: ${c.defaultAddress.phone}\n`;
      md += "\n";
    }

    if (c.recentOrders?.length) {
      md += `## Recent Orders (${c.recentOrders.length})\n\n`;
      md += "| Order # | Date | Financial | Fulfillment | Total |\n";
      md += "|---|---|---|---|---|\n";
      c.recentOrders.forEach((o) => {
        const date = new Date(o.createdAt).toLocaleDateString();
        md += `| ${o.name} | ${date} | ${o.displayFinancialStatus} | ${o.displayFulfillmentStatus} | ${o.totalPriceSet || "-"} |\n`;
      });
    }

    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
}

// GraphQL Queries
const CUSTOMER_LIST_QUERY = `
  query ListCustomers($first: Int!, $query: String, $after: String) {
    customers(first: $first, query: $query, after: $after) {
      edges {
        node {
          id
          displayName
          email
          phone
          createdAt
          updatedAt
          ordersCount
          totalSpentV2 {
            amount
            currencyCode
          }
          state
          tags
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

const CUSTOMER_GET_QUERY = `
  query GetCustomer($id: ID!) {
    customer(id: $id) {
      id
      displayName
      firstName
      lastName
      email
      phone
      createdAt
      updatedAt
      ordersCount
      totalSpentV2 {
        amount
        currencyCode
      }
      state
      tags
      note
      verifiedEmail
      taxExempt
      defaultAddress {
        address1
        address2
        city
        province
        country
        zip
        phone
      }
      orders(first: 10, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
          }
        }
      }
    }
  }
`;

export function registerCustomerTools(server) {
  // List Customers
  server.registerTool(
    "customer_list",
    {
      title: "List Customers",
      description:
        "List customers from a Shopify store with optional search and pagination.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
        limit: z.number().min(1).max(250).default(50).describe("Number of customers to return (1-250)"),
        query: z.string().optional().describe("Search query (e.g., 'email:john@example.com' or 'tag:vip')"),
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

      const data = await shopifyGraphQL(store, CUSTOMER_LIST_QUERY, {
        first: limit,
        query: query || null,
        after: cursor || null,
      });

      return formatCustomers(
        data.customers.edges,
        data.customers.pageInfo,
        response_format
      );
    }
  );

  // Get Customer
  server.registerTool(
    "customer_get",
    {
      title: "Get Customer",
      description:
        "Get detailed information about a specific customer including their address and recent orders.",
      inputSchema: {
        store: z.string().describe("Store name"),
        id: z.string().describe("Customer ID (numeric ID or full GID)"),
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

      const data = await shopifyGraphQL(store, CUSTOMER_GET_QUERY, {
        id: buildGid("Customer", id),
      });

      if (!data.customer) {
        return {
          content: [{ type: "text", text: `Customer with ID ${id} not found.` }],
          isError: true,
        };
      }

      return formatCustomer(data.customer, response_format);
    }
  );
}
