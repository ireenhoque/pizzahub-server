/**
 * Verified authentication context attached to `req.auth` by the
 * `authenticate` middleware. Every field originates from a JWT that passed
 * signature, issuer, audience and expiration verification — nothing here is
 * ever taken from the request body, query string, or unverified headers.
 */
export interface AuthenticatedUser {
  /**
   * Verified JWT `sub` claim — the Better Auth user `_id`.
   * This is the ONLY trusted identity source in the whole application.
   */
  userId: string;

  /** Verified claims (display info only — never used for authorization). */
  email?: string;
  emailVerified?: boolean;

  /** Token metadata. */
  issuer: string;
  audience: string;
  issuedAt: Date;
  expiresAt: Date;
}
