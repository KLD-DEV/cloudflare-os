import { useEffect, useRef } from 'react'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { isDomReconcileError } from './domReconcileError'
import { reportIssue } from './errorReporting'

let recoveredDomReconcileError = false

/** Clears the one-shot DOM-reconcile recovery so tests can exercise it in isolation. */
export function resetDomReconcileRecoveryForTests() {
  recoveredDomReconcileError = false
}

/**
 * Replaces TanStack Router's default overlay ("Something went wrong!" / "Hide Error").
 * Browser-translation DOM mismatches remount the route once; anything else offers a retry.
 */
export default function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  const reported = useRef(false)
  const canAutoRecover = isDomReconcileError(error) && !recoveredDomReconcileError

  useEffect(() => {
    if (reported.current) return
    reported.current = true
    reportIssue('workshop.route-render', error, {
      handled: true,
      severity: canAutoRecover ? 'error' : 'fatal',
      captureMechanism: 'react',
    })
  }, [canAutoRecover, error])

  useEffect(() => {
    if (!canAutoRecover) return
    recoveredDomReconcileError = true
    reset()
  }, [canAutoRecover, reset])

  if (canAutoRecover) return null

  return (
    <main className="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-kumo-subtle">
        This page hit an unexpected error. You can try again or reload the Workshop.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          className="rounded-md bg-kumo-brand px-4 py-2 text-sm text-kumo-inverse"
          onClick={() => reset()}
        >
          Try again
        </button>
        <button
          type="button"
          className="rounded-md px-4 py-2 text-sm text-kumo-default hover:bg-kumo-tint"
          onClick={() => location.reload()}
        >
          Reload
        </button>
      </div>
    </main>
  )
}
