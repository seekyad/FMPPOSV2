import { Router } from 'express';
import type { RequestHandler } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Express 4 does not forward rejected async handlers by itself. */
export function createRouter() {
  const router = Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const register = router[method].bind(router);
    router[method] = ((path: string, ...handlers: RequestHandler[]) => register(path,
      ...handlers.map(handler => ((req, res, next) => {
        try { Promise.resolve(handler(req, res, next)).catch(next); } catch (error) { next(error); }
      }) as RequestHandler),
    )) as typeof router[typeof method];
  }
  return router;
}
