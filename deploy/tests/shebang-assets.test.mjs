import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const deployRoot = path.join(repositoryRoot, 'deploy');

async function filesWithin(directory) {
  const results = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await filesWithin(absolute));
    else if (entry.isFile()) results.push(absolute);
  }
  return results.sort();
}

function repositoryPath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/');
}

function executableDeployPaths() {
  const records = execFileSync('git', ['ls-files', '--stage', '-z', '--', 'deploy'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  }).split('\0').filter(Boolean);
  return new Set(records.filter((record) => record.startsWith('100755 ')).map((record) => record.split('\t')[1]));
}

async function shebangAssets() {
  const results = [];
  for (const absolute of await filesWithin(deployRoot)) {
    const bytes = await fs.readFile(absolute);
    if (bytes[0] === 0x23 && bytes[1] === 0x21) results.push({ absolute, bytes, relative: repositoryPath(absolute) });
  }
  return results;
}

test('every executable or shebang deploy asset is CR-free and explicitly normalized to LF', async () => {
  const assets = await shebangAssets();
  const byPath = new Map(assets.map((asset) => [asset.relative, asset]));
  assert(assets.length >= 25, 'deploy shebang discovery unexpectedly shrank');
  for (const executable of executableDeployPaths()) {
    assert(byPath.has(executable), `executable deploy asset lacks a shebang: ${executable}`);
  }
  for (const { bytes, relative } of assets) {
    assert.equal(bytes.includes(0x0d), false, `deploy shebang asset contains CR bytes: ${relative}`);
    const attribute = execFileSync('git', ['check-attr', 'eol', '--', relative], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    }).trim();
    assert.equal(attribute, `${relative}: eol: lf`, `deploy shebang asset lacks an explicit LF attribute: ${relative}`);
  }
});

test('every deploy shebang asset passes its declared interpreter syntax check', {
  skip: process.platform === 'win32'
}, async () => {
  for (const { absolute, bytes, relative } of await shebangAssets()) {
    const firstLine = bytes.toString('utf8').split('\n', 1)[0];
    let command;
    let args;
    if (firstLine === '#!/bin/sh') {
      command = '/bin/sh';
      args = ['-n', absolute];
    } else if (firstLine === '#!/usr/bin/env bash') {
      command = '/usr/bin/env';
      args = ['bash', '-n', absolute];
    } else if (firstLine === '#!/usr/bin/env node' || /^#!\/[^\s]*\/node$/.test(firstLine)) {
      command = process.execPath;
      args = ['--check', absolute];
    } else {
      assert.fail(`unsupported deploy shebang: ${relative}: ${firstLine}`);
    }
    const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative} failed ${firstLine} syntax validation:\n${result.stderr || result.stdout}`);
  }
});
