// Copies the Capacitor plugin JS (ES modules) into app/vendor so the no-build web app can import them
// through the import map in index.html. Run after changing Capacitor versions: `npm run vendor`.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "app/vendor";
const SRC = {
  "capacitor/core.js": "node_modules/@capacitor/core/dist/index.js",
  "capacitor/synapse.js": "node_modules/@capacitor/synapse/dist/synapse.mjs",
  "bluetooth-le": "node_modules/@capacitor-community/bluetooth-le/dist/esm",
  "keep-awake": "node_modules/@capacitor-community/keep-awake/dist/esm",
  filesystem: "node_modules/@capacitor/filesystem/dist/esm",
  share: "node_modules/@capacitor/share/dist/esm",
};

rmSync(OUT, { recursive: true, force: true });
for (const [dst, src] of Object.entries(SRC)) {
  const to = join(OUT, dst);
  if (dst.endsWith(".js")) { mkdirSync(join(to, ".."), { recursive: true }); cpSync(src, to); continue; }
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(src)) if (f.endsWith(".js")) cpSync(join(src, f), join(to, f));
}
// browsers need file extensions on relative imports (bundlers add them); drop source map links (maps aren't copied)
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
for (const f of walk(OUT)) {
  writeFileSync(f, readFileSync(f, "utf8")
    .replace(/((?:from\s*|import\s*\(\s*)(['"]))(\.{1,2}\/[^'"]+?)(?<!\.js)\2/g, "$1$3.js$2")
    .replace(/\n\/\/# sourceMappingURL=.*$/m, ""));
}
console.log(`vendored into ${OUT}`);
