#!/usr/bin/env node
import { initializeWorkspace } from '../src/init.mjs';
try {
  const result = initializeWorkspace(process.argv[2] || process.cwd());
  console.log(`VibeSync is ready in ${result.repoRoot}\nMCP configuration: ${result.configPath}\nStart the dashboard: vibesync --hud --repo ${JSON.stringify(result.repoRoot)}\nCreate your first feature contract in the dashboard.`);
} catch (err) {
  console.error(`VibeSync initialization failed: ${err.message}`);
  process.exitCode = 1;
}
