import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Chamber doesn't own the bare "chamber" name under the .security TLD, and
// anyone can register it. Built from parts so this file doesn't match itself.
const unowned = ["chamber", "security"].join(".");

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !["node_modules", ".git"].includes(entry.name))
      .map((entry) => {
        const child = path.join(directory, entry.name);
        return entry.isDirectory() ? files(child) : Promise.resolve([child]);
      }),
  );
  return nested.flat();
}

void test("sends evidence and tokens only to domains Chamber owns", async () => {
  const checked = await files(".");
  assert.ok(checked.includes(path.join("dist", "index.js")));
  const found: string[] = [];
  for (const file of checked) {
    // Hostnames are case-insensitive.
    const lines = (await readFile(file, "utf8")).toLowerCase().split("\n");
    lines.forEach((line, index) => {
      if (line.includes(unowned)) {
        found.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(found, []);
});
