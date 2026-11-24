/**
 * ESLint rule: no-secret-logging
 *
 * Flags direct inclusion of known secret-bearing field names as keys inside
 * the first-argument object of a logger call (log.info, log.warn, log.error,
 * log.debug, log.trace, logger.*, getLogger().*, and console.*).
 *
 * ## What it catches
 *
 *   log.info({ preimage }, "order claimed");           // ❌ shorthand property
 *   log.warn({ privateKey: key }, "key used");         // ❌ explicit key
 *   log.error({ secret: order.secret }, "failed");     // ❌ explicit key
 *   console.log(preimage);                             // ❌ bare identifier arg
 *
 * ## What it allows
 *
 *   log.info({ hashlock }, "order created");           // ✅ hashlock is public
 *   log.warn({ orderId, status }, "order expired");    // ✅ no secret fields
 *   log.info(redactSensitiveFields({ preimage }), …);  // ✅ explicitly redacted
 *   log.info({ preimage: "[REDACTED]" }, "ok");        // ✅ literal redacted
 *
 * ## Secret field list
 *
 * Mirrors SENSITIVE_FIELD_NAMES from
 * coordinator/src/sensitive/sensitive-fields.ts.  Any addition there should
 * be reflected here.
 */

"use strict";

/** Fields that must never appear in plaintext in a log call. */
const SECRET_FIELDS = new Set([
  "preimage",
  "secret",
  "secretKey",
  "encKey",
  "secretStorageKey",
  "privateKey",
  "mnemonic",
  "seed",
]);

/**
 * Names of functions / methods that constitute a "logger call".
 * Covers the structured pino convention: log.info, log.warn, log.error,
 * log.debug, log.trace, logger.*, getLogger().*, and console.*.
 */
const LOGGER_METHODS = new Set([
  "info", "warn", "error", "debug", "trace", "fatal", "log",
]);

/**
 * Callee patterns that are known redaction wrappers.
 * A first-argument object wrapped in one of these is permitted.
 */
const REDACTION_WRAPPERS = new Set([
  "redactSensitiveFields",
  "sanitizeForLog",
  "redact",
]);

/** Return true if the CallExpression node looks like a logger call. */
function isLoggerCall(node) {
  const { callee } = node;
  // log.info(...) / logger.warn(...) / getLogger().error(...)
  if (callee.type === "MemberExpression") {
    const method = callee.property.name ?? callee.property.value;
    return LOGGER_METHODS.has(method);
  }
  // console.log(...)
  if (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "console"
  ) {
    return LOGGER_METHODS.has(callee.property.name);
  }
  return false;
}

/**
 * Return true if `node` is wrapped in a known redaction function call.
 * e.g.  redactSensitiveFields({ preimage })
 */
function isWrappedInRedaction(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type !== "CallExpression") return false;
  const { callee } = parent;
  if (callee.type === "Identifier") return REDACTION_WRAPPERS.has(callee.name);
  if (callee.type === "MemberExpression")
    return REDACTION_WRAPPERS.has(callee.property.name ?? "");
  return false;
}

/**
 * Return true if the value of a property is a string literal "[REDACTED]"
 * or "[REDACTED_SECRET]" — the caller already handled redaction manually.
 */
function isLiterallyRedacted(valueNode) {
  return (
    valueNode &&
    valueNode.type === "Literal" &&
    typeof valueNode.value === "string" &&
    /^\[REDACT/i.test(valueNode.value)
  );
}

// ── Rule definition ───────────────────────────────────────────────────────────

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow logging secret-bearing fields (preimage, privateKey, secret, …) directly in logger calls.",
      category: "Security",
      recommended: true,
      url: "https://github.com/Waffle-finance/waffle-finance-core/blob/main/eslint-rules/no-secret-logging.js",
    },
    schema: [
      {
        type: "object",
        properties: {
          /**
           * Additional field names to flag beyond the built-in list.
           * Useful for project-specific secrets not in the global list.
           */
          additionalFields: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
          /**
           * Field names from the built-in list to allow (narrow the rule).
           * Use sparingly; prefer renaming the field or using redactSensitiveFields.
           */
          allowFields: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      secretField:
        "Direct logging of secret field '{{field}}' is forbidden. " +
        "Wrap the object with redactSensitiveFields() or omit the field entirely.",
      secretIdentifier:
        "Passing the identifier '{{name}}' directly to a logger is forbidden " +
        "when its name matches a known secret field. " +
        "Use redactSensitiveFields() or log a safe summary value instead.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const additionalFields = new Set(options.additionalFields ?? []);
    const allowFields = new Set(options.allowFields ?? []);

    /** Effective secret field set for this rule invocation. */
    function isSecretField(name) {
      if (allowFields.has(name)) return false;
      return SECRET_FIELDS.has(name) || additionalFields.has(name);
    }

    /**
     * Check all properties of an ObjectExpression that is the first arg
     * of a logger call.
     */
    function checkObjectArg(objNode) {
      if (isWrappedInRedaction(objNode)) return;

      for (const prop of objNode.properties) {
        if (prop.type === "SpreadElement") continue; // can't statically inspect

        // Key name: covers both { preimage } (shorthand) and { preimage: x }
        const keyName =
          prop.key && prop.key.type === "Identifier"
            ? prop.key.name
            : prop.key && prop.key.type === "Literal"
              ? String(prop.key.value)
              : null;

        if (!keyName) continue;
        if (!isSecretField(keyName)) continue;

        // Allow if the value is a literal "[REDACTED...]" string.
        if (isLiterallyRedacted(prop.value)) continue;

        context.report({
          node: prop,
          messageId: "secretField",
          data: { field: keyName },
        });
      }
    }

    return {
      CallExpression(node) {
        if (!isLoggerCall(node)) return;

        const args = node.arguments;
        if (args.length === 0) return;

        // Pattern 1: log.info({ preimage, … }, "message")
        // — first argument is an ObjectExpression
        if (args[0].type === "ObjectExpression") {
          checkObjectArg(args[0]);
          return;
        }

        // Pattern 2: console.log(preimage) / log.info(preimage)
        // — bare Identifier whose name is a secret field
        for (const arg of args) {
          if (
            arg.type === "Identifier" &&
            isSecretField(arg.name) &&
            !isWrappedInRedaction(arg)
          ) {
            context.report({
              node: arg,
              messageId: "secretIdentifier",
              data: { name: arg.name },
            });
          }
        }
      },
    };
  },
};
