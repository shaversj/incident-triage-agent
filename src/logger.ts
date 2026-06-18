import pino, { type Logger } from "pino";
import pretty from "pino-pretty";

export type TriageLogger = Pick<Logger, "debug" | "info" | "warn" | "error">;

export function createLogger(level = "info"): Logger {
  const stream = pretty({
    colorize: process.stderr.isTTY,
    destination: 2,
    ignore: "pid,hostname",
    messageFormat: "{component} | {msg}",
    sync: true,
    translateTime: "yyyy-mm-dd HH:MM:ss.l",
  });
  return pino({ base: null, level: level.toLowerCase() }, stream);
}

export const noopLogger: TriageLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
