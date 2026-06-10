import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dev-dist/**",
      "node_modules/**",
      "src/bindings/**",
      // Old Mithril app, kept for reference during the port.
      "src/**/*.js",
      "src/views/**",
      "src/components/**",
      "test/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      // Area barrels must be imported as namespaces (`import * as x from "@lib/..."`)
      // so generic verbs (apply/compute/detect) read meaningfully at the call site.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value=/^@lib\\u002f(schedule|project|ops)$/] :matches(ImportSpecifier, ImportDefaultSpecifier)",
          message: "Import area barrels as namespaces: import * as x from \"@lib/...\".",
        },
      ],
    },
  },
  {
    // ui/ talks to the app through state/, never to data/ (or IndexedDB) directly.
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@data", "@data/*", "idb"],
              message: "ui/ must go through state/, not data/ directly.",
            },
          ],
        },
      ],
    },
  },
  {
    // lib/ is pure: no framework, no data/state/ui.
    files: ["src/lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "preact",
                "preact/*",
                "@preact/*",
                "@data/*",
                "@state/*",
                "@ui/*",
              ],
              message: "lib/ must stay pure (no framework / data / state / ui imports).",
            },
          ],
        },
      ],
    },
  },
);
