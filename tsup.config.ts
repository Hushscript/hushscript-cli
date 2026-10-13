import type { Options } from "tsup";

const config: Options = {
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  treeshake: true,
  banner: { js: "#!/usr/bin/env node" },
};

export default config;
