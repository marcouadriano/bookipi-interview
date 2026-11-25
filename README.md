# Flash Sale

A high-throughput flash sale system: a React page, a Sale Service that decides purchases in Redis, and an Order Service that turns accepted purchases into orders in Postgres. Built for the Bookipi take-home.

A purchase counts as successful only when its order row exists in Postgres. The page never says "success" before that.

## System diagram

```mermaid
flowchart LR
  U["Browser"]

  subgraph EDGE["AWS edge"]
    CDN["CloudFront + S3<br/>React app"]
    ALB["ALB<br/>routes by path"]
  end

  subgraph SALE["Sale Service (one image, two apps)"]
    WR["Waiting Room app<br/>/api/sale, /api/queue<br/>pop timer"]
    PA["Purchase app<br/>/api/purchase<br/>results reader, rebuild"]
  end

  subgraph REDIS["Redis (AOF, fsync always)"]
    RS[("Sale state<br/>line counters, stock, buyers,<br/>purchase states, ready marker")]
    SO[["Stream: flashsale:orders"]]
    SR[["Stream: flashsale:order-results"]]
  end

  OS["Order Service<br/>workers"]
  PG[("Postgres<br/>orders, sales<br/>view: sale_buyers")]

  U -->|"1 page files"| CDN
  U -->|"2 /api/*"| ALB
  ALB -->|"/api/sale, /api/queue"| WR
  ALB -->|"/api/purchase"| PA
  WR <-->|"3 join, pop N every S"| RS
  PA -->|"4 one Lua step: checks, take stock"| RS
  PA -->|"same step: add order"| SO
  SO -->|"5 consumer group"| OS
  OS -->|"6 batched insert"| PG
  OS -->|"7 recorded / failed"| SR
  SR -->|"8 update purchase state"| PA
  PA -.->|"read-only, recovery only"| PG
```

1. Users join a waiting line. Every S seconds the Waiting Room app admits up to N users, and each gets D minutes to try to buy.
2. On Buy, the Purchase app runs one atomic Redis script. It checks the sale window, one purchase per user, admission and stock, then takes one unit and queues the order in the same step.
3. The Order Service reads the queue, writes orders to Postgres in batches, and reports each result back. Postgres also checks that sold never goes above stock.
4. The Purchase app applies the results, and the page polls for the outcome.

The diagram shows the production layout (AWS). Locally, Docker Compose runs the same boxes, and the Vite dev server and proxy stand in for CloudFront and the ALB.

## Design choices and trade-offs

The main idea: **keep the database off the purchase path.** Redis decides who gets an item, Postgres records it and checks it. Each choice below says what it costs.

| Choice                                                  | Why                                                                                                                                                                                                                                                                                                              | What it costs                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis decides the purchase, in one Lua script**       | The script checks the sale window, one-per-user, admission and stock, then takes the unit and queues the order as one step. Nothing can run between the check and the write, so there is no oversell and no race. `MULTI/EXEC` cannot stop halfway on "sold out", and `WATCH` retries collapse under contention. | Every purchase goes through one Redis stock key, so Redis is the ceiling. That key cannot be spread over machines.                                                                                                                                                      |
| **A waiting line in front of Buy**                      | It caps purchase traffic at N users every S seconds, so Redis never sees the whole crowd at once. The line is two counters (last ticket, now serving), so a user's place is a subtraction, not a list scan. Any instance can run the timer, and an atomic claim makes each tick pop exactly once.                | An extra step for the user, and more code than a plain "Buy" endpoint. Admission is checked in the same Redis as the stock, so there is no access token to manage.                                                                                                      |
| **Two apps (Waiting Room and Purchase) from one image** | Everyone waiting polls the Waiting Room; only admitted users reach Purchase. Waiting traffic cannot slow purchases, and each app scales on its own. One image means both always run the same version of the shared Redis data.                                                                                   | They must be deployed together.                                                                                                                                                                                                                                         |
| **A stream between Redis and Postgres**                 | A purchase spike hits Redis. Postgres only sees batched inserts at the pace the workers choose, and more workers add write throughput. A unique constraint keeps parallel inserts safe.                                                                                                                          | A purchase is only "processing" until its row exists. The page shows success only after that, so a user may wait about a second.                                                                                                                                        |
| **Postgres is the source of truth for stock**           | It checks that sold never goes above stock. If Redis ever disagrees, the Order Service reports `sold_out` and the sale ends at the true stock.                                                                                                                                                                   | The rare case where Redis loses data can leave the last few units oversold in Redis. It is caught, and those users are told they missed out. Closing that gap completely means a Postgres write on every purchase, which gives up the throughput the system exists for. |
| **Redis is durable and rebuilt from Postgres**          | `appendfsync always` means an accepted purchase survives a restart. A "ready" marker closes purchases whenever Redis lost its data, and a change of Redis's `run_id` (restart or failover) triggers a rebuild from a read-only Postgres view.                                                                    | Every write waits for the disk. Places in the line and `failed` states are not restored after a data loss; users rejoin.                                                                                                                                                |
| **Polling, not server-sent events**                     | A polling endpoint is needed anyway, because events are lost when a connection drops. Each poll is one Redis read, and there are no thousands of open connections.                                                                                                                                               | Up to one second (the poll interval) before the page sees a result.                                                                                                                                                                                                     |
| **Failed orders are reviewed and replayed by hand**     | Giving the unit back automatically could sell it twice if the row had in fact been written.                                                                                                                                                                                                                      | An operator must look at the `flashsale:orders:failed` stream and replay by hand.                                                                                                                                                                                       |
| **No cloud deployment**                                 | The brief allows running Redis and Postgres locally. The same design is described for AWS in the diagram above, but nothing there is provisioned.                                                                                                                                                                | The production layout is untested.                                                                                                                                                                                                                                      |
| **No login, no ORM, plain CSS**                         | The brief allows a plain user identifier. Two tables and a view do not need an ORM.                                                                                                                                                                                                                              | Anyone can use someone else's ID or create many IDs. That needs login and bot protection, which are out of scope.                                                                                                                                                       |

Where the system breaks first: the single Redis stock key, then the disk wait of `appendfsync always`, then Node CPU on the polling endpoints. The stress test below shows correctness under load, not where that limit is.

## Build and run

You need Node 24, pnpm 12 and podman with `podman-compose`. `docker compose` should work the same, but only podman 6 was tested.

### Server

This starts Redis, Postgres, the Order Service and both Sale Service apps.

1. Install and copy the settings file:

   ```
   pnpm install
   cp .env.example .env
   ```

2. Edit `.env`:
   - Set `SALE_READER_PASSWORD` (letters and digits only, it goes into a connection URL).
   - **Set the sale window.** `.env.example` has no `SALE_START` or `SALE_END` on purpose, and the stack will not start without them. For a one hour sale that starts now, run these two commands, which add the lines to `.env` (GNU `date`; on macOS use `date -u -v+1H +%Y-%m-%dT%H:%M:%SZ` for the end time):

     ```
     echo "SALE_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .env
     echo "SALE_END=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)" >> .env
     ```

   - Optionally set `TOTAL_STOCK`, the number of units for sale (default 100).

3. Start the stack:

   ```
   podman-compose up --build
   ```

   A one-off `migrate` container creates the tables, the `sale_buyers` view, the `sales` row and the read-only `sale_reader` role, then exits. The Waiting Room app is published on port 3000 and the Purchase app on port 3002.

### Frontend

In another terminal:

```
pnpm dev
```

Open the URL Vite prints. Its dev proxy sends `/api/sale` and `/api/queue*` to port 3000 and `/api/purchase*` to port 3002. Override them with `WAITING_ROOM_URL` and `PURCHASE_URL`. To build the page for production, run `pnpm build`.

To stop everything and delete the data: `podman-compose down -v`.

## Tests

**Unit tests** need nothing running and finish in about a second:

```
pnpm test:unit    # 95 tests
```

They cover the sale status rule, the Order Service `Processor` (with in-memory fakes), the rate limits, config parsing, the user ID rule, the page logic and the stress test's own checks. There are no component tests for the React page.

**Integration tests** run the real services against a real Redis and Postgres, and check every API endpoint, the sale window, one purchase per user, overselling under concurrent buyers, crash recovery, and each rule of the Lua purchase scripts:

```
podman-compose -f docker-compose.test.yml up -d    # a throwaway Redis (16380) and Postgres (15433)
pnpm test                                          # 86 tests, about 90 seconds
podman-compose -f docker-compose.test.yml down
```

- The tests wipe their Redis and database. They refuse to run unless the database name contains `test` and Redis holds only keys of this system.
- Run a whole file or a whole `describe` block. Tests inside a block build on each other, so running one by name can fail for the wrong reason.

`pnpm typecheck` checks every package.

## Stress test

`tests/stress-test` simulates many users at once, each behaving like the page: join the line, poll the sale and its place every 3 s, buy as soon as admitted, then poll the purchase every second. It calls the Waiting Room app and the Purchase app directly, and when it is done it checks that the sale stayed correct: no oversell, no user accepted twice, every accepted purchase recorded, the whole stock sold, and (with a database URL) Postgres agreeing with what users were told. It exits with a non-zero code if any check fails.

1. Start the stack with the per-IP rate limit off (every virtual user comes from your one machine) and your load settings. Set the sale variables from "Build and run" first. The `ADMIT_*` settings control how fast users are let in, and `TOTAL_STOCK` the stock:

   ```
   RATE_LIMIT_IP_ENABLED=false ADMIT_BATCH_SIZE=3000 ADMIT_INTERVAL_MS=1000 TOTAL_STOCK=10000 \
   podman-compose -f docker-compose.yml -f docker-compose.stress.yml up -d --build
   ```

   The extra file only publishes Postgres on port 15434, so the test can read it.

2. Run the test. `--stock` must equal `TOTAL_STOCK`:

   ```
   pnpm stress --users 20000 --ramp-seconds 10 --stock 10000 \
     --database-url postgres://postgres:postgres@localhost:15434/flashsale
   ```

   `pnpm --filter @flashsale/stress-test exec tsx src/index.ts --help` lists every option. Start with a fresh stack for each run: the test refuses to run against a sale that is not active, and its checks assume nothing was sold before.

**Expected outcome:** the test prints `RESULT: all invariants held` and exits with code 0. Exactly `--stock` units are sold, every accepted purchase has an order in Postgres, and nobody is accepted twice. If any rule breaks, the report shows `FAIL` for it and the exit code is not 0.

Results from one machine (the test, Redis, Postgres and all services sharing a single laptop, one instance of each service, podman rootless). All invariants held in every run:

| Run             | Users  | Stock  | Admitted per second | Result                            | Peak load    | Latency (p99) |
| --------------- | ------ | ------ | ------------------- | --------------------------------- | ------------ | ------------- |
| Contention      | 5,000  | 100    | 500                 | exactly 100 sold, all recorded    | 2,157 req/s  | 11 ms         |
| Join storm      | 20,000 | 100    | 500                 | exactly 100 sold, all recorded    | 6,392 req/s  | 59 ms         |
| Purchase volume | 20,000 | 10,000 | 3,000               | exactly 10,000 sold, all recorded | 10,488 req/s | 166 ms        |

In the last run all 10,000 orders reached Postgres, and each user saw "success" about 1 second after buying, which is the page's 1 second poll. The services' CPU stayed low (the busiest was the Waiting Room app at about 17%), so these numbers say the system keeps its guarantees under this load, not where its limit is. The load generator shares the machine, and a single Node process may limit it before the services do.
