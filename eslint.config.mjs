import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import globals from "globals";
import packageJson from "eslint-plugin-package-json";

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
    // the package.json rules modules.magicmirror.builders checks
    files: ["package.json"],
    extends: [packageJson.configs.recommended],
    rules: {
      "package-json/order-properties": "off",
      "package-json/require-exports": "off",
      "package-json/require-files": "off",
      "package-json/require-sideEffects": "off",
      "package-json/sort-collections": ["error", ["config", "dependencies", "devDependencies", "exports",
        "optionalDependencies", "overrides", "peerDependencies", "peerDependenciesMeta"]]
    }
  },
  {
    files: ["**/__tests__/**", "**/__mocks__/**", "**/test/**", "**/*.test.js"],
    languageOptions: { globals: { ...globals.jest } }
  }
]);
