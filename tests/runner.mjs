#!/usr/bin/env node
/**
 * VibeSync Hierarchical Test Runner
 * Orchestrates test execution across Tiers 1-4 with process isolation and structured reporting.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// ANSI Color Codes
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
};

const BASE_TIERS = [
  { id: "all", name: "Suite", title: "Consolidated Test Suite", dir: "." },
];

function printUsage() {
  console.log(`
${COLORS.bold}VibeSync Test Runner${COLORS.reset}
Usage: node tests/runner.mjs [options]

Options:
  -t, --tier <1|2|3|4|all>   Target specific tier or all tiers (default: all)
  -f, --filter <pattern>      Run only test files matching pattern
  -v, --verbose               Print full stdout/stderr of test processes
  -b, --bail, --fail-fast     Stop execution immediately on first failure
  -h, --help                  Show this help message
`);
}

function parseCliArgs() {
  const options = {
    tier: { type: "string", short: "t", default: "all" },
    filter: { type: "string", short: "f" },
    verbose: { type: "boolean", short: "v", default: false },
    bail: { type: "boolean", short: "b", default: false },
    "fail-fast": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  };

  try {
    const { values } = parseArgs({ options, args: process.argv.slice(2), strict: false });
    if (values["fail-fast"]) values.bail = true;
    return values;
  } catch (err) {
    console.error(`${COLORS.red}Argument Error: ${err.message}${COLORS.reset}`);
    printUsage();
    process.exit(1);
  }
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function discoverTestFiles(targetDir, filter) {
  const fullDir = path.isAbsolute(targetDir) ? targetDir : path.join(REPO_ROOT, "tests", targetDir);
  if (!fs.existsSync(fullDir)) return [];

  const files = fs
    .readdirSync(fullDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.js")))
    .map((entry) => path.join(fullDir, entry.name))
    .sort();

  if (!filter) return files;

  const regex = new RegExp(filter, "i");
  return files.filter((f) => regex.test(path.basename(f)) || regex.test(f));
}

function parseSpecSummary(rawOutput) {
  const clean = stripAnsi(rawOutput);
  const testsMatch = clean.match(/^\s*(?:ℹ\s*)?tests\s+(\d+)/mi);
  const passMatch = clean.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)/mi);
  const failMatch = clean.match(/^\s*(?:ℹ\s*)?fail\s+(\d+)/mi);
  const skipMatch = clean.match(/^\s*(?:ℹ\s*)?skipped\s+(\d+)/mi);
  const durationMatch = clean.match(/^\s*(?:ℹ\s*)?duration_ms\s+([\d.]+)/mi);

  let tests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
  let pass = passMatch ? parseInt(passMatch[1], 10) : 0;
  let fail = failMatch ? parseInt(failMatch[1], 10) : 0;
  let skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  let durationMs = durationMatch ? parseFloat(durationMatch[1]) : 0;

  if (tests === 0) {
    const passMatches = clean.match(/✔\s+[^\n]+/g) || [];
    const failMatches = clean.match(/✖\s+[^\n]+/g) || [];
    if (passMatches.length > 0 || failMatches.length > 0) {
      pass = passMatches.length;
      fail = failMatches.length;
      tests = pass + fail;
    }
  }

  return { tests, pass, fail, skipped, durationMs };
}

function runTestFile(filePath, verbose) {
  const relPath = path.relative(REPO_ROOT, filePath);
  const startTime = Date.now();

  const proc = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=spec", filePath],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
    }
  );

  const durationMs = Date.now() - startTime;
  const combinedOutput = (proc.stdout || "") + "\n" + (proc.stderr || "");
  const metrics = parseSpecSummary(combinedOutput);
  if (metrics.durationMs === 0) {
    metrics.durationMs = durationMs;
  }

  // If node --test process failed but parser didn't catch failures
  if (proc.status !== 0 && metrics.fail === 0) {
    metrics.fail = 1;
    metrics.tests = Math.max(metrics.tests, 1);
  }

  return {
    file: relPath,
    exitCode: proc.status,
    passed: proc.status === 0,
    metrics,
    output: combinedOutput,
    durationMs,
  };
}

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  console.log(`\n${COLORS.bold}${COLORS.cyan}========================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}                    VIBESYNC HIERARCHICAL TEST RUNNER                   ${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}========================================================================${COLORS.reset}`);
  console.log(`${COLORS.dim}Runtime: Node.js ${process.version} | Target Tier: ${args.tier} | Filter: ${args.filter || "none"}${COLORS.reset}\n`);

  // Detect root-level test files in tests/
  const rootTestsDir = path.join(REPO_ROOT, "tests");
  const rootFiles = fs.existsSync(rootTestsDir)
    ? fs.readdirSync(rootTestsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.js")))
        .map((entry) => entry.name)
    : [];

  const activeTiers = BASE_TIERS;

  const tierReports = [];
  const allFailures = [];

  for (const tier of activeTiers) {
    const files = discoverTestFiles(tier.dir, args.filter);

    // Skip tier heading if no files in tier unless explicitly requested or in verbose
    if (files.length === 0) {
      if (args.tier !== "all" || args.verbose) {
        console.log(`${COLORS.bold}${COLORS.blue}▶ Running ${tier.name}: ${tier.title}${COLORS.reset}`);
        console.log(`  ${COLORS.yellow}⚠ No test files found in tests/${tier.dir}${COLORS.reset}\n`);
      }
      continue;
    }

    console.log(`${COLORS.bold}${COLORS.blue}▶ Running ${tier.name}: ${tier.title}${COLORS.reset}`);

    const tierStats = {
      tier: tier.name,
      title: tier.title,
      fileCount: files.length,
      tests: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
      durationMs: 0,
    };

    for (const file of files) {
      const result = runTestFile(file, args.verbose);
      tierStats.tests += result.metrics.tests;
      tierStats.pass += result.metrics.pass;
      tierStats.fail += result.metrics.fail;
      tierStats.skipped += result.metrics.skipped;
      tierStats.durationMs += result.durationMs;

      const fileName = path.basename(result.file);
      if (result.passed) {
        console.log(`  ${COLORS.green}✔${COLORS.reset} ${fileName} ${COLORS.dim}(${result.metrics.pass} passed, ${result.durationMs}ms)${COLORS.reset}`);
      } else {
        console.log(`  ${COLORS.red}✖${COLORS.reset} ${fileName} ${COLORS.bold}${COLORS.red}(FAILED: ${result.metrics.fail} failed, ${result.durationMs}ms)${COLORS.reset}`);
        allFailures.push(result);
      }

      if (args.verbose || !result.passed) {
        if (args.verbose && result.passed) {
          console.log(`${COLORS.dim}${result.output.trim()}${COLORS.reset}\n`);
        }
      }

      if (args.bail && !result.passed) {
        console.log(`\n${COLORS.red}${COLORS.bold}Bailing execution immediately due to --bail / --fail-fast.${COLORS.reset}`);
        break;
      }
    }

    console.log();
    tierReports.push(tierStats);

    if (args.bail && allFailures.length > 0) break;
  }

  const grandTotal = tierReports.reduce(
    (acc, r) => {
      acc.files += r.fileCount;
      acc.tests += r.tests;
      acc.pass += r.pass;
      acc.fail += r.fail;
      acc.skipped += r.skipped;
      acc.durationMs += r.durationMs;
      return acc;
    },
    { files: 0, tests: 0, pass: 0, fail: 0, skipped: 0, durationMs: 0 }
  );

  // Print Structured Summary Table
  console.log(`${COLORS.bold}========================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}                           TEST EXECUTION SUMMARY                       ${COLORS.reset}`);
  console.log(`${COLORS.bold}========================================================================${COLORS.reset}`);
  console.log(
    `${"Tier".padEnd(8)} | ${"Description".padEnd(30)} | ${"Files".padStart(5)} | ${"Pass".padStart(6)} | ${"Fail".padStart(6)} | ${"Skip".padStart(5)} | ${"Duration".padStart(9)}`
  );
  console.log("-".repeat(78));

  for (const r of tierReports) {
    const passStr = r.pass > 0 ? `${COLORS.green}${r.pass}${COLORS.reset}` : `${r.pass}`;
    const failStr = r.fail > 0 ? `${COLORS.red}${r.fail}${COLORS.reset}` : `${r.fail}`;
    console.log(
      `${r.tier.padEnd(8)} | ${r.title.padEnd(30)} | ${String(r.fileCount).padStart(5)} | ${String(passStr).padStart(6)} | ${String(failStr).padStart(6)} | ${String(r.skipped).padStart(5)} | ${(r.durationMs + "ms").padStart(9)}`
    );
  }
  console.log("-".repeat(78));
  console.log(
    `${"TOTAL".padEnd(8)} | ${"All Executed Tiers".padEnd(30)} | ${String(grandTotal.files).padStart(5)} | ${String(grandTotal.pass).padStart(6)} | ${String(grandTotal.fail).padStart(6)} | ${String(grandTotal.skipped).padStart(5)} | ${(grandTotal.durationMs + "ms").padStart(9)}`
  );
  console.log("=".repeat(78));

  // Print Failure Diagnostics
  if (allFailures.length > 0) {
    console.log(`\n${COLORS.bold}${COLORS.red}FAILURE DETAILS (${allFailures.length} file(s)):${COLORS.reset}`);
    for (const fail of allFailures) {
      console.log(`\n${COLORS.bold}${COLORS.bgRed} FAIL ${COLORS.reset} ${COLORS.bold}${fail.file}${COLORS.reset}`);
      console.log(fail.output.trim());
    }
    console.log(`\n${COLORS.bold}${COLORS.red}❌ TEST SUITE FAILED: ${grandTotal.fail} failure(s) detected.${COLORS.reset}\n`);
    process.exit(1);
  }

  if (grandTotal.files === 0) {
    console.log(`\n${COLORS.yellow}⚠ No tests were executed.${COLORS.reset}\n`);
    process.exit(0);
  }

  console.log(`\n${COLORS.bold}${COLORS.green}🎉 ALL TIERS PASSED: ${grandTotal.pass} test(s) succeeded with zero errors.${COLORS.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${COLORS.red}Fatal runner exception: ${err.stack || err}${COLORS.reset}`);
  process.exit(1);
});
