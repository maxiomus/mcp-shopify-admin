import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../shopify/client.js";

/**
 * Format orders list response
 */
function formatOrders(orders, pageInfo, format) {
  const items = orders.map((edge) => {
    const node = edge.node;
    return {
      id: parseGid(node.id),
      name: node.name,
      email: node.email,
      createdAt: node.createdAt,
      displayFinancialStatus: node.displayFinancialStatus,
      displayFulfillmentStatus: node.displayFulfillmentStatus,
      totalPriceSet: node.totalPriceSet?.shopMoney
        ? `${node.totalPriceSet.shopMoney.amount} ${node.totalPriceSet.shopMoney.currencyCode}`
        : null,
      lineItemsCount: node.lineItems?.edges?.length || 0,
      customer: node.customer
        ? {
            id: parseGid(node.customer.id),
            displayName: node.customer.displayName,
          }
        : null,
    };
  });

  const result = {
    orders: items,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      hasPreviousPage: pageInfo.hasPreviousPage,
      endCursor: pageInfo.endCursor,
      startCursor: pageInfo.startCursor,
    },
    total: items.length,
  };

  if (format === "markdown") {
    let md = `# Orders (${items.length} results)\n\n`;
    if (pageInfo.hasNextPage) {
      md += `*More results available. Use cursor: \`${pageInfo.endCursor}\`*\n\n`;
    }
    md += "| Order # | Customer | Financial | Fulfillment | Total |\n";
    md += "|---|---|---|---|---|\n";
    items.forEach((o) => {
      md += `| ${o.name} | ${o.customer?.displayName || o.email || "-"} | ${o.displayFinancialStatus} | ${o.displayFulfillmentStatus} | ${o.totalPriceSet || "-"} |\n`;
    });
    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/**
 * Format single order response
 */
function formatOrder(order, format) {
  const o = {
    id: parseGid(order.id),
    name: order.name,
    email: order.email,
    phone: order.phone,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    displayFinancialStatus: order.displayFinancialStatus,
    displayFulfillmentStatus: order.displayFulfillmentStatus,
    totalPriceSet: order.totalPriceSet?.shopMoney
      ? `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`
      : null,
    subtotalPriceSet: order.subtotalPriceSet?.shopMoney
      ? `${order.subtotalPriceSet.shopMoney.amount} ${order.subtotalPriceSet.shopMoney.currencyCode}`
      : null,
    totalTaxSet: order.totalTaxSet?.shopMoney
      ? `${order.totalTaxSet.shopMoney.amount} ${order.totalTaxSet.shopMoney.currencyCode}`
      : null,
    customer: order.customer
      ? {
          id: parseGid(order.customer.id),
          displayName: order.customer.displayName,
          email: order.customer.email,
        }
      : null,
    shippingAddress: order.shippingAddress
      ? {
          name: order.shippingAddress.name,
          address1: order.shippingAddress.address1,
          address2: order.shippingAddress.address2,
          city: order.shippingAddress.city,
          province: order.shippingAddress.province,
          country: order.shippingAddress.country,
          zip: order.shippingAddress.zip,
        }
      : null,
    lineItems: order.lineItems?.edges?.map((e) => ({
      id: parseGid(e.node.id),
      title: e.node.title,
      quantity: e.node.quantity,
      sku: e.node.sku,
      originalUnitPriceSet: e.node.originalUnitPriceSet?.shopMoney
        ? `${e.node.originalUnitPriceSet.shopMoney.amount} ${e.node.originalUnitPriceSet.shopMoney.currencyCode}`
        : null,
      variant: e.node.variant
        ? {
            id: parseGid(e.node.variant.id),
            title: e.node.variant.title,
          }
        : null,
    })),
    fulfillments: order.fulfillments?.map((f) => ({
      id: parseGid(f.id),
      status: f.status,
      createdAt: f.createdAt,
      trackingInfo: f.trackingInfo,
    })),
  };

  if (format === "markdown") {
    let md = `# Order ${o.name}\n\n`;
    md += `**ID:** ${o.id}\n`;
    md += `**Created:** ${o.createdAt}\n`;
    md += `**Financial Status:** ${o.displayFinancialStatus}\n`;
    md += `**Fulfillment Status:** ${o.displayFulfillmentStatus}\n\n`;

    if (o.cancelledAt) {
      md += `**Cancelled:** ${o.cancelledAt} (${o.cancelReason})\n\n`;
    }

    md += `## Pricing\n`;
    md += `- **Subtotal:** ${o.subtotalPriceSet || "-"}\n`;
    md += `- **Tax:** ${o.totalTaxSet || "-"}\n`;
    md += `- **Total:** ${o.totalPriceSet || "-"}\n\n`;

    if (o.customer) {
      md += `## Customer\n`;
      md += `- **Name:** ${o.customer.displayName}\n`;
      md += `- **Email:** ${o.customer.email || o.email || "-"}\n\n`;
    }

    if (o.shippingAddress) {
      md += `## Shipping Address\n`;
      md += `${o.shippingAddress.name}\n`;
      md += `${o.shippingAddress.address1}\n`;
      if (o.shippingAddress.address2) md += `${o.shippingAddress.address2}\n`;
      md += `${o.shippingAddress.city}, ${o.shippingAddress.province} ${o.shippingAddress.zip}\n`;
      md += `${o.shippingAddress.country}\n\n`;
    }

    if (o.lineItems?.length) {
      md += `## Line Items (${o.lineItems.length})\n\n`;
      md += "| Title | SKU | Qty | Unit Price |\n";
      md += "|---|---|---|---|\n";
      o.lineItems.forEach((li) => {
        md += `| ${li.title} | ${li.sku || "-"} | ${li.quantity} | ${li.originalUnitPriceSet || "-"} |\n`;
      });
      md += "\n";
    }

    if (o.fulfillments?.length) {
      md += `## Fulfillments (${o.fulfillments.length})\n\n`;
      o.fulfillments.forEach((f, i) => {
        md += `### Fulfillment ${i + 1}\n`;
        md += `- **Status:** ${f.status}\n`;
        md += `- **Created:** ${f.createdAt}\n`;
        if (f.trackingInfo?.length) {
          f.trackingInfo.forEach((t) => {
            md += `- **Tracking:** ${t.number} (${t.company})\n`;
          });
        }
        md += "\n";
      });
    }

    return { content: [{ type: "text", text: md }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] };
}

export function registerOrderTools(server) {
  // List Orders
  server.tool(
    "shopify_list_orders",
    {
      title: "List Shopify Orders",
      description:
        "List orders from your Shopify store with optional filtering by status and pagination.",
      inputSchema: {
        limit: z.number().min(1).max(250).default(50).describe("Number of orders to return (1-250)"),
        status: z
          .enum(["open", "closed", "cancelled", "any"])
          .default("any")
          .describe("Filter by order status"),
        financial_status: z
          .enum([
            "authorized",
            "pending",
            "paid",
            "partially_paid",
            "refunded",
            "partially_refunded",
            "voided",
            "any",
          ])
          .optional()
          .describe("Filter by financial status"),
        fulfillment_status: z
          .enum(["shipped", "partial", "unshipped", "unfulfilled", "any"])
          .optional()
          .describe("Filter by fulfillment status"),
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
    async ({ limit, status, financial_status, fulfillment_status, cursor, response_format }) => {
      // Build query string for filtering
      let queryParts = [];
      if (status && status !== "any") {
        queryParts.push(`status:${status}`);
      }
      if (financial_status && financial_status !== "any") {
        queryParts.push(`financial_status:${financial_status}`);
      }
      if (fulfillment_status && fulfillment_status !== "any") {
        queryParts.push(`fulfillment_status:${fulfillment_status}`);
      }

      const gqlQuery = `
        query ListOrders($first: Int!, $query: String, $after: String) {
          orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                email
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet {
                  shopMoney { amount currencyCode }
                }
                customer {
                  id
                  displayName
                }
                lineItems(first: 5) {
                  edges { node { id } }
                }
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

      const data = await shopifyGraphQL(gqlQuery, {
        first: limit,
        query: queryParts.length > 0 ? queryParts.join(" AND ") : null,
        after: cursor || null,
      });

      return formatOrders(
        data.orders.edges,
        data.orders.pageInfo,
        response_format
      );
    }
  );

  // Get Order
  server.tool(
    "shopify_get_order",
    {
      title: "Get Shopify Order",
      description:
        "Get detailed information about a specific order by ID, including line items, fulfillments, and customer info.",
      inputSchema: {
        id: z.string().describe("Order ID (numeric ID or full GID)"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, response_format }) => {
      const gqlQuery = `
        query GetOrder($id: ID!) {
          order(id: $id) {
            id
            name
            email
            phone
            createdAt
            updatedAt
            cancelledAt
            cancelReason
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            subtotalPriceSet {
              shopMoney { amount currencyCode }
            }
            totalTaxSet {
              shopMoney { amount currencyCode }
            }
            customer {
              id
              displayName
              email
            }
            shippingAddress {
              name
              address1
              address2
              city
              province
              country
              zip
            }
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  sku
                  originalUnitPriceSet {
                    shopMoney { amount currencyCode }
                  }
                  variant {
                    id
                    title
                  }
                }
              }
            }
            fulfillments {
              id
              status
              createdAt
              trackingInfo {
                number
                company
                url
              }
            }
          }
        }
      `;

      const data = await shopifyGraphQL(gqlQuery, {
        id: buildGid("Order", id),
      });

      if (!data.order) {
        return {
          content: [{ type: "text", text: `Order with ID ${id} not found.` }],
          isError: true,
        };
      }

      return formatOrder(data.order, response_format);
    }
  );

  // Fulfill Order
  server.tool(
    "shopify_fulfill_order",
    {
      title: "Fulfill Shopify Order",
      description:
        "Create a fulfillment for an order. This marks items as shipped and optionally adds tracking information.",
      inputSchema: {
        order_id: z.string().describe("Order ID (numeric ID or full GID)"),
        tracking_number: z.string().optional().describe("Tracking number"),
        tracking_company: z.string().optional().describe("Shipping carrier name"),
        tracking_url: z.string().optional().describe("Tracking URL"),
        notify_customer: z.boolean().default(true).describe("Send shipment notification to customer"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ order_id, tracking_number, tracking_company, tracking_url, notify_customer, response_format }) => {
      // First, get the fulfillment order ID
      const getOrderQuery = `
        query GetFulfillmentOrders($id: ID!) {
          order(id: $id) {
            id
            name
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
                  lineItems(first: 100) {
                    edges {
                      node {
                        id
                        remainingQuantity
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const orderData = await shopifyGraphQL(getOrderQuery, {
        id: buildGid("Order", order_id),
      });

      if (!orderData.order) {
        return {
          content: [{ type: "text", text: `Order with ID ${order_id} not found.` }],
          isError: true,
        };
      }

      // Find fulfillment orders that can be fulfilled
      const fulfillableOrders = orderData.order.fulfillmentOrders.edges.filter(
        (edge) =>
          edge.node.status === "OPEN" ||
          edge.node.status === "IN_PROGRESS"
      );

      if (fulfillableOrders.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Order ${orderData.order.name} has no items available for fulfillment.`,
            },
          ],
          isError: true,
        };
      }

      // Build fulfillment input
      const fulfillmentOrderLineItems = fulfillableOrders[0].node.lineItems.edges
        .filter((e) => e.node.remainingQuantity > 0)
        .map((e) => ({
          id: e.node.id,
          quantity: e.node.remainingQuantity,
        }));

      const mutation = `
        mutation FulfillOrder($fulfillment: FulfillmentV2Input!) {
          fulfillmentCreateV2(fulfillment: $fulfillment) {
            fulfillment {
              id
              status
              createdAt
              trackingInfo {
                number
                company
                url
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const trackingInfo =
        tracking_number || tracking_company || tracking_url
          ? {
              number: tracking_number,
              company: tracking_company,
              url: tracking_url,
            }
          : null;

      const fulfillmentInput = {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: fulfillableOrders[0].node.id,
            fulfillmentOrderLineItems,
          },
        ],
        notifyCustomer: notify_customer,
      };

      if (trackingInfo) {
        fulfillmentInput.trackingInfo = trackingInfo;
      }

      const data = await shopifyGraphQL(mutation, {
        fulfillment: fulfillmentInput,
      });

      if (data.fulfillmentCreateV2.userErrors?.length > 0) {
        const errors = data.fulfillmentCreateV2.userErrors
          .map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Failed to create fulfillment: ${errors}` }],
          isError: true,
        };
      }

      const f = data.fulfillmentCreateV2.fulfillment;
      const result = {
        message: `Fulfillment created successfully for order ${orderData.order.name}`,
        fulfillment: {
          id: parseGid(f.id),
          status: f.status,
          createdAt: f.createdAt,
          trackingInfo: f.trackingInfo,
        },
      };

      if (response_format === "markdown") {
        let md = `# Fulfillment Created\n\n`;
        md += `**Order:** ${orderData.order.name}\n`;
        md += `**Fulfillment ID:** ${result.fulfillment.id}\n`;
        md += `**Status:** ${result.fulfillment.status}\n`;
        md += `**Created:** ${result.fulfillment.createdAt}\n`;
        if (result.fulfillment.trackingInfo?.length) {
          md += `\n## Tracking\n`;
          result.fulfillment.trackingInfo.forEach((t) => {
            md += `- **Number:** ${t.number || "-"}\n`;
            md += `- **Company:** ${t.company || "-"}\n`;
            if (t.url) md += `- **URL:** ${t.url}\n`;
          });
        }
        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Cancel Order
  server.tool(
    "shopify_cancel_order",
    {
      title: "Cancel Shopify Order",
      description:
        "Cancel an order. This will void any pending payments and can optionally restock items and send notification.",
      inputSchema: {
        id: z.string().describe("Order ID (numeric ID or full GID)"),
        reason: z
          .enum(["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"])
          .default("OTHER")
          .describe("Cancellation reason"),
        restock: z.boolean().default(true).describe("Restock inventory items"),
        notify_customer: z.boolean().default(true).describe("Send cancellation notification to customer"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, reason, restock, notify_customer, response_format }) => {
      const mutation = `
        mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean!) {
          orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer) {
            job {
              id
              done
            }
            orderCancelUserErrors {
              field
              message
              code
            }
          }
        }
      `;

      const data = await shopifyGraphQL(mutation, {
        orderId: buildGid("Order", id),
        reason,
        restock,
        notifyCustomer: notify_customer,
      });

      if (data.orderCancel.orderCancelUserErrors?.length > 0) {
        const errors = data.orderCancel.orderCancelUserErrors
          .map((e) => `${e.field || e.code}: ${e.message}`)
          .join("; ");
        return {
          content: [{ type: "text", text: `Failed to cancel order: ${errors}` }],
          isError: true,
        };
      }

      const result = {
        message: `Order cancellation initiated successfully`,
        jobId: data.orderCancel.job?.id ? parseGid(data.orderCancel.job.id) : null,
        done: data.orderCancel.job?.done,
        reason,
        restocked: restock,
        notifiedCustomer: notify_customer,
      };

      if (response_format === "markdown") {
        let md = `# Order Cancellation\n\n`;
        md += `**Status:** ${result.done ? "Completed" : "Processing"}\n`;
        md += `**Reason:** ${result.reason}\n`;
        md += `**Restocked:** ${result.restocked ? "Yes" : "No"}\n`;
        md += `**Customer Notified:** ${result.notifiedCustomer ? "Yes" : "No"}\n`;
        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
