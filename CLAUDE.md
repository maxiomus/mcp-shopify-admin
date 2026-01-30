# CLAUDE.md - Development Guide

This file provides context for Claude Code when working on this project.

## Project Overview

MCP Shopify Admin Server - A Model Context Protocol server that exposes Shopify Admin API capabilities to LLMs.

## Architecture

```
src/
├── index.js          # Entry point, STDIO transport setup
├── server.js         # MCP server configuration
├── config.js         # Environment validation with Zod
├── shopify/
│   └── client.js     # Shopify GraphQL client (axios-based)
└── tools/
    ├── index.js      # Tool registration hub
    ├── products.js   # Product CRUD tools
    ├── orders.js     # Order management tools
    ├── customers.js  # Customer tools
    └── inventory.js  # Inventory tools
```

## Key Patterns

### Tool Registration

Tools are registered using the MCP SDK's `server.tool()` method:

```javascript
server.tool(
  "tool_name",
  {
    title: "Human Title",
    description: "Detailed description...",
    inputSchema: {
      param: z.string().describe("Parameter description"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    // Implementation
    return { content: [{ type: "text", text: "result" }] };
  }
);
```

### GraphQL Client

All Shopify API calls use GraphQL via `shopifyGraphQL()`:

```javascript
const data = await shopifyGraphQL(query, variables);
```

### GID Handling

Shopify uses Global IDs (GIDs). Utility functions:
- `buildGid("Product", "123")` → `"gid://shopify/Product/123"`
- `parseGid("gid://shopify/Product/123")` → `"123"`

### Response Formatting

All tools support `response_format` parameter:
- `json`: Structured data (default)
- `markdown`: Human-readable tables and formatting

## Development Commands

```bash
# Install dependencies
npm install

# Run the server
npm start

# Test with MCP Inspector
npm run inspect
```

## Adding New Tools

1. Create or edit a file in `src/tools/`
2. Define the tool using `server.tool()`
3. Register in `src/tools/index.js` if new file
4. Follow existing patterns for:
   - Zod schema validation
   - GraphQL queries
   - Response formatting (JSON/Markdown)
   - Error handling

## Environment Variables

Required:
- `SHOPIFY_STORE_DOMAIN`: Your store's myshopify.com domain
- `SHOPIFY_ACCESS_TOKEN`: Admin API access token (starts with `shpat_`)

## API Version

Currently using Shopify Admin API version `2024-10`. Update in `src/shopify/client.js` if needed.

## Testing

Test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node src/index.js
```

Or configure in Claude Desktop and test interactively.
