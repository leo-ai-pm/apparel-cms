import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".next-unified/**", ".next-s1-*/**", ".next-s3-*/**", ".next-profile-*/**", "coverage/**", "next-env.d.ts"]),
]);
