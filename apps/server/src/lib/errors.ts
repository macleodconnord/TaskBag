export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export class NotFound extends HttpError {
  constructor(what = 'Not found') { super(404, what); }
}
export class Forbidden extends HttpError {
  constructor(msg = 'You do not have permission to do that') { super(403, msg); }
}
export class Unauthorized extends HttpError {
  constructor(msg = 'Sign in required') { super(401, msg); }
}
export class Conflict extends HttpError {
  constructor(msg: string) { super(409, msg); }
}
export class Validation extends HttpError {
  constructor(msg: string, details?: unknown) { super(400, msg, details); }
}
