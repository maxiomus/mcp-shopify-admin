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
    ├── index.js         # Tool registration hub
    ├── stores.js        # store_list
    ├── operations.js    # Staged-operation inspection
    ├── products.js      # Product CRUD tools
    ├── tags.js          # Additive/subtractive tag tools (tagsAdd / tagsRemove)
    ├── collections.js   # Collection read + create/update incl. ruleSet
    ├── publications.js  # Sales-channel listing and publishing
    ├── orders.js        # Order management tools
    ├── customers.js     # Customer tools
    └── inventory.js     # Inventory tools
```

## Key Patterns

### Tool Registration

**Use `server.registerTool(name, config, cb)` — NOT `server.tool()`.**

`server.tool()` is deprecated in SDK v1.25+, and its overloads expect a raw
ZodRawShape as the second argument, not a config object. Passing a
`{ title, description, inputSchema, annotations }` object to `server.tool()`
makes the SDK treat those four keys as the parameter shape, which produces an
**empty input schema** (`{"type":"object","properties":{}}`). Clients then strip
every argument before sending, and each tool fails with confusing errors such as
`Store "undefined" not found`. This bit the whole server once — every tool was
silently unusable.

```javascript
server.registerTool(
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

## Tag changes: always use the tag tools, never product_update

`productUpdate(input: { tags: [...] })` **replaces the entire tag array**. Two
jobs tagging overlapping products will overwrite each other (last writer wins),
and any stale read destroys pre-existing tags. This happened in production on
2026-08-04: a parallel tagging run across 13 overlapping collections destroyed
the tag `may 26` on 34 products before it was caught and repaired.

Use instead:

- `product_tags_add_*` — Shopify `tagsAdd`, purely additive, safe to run in
  parallel, immune to stale snapshots.
- `product_tags_remove_*` — Shopify `tagsRemove`, removes only the named tags.

`product_update` should only set `tags` when the intent is genuinely to replace
the whole list.

## Collections: MANUAL vs AUTOMATED matters for external feeds

A Shopify collection with no `ruleSet` is MANUAL (hand-picked). Its membership
is stored in a join table that product feeds do not carry, so **manual
collection membership never reaches the Meta/Facebook catalog** — a product set
filtered on that collection returns zero products even though the products
themselves sync fine.

An AUTOMATED collection defines membership by rule (e.g. `TAG EQUALS
"or-cocktail-dresses"`), which is derivable from the product record and
therefore does propagate.

Workflow to make a manual collection advertisable:
1. `product_tags_add_*` — tag the products already curated into it.
2. `collection_update_*` with a `rule_set` of `TAG EQUALS <tag>` to convert it.
3. If Shopify refuses the conversion, use `collection_create_*` to make an
   automated twin and repoint downstream systems at the new collection ID.

`collection_list` and `collection_get` report the `type` field (MANUAL /
AUTOMATED) so this is visible at a glance.
