#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDirectory = process.env.AGENT_SKILLS_DIR ?? join(homedir(), ".agents", "skills");
const target = join(skillsDirectory, "poker");
mkdirSync(skillsDirectory, { recursive: true });
cpSync(fileURLToPath(new URL("dist/poker", import.meta.url)), target, {
  recursive: true,
  force: true,
});
console.log(`Installed poker skill to ${target}`);
