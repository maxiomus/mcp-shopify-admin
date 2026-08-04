import { sessionStore, OperationState, OperationType } from "./session.js";
import {
  validateForExecution,
  validateForPreview,
  validateForCancellation,
  hasStateChanged,
  ValidationError,
} from "./validators.js";
import { isProduction, requireStore } from "../stores/registry.js";

/**
 * Workflow Engine - orchestrates the staged plan → preview → execute workflow
 */
export const workflowEngine = {
  /**
   * Create a planned operation (step 1)
   * @param {object} params - Operation parameters
   * @returns {object} Planned operation
   */
  plan({ store, operationType, payload, description, affectedResources = [] }) {
    // Validate store exists
    requireStore(store);

    // Create the operation
    const operation = sessionStore.create({
      store,
      operationType,
      payload,
      description,
      affectedResources,
    });

    return {
      operationId: operation.operationId,
      state: operation.state,
      store: operation.store,
      storeEnvironment: isProduction(store) ? "production" : "non-production",
      operationType: operation.operationType,
      description: operation.description,
      affectedResources: operation.affectedResources,
      createdAt: operation.createdAt,
      expiresIn: "30 minutes",
      nextStep: "Call the corresponding _preview tool with this operation_id",
    };
  },

  /**
   * Generate preview for an operation (step 2)
   * @param {string} operationId - Operation ID
   * @param {Function} previewGenerator - Function that generates preview data
   * @returns {object} Preview result
   */
  async preview(operationId, previewGenerator) {
    const operation = sessionStore.get(operationId);
    validateForPreview(operation, operationId);

    // Generate preview data (fetches current state, computes diff)
    const preview = await previewGenerator(operation);

    // Update operation with preview
    sessionStore.setPreview(operationId, preview);

    const store = requireStore(operation.store);
    const storeWarning =
      store.environment === "production" ? " (PRODUCTION)" : "";

    return {
      operationId,
      state: OperationState.PREVIEWED,
      store: `${operation.store}${storeWarning}`,
      operationType: operation.operationType,
      description: operation.description,
      preview,
      warnings: store.environment === "production"
        ? ["This operation targets a PRODUCTION store. Execution requires confirm_production: true"]
        : [],
      nextStep: "Review the changes above. If approved, call the corresponding _execute tool",
    };
  },

  /**
   * Execute a previewed operation (step 3)
   * @param {string} operationId - Operation ID
   * @param {boolean} confirmProduction - Required for production stores
   * @param {Function} executor - Function that performs the mutation
   * @param {Function} freshPreviewGenerator - Function to get fresh preview for state check
   * @returns {object} Execution result
   */
  async execute(
    operationId,
    confirmProduction,
    executor,
    freshPreviewGenerator = null
  ) {
    const operation = sessionStore.get(operationId);

    // Run all guardrail validations
    validateForExecution(operation, { operationId, confirmProduction });

    // GUARDRAIL 5: Check if state changed since preview (optional but recommended)
    if (freshPreviewGenerator && operation.preview) {
      try {
        const freshPreview = await freshPreviewGenerator(operation);
        if (hasStateChanged(operation.preview, freshPreview)) {
          throw new ValidationError(
            "State has changed since preview. Please re-plan and re-preview the operation.",
            "STATE_CHANGED"
          );
        }
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        // If we can't verify state, log warning but proceed
        console.warn(
          `[workflow] Could not verify state for operation ${operationId}: ${error.message}`
        );
      }
    }

    // Execute the mutation
    const result = await executor(operation);

    // Mark as executed
    sessionStore.setExecuted(operationId, result);

    return {
      operationId,
      state: OperationState.EXECUTED,
      store: operation.store,
      operationType: operation.operationType,
      executedAt: new Date().toISOString(),
      result,
    };
  },

  /**
   * Cancel a pending operation
   * @param {string} operationId - Operation ID
   * @returns {object} Cancellation result
   */
  cancel(operationId) {
    const operation = sessionStore.get(operationId);
    validateForCancellation(operation, operationId);

    sessionStore.cancel(operationId);

    return {
      operationId,
      state: OperationState.CANCELLED,
      message: "Operation cancelled successfully",
    };
  },

  /**
   * Get operation status
   * @param {string} operationId - Operation ID
   * @returns {object|null} Operation status
   */
  getStatus(operationId) {
    const operation = sessionStore.get(operationId);
    if (!operation) return null;

    const store = requireStore(operation.store);
    const storeWarning =
      store.environment === "production" ? " (PRODUCTION)" : "";

    return {
      operationId: operation.operationId,
      state: operation.state,
      store: `${operation.store}${storeWarning}`,
      operationType: operation.operationType,
      description: operation.description,
      affectedResources: operation.affectedResources,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      executedAt: operation.executedAt,
      preview: operation.preview,
      result: operation.result,
    };
  },

  /**
   * List all pending operations
   * @returns {Array} List of pending operations
   */
  listPending() {
    return sessionStore.listPending().map((op) => {
      let storeWarning = "";
      try {
        const store = requireStore(op.store);
        storeWarning = store.environment === "production" ? " (PRODUCTION)" : "";
      } catch (e) {
        storeWarning = " (INVALID STORE)";
      }

      return {
        operationId: op.operationId,
        state: op.state,
        store: `${op.store}${storeWarning}`,
        operationType: op.operationType,
        description: op.description,
        createdAt: op.createdAt,
        expiresAt: new Date(op.expiresAt).toISOString(),
      };
    });
  },
};

// Re-export types for convenience
export { OperationState, OperationType };
