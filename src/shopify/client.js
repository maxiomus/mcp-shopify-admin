import axios from "axios";
import { config } from "../config.js";

const API_VERSION = "2024-10";

const client = axios.create({
  baseURL: `https://${config.shopifyStoreDomain}/admin/api/${API_VERSION}`,
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": config.shopifyAccessToken,
  },
});

/**
 * Execute a GraphQL query against the Shopify Admin API
 * @param {string} query - GraphQL query or mutation
 * @param {object} variables - Query variables
 * @returns {Promise<object>} - Response data
 */
export async function shopifyGraphQL(query, variables = {}) {
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
          "Rate limit exceeded. Please wait before making more requests."
        );
      }

      if (status === 401) {
        throw new Error(
          "Authentication failed. Check your SHOPIFY_ACCESS_TOKEN."
        );
      }

      if (status === 403) {
        throw new Error(
          "Access forbidden. Your access token may lack required scopes."
        );
      }

      throw new Error(`Shopify API error (${status}): ${JSON.stringify(message)}`);
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
