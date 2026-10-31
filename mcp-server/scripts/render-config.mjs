// Writes wrangler.deploy.jsonc (gitignored) from wrangler.jsonc with the account-specific Hyperdrive ID filled in.
// Usage: HYPERDRIVE_ID=<32-hex id> node scripts/render-config.mjs
import { readFileSync, writeFileSync } from "node:fs";

const PLACEHOLDER = "REPLACE_WITH_HYPERDRIVE_ID";
const src = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const id = (process.env.HYPERDRIVE_ID ?? "").trim();

if (src.includes(PLACEHOLDER)) {
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    console.error(`Set HYPERDRIVE_ID to your Hyperdrive configuration ID (32 hex characters).\n` +
      `Create one with: npx wrangler hyperdrive create seba-textbook-db --connection-string="<read-only DSN>" --caching-disabled`);
    process.exit(1);
  }
}
writeFileSync(new URL("../wrangler.deploy.jsonc", import.meta.url), src.replace(PLACEHOLDER, id));
console.log("wrote wrangler.deploy.jsonc");
