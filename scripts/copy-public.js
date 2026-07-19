const { cpSync } = require("node:fs");
const { join } = require("node:path");

cpSync(join(__dirname, "..", "src", "public"), join(__dirname, "..", "dist", "public"), { recursive: true });
