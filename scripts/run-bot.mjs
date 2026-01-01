#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
process.chdir(repoRoot);

// Load .env so launcher flags (SKIP_INSTALL / REGISTER_COMMANDS) work even when
// the user double-clicks a file or sets variables without exporting them.
dotenv.config({ path: path.join(repoRoot, '.env') });

function info(message) {
  process.stdout.write(`[run-bot] ${message}\n`);
}

function error(message) {
  process.stderr.write(`[run-bot] ERROR: ${message}\n`);
}

function fail(message, exitCode = 1) {
  error(message);
  process.exit(exitCode);
}

function envFlag(name, defaultValue = '0') {
  const value = process.env[name];
  return (
    (value ?? defaultValue).toLowerCase() === '1' ||
    (value ?? defaultValue).toLowerCase() === 'true'
  );
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function nodeMajorVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const major = nodeMajorVersion();
  if (!major) fail('Could not determine Node.js version.');
  if (major < 20) fail(`Node.js >= 20 is required (found v${process.versions.node}).`);

  if (!exists(path.join(repoRoot, '.env'))) {
    fail('Missing .env file. Copy .env.example -> .env and fill in required values.');
  }

  const skipInstall = envFlag('SKIP_INSTALL');
  // Default to registering commands so "double-click to run" works end-to-end.
  // Users can opt out with REGISTER_COMMANDS=0 / false.
  const registerCommands = envFlag('REGISTER_COMMANDS', '1');

  // npm availability check: attempt to run `npm --version`.
  try {
    await run('npm', ['--version']);
  } catch {
    fail('npm is not installed or not on PATH.');
  }

  if (!skipInstall) {
    const hasNodeModules = exists(path.join(repoRoot, 'node_modules'));
    const hasPackageLock = exists(path.join(repoRoot, 'package-lock.json'));

    if (!hasNodeModules) {
      info('Installing dependencies (node_modules not found)…');
      await run('npm', [hasPackageLock ? 'ci' : 'install']);
    } else {
      info('Ensuring dependencies are up to date…');
      await run('npm', ['install']);
    }
  } else {
    info('Skipping dependency install (SKIP_INSTALL=1).');
  }

  info('Building TypeScript…');
  await run('npm', ['run', 'build']);

  if (registerCommands) {
    info('Registering slash commands (REGISTER_COMMANDS=1)…');
    await run('npm', ['run', 'register:commands']);
  }

  info('Starting bot…');
  await run('npm', ['run', 'start']);
}

main().catch((e) => {
  error(e?.message || String(e));
  process.exit(1);
});
