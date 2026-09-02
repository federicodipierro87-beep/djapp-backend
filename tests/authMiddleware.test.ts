import { beforeEach, describe, expect, it, vi } from 'vitest';

// A JWT lasts seven days and cannot be withdrawn, so everything an admin decides
// about a DJ in the meantime only takes effect if this middleware goes and looks.
// Login already refuses a DJ who is not approved; without the same check here,
// rejecting one mid-week changed nothing until their token expired on its own.

const djFindUnique = vi.fn();
const verifyToken = vi.fn();

vi.mock('../src/utils/database', () => ({
  default: { dJ: { findUnique: (...args: unknown[]) => djFindUnique(...args) } }
}));

vi.mock('../src/utils/jwt', () => ({
  verifyToken: (...args: unknown[]) => verifyToken(...args)
}));

const { authMiddleware } = await import('../src/middlewares/auth.middleware');

const approved = {
  passwordChangedAt: null,
  status: 'APPROVED',
  isAdmin: false
};

const invoke = async () => {
  const req: any = { headers: { authorization: 'Bearer token' } };
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  const next = vi.fn();

  await authMiddleware(req, res, next);

  return { req, res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyToken.mockReturnValue({ djId: 'dj-1', email: 'dj@example.com', iat: 1_760_000_000 });
  djFindUnique.mockResolvedValue(approved);
});

describe('authMiddleware', () => {
  it('lets an approved DJ through', async () => {
    const { req, next } = await invoke();

    expect(next).toHaveBeenCalledOnce();
    expect(req.dj).toMatchObject({ djId: 'dj-1' });
  });

  it('refuses a DJ the admin has rejected since the token was issued', async () => {
    djFindUnique.mockResolvedValue({ ...approved, status: 'REJECTED' });

    const { res, next } = await invoke();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a DJ who is still waiting for approval', async () => {
    djFindUnique.mockResolvedValue({ ...approved, status: 'PENDING' });

    const { res, next } = await invoke();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // The platform's own accounts are not approved by anyone: there is nobody
  // above them to do it. Locking them out here would lock the admin out of the
  // screen where DJs are approved.
  it('lets an admin through whatever their status says', async () => {
    djFindUnique.mockResolvedValue({ ...approved, status: 'PENDING', isAdmin: true });

    const { next } = await invoke();

    expect(next).toHaveBeenCalledOnce();
  });

  // 401, not 403: the token is what is wrong here, and the client is meant to
  // send the DJ back to the login screen rather than show them a message.
  it('refuses a token issued before the password was reset', async () => {
    djFindUnique.mockResolvedValue({
      ...approved,
      passwordChangedAt: new Date('2026-01-01T00:00:00.000Z')
    });

    const { res, next } = await invoke();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a token naming a DJ who no longer exists', async () => {
    djFindUnique.mockResolvedValue(null);

    const { res, next } = await invoke();

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a request with no bearer token', async () => {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    const next = vi.fn();

    await authMiddleware({ headers: {} } as any, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(djFindUnique).not.toHaveBeenCalled();
  });
});
