/**
 * The module's own error type — it may not import the host app's. Carries the
 * same `status` / `code` / `problems` shape that core's fail() passes through.
 */
export class CodegenError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}
