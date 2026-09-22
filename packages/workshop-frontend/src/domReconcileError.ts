/**
 * Browser translators and extensions rewrite React-owned DOM (typically wrapping text in extra
 * nodes). React then throws during commit when it tries to remove or move the original node.
 * TanStack Router surfaces that as the default "Something went wrong!" overlay.
 */
export function isDomReconcileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /Failed to execute '(?:removeChild|insertBefore|replaceChild)' on 'Node'/.test(message)
}
