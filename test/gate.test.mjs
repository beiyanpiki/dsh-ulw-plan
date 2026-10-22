/**
 * The plan-gate decision table: mode x role x artifact x plan path.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkGate, collectPlanPaths } from '../lib/gate.js'

const base = {
  mode: 'plan',
  type: 'plan-consultant',
  category: undefined,
  prompt: 'analyse the request',
  cwd: '/ws',
  artifactExists: true,
  planExists: () => true,
}

const reason = (overrides) => checkGate({ ...base, ...overrides })

test('consultants pass only in plan mode with an artifact', () => {
  assert.equal(reason({}), undefined)
  assert.match(reason({ mode: 'off' }), /ulw-plan mode is required/)
  assert.match(reason({ mode: 'execute' }), /planning review is over/)
  assert.match(reason({ artifactExists: false }), /no artifact yet/)
})

test('explore and librarian are never gated', () => {
  for (const mode of ['off', 'plan', 'execute']) {
    assert.equal(reason({ mode, type: 'explore' }), undefined)
    assert.equal(reason({ mode, type: 'librarian' }), undefined)
  }
})

test('reviewers need exactly one existing plan path', () => {
  const plan = '.dsh/ulw/plans/feature.md'
  assert.equal(reason({ type: 'plan-reviewer', prompt: `review ${plan}` }), undefined)
  assert.match(reason({ type: 'plan-reviewer', prompt: 'review the plan' }), /exactly one/)
  assert.match(
    reason({ type: 'plan-reviewer', prompt: `review ${plan} and .dsh/ulw/plans/other.md` }),
    /found 2/,
  )
  assert.match(
    reason({ type: 'plan-reviewer', prompt: `review ${plan}`, planExists: () => false }),
    /does not exist/,
  )
})

test('a reviewer path may not escape the plans directory', () => {
  assert.match(
    reason({ type: 'plan-reviewer', prompt: 'review .dsh/ulw/plans/../../secret.md' }),
    /exactly one|may only review/,
  )
})

test('aliases use the same gate', () => {
  assert.match(reason({ type: 'metis', mode: 'off' }), /ulw-plan mode is required/)
  const plan = '.dsh/ulw/plans/feature.md'
  assert.equal(reason({ type: 'momus', prompt: `review ${plan}` }), undefined)
  assert.equal(reason({ type: 'oracle', prompt: `review ${plan}` }), undefined)
})

test('categories are refused while planning', () => {
  assert.match(
    reason({ type: undefined, category: 'quick', mode: 'plan' }),
    /category spawns an implementer/,
  )
  assert.equal(reason({ type: undefined, category: 'quick', mode: 'execute' }), undefined)
  assert.equal(reason({ type: undefined, category: 'quick', mode: 'off' }), undefined)
})

test('plan path extraction is unique and first-seen ordered', () => {
  assert.deepEqual(collectPlanPaths('x .dsh/ulw/plans/a.md y .dsh/ulw/plans/a.md'), ['.dsh/ulw/plans/a.md'])
  assert.deepEqual(collectPlanPaths('none here'), [])
})
