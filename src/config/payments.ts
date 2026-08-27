import { PaymentMethod, PaymentProvider } from '@prisma/client';

// Everything is priced in euro and the providers are told so explicitly; a
// mismatch here is the difference between charging €10 and charging $10.
export const CURRENCY = 'eur';

// A request that nobody has paid for is invisible to the DJ, so leaving it
// around costs nothing except a dangling authorisation at the provider. Half an
// hour is long enough for a guest to fumble through 3-D Secure and short enough
// that the hold is released the same evening.
export const AWAITING_PAYMENT_TIMEOUT_MINUTES = 30;
export const AWAITING_PAYMENT_TIMEOUT_MS = AWAITING_PAYMENT_TIMEOUT_MINUTES * 60 * 1000;

const PROVIDER_BY_METHOD: Record<PaymentMethod, PaymentProvider> = {
  CARD: PaymentProvider.STRIPE,
  APPLE_PAY: PaymentProvider.STRIPE,
  GOOGLE_PAY: PaymentProvider.STRIPE,
  PAYPAL: PaymentProvider.PAYPAL,
  SATISPAY: PaymentProvider.SATISPAY
};

export function providerFor(method: PaymentMethod): PaymentProvider {
  return PROVIDER_BY_METHOD[method];
}

// Only Stripe can actually hold money today. The PayPal integration never calls
// authorizeOrder and the Satispay request signature is not the one the API
// expects, so both would fail - loudly if we are lucky, silently if we are not.
// They stay off until their own phases replace them, and PAYMENT_METHODS lets a
// staging environment switch one on early without a deploy.
const DEFAULT_ENABLED_METHODS: PaymentMethod[] = [
  PaymentMethod.CARD,
  PaymentMethod.APPLE_PAY,
  PaymentMethod.GOOGLE_PAY
];

const configured = process.env.PAYMENT_METHODS
  ?.split(',')
  .map((method) => method.trim().toUpperCase())
  .filter((method): method is PaymentMethod => method in PaymentMethod);

export const enabledPaymentMethods: PaymentMethod[] =
  configured && configured.length > 0 ? configured : DEFAULT_ENABLED_METHODS;

export function isPaymentMethodEnabled(method: PaymentMethod): boolean {
  return enabledPaymentMethods.includes(method);
}
