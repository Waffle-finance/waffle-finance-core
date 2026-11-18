/**
 * Canonical object schema for coordinator API payloads.
 *
 * This module defines strict validation for all coordinator request and
 * response payloads to prevent API drift and catch integration issues early.
 */

import type {
  CoordinatorAnnounceRequest,
  CoordinatorRevealRequest,
  CoordinatorOrder,
  CoordinatorChainLeg,
  CoordinatorSecretBlock,
  CoordinatorHealthResponse,
  CoordinatorReadinessResponse,
} from "./contract.js";
import type { Chain, OrderStatus } from "../types/index.js";
import { validateHashlock, validateOrderId } from "../shared-utils/index.js";

export interface SchemaValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

/**
 * Validate a coordinator announce request payload.
 */
export function validateAnnounceRequestSchema(
  payload: unknown
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (typeof payload !== "object" || payload === null) {
    return {
      valid: false,
      errors: [{ field: "root", message: "Payload must be an object" }],
    };
  }

  const req = payload as Record<string, unknown>;

  // Required string fields
  const stringFields = [
    "direction",
    "hashlock",
    "srcChain",
    "srcAddress",
    "srcAsset",
    "srcAmount",
    "srcSafetyDeposit",
    "dstChain",
    "dstAddress",
    "dstAsset",
    "dstAmount",
  ];

  for (const field of stringFields) {
    if (typeof req[field] !== "string") {
      errors.push({
        field,
        message: `${field} must be a string`,
        value: req[field],
      });
    }
  }

  // Validate hashlock format
  if (typeof req.hashlock === "string" && !validateHashlock(req.hashlock)) {
    errors.push({
      field: "hashlock",
      message: "hashlock must be 0x-prefixed 64 hex characters",
      value: req.hashlock,
    });
  }

  // Validate amount fields are decimal integers
  const amountFields = ["srcAmount", "srcSafetyDeposit", "dstAmount"];
  for (const field of amountFields) {
    if (typeof req[field] === "string" && !/^\d+$/.test(req[field] as string)) {
      errors.push({
        field,
        message: `${field} must be a decimal integer string`,
        value: req[field],
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a coordinator reveal request payload.
 */
export function validateRevealRequestSchema(
  payload: unknown
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (typeof payload !== "object" || payload === null) {
    return {
      valid: false,
      errors: [{ field: "root", message: "Payload must be an object" }],
    };
  }

  const req = payload as Record<string, unknown>;

  // publicId
  if (typeof req.publicId !== "string") {
    errors.push({
      field: "publicId",
      message: "publicId must be a string",
      value: req.publicId,
    });
  } else {
    const idErr = validateOrderId(req.publicId);
    if (idErr) {
      errors.push({
        field: "publicId",
        message: idErr,
        value: req.publicId,
      });
    }
  }

  // preimage
  if (typeof req.preimage !== "string") {
    errors.push({
      field: "preimage",
      message: "preimage must be a string",
      value: req.preimage,
    });
  } else if (!validateHashlock(req.preimage)) {
    errors.push({
      field: "preimage",
      message: "preimage must be 0x-prefixed 64 hex characters",
      value: req.preimage,
    });
  }

  // txHash
  if (typeof req.txHash !== "string" || req.txHash.length === 0) {
    errors.push({
      field: "txHash",
      message: "txHash must be a non-empty string",
      value: req.txHash,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a coordinator chain leg response.
 */
export function validateChainLegSchema(
  leg: unknown,
  legName: string
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (typeof leg !== "object" || leg === null) {
    return {
      valid: false,
      errors: [
        {
          field: legName,
          message: `${legName} must be an object`,
          value: leg,
        },
      ],
    };
  }

  const l = leg as Record<string, unknown>;

  // Required fields
  const requiredStrings = ["chain", "address", "asset", "amount"];
  for (const field of requiredStrings) {
    if (typeof l[field] !== "string") {
      errors.push({
        field: `${legName}.${field}`,
        message: `${field} must be a string`,
        value: l[field],
      });
    }
  }

  // amount must be decimal integer
  if (typeof l.amount === "string" && !/^\d+$/.test(l.amount)) {
    errors.push({
      field: `${legName}.amount`,
      message: "amount must be a decimal integer string",
      value: l.amount,
    });
  }

  // Optional fields with type constraints
  if (l.safetyDeposit !== undefined) {
    if (typeof l.safetyDeposit !== "string") {
      errors.push({
        field: `${legName}.safetyDeposit`,
        message: "safetyDeposit must be a string",
        value: l.safetyDeposit,
      });
    } else if (!/^\d+$/.test(l.safetyDeposit)) {
      errors.push({
        field: `${legName}.safetyDeposit`,
        message: "safetyDeposit must be a decimal integer string",
        value: l.safetyDeposit,
      });
    }
  }

  // Nullable fields
  const nullableStrings = ["orderId", "lockTx", "revealedTx"];
  for (const field of nullableStrings) {
    if (l[field] !== null && typeof l[field] !== "string") {
      errors.push({
        field: `${legName}.${field}`,
        message: `${field} must be a string or null`,
        value: l[field],
      });
    }
  }

  if (l.lockBlock !== null && typeof l.lockBlock !== "number") {
    errors.push({
      field: `${legName}.lockBlock`,
      message: "lockBlock must be a number or null",
      value: l.lockBlock,
    });
  }

  if (l.timelock !== null && typeof l.timelock !== "number") {
    errors.push({
      field: `${legName}.timelock`,
      message: "timelock must be a number or null",
      value: l.timelock,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a coordinator secret block response.
 */
export function validateSecretBlockSchema(
  secret: unknown
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (typeof secret !== "object" || secret === null) {
    return {
      valid: false,
      errors: [{ field: "secret", message: "secret must be an object", value: secret }],
    };
  }

  const s = secret as Record<string, unknown>;

  if (typeof s.revealed !== "boolean") {
    errors.push({
      field: "secret.revealed",
      message: "revealed must be a boolean",
      value: s.revealed,
    });
  }

  if (s.preimage !== null && typeof s.preimage !== "string") {
    errors.push({
      field: "secret.preimage",
      message: "preimage must be a string or null",
      value: s.preimage,
    });
  }

  if (s.revealedTx !== null && typeof s.revealedTx !== "string") {
    errors.push({
      field: "secret.revealedTx",
      message: "revealedTx must be a string or null",
      value: s.revealedTx,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a coordinator order response.
 */
export function validateOrderSchema(order: unknown): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (typeof order !== "object" || order === null) {
    return {
      valid: false,
      errors: [{ field: "order", message: "order must be an object", value: order }],
    };
  }

  const o = order as Record<string, unknown>;

  // id
  if (typeof o.id !== "string") {
    errors.push({ field: "id", message: "id must be a string", value: o.id });
  } else {
    const idErr = validateOrderId(o.id);
    if (idErr) {
      errors.push({ field: "id", message: idErr, value: o.id });
    }
  }

  // direction
  if (typeof o.direction !== "string") {
    errors.push({
      field: "direction",
      message: "direction must be a string",
      value: o.direction,
    });
  }

  // status
  const validStatuses = [
    "announced",
    "src_locked",
    "dst_locked",
    "secret_revealed",
    "completed",
    "refunded",
    "failed",
    "expired",
    "cancelled",
    "abandoned",
  ];
  if (typeof o.status !== "string" || !validStatuses.includes(o.status)) {
    errors.push({
      field: "status",
      message: `status must be one of: ${validStatuses.join(", ")}`,
      value: o.status,
    });
  }

  // hashlock
  if (typeof o.hashlock !== "string") {
    errors.push({
      field: "hashlock",
      message: "hashlock must be a string",
      value: o.hashlock,
    });
  } else if (!validateHashlock(o.hashlock)) {
    errors.push({
      field: "hashlock",
      message: "hashlock must be 0x-prefixed 64 hex characters",
      value: o.hashlock,
    });
  }

  // src leg
  const srcResult = validateChainLegSchema(o.src, "src");
  errors.push(...srcResult.errors);

  // dst leg
  const dstResult = validateChainLegSchema(o.dst, "dst");
  errors.push(...dstResult.errors);

  // secret block
  const secretResult = validateSecretBlockSchema(o.secret);
  errors.push(...secretResult.errors);

  // resolver
  if (o.resolver !== null && typeof o.resolver !== "string") {
    errors.push({
      field: "resolver",
      message: "resolver must be a string or null",
      value: o.resolver,
    });
  }

  // timestamps
  if (typeof o.createdAt !== "number") {
    errors.push({
      field: "createdAt",
      message: "createdAt must be a number",
      value: o.createdAt,
    });
  }

  if (typeof o.updatedAt !== "number") {
    errors.push({
      field: "updatedAt",
      message: "updatedAt must be a number",
      value: o.updatedAt,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a coordinator health response.
 */
export function validateHealthResponseSchema(
  response: unknown
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];

  if (typeof response !== "object" || response === null) {
    return {
      valid: false,
      errors: [
        {
          field: "root",
          message: "Health response must be an object",
          value: response,
        },
      ],
    };
  }

  const r = response as Record<string, unknown>;

  // status
  if (r.status !== "ok" && r.status !== "degraded") {
    errors.push({
      field: "status",
      message: 'status must be "ok" or "degraded"',
      value: r.status,
    });
  }

  // service
  if (typeof r.service !== "string") {
    errors.push({
      field: "service",
      message: "service must be a string",
      value: r.service,
    });
  }

  // version
  if (typeof r.version !== "string") {
    errors.push({
      field: "version",
      message: "version must be a string",
      value: r.version,
    });
  }

  // uptimeSeconds
  if (typeof r.uptimeSeconds !== "number") {
    errors.push({
      field: "uptimeSeconds",
      message: "uptimeSeconds must be a number",
      value: r.uptimeSeconds,
    });
  }

  // timestamp
  if (typeof r.timestamp !== "string") {
    errors.push({
      field: "timestamp",
      message: "timestamp must be a string",
      value: r.timestamp,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Assert that a payload matches the schema, throwing on validation failure.
 */
export function assertValidSchema(
  result: SchemaValidationResult,
  context: string
): void {
  if (!result.valid) {
    const errorMessages = result.errors
      .map((e) => `${e.field}: ${e.message}`)
      .join("; ");
    throw new Error(`${context} schema validation failed: ${errorMessages}`);
  }
}
