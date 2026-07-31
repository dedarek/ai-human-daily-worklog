import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("desktop breakpoint keeps the sidebar and main canvas in two columns", async () => {
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(
    css,
    /@media\(max-width:1050px\)\{\.app-shell\{grid-template-columns:220px minmax\(0,1fr\)\}/,
  );
  assert.doesNotMatch(css, /@media\(max-width:1050px\)\{\.app-shell\{grid-template-columns:220px\}/);
});

test("dashboard isolates widget failures instead of blanking the whole page", async () => {
  const source = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(source, /Promise\.allSettled\(\[loadRuns\(\), loadMeetings\(\), loadMeetingStatus\(\), loadGraph\(\), loadDraft\(\), loadMorning\(\)\]\)/);
  assert.match(source, /document\.body\.classList\.add\("is-ready"\)/);
});
