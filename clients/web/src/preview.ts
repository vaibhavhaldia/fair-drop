#!/usr/bin/env node
// Renders a fixture (CONTRACT.md §3 shape) to a static HTML file for the milestone check —
// Gate 1 has no live module, so this stands in for what will be a live-subscribed page in
// Gate 2. `renderDisplay`/`deriveDisplayModel` do not change shape when that happens.
//
// Usage: node --experimental-strip-types src/preview.ts fixtures/turn-round2.json out.html

import { readFileSync, writeFileSync } from "node:fs";
import { parseFixture } from "./loadFixture.ts";
import { deriveDisplayModel } from "./deriveDisplayModel.ts";
import { renderDisplay } from "./renderDisplay.ts";

const [, , fixturePath, outPath] = process.argv;
if (!fixturePath || !outPath) {
  console.error("usage: preview.ts <fixture.json> <out.html>");
  process.exit(1);
}

const json = readFileSync(fixturePath, "utf8");
const data = parseFixture(json);
const model = deriveDisplayModel(data);
const body = renderDisplay(model);

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Fair Drop — display</title>
<style>
  body { font-family: sans-serif; margin: 2rem; }
  .split { display: flex; gap: 2rem; margin-bottom: 2rem; }
  .split-human, .split-bot { font-size: 3rem; text-align: center; }
  .split-label { display: block; font-size: 1rem; color: #666; }
  table { border-collapse: collapse; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; text-align: left; }
</style>
</head>
<body>
${body}
</body>
</html>`;

writeFileSync(outPath, page);
console.log(`wrote ${outPath} from ${fixturePath}`);
