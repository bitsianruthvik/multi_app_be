import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "multi_app_be" },
  // Pretty-print in dev only — pino-pretty is not installed, so this is a no-op
  // unless the operator opts in by installing it. The "transport" option is only
  // applied when running in dev to avoid surprising prod deploys.
  ...(isDev && process.env.LOG_PRETTY === "true"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

export default logger;
