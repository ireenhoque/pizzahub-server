/**
 * Single source of truth for database collection names.
 *
 * NOTE: Collections are NOT created here — they are only named.
 * `users` is owned by Better Auth; do not create or manage it manually.
 */
export const COLLECTIONS = {
  menuItems: 'menuItems',
  orders: 'orders',
  transactions: 'transactions',
  users: 'users', // managed by Better Auth
} as const;
