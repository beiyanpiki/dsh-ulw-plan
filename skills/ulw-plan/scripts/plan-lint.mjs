#!/usr/bin/env node
// plan-lint.mjs - read-only structural preflight for a ulw work plan.
//
// Usage:  plan-lint.mjs <plan.md> [--json]
//
// Exit codes: 0 valid, 2 structural defects found, 5 usage/IO (nothing linted).
//
// This script only READS the plan through one descriptor, hashes exactly the bytes it
// linted and prints them. It never writes the plan, never executes a plan command, and
// never reports a semantic verdict; a non-regular source (FIFO, directory) and a source
// that changes while it is read are refused instead of blocking or lying.
//
// LIMIT: the before/after fstat identity check proves freshness only against writers
// whose change is visible in that metadata or leaves the read window between chunks. An
// in-place, same-size rewrite that completes entirely inside the fstat window can still
// be observed as a mixed stream on filesystems whose timestamps are coarser than the
// rewrite; this reader cannot distinguish that without a lock. Atomic replacement (write
// a temp file, then rename over the target) is the supported concurrent writer.
//
// Zero external dependencies (node builtins only), mirroring plan-state.mjs.

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { lintPlan } from '../../../lib/review-lint.js'

const USAGE = [
  'usage: plan-lint.mjs <plan.md> [--json]',
  '',
  'Structural preflight only: parses fences, comments, quotes and nested lines, then',
  'checks canonical section order, task ids, task slots, IS/GAP mapping and existing',
  'source citations. It never executes a plan command, never edits the plan and never',
  'claims a semantic review.',
  '',
  'exit codes: 0 valid; 2 structural defects; 5 usage/IO (nothing linted)',
].join('\n')

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

const failure = (path, action, error) => new UsageError('cannot ' + action + ' ' + path + ': ' + (error instanceof Error ? error.message : String(error)))

// One descriptor, one buffer: the hash reported by the CLI is the hash of exactly the
// bytes that were linted, and an identity/size/mtime change during the read refuses
// instead of reporting a version that never existed on disk.
export function readSource(path) {
  let stat
  try {
    stat = statSync(path, { bigint: true })
  } catch (error) {
    throw failure(path, 'read', error)
  }
  if (!stat.isFile()) throw new UsageError('not a regular file: ' + path)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  } catch (error) {
    throw failure(path, 'open', error)
  }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile()) throw new UsageError('not a regular file: ' + path)
    const chunk = Buffer.allocUnsafe(64 * 1024)
    const parts = []
    let total = 0
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      parts.push(Buffer.from(chunk.subarray(0, read)))
      total += read
    }
    const after = fstatSync(fd, { bigint: true })
    const bytes = Buffer.concat(parts, total)
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size) {
      throw new UsageError('source changed while reading: ' + path + ' (nothing reported)')
    }
    return bytes
  } finally {
    try {
      closeSync(fd)
    } catch {
      // The descriptor was already closed.
    }
  }
}

function formatText(path, result) {
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
  const lines = ['plan=' + path + ' valid=' + (result.valid ? 'yes' : 'no') + ' sha256=' + result.sha256 + ' errors=' + errors + ' warnings=' + (result.diagnostics.length - errors)]
  for (const diagnostic of result.diagnostics) {
    lines.push(diagnostic.severity + ' line ' + diagnostic.line + ' ' + diagnostic.code + (diagnostic.taskId === '' ? '' : ' task ' + diagnostic.taskId) + ' - ' + diagnostic.message)
  }
  lines.push('note: structural preflight only - no semantic review, no plan command executed, nothing written')
  return lines.join('\n') + '\n'
}

function main(argv) {
  const args = argv.slice(2)
  let json = false
  let planPath
  for (const arg of args) {
    if (arg === '--json') json = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n')
      return 0
    } else if (arg.startsWith('--')) throw new UsageError('unknown flag: ' + arg + '\n' + USAGE)
    else if (planPath === undefined) planPath = arg
    else throw new UsageError('unexpected argument: ' + arg + '\n' + USAGE)
  }
  if (planPath === undefined) throw new UsageError(USAGE)
  const result = lintPlan({ content: readSource(planPath), path: planPath, workspace: process.cwd() })
  process.stdout.write(json ? JSON.stringify(result) + '\n' : formatText(planPath, result))
  return result.valid ? 0 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv)
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 5
  }
}
