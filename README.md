# MCP Shopify Admin Server

An MCP (Model Context Protocol) server that exposes Shopify Admin API capabilities to LLMs like Claude.

## Features

- **Products**: List, get, create, and update products
- **Orders**: List, get, fulfill, and cancel orders
- **Customers**: List and get customer details
- **Inventory**: Get inventory levels and adjust quantities

## Prerequisites

- Node.js 18+
- A Shopify store with Admin API access
- An Admin API access token with the required scopes

### Required API Scopes

Your Shopify Admin API access token needs these scopes:
- `read_products`, `write_products`
- `read_orders`, `write_orders`
- `read_customers`, `write_customers`
- `read_inventory`, `write_inventory`
- `read_locations`

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/your-org/mcp-shopify-admin.git
   cd mcp-shopify-admin
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with your Shopify credentials:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your store domain and access token:
   ```
   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
   SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

## Usage

### With Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shopify": {
      "command": "node",
      "args": ["path/to/mcp-shopify-admin/src/index.js"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "your-store.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### With MCP Inspector

Test the server using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

### Standalone

Run the server directly (for debugging):

```bash
npm start
```

## Available Tools

### Products

| Tool | Description | Type |
|------|-------------|------|
| `shopify_list_products` | List products with filtering and pagination | Read |
| `shopify_get_product` | Get detailed product info by ID | Read |
| `shopify_create_product` | Create a new product | Write |
| `shopify_update_product` | Update an existing product | Write |

### Orders

| Tool | Description | Type |
|------|-------------|------|
| `shopify_list_orders` | List orders with status filtering | Read |
| `shopify_get_order` | Get detailed order info by ID | Read |
| `shopify_fulfill_order` | Create fulfillment for an order | Write |
| `shopify_cancel_order` | Cancel an order | Write |

### Customers

| Tool | Description | Type |
|------|-------------|------|
| `shopify_list_customers` | List customers with search | Read |
| `shopify_get_customer` | Get detailed customer info by ID | Read |

### Inventory

| Tool | Description | Type |
|------|-------------|------|
| `shopify_get_inventory_levels` | Get inventory at locations | Read |
| `shopify_update_inventory` | Adjust inventory quantities | Write |

## Response Formats

All tools support two response formats via the `response_format` parameter:

- `json` (default): Structured JSON for programmatic use
- `markdown`: Human-readable formatted output

## Examples

### List Products

```
Use shopify_list_products to show me the first 10 products
```

### Get Order Details

```
Use shopify_get_order with id "5123456789" and response_format "markdown"
```

### Update Inventory

```
Use shopify_update_inventory to add 50 units to inventory item "12345" at location "67890"
```

## Error Handling

The server provides clear error messages for common issues:

- **401 Unauthorized**: Check your access token
- **403 Forbidden**: Your token may lack required scopes
- **429 Rate Limited**: Wait before making more requests
- **404 Not Found**: The requested resource doesn't exist

## License

MIT
