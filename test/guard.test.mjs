/**
 * The planning guard's decision table: mode x tool x target.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGuard } from '../lib/guard.js'

const cwd = '/ws'
const session = { header: { cwd } }
const agent = { session }

function guardFor(mode) {
  const ctx = {
    sessionProjections: { stateOf: () => ({ mode }) },
    workingDirectory: { get: () => cwd },
  }
  return createGuard(ctx)
}

const call = (name, filePath, useAgent = agent) => ({ name, arguments: { file_path: filePath }, agent: useAgent })

test('plan mode refuses a product write with exit instructions', () => {
  const reason = guardFor('plan')(call('write', 'src/main.ts'))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /\/ulw-mode execute/)
  assert.match(reason, /\/ulw-mode off/)
})

test('plan mode refuses a product edit', () => {
  assert.equal(typeof guardFor('plan')(call('edit', 'src/main.ts')), 'string')
})

test('plan mode allows writing a plan under .dsh/ulw/', () => {
  assert.equal(guardFor('plan')(call('write', '.dsh/ulw/plans/x.md')), undefined)
  assert.equal(guardFor('plan')(call('edit', `${cwd}/.dsh/ulw/drafts/x.md`)), undefined)
})

test('plan mode refuses traversal out of the artifact root', () => {
  assert.equal(typeof guardFor('plan')(call('write', '.dsh/ulw/../src/x.ts')), 'string')
})

test('execute and off modes do not gate product writes', () => {
  assert.equal(guardFor('execute')(call('write', 'src/main.ts')), undefined)
  assert.equal(guardFor('off')(call('write', 'src/main.ts')), undefined)
})

test('plan mode does not gate bash or read-only tools', () => {
  assert.equal(guardFor('plan')(call('bash', undefined)), undefined)
  assert.equal(guardFor('plan')(call('read', 'src/main.ts')), undefined)
  assert.equal(guardFor('plan')(call('grep', 'src/main.ts')), undefined)
})

test('an execution without an agent is never gated', () => {
  assert.equal(guardFor('plan')({ name: 'write', arguments: { file_path: 'src/main.ts' } }), undefined)
})
