/**
 * Local ESLint plugin: wafflefinance-security
 *
 * Exposes custom security rules for use across all service packages
 * via the root .eslintrc.json.
 */

"use strict";

module.exports = {
  rules: {
    "no-secret-logging": require("./no-secret-logging.js"),
  },
};
