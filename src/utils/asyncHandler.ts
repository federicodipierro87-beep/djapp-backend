import { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRouteHandler<Req extends Request> = (
  req: Req,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

/**
 * Express 4 ignores rejected promises returned by async handlers, so an error
 * thrown inside one never reaches the error middleware and the request hangs
 * until the client times out. Wrapping forwards the rejection to next().
 */
export const asyncHandler = <Req extends Request = Request>(
  fn: AsyncRouteHandler<Req>
): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req as Req, res, next)).catch(next);
};
