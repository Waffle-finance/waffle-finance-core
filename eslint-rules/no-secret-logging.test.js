/**
 * Unit tests for the no-secret-logging ESLint rule.
 *
 * Uses ESLint's built-in RuleTester.
 *
 * Run:
 *   node eslint-rules/no-secret-logging.test.js
 */

"use strict";

const { RuleTester } = require("eslint");
const rule = require("./no-secret-logging.js");

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-secret-logging", rule, {
  // ── Valid (must NOT be flagged) ─────────────────────────────────────────────
  valid: [
    // Public hashlock is fine — it is not a secret
    {
      code: `log.info({ hashlock, orderId }, "order created");`,
      name: "hashlock is a public field — allowed",
    },
    // Safe structured fields with no secret keys
    {
      code: `log.warn({ orderId, status, chain }, "order expired");`,
      name: "no secret fields — allowed",
    },
    // Explicitly redacted value with literal placeholder
    {
      code: `log.info({ preimage: "[REDACTED]" }, "reveal received");`,
      name: "literal [REDACTED] value — allowed",
    },
    {
      code: `log.error({ preimage: "[REDACTED_SECRET]" }, "bad reveal");`,
      name: "literal [REDACTED_SECRET] value — allowed",
    },
    // Wrapped in redactSensitiveFields — the wrapper handles it
    {
      code: `log.info(redactSensitiveFields({ preimage, orderId }), "reveal");`,
      name: "wrapped in redactSensitiveFields — allowed",
    },
    {
      code: `log.warn(sanitizeForLog({ secret: rawSecret }), "sanitized");`,
      name: "wrapped in sanitizeForLog — allowed",
    },
    // Non-logger call — not checked
    {
      code: `encryptSecret({ preimage });`,
      name: "non-logger call with secret field — not flagged",
    },
    // Error logging where the err field does not expose a secret directly
    {
      code: `log.error({ orderId, err }, "settlement failed");`,
      name: "err field without secret keys — allowed",
    },
    // allowFields option
    {
      code: `log.info({ seed }, "seeded");`,
      name: "seed allowed via allowFields option",
      options: [{ allowFields: ["seed"] }],
    },
    // Secret in a non-first argument position (message string) — not checked
    {
      code: `log.info("order claimed", "preimage was valid");`,
      name: "secret word in a string literal — not flagged",
    },
    // Spread element — statically unknown, not flagged
    {
      code: `log.info({ ...safeFields }, "spread — cannot inspect statically");`,
      name: "spread element — not flagged",
    },
  ],

  // ── Invalid (MUST be flagged) ───────────────────────────────────────────────
  invalid: [
    // Shorthand property: { preimage }
    {
      code: `log.info({ preimage }, "order claimed");`,
      name: "shorthand preimage in log.info — flagged",
      errors: [{ messageId: "secretField", data: { field: "preimage" } }],
    },
    // Explicit property: { preimage: order.preimage }
    {
      code: `log.warn({ preimage: order.preimage, orderId }, "reveal");`,
      name: "explicit preimage key in log.warn — flagged",
      errors: [{ messageId: "secretField", data: { field: "preimage" } }],
    },
    // privateKey
    {
      code: `log.error({ privateKey: wallet.privateKey }, "signing");`,
      name: "privateKey in log.error — flagged",
      errors: [{ messageId: "secretField", data: { field: "privateKey" } }],
    },
    // secret
    {
      code: `log.debug({ secret }, "debug dump");`,
      name: "shorthand secret in log.debug — flagged",
      errors: [{ messageId: "secretField", data: { field: "secret" } }],
    },
    // secretKey
    {
      code: `log.trace({ secretKey: cfg.secretKey }, "config loaded");`,
      name: "secretKey in log.trace — flagged",
      errors: [{ messageId: "secretField", data: { field: "secretKey" } }],
    },
    // mnemonic
    {
      code: `log.info({ mnemonic }, "wallet created");`,
      name: "mnemonic in log.info — flagged",
      errors: [{ messageId: "secretField", data: { field: "mnemonic" } }],
    },
    // Multiple secret fields in one call — each flagged independently
    {
      code: `log.warn({ preimage, privateKey, orderId }, "dump");`,
      name: "multiple secret fields in one call — both flagged",
      errors: [
        { messageId: "secretField", data: { field: "preimage" } },
        { messageId: "secretField", data: { field: "privateKey" } },
      ],
    },
    // Bare identifier passed directly
    {
      code: `console.log(preimage);`,
      name: "bare preimage identifier passed to console.log — flagged",
      errors: [{ messageId: "secretIdentifier", data: { name: "preimage" } }],
    },
    {
      code: `log.error(privateKey);`,
      name: "bare privateKey identifier passed to log.error — flagged",
      errors: [{ messageId: "secretIdentifier", data: { name: "privateKey" } }],
    },
    // logger.warn() — method name coverage
    {
      code: `logger.warn({ secret: rawVal }, "logger.warn call");`,
      name: "secret in logger.warn — flagged",
      errors: [{ messageId: "secretField", data: { field: "secret" } }],
    },
    // additionalFields option
    {
      code: `log.info({ apiToken }, "request");`,
      name: "additionalFields option adds apiToken to the blocked list",
      options: [{ additionalFields: ["apiToken"] }],
      errors: [{ messageId: "secretField", data: { field: "apiToken" } }],
    },
    // seed (without allowFields override)
    {
      code: `log.info({ seed }, "wallet seed logged");`,
      name: "seed without allowFields — flagged",
      errors: [{ messageId: "secretField", data: { field: "seed" } }],
    },
  ],
});

console.log("no-secret-logging: all tests passed ✅");
