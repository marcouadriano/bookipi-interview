import { parseArgs } from 'node:util';

export interface Options {
  users: number;
  rampMs: number;
  stock: number;
  waitingRoomUrl: string;
  purchaseUrl: string;
  databaseUrl: string | undefined;
  saleId: string;
  timeoutMs: number;
  maxSockets: number;
}

const USAGE = `Usage: pnpm stress [options]

  --users <n>            virtual users (default 2000)
  --ramp-seconds <n>     users arrive spread evenly over this time (default 10)
  --stock <n>            TOTAL_STOCK the sale was started with (default 100)
  --waiting-room <url>   Waiting Room app (default http://localhost:3000)
  --purchase <url>       Purchase app (default http://localhost:3002)
  --database-url <url>   Postgres, to compare its orders with what users were told (optional)
  --sale-id <id>         SALE_ID (default flash-sale-1)
  --timeout-seconds <n>  stop the run after this long (default 240)
  --max-sockets <n>      connections per app (default 1000)`;

// A bad command line. `main` prints just the message.
export class UsageError extends Error {}

// A number of at least `min`, whole unless `whole` is
// false. A typo such as `2o000` is an error, not NaN.
function numeric(flag: string, raw: string, min: number, whole = true): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || (whole && !Number.isInteger(n))) {
    throw new UsageError(
      `--${flag} must be ${whole ? 'a whole number' : 'a number'} of at least ${min}, got "${raw}"`,
    );
  }
  return n;
}

// Reads the command line. `--help` prints the usage and exits.
export function parseOptions(argv: string[] = process.argv.slice(2)): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      users: { type: 'string', default: '2000' },
      'ramp-seconds': { type: 'string', default: '10' },
      stock: { type: 'string', default: '100' },
      'waiting-room': { type: 'string', default: 'http://localhost:3000' },
      purchase: { type: 'string', default: 'http://localhost:3002' },
      'database-url': { type: 'string' },
      'sale-id': { type: 'string', default: 'flash-sale-1' },
      'timeout-seconds': { type: 'string', default: '240' },
      'max-sockets': { type: 'string', default: '1000' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  return {
    users: numeric('users', values.users!, 1),
    rampMs: numeric('ramp-seconds', values['ramp-seconds']!, 0, false) * 1000,
    stock: numeric('stock', values.stock!, 1),
    waitingRoomUrl: values['waiting-room']!,
    purchaseUrl: values.purchase!,
    databaseUrl: values['database-url'],
    saleId: values['sale-id']!,
    timeoutMs: numeric('timeout-seconds', values['timeout-seconds']!, 1, false) * 1000,
    maxSockets: numeric('max-sockets', values['max-sockets']!, 1),
  };
}
