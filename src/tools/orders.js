import { z } from "zod";
import { shopifyGraphQL, buildGid, parseGid } from "../stores/client.js";
import { requireStore, isProduction } from "../stores/registry.js";
import { workflowEngine, OperationType } from "../workflow/engine.js";

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

// GraphQL Queries
const ORDER_LIST_QUERY = `
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

const ORDER_GET_QUERY = `
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

const FULFILLMENT_ORDERS_QUERY = `
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

const FULFILLMENT_CREATE_MUTATION = `
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

const ORDER_CANCEL_MUTATION = `
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

export function registerOrderTools(server) {
  // ============================================
  // READ TOOLS (require store parameter)
  // ============================================

  // List Orders
  server.registerTool(
    "order_list",
    {
      title: "List Orders",
      description:
        "List orders from a Shopify store with optional filtering by status and pagination.",
      inputSchema: {
        store: z.string().describe("Store name (use store_list to see available stores)"),
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
    async ({ store, limit, status, financial_status, fulfillment_status, cursor, response_format }) => {
      requireStore(store);

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

      const data = await shopifyGraphQL(store, ORDER_LIST_QUERY, {
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
  server.registerTool(
    "order_get",
    {
      title: "Get Order",
      description:
        "Get detailed information about a specific order including line items, fulfillments, and customer info.",
      inputSchema: {
        store: z.string().describe("Store name"),
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
    async ({ store, id, response_format }) => {
      requireStore(store);

      const data = await shopifyGraphQL(store, ORDER_GET_QUERY, {
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

  // ============================================
  // FULFILL ORDER - STAGED WORKFLOW
  // ============================================

  // Step 1: Plan order fulfillment
  server.registerTool(
    "order_fulfill_plan",
    {
      title: "Plan Order Fulfillment",
      description:
        "Plan an order fulfillment. This creates a staged operation that must be previewed and executed.",
      inputSchema: {
        store: z.string().describe("Store name"),
        order_id: z.string().describe("Order ID (numeric ID or full GID)"),
        tracking_number: z.string().optional().describe("Tracking number"),
        tracking_company: z.string().optional().describe("Shipping carrier name"),
        tracking_url: z.string().optional().describe("Tracking URL"),
        notify_customer: z.boolean().default(true).describe("Send shipment notification to customer"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ store, order_id, tracking_number, tracking_company, tracking_url, notify_customer, response_format }) => {
      requireStore(store);

      // Verify order exists and check fulfillment status
      const orderData = await shopifyGraphQL(store, FULFILLMENT_ORDERS_QUERY, {
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

      const fulfillmentOrderLineItems = fulfillableOrders[0].node.lineItems.edges
        .filter((e) => e.node.remainingQuantity > 0)
        .map((e) => ({
          id: e.node.id,
          quantity: e.node.remainingQuantity,
        }));

      const payload = {
        orderId: order_id,
        orderName: orderData.order.name,
        fulfillmentOrderId: fulfillableOrders[0].node.id,
        fulfillmentOrderLineItems,
        trackingNumber: tracking_number,
        trackingCompany: tracking_company,
        trackingUrl: tracking_url,
        notifyCustomer: notify_customer,
      };

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.ORDER_FULFILL,
        payload,
        description: `Fulfill order ${orderData.order.name}`,
        affectedResources: [`Order: ${orderData.order.name} (${order_id})`],
      });

      if (response_format === "markdown") {
        const prodWarning = isProduction(store)
          ? "\n\n**WARNING: This targets a PRODUCTION store!**"
          : "";

        let md = `# Order Fulfillment Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${prodWarning}\n`;
        md += `**State:** ${result.state}\n\n`;
        md += `## Order Details\n`;
        md += `- **Order:** ${orderData.order.name}\n`;
        md += `- **Items to Fulfill:** ${fulfillmentOrderLineItems.length}\n`;
        md += `- **Notify Customer:** ${notify_customer ? "Yes" : "No"}\n`;
        if (tracking_number) md += `- **Tracking Number:** ${tracking_number}\n`;
        if (tracking_company) md += `- **Carrier:** ${tracking_company}\n`;
        md += `\n## Next Step\n`;
        md += `Call \`order_fulfill_preview\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 2: Preview order fulfillment
  server.registerTool(
    "order_fulfill_preview",
    {
      title: "Preview Order Fulfillment",
      description: "Preview a planned order fulfillment. Shows what will be shipped.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from order_fulfill_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        return {
          action: "FULFILL",
          orderName: operation.payload.orderName,
          itemCount: operation.payload.fulfillmentOrderLineItems.length,
          tracking: {
            number: operation.payload.trackingNumber || "Not provided",
            company: operation.payload.trackingCompany || "Not provided",
            url: operation.payload.trackingUrl || "Not provided",
          },
          notifyCustomer: operation.payload.notifyCustomer,
          summary: `Will fulfill ${operation.payload.fulfillmentOrderLineItems.length} item(s) for order ${operation.payload.orderName}`,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        let md = `# Order Fulfillment Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store}\n`;
        md += `**Order:** ${result.preview.orderName}\n\n`;
        md += `## Fulfillment Details\n`;
        md += `- **Items to Fulfill:** ${result.preview.itemCount}\n`;
        md += `- **Tracking Number:** ${result.preview.tracking.number}\n`;
        md += `- **Carrier:** ${result.preview.tracking.company}\n`;
        md += `- **Notify Customer:** ${result.preview.notifyCustomer ? "Yes" : "No"}\n\n`;

        if (result.warnings?.length > 0) {
          md += `## Warnings\n`;
          result.warnings.forEach((w) => {
            md += `- ${w}\n`;
          });
        }

        md += `\n## Next Step\n`;
        md += `If approved, call \`order_fulfill_execute\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 3: Execute order fulfillment
  server.registerTool(
    "order_fulfill_execute",
    {
      title: "Execute Order Fulfillment",
      description:
        "Execute a previewed order fulfillment. This marks items as shipped. " +
        "Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from order_fulfill_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const trackingInfo =
          operation.payload.trackingNumber ||
          operation.payload.trackingCompany ||
          operation.payload.trackingUrl
            ? {
                number: operation.payload.trackingNumber,
                company: operation.payload.trackingCompany,
                url: operation.payload.trackingUrl,
              }
            : null;

        const fulfillmentInput = {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: operation.payload.fulfillmentOrderId,
              fulfillmentOrderLineItems: operation.payload.fulfillmentOrderLineItems,
            },
          ],
          notifyCustomer: operation.payload.notifyCustomer,
        };

        if (trackingInfo) {
          fulfillmentInput.trackingInfo = trackingInfo;
        }

        const data = await shopifyGraphQL(operation.store, FULFILLMENT_CREATE_MUTATION, {
          fulfillment: fulfillmentInput,
        });

        if (data.fulfillmentCreateV2.userErrors?.length > 0) {
          const errors = data.fulfillmentCreateV2.userErrors
            .map((e) => `${e.field}: ${e.message}`)
            .join("; ");
          throw new Error(`Failed to create fulfillment: ${errors}`);
        }

        const f = data.fulfillmentCreateV2.fulfillment;
        return {
          success: true,
          fulfillment: {
            id: parseGid(f.id),
            status: f.status,
            createdAt: f.createdAt,
            trackingInfo: f.trackingInfo,
          },
        };
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);

        if (response_format === "markdown") {
          let md = `# Order Fulfilled Successfully\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Store:** ${result.store}\n`;
          md += `**Executed At:** ${result.executedAt}\n\n`;
          md += `## Fulfillment Details\n`;
          md += `- **Fulfillment ID:** ${result.result.fulfillment.id}\n`;
          md += `- **Status:** ${result.result.fulfillment.status}\n`;
          md += `- **Created:** ${result.result.fulfillment.createdAt}\n`;
          if (result.result.fulfillment.trackingInfo?.length) {
            md += `\n### Tracking\n`;
            result.result.fulfillment.trackingInfo.forEach((t) => {
              md += `- **Number:** ${t.number || "-"}\n`;
              md += `- **Company:** ${t.company || "-"}\n`;
              if (t.url) md += `- **URL:** ${t.url}\n`;
            });
          }

          return { content: [{ type: "text", text: md }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Execution failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ============================================
  // CANCEL ORDER - STAGED WORKFLOW
  // ============================================

  // Step 1: Plan order cancellation
  server.registerTool(
    "order_cancel_plan",
    {
      title: "Plan Order Cancellation",
      description:
        "Plan an order cancellation. This creates a staged operation that must be previewed and executed.",
      inputSchema: {
        store: z.string().describe("Store name"),
        order_id: z.string().describe("Order ID (numeric ID or full GID)"),
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
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ store, order_id, reason, restock, notify_customer, response_format }) => {
      requireStore(store);

      // Verify order exists
      const orderData = await shopifyGraphQL(store, ORDER_GET_QUERY, {
        id: buildGid("Order", order_id),
      });

      if (!orderData.order) {
        return {
          content: [{ type: "text", text: `Order with ID ${order_id} not found.` }],
          isError: true,
        };
      }

      if (orderData.order.cancelledAt) {
        return {
          content: [
            {
              type: "text",
              text: `Order ${orderData.order.name} is already cancelled.`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        orderId: order_id,
        orderName: orderData.order.name,
        reason,
        restock,
        notifyCustomer: notify_customer,
        currentStatus: {
          financial: orderData.order.displayFinancialStatus,
          fulfillment: orderData.order.displayFulfillmentStatus,
        },
      };

      const result = workflowEngine.plan({
        store,
        operationType: OperationType.ORDER_CANCEL,
        payload,
        description: `Cancel order ${orderData.order.name}`,
        affectedResources: [`Order: ${orderData.order.name} (${order_id})`],
      });

      if (response_format === "markdown") {
        const prodWarning = isProduction(store)
          ? "\n\n**WARNING: This targets a PRODUCTION store!**"
          : "";

        let md = `# Order Cancellation Planned\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store} (${result.storeEnvironment})${prodWarning}\n`;
        md += `**State:** ${result.state}\n\n`;
        md += `## Order Details\n`;
        md += `- **Order:** ${orderData.order.name}\n`;
        md += `- **Financial Status:** ${orderData.order.displayFinancialStatus}\n`;
        md += `- **Fulfillment Status:** ${orderData.order.displayFulfillmentStatus}\n\n`;
        md += `## Cancellation Options\n`;
        md += `- **Reason:** ${reason}\n`;
        md += `- **Restock Items:** ${restock ? "Yes" : "No"}\n`;
        md += `- **Notify Customer:** ${notify_customer ? "Yes" : "No"}\n`;
        md += `\n## Next Step\n`;
        md += `Call \`order_cancel_preview\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 2: Preview order cancellation
  server.registerTool(
    "order_cancel_preview",
    {
      title: "Preview Order Cancellation",
      description: "Preview a planned order cancellation. Shows what will happen.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from order_cancel_plan"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ operation_id, response_format }) => {
      const previewGenerator = async (operation) => {
        return {
          action: "CANCEL",
          orderName: operation.payload.orderName,
          reason: operation.payload.reason,
          restock: operation.payload.restock,
          notifyCustomer: operation.payload.notifyCustomer,
          currentStatus: operation.payload.currentStatus,
          effects: [
            "Order will be marked as cancelled",
            operation.payload.restock
              ? "Inventory will be restocked"
              : "Inventory will NOT be restocked",
            operation.payload.notifyCustomer
              ? "Customer will receive cancellation email"
              : "Customer will NOT be notified",
          ],
          summary: `Will cancel order ${operation.payload.orderName} with reason: ${operation.payload.reason}`,
        };
      };

      const result = await workflowEngine.preview(operation_id, previewGenerator);

      if (response_format === "markdown") {
        let md = `# Order Cancellation Preview\n\n`;
        md += `**Operation ID:** \`${result.operationId}\`\n`;
        md += `**Store:** ${result.store}\n`;
        md += `**Order:** ${result.preview.orderName}\n\n`;
        md += `## Current Status\n`;
        md += `- **Financial:** ${result.preview.currentStatus.financial}\n`;
        md += `- **Fulfillment:** ${result.preview.currentStatus.fulfillment}\n\n`;
        md += `## Effects of Cancellation\n`;
        result.preview.effects.forEach((e) => {
          md += `- ${e}\n`;
        });

        if (result.warnings?.length > 0) {
          md += `\n## Warnings\n`;
          result.warnings.forEach((w) => {
            md += `- ${w}\n`;
          });
        }

        md += `\n## Next Step\n`;
        md += `If approved, call \`order_cancel_execute\` with \`operation_id: "${result.operationId}"\`\n`;

        return { content: [{ type: "text", text: md }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Step 3: Execute order cancellation
  server.registerTool(
    "order_cancel_execute",
    {
      title: "Execute Order Cancellation",
      description:
        "Execute a previewed order cancellation. This actually cancels the order. " +
        "Production stores require confirm_production: true.",
      inputSchema: {
        operation_id: z.string().describe("Operation ID from order_cancel_plan"),
        confirm_production: z.boolean().default(false).describe("Required for production stores"),
        response_format: z.enum(["json", "markdown"]).default("json").describe("Response format"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ operation_id, confirm_production, response_format }) => {
      const executor = async (operation) => {
        const data = await shopifyGraphQL(operation.store, ORDER_CANCEL_MUTATION, {
          orderId: buildGid("Order", operation.payload.orderId),
          reason: operation.payload.reason,
          restock: operation.payload.restock,
          notifyCustomer: operation.payload.notifyCustomer,
        });

        if (data.orderCancel.orderCancelUserErrors?.length > 0) {
          const errors = data.orderCancel.orderCancelUserErrors
            .map((e) => `${e.field || e.code}: ${e.message}`)
            .join("; ");
          throw new Error(`Failed to cancel order: ${errors}`);
        }

        return {
          success: true,
          jobId: data.orderCancel.job?.id ? parseGid(data.orderCancel.job.id) : null,
          done: data.orderCancel.job?.done,
          reason: operation.payload.reason,
          restocked: operation.payload.restock,
          notifiedCustomer: operation.payload.notifyCustomer,
        };
      };

      try {
        const result = await workflowEngine.execute(operation_id, confirm_production, executor);

        if (response_format === "markdown") {
          let md = `# Order Cancelled Successfully\n\n`;
          md += `**Operation ID:** \`${result.operationId}\`\n`;
          md += `**Store:** ${result.store}\n`;
          md += `**Executed At:** ${result.executedAt}\n\n`;
          md += `## Cancellation Details\n`;
          md += `- **Status:** ${result.result.done ? "Completed" : "Processing"}\n`;
          md += `- **Reason:** ${result.result.reason}\n`;
          md += `- **Restocked:** ${result.result.restocked ? "Yes" : "No"}\n`;
          md += `- **Customer Notified:** ${result.result.notifiedCustomer ? "Yes" : "No"}\n`;

          return { content: [{ type: "text", text: md }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Execution failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
