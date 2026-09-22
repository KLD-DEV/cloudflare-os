import { describe, expect, it } from 'vitest'
import { isDomReconcileError } from './domReconcileError'

describe('isDomReconcileError', () => {
  it('matches the browser translation / extension DOM mismatch', () => {
    const error = new DOMException(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      'NotFoundError',
    )
    expect(isDomReconcileError(error)).toBe(true)
    expect(isDomReconcileError(new Error(error.message))).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isDomReconcileError(new Error('Failed to create workspace'))).toBe(false)
    expect(isDomReconcileError('network failed')).toBe(false)
  })
})
