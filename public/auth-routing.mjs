/** Resolve the customer-facing page without changing the authentication session. */
export function resolveCustomerView(session, recovery = false) {
  if (recovery) return 'recovery';
  return session?.user ? 'dashboard' : 'landing';
}
