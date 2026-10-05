import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";

// MagicMirror front-end files run in the browser with MagicMirror's globals; node_helper.js and
// the tests run in Node. Vendored and generated files are not linted.
export default defineConfig([
  {
    ignores: ["node_modules/", "vendor/", "lib/", "animations/", "videos/", "docs/", "coverage/", "**/*.min.js"]
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
        Module: "readonly",
        Log: "readonly",
        MM: "readonly",
        config: "readonly",
        moment: "readonly",
        lottie: "readonly",
        SunCalc: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      // the modules keep /* global ... */ comments for editors without ESLint; they may repeat
      // globals declared above
      "no-redeclare": ["error", { builtinGlobals: false }]
    }
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node } }
  },
  {
    files: ["**/__tests__/**", "**/__mocks__/**", "**/test/**", "**/*.test.js"],
    languageOptions: { globals: { ...globals.jest } }
  }
]);
