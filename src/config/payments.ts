import { PaymentMethod, PaymentProvider } from '@prisma/client';

// Everything is priced in euro and the providers are told so explicitly; a
// mismatch here is the difference between charging €10 and charging $10.
export const CURRENCY = 'eur';

// The smallest donation that can exist. Not a product preference: Stripe refuses
// a euro charge under 50 cents, and it refuses it when the PaymentIntent is
// created, so a smaller amount is not a smaller payment - it is a request that
// cannot be filed at all. The guest would get "Amount must convert to at least
// 50 cents" from the provider instead of an answer from us.
//
// It is also the only friction on the public endpoint: filing a request costs a
// real card authorisation, which is what a flood of junk requests cannot afford.
// Every schema that accepts an amount is floored by this one constant, so
// raising or lowering it is a single edit. Below 0.5 the card providers break.
export const MIN_DONATION = 0.5;

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

// Only Stripe is switched on in production. PayPal and Satispay are both
// implemented but neither has been run against a real account, so they stay off
// until someone has watched a euro move end to end in staging. PAYMENT_METHODS
// is what turns one on, without a deploy.
//
// Satispay additionally depends on the DJ: see availableMethods in the event
// controller. Being enabled here only makes it possible, not offered.
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

// With Connect on, a donation is charged on the platform account but settled
// into the DJ's own, and a DJ who has not been through onboarding cannot be
// paid at all.
//
// Off by default on purpose. No existing DJ has a connected account, so turning
// this on is what makes onboarding mandatory: enable it once the DJs have
// actually completed it, or the next guest to scan a QR code is told the DJ
// cannot take payments.
export const stripeConnectEnabled = process.env.STRIPE_CONNECT_ENABLED === 'true';

// Express accounts are tied to a country at creation and it cannot be changed
// afterwards. The DJs are Italian; anywhere else needs its own value.
export const stripeConnectCountry = process.env.STRIPE_CONNECT_COUNTRY || 'IT';

// The platform's cut of each donation, as a percentage. Zero by default: the
// DJs already pay a subscription, so charging them twice has to be a deliberate
// decision rather than something that happens because a variable was unset.
const configuredFee = Number(process.env.PLATFORM_FEE_PERCENT ?? 0);
export const platformFeePercent =
  Number.isFinite(configuredFee) && configuredFee >= 0 && configuredFee <= 100 ? configuredFee : 0;

export function platformFeeInCents(amountInCents: number): number {
  return Math.round((amountInCents * platformFeePercent) / 100);
}
