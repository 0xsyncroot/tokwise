import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const f = "dist/cli.js";
let s = readFileSync(f, "utf8");
if (!s.startsWith("#!")) {
  s = "#!/usr/bin/env node\n" + s;
  writeFileSync(f, s);
}
chmodSync(f, 0o755);
