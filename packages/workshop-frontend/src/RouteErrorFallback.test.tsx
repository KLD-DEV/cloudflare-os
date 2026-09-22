// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RouteErrorFallback, { resetDomReconcileRecoveryForTests } from './RouteErrorFallback'
import { reportIssue } from './errorReporting'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<typeof reportIssue>() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('RouteErrorFallback', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => root?.unmount())
    resetDomReconcileRecoveryForTests()
    vi.restoreAllMocks()
  })

  it('offers retry for ordinary route crashes', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const reset = vi.fn()
    await act(async () => root!.render(
      <RouteErrorFallback error={new Error('render failed')} reset={reset} />,
    ))
    expect(container.textContent).toContain('Something went wrong')
    expect(container.textContent).toContain('Try again')
    container.querySelector('button')?.click()
    expect(reset).toHaveBeenCalled()
    expect(reportIssue).toHaveBeenCalledWith('workshop.route-render', expect.any(Error),
      expect.objectContaining({ captureMechanism: 'react', handled: true }))
    container.remove()
  })

  it('remounts the route once for a DOM reconcile mismatch', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const reset = vi.fn()
    const error = new Error(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
    )
    await act(async () => root!.render(
      <RouteErrorFallback error={error} reset={reset} />,
    ))
    expect(reset).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
    container.remove()
  })
})
