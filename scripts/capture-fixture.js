#!/usr/bin/env node
/**
 * Capture a page snapshot fixture for tests: node scripts/capture-fixture.js <url> <name>
 * Writes test/fixtures/<name>.json (compact snapshot as sent to Jev, without rawById).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { collectElementsInPage, buildSnapshot } from "../src/snapshot.js";

const [url, name] = process.argv.slice(2);
if (!url || !name) {
  console.error("usage: node scripts/capture-fixture.js <url> <name>");
  process.exit(1);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForTimeout(800);
const data = await page.evaluate(collectElementsInPage);
const snap = buildSnapshot(data);
delete snap.rawById;
const out = path.join(__dirname, "..", "test", "fixtures", `${name}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ ...snap, rawCount: data.elements.length }, null, 2));
console.log(`${out}: ${snap.elements.length} elements (raw ${data.elements.length}), searchBox=${snap.searchBoxId}, site=${snap.site}`);
await browser.close();
