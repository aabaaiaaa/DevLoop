import * as fsSync from 'fs';
import * as path from 'path';

export interface Logger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(workspacePath: string): Logger {
  const logPath = path.join(workspacePath, '.devloop', 'debug.log');

  // Ensure .devloop directory exists
  try {
    const dir = path.dirname(logPath);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // If we can't create the directory, the logger will silently fail
  }

  function write(level: string, message: string): void {
    try {
      const timestamp = new Date().toISOString();
      fsSync.appendFileSync(logPath, `[${timestamp}] [${level}] ${message}\n`);
    } catch {
      // Logger never throws
    }
  }

  return {
    info(message: string): void {
      write('INFO', message);
    },
    error(message: string, error?: unknown): void {
      write('ERROR', message);
      if (error instanceof Error && error.stack) {
        write('ERROR', error.stack);
      } else if (error !== undefined) {
        write('ERROR', String(error));
      }
    }
  };
}
