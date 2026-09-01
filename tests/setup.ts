// Runs before any test module is imported. Setting this inside a test file
// would be too late: imports are hoisted above the assignments written above
// them, so src/config/env.ts would already have run and thrown. CI has no .env
// to fall back on, which is exactly the point of the guard.
process.env.JWT_SECRET = 'test-secret';

// The Resend client is built when its module is imported and throws without a
// key, so importing anything that sends email - a controller, say - would fail
// before a single test ran. Nothing here sends an email, so the value is inert.
process.env.RESEND_API_KEY = 're_test_key';
