import axios from "axios";
import { getStore } from "./registry.js";

const API_VERSION = "2024-10";

// Client cache - one client per store
const clientCache = new Map();

/**
 * Get or create a GraphQL client for a specific store
 * @param {string} storeName - Name of the store
 * @returns {object} Axios client configured for the store
 */
function getClient(storeName) {
  if (clientCache.has(storeName)) {
    return clientCache.get(storeName);
  }

  const store = getStore(storeName);
  if (!store) {
    throw new Error(`Store "${storeName}" not found`);
  }

  const client = axios.create({
    baseURL: `https://${store.domain}/admin/api/${API_VERSION}`,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": store.accessToken,
    },
  });

  clientCache.set(storeName, client);
  return client;
}

/**
 * Execute a GraphQL query against a specific store's Shopify Admin API
 * @param {string} storeName - Name of the store
 * @param {string} query - GraphQL query or mutation
 * @param {object} variables - Query variables
 * @returns {Promise<object>} - Response data
 */
export async function shopifyGraphQL(storeName, query, variables = {}) {
  const client = getClient(storeName);
  const store = getStore(storeName);

  try {
    const response = await client.post("/graphql.json", {
      query,
      variables,
    });

    const { data, errors } = response.data;

    if (errors && errors.length > 0) {
      const errorMessages = errors.map((e) => e.message).join("; ");
      throw new Error(`GraphQL errors: ${errorMessages}`);
    }

    return data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.errors || error.message;

      if (status === 429) {
        throw new Error(
          `[${storeName}] Rate limit exceeded. Please wait before making more requests.`
        );
      }

      if (status === 401) {
        throw new Error(
          `[${storeName}] Authentication failed. Check your access token.`
        );
      }

      if (status === 403) {
        throw new Error(
          `[${storeName}] Access forbidden. Your access token may lack required scopes.`
        );
      }

      throw new Error(
        `[${storeName}] Shopify API error (${status}): ${JSON.stringify(message)}`
      );
    }

    throw error;
  }
}

/**
 * Parse a Shopify GID to extract the numeric ID
 * @param {string} gid - Shopify Global ID (e.g., "gid://shopify/Product/123")
 * @returns {string} - Numeric ID
 */
export function parseGid(gid) {
  if (!gid) return null;
  const match = gid.match(/\/(\d+)$/);
  return match ? match[1] : gid;
}

/**
 * Build a Shopify GID from a resource type and numeric ID
 * @param {string} resourceType - Resource type (e.g., "Product", "Order")
 * @param {string|number} id - Numeric ID
 * @returns {string} - Shopify Global ID
 */
export function buildGid(resourceType, id) {
  if (String(id).startsWith("gid://")) {
    return id;
  }
  return `gid://shopify/${resourceType}/${id}`;
}

/**
 * Clear the client cache (useful for testing)
 */
export function clearClientCache() {
  clientCache.clear();
}
