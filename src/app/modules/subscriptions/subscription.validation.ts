import { z } from 'zod';

/**
 * Premium Checkout takes NO input. The schema is strict, so a client that
 * sends `priceId`, `amount`, `vendorId`, … is rejected with 400 instead of
 * having the field silently stripped: prices, plan ids and vendor identity
 * are exclusively server-controlled.
 */
export const createCheckoutSchema = z.strictObject({});
