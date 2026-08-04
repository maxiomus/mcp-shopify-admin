import { isProduction, requireStore } from "../stores/registry.js";
import { OperationState } from "./session.js";

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

/**
 * Validator functions for operations
 */
export const validators = {
  /**
   * Validate that an operation exists
   */
  operationExists(operation, operationId) {
    if (!operation) {
      throw new ValidationError(
        `Operation "${operationId}" not found or expired. Operations expire after 30 minutes.`,
        "OPERATION_NOT_FOUND"
      );
    }
  },

  /**
   * Validate that an operation is in the expected state
   */
  operationInState(operation, expectedState) {
    if (operation.state !== expectedState) {
      throw new ValidationError(
        `Cannot proceed: operation is in state "${operation.state}", expected "${expectedState}"`,
        "INVALID_STATE"
      );
    }
  },

  /**
   * Validate that an operation has been previewed before execution
   */
  operationPreviewed(operation) {
    if (operation.state !== OperationState.PREVIEWED) {
      throw new ValidationError(
        `Cannot execute: operation must be previewed first. Current state: ${operation.state}`,
        "NOT_PREVIEWED"
      );
    }
  },

  /**
   * Validate that the store is still valid
   */
  storeValid(storeName) {
    try {
      requireStore(storeName);
    } catch (error) {
      throw new ValidationError(
        `Store "${storeName}" is no longer configured or valid`,
        "STORE_INVALID"
      );
    }
  },

  /**
   * Validate production confirmation for production stores
   */
  productionConfirmed(storeName, confirmProduction) {
    if (isProduction(storeName) && !confirmProduction) {
      throw new ValidationError(
        `This operation targets a PRODUCTION store ("${storeName}"). ` +
          `You must pass confirm_production: true to execute.`,
        "PRODUCTION_CONFIRMATION_REQUIRED"
      );
    }
  },

  /**
   * Validate that an operation can be cancelled
   */
  operationCancellable(operation) {
    if (operation.state === OperationState.EXECUTED) {
      throw new ValidationError(
        "Cannot cancel: operation has already been executed",
        "ALREADY_EXECUTED"
      );
    }
    if (operation.state === OperationState.CANCELLED) {
      throw new ValidationError(
        "Cannot cancel: operation is already cancelled",
        "ALREADY_CANCELLED"
      );
    }
  },
};

/**
 * Run all pre-execution validations
 * @param {object} operation - The operation to validate
 * @param {object} options - Validation options
 */
export function validateForExecution(operation, options = {}) {
  const { operationId, confirmProduction = false } = options;

  // GUARDRAIL 1: Operation must exist
  validators.operationExists(operation, operationId);

  // GUARDRAIL 2: Must be in PREVIEWED state
  validators.operationPreviewed(operation);

  // GUARDRAIL 3: Store must still be valid
  validators.storeValid(operation.store);

  // GUARDRAIL 4: Production requires explicit confirmation
  validators.productionConfirmed(operation.store, confirmProduction);
}

/**
 * Run validations for preview
 * @param {object} operation - The operation to validate
 * @param {string} operationId - The operation ID
 */
export function validateForPreview(operation, operationId) {
  // Operation must exist
  validators.operationExists(operation, operationId);

  // Must be in PLANNED state (can re-preview if already PREVIEWED)
  if (
    operation.state !== OperationState.PLANNED &&
    operation.state !== OperationState.PREVIEWED
  ) {
    throw new ValidationError(
      `Cannot preview: operation is in state "${operation.state}"`,
      "INVALID_STATE"
    );
  }

  // Store must still be valid
  validators.storeValid(operation.store);
}

/**
 * Run validations for cancellation
 * @param {object} operation - The operation to validate
 * @param {string} operationId - The operation ID
 */
export function validateForCancellation(operation, operationId) {
  validators.operationExists(operation, operationId);
  validators.operationCancellable(operation);
}

/**
 * Compare two previews to detect state changes
 * @param {object} oldPreview - Previous preview
 * @param {object} newPreview - Fresh preview
 * @returns {boolean} True if state has changed
 */
export function hasStateChanged(oldPreview, newPreview) {
  if (!oldPreview || !newPreview) return false;

  // Deep comparison of relevant preview fields
  // This catches cases where data changed between preview and execute
  const oldJson = JSON.stringify(sortObject(oldPreview.currentState || {}));
  const newJson = JSON.stringify(sortObject(newPreview.currentState || {}));

  return oldJson !== newJson;
}

/**
 * Sort object keys for consistent comparison
 */
function sortObject(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);

  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortObject(obj[key]);
      return acc;
    }, {});
}
