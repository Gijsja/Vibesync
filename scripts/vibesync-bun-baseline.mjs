#!/usr/bin/env bun
import { main } from './vibesync-baseline.mjs';

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
