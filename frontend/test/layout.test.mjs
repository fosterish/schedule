import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { computeLayout } from "../src/components/layout.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const corpusDir = path.resolve(here, "..", "..", "tests", "layout");
const files = fs
  .readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json"))
  .sort();
assert.ok(files.length > 0, "no golden corpus files in " + corpusDir);

for (const f of files) {
  test(`layout golden: ${f}`, () => {
    const raw = fs.readFileSync(path.join(corpusDir, f), "utf8");
    const c = JSON.parse(raw);
    const result = computeLayout(c.schedule, c.items);
    if (c.expected && c.expected.items) {
      assert.equal(result.items.length, c.expected.items.length, "item count");
      for (let i = 0; i < c.expected.items.length; i++) {
        const ei = c.expected.items[i];
        const r = result.items[i];
        assert.equal(r.id, ei.id, `id at index ${i}`);
        assert.equal(
          r.assigned_start,
          ei.assigned_start,
          `assigned_start at item ${i}`
        );
        assert.equal(
          r.assigned_end,
          ei.assigned_end,
          `assigned_end at item ${i}`
        );
        assert.equal(r.flags.overflow, ei.flags.overflow, `overflow item ${i}`);
        assert.equal(
          r.flags.out_of_bounds,
          ei.flags.out_of_bounds,
          `out_of_bounds item ${i}`
        );
        assert.equal(
          r.flags.below_min,
          ei.flags.below_min,
          `below_min item ${i}`
        );
      }
    }
    if (c.expected_errors_contain) {
      for (const want of c.expected_errors_contain) {
        assert.ok(
          result.errors.includes(want),
          `expected error '${want}' in ${JSON.stringify(result.errors)}`
        );
      }
    }
  });
}
