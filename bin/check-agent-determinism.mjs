#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'check-repo-policy.mjs');
const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' });
process.exit(result.status ?? 1);
