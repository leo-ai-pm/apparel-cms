import { defineConfig, globalIgnores } from "eslint/config";
import { fixupConfigRules } from "@eslint/compat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  // Preserve all Next/React rules while supporting plugins on the ESLint 10 API.
  ...fixupConfigRules([...nextVitals, ...nextTs]),
  globalIgnores([".next*/**", "coverage/**", "next-env.d.ts"]),
]);
