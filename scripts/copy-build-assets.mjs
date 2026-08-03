import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const assets = [
  ["src/persistence/migrations", "dist/persistence/migrations"],
];

for (const [source, target] of assets) {
  if (!existsSync(source)) {
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
