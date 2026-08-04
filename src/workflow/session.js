import { randomUUID } from "crypto";

/**
 * Operation states in the staged workflow
 */
export const OperationState = {
  PLANNED: "PLANNED",
  PREVIEWED: "PREVIEWED",
  EXECUTED: "EXECUTED",
  CANCELLED: "CANCELLED",
};

/**
 * Operation types
 */
export const OperationType = {
  // Product operations
  PRODUCT_CREATE: "product_create",
  PRODUCT_UPDATE: "product_update",
  PRODUCT_BULK_UPDATE: "product_bulk_update",
  PRODUCT_TAGS_ADD: "product_tags_add",
  PRODUCT_TAGS_REMOVE: "product_tags_remove",
  PRODUCT_PUBLISH: "product_publish",

  // Collection operations
  COLLECTION_CREATE: "collection_create",
  COLLECTION_UPDATE: "collection_update",

  // Order operations
  ORDER_FULFILL: "order_fulfill",
  ORDER_CANCEL: "order_cancel",

  // Inventory operations
  INVENTORY_ADJUST: "inventory_adjust",
};

// Default expiration time: 30 minutes
const DEFAULT_EXPIRATION_MS = 30 * 60 * 1000;

/**
 * In-memory session store for pending operations
 */
class SessionStore {
  constructor() {
    this.operations = new Map();
    this.cleanupInterval = null;
  }

  /**
   * Start automatic cleanup of expired operations
   */
  startCleanup(intervalMs = 60000) {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, intervalMs);

    // Don't keep the process alive just for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop automatic cleanup
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Remove expired operations
   */
  cleanupExpired() {
    const now = Date.now();
    for (const [id, op] of this.operations) {
      if (op.expiresAt < now) {
        this.operations.delete(id);
      }
    }
  }

  /**
   * Create a new pending operation
   * @param {object} params - Operation parameters
   * @returns {object} Created operation
   */
  create({
    store,
    operationType,
    payload,
    description,
    affectedResources = [],
  }) {
    const operationId = randomUUID();
    const now = Date.now();

    const operation = {
      operationId,
      store,
      operationType,
      payload,
      description,
      affectedResources,
      state: OperationState.PLANNED,
      preview: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + DEFAULT_EXPIRATION_MS,
      executedAt: null,
      result: null,
    };

    this.operations.set(operationId, operation);
    return operation;
  }

  /**
   * Get an operation by ID
   * @param {string} operationId - Operation ID
   * @returns {object|null} Operation or null if not found
   */
  get(operationId) {
    const op = this.operations.get(operationId);
    if (!op) return null;

    // Check expiration
    if (op.expiresAt < Date.now() && op.state !== OperationState.EXECUTED) {
      this.operations.delete(operationId);
      return null;
    }

    return op;
  }

  /**
   * Update an operation's state
   * @param {string} operationId - Operation ID
   * @param {object} updates - Fields to update
   * @returns {object|null} Updated operation or null
   */
  update(operationId, updates) {
    const op = this.get(operationId);
    if (!op) return null;

    Object.assign(op, updates, {
      updatedAt: new Date().toISOString(),
    });

    return op;
  }

  /**
   * Set operation to PREVIEWED state with preview data
   * @param {string} operationId - Operation ID
   * @param {object} preview - Preview data
   * @returns {object|null} Updated operation
   */
  setPreview(operationId, preview) {
    return this.update(operationId, {
      state: OperationState.PREVIEWED,
      preview,
    });
  }

  /**
   * Set operation to EXECUTED state with result
   * @param {string} operationId - Operation ID
   * @param {object} result - Execution result
   * @returns {object|null} Updated operation
   */
  setExecuted(operationId, result) {
    return this.update(operationId, {
      state: OperationState.EXECUTED,
      executedAt: new Date().toISOString(),
      result,
    });
  }

  /**
   * Cancel an operation
   * @param {string} operationId - Operation ID
   * @returns {object|null} Updated operation
   */
  cancel(operationId) {
    return this.update(operationId, {
      state: OperationState.CANCELLED,
    });
  }

  /**
   * Delete an operation
   * @param {string} operationId - Operation ID
   * @returns {boolean} True if deleted
   */
  delete(operationId) {
    return this.operations.delete(operationId);
  }

  /**
   * List all pending (non-executed, non-cancelled, non-expired) operations
   * @returns {Array} Array of operations
   */
  listPending() {
    const now = Date.now();
    const pending = [];

    for (const [id, op] of this.operations) {
      if (op.expiresAt < now && op.state !== OperationState.EXECUTED) {
        this.operations.delete(id);
        continue;
      }

      if (
        op.state === OperationState.PLANNED ||
        op.state === OperationState.PREVIEWED
      ) {
        pending.push(op);
      }
    }

    return pending;
  }

  /**
   * List all operations (for debugging/admin)
   * @returns {Array} Array of all operations
   */
  listAll() {
    return [...this.operations.values()];
  }

  /**
   * Get operation count by state
   * @returns {object} Counts by state
   */
  getCounts() {
    const counts = {
      [OperationState.PLANNED]: 0,
      [OperationState.PREVIEWED]: 0,
      [OperationState.EXECUTED]: 0,
      [OperationState.CANCELLED]: 0,
      expired: 0,
    };

    const now = Date.now();

    for (const op of this.operations.values()) {
      if (op.expiresAt < now && op.state !== OperationState.EXECUTED) {
        counts.expired++;
      } else {
        counts[op.state]++;
      }
    }

    return counts;
  }

  /**
   * Clear all operations (for testing)
   */
  clear() {
    this.operations.clear();
  }
}

// Singleton instance
export const sessionStore = new SessionStore();

// Start cleanup on module load
sessionStore.startCleanup();
