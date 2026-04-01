import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export interface Spinner {
  text: string;
  isSpinning: boolean;
  start(text?: string): void;
  stop(): void;
  succeed(text: string): void;
  fail(text: string): void;
  stopAndPersist(opts: { symbol: string; text: string }): void;
}

export function createSpinner(): Spinner {
  let frameIndex = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentText = '';
  let spinning = false;

  function clearLine(): void {
    process.stdout.write('\r\x1b[K');
  }

  function render(): void {
    const frame = chalk.cyan(FRAMES[frameIndex]);
    clearLine();
    process.stdout.write(`${frame} ${currentText}`);
    frameIndex = (frameIndex + 1) % FRAMES.length;
  }

  return {
    get text() {
      return currentText;
    },
    set text(value: string) {
      currentText = value;
    },
    get isSpinning() {
      return spinning;
    },
    start(text?: string) {
      if (text !== undefined) currentText = text;
      spinning = true;
      frameIndex = 0;
      render();
      interval = setInterval(render, INTERVAL_MS);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      spinning = false;
      clearLine();
    },
    succeed(text: string) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      spinning = false;
      clearLine();
      console.log(`${chalk.green('✓')} ${text}`);
    },
    fail(text: string) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      spinning = false;
      clearLine();
      console.log(`${chalk.red('✗')} ${text}`);
    },
    stopAndPersist(opts: { symbol: string; text: string }) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      spinning = false;
      clearLine();
      console.log(`${opts.symbol} ${opts.text}`);
    }
  };
}
