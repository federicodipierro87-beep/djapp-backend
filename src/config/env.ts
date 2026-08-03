import dotenv from 'dotenv';

// .env is loaded here rather than only in index.ts because TypeScript emits
// every import as a require above the first statement: by the time index.ts
// reaches its own dotenv.config(), the modules that read process.env at load
// time have already been evaluated. Doing it inside this module guarantees the
// file is read before any value below is looked up, whoever imports first.
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Refusing to start: falling back to a default here ` +
        `would mean anyone could mint valid tokens.`
    );
  }
  return value;
}

export const JWT_SECRET = required('JWT_SECRET');
