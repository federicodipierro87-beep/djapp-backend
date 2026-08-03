// Runs before any test module is imported. Setting this inside a test file
// would be too late: imports are hoisted above the assignments written above
// them, so src/config/env.ts would already have run and thrown. CI has no .env
// to fall back on, which is exactly the point of the guard.
process.env.JWT_SECRET = 'test-secret';
