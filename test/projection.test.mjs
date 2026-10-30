/**
 * Behaviour tests for the ulwMode fold. These exercise the projection contract
 * (initial state, the two accepted events, and reference stability), not its
 * private helper functions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ulwModeProjection } from '../lib/projection.js'

const initial = ulwModeProjection.init()
const event = (type, data) => ({ type, data })

test('a new session starts off', () => {
  assert.deepEqual(initial, { mode: 'off' })
})

test('command/run for another command leaves the state untouched', () => {
  const next = ulwModeProjection.apply(initial, event('command/run', { name: 'compact', args: 'plan' }))
  assert.equal(Object.is(next, initial), true)
})

test('/ulw-mode off folds to off', () => {
  const next = ulwModeProjection.apply({ mode: 'plan' }, event('command/run', { name: 'ulw-mode', args: 'off' }))
  assert.deepEqual(next, { mode: 'off' })
})

test('/ulw-mode plan folds to plan', () => {
  const next = ulwModeProjection.apply(initial, event('command/run', { name: 'ulw-mode', args: ' plan ' }))
  assert.deepEqual(next, { mode: 'plan' })
})

test('/ulw-mode execute folds to execute', () => {
  const next = ulwModeProjection.apply(initial, event('command/run', { name: 'ulw-mode', args: 'execute' }))
  assert.deepEqual(next, { mode: 'execute' })
})

test('unknown command arguments never overwrite the mode', () => {
  const state = { mode: 'plan' }
  const next = ulwModeProjection.apply(state, event('command/run', { name: 'ulw-mode', args: 'bogus' }))
  assert.equal(Object.is(next, state), true)
})

test('command/run without a string args keeps the mode', () => {
  const state = { mode: 'execute' }
  const next = ulwModeProjection.apply(state, event('command/run', { name: 'ulw-mode', args: 42 }))
  assert.equal(Object.is(next, state), true)
})

test('invoking the ulw-plan skill enters plan mode', () => {
  const next = ulwModeProjection.apply(initial, event('user/message', {
    source: { kind: 'skill-invocation', name: 'ulw-plan', form: 'instructions' },
  }))
  assert.deepEqual(next, { mode: 'plan' })
})

test('invoking the ulw-execute skill enters execute mode', () => {
  const next = ulwModeProjection.apply({ mode: 'plan' }, event('user/message', {
    source: { kind: 'skill-invocation', name: 'ulw-execute', form: 'instructions' },
  }))
  assert.deepEqual(next, { mode: 'execute' })
})

test('other skill invocations are ignored', () => {
  const state = { mode: 'plan' }
  const next = ulwModeProjection.apply(state, event('user/message', {
    source: { kind: 'skill-invocation', name: 'git-commit', form: 'instructions' },
  }))
  assert.equal(Object.is(next, state), true)
})

test('a plain user message is not a mode change', () => {
  const state = { mode: 'execute' }
  const next = ulwModeProjection.apply(state, event('user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '/ulw-plan add rate limiting' }],
  }))
  assert.equal(Object.is(next, state), true)
})

test('unrelated and malformed events keep the same reference', () => {
  const state = { mode: 'plan' }
  for (const candidate of [
    event('tool/result', { name: 'write' }),
    event('turn/start', { turn: 1 }),
    { type: 'user/message' },
    { type: 'command/run' },
  ]) {
    assert.equal(Object.is(ulwModeProjection.apply(state, candidate), state), true)
  }
})

test('persisted garbage seeds off instead of throwing', () => {
  assert.deepEqual(ulwModeProjection.stateSchema.parse(null), { mode: 'off' })
  assert.deepEqual(ulwModeProjection.stateSchema.parse({ mode: 'bogus' }), { mode: 'off' })
  assert.deepEqual(ulwModeProjection.stateSchema.parse({ mode: 'execute' }), { mode: 'execute' })
})

test('only the human /ulw-mode command leaves the workflow off', () => {
  const execute = ulwModeProjection.apply({ mode: 'plan' }, event('user/message', {
    source: { kind: 'skill-invocation', name: 'ulw-execute', form: 'instructions' },
  }))
  assert.deepEqual(execute, { mode: 'execute' })
  // A model skill load, a tool event or an ordinary user message can record a
  // workflow intent but can never forge the human off escape hatch.
  for (const candidate of [
    event('user/message', { source: { kind: 'skill-invocation', name: 'ulw-plan', form: 'instructions' } }),
    event('tool/result', { name: 'skill', content: 'ulw-mode off' }),
    event('turn/start', { turn: 2 }),
    event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'ulw-mode off' }] }),
  ]) {
    assert.notDeepEqual(ulwModeProjection.apply(execute, candidate), { mode: 'off' })
  }
  assert.deepEqual(ulwModeProjection.apply(execute, event('command/run', { name: 'ulw-mode', args: 'off' })), { mode: 'off' })
})
