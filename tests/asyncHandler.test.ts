import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { asyncHandler } from '../src/utils/asyncHandler';
import { errorMiddleware } from '../src/middlewares/error.middleware';

const buildApp = (handler: express.RequestHandler) => {
  const app = express();
  app.get('/boom', handler);
  app.use(errorMiddleware);
  return app;
};

describe('asyncHandler', () => {
  it('sends a rejected promise to the error middleware', async () => {
    const app = buildApp(
      asyncHandler(async () => {
        throw new Error('handler exploded');
      })
    );

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
  });

  it('leaves successful responses untouched', async () => {
    const app = buildApp(
      asyncHandler(async (_req, res) => {
        res.json({ ok: true });
      })
    );

    const res = await request(app).get('/boom');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('shows why the wrapper is needed: express 4 drops the rejection on its own', async () => {
    let rejected: Error | undefined;
    const app = buildApp((() =>
      // Express ignores whatever a handler returns, so the catch here changes
      // nothing about the request; it only keeps the runner from reporting the
      // deliberate rejection as an unhandled one.
      Promise.reject(new Error('handler exploded')).catch((err: Error) => {
        rejected = err;
      })) as express.RequestHandler);

    // Nothing answers the request, so the client is left hanging. In production
    // the same rejection reached the unhandledRejection hook, which exits the
    // process.
    await expect(request(app).get('/boom').timeout(300)).rejects.toThrow();
    expect(rejected?.message).toBe('handler exploded');
  });
});
