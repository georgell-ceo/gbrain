# Hosted HTTP liveness

`gbrain serve --http` has two probes. Keep them separate.

| Probe | What it does | Use it for |
| --- | --- | --- |
| `GET /health` | One `SELECT 1`, 3 second cap. No engine stats. | Platform liveness (`healthcheckPath=/health`). A restart here means the process cannot answer or the database ping failed. |
| `GET /ready` | In-process watchdog only. No database call. | A separate monitor. 503 means the request pipeline looks wedged, or the heartbeat timer stopped running. |
| `GET /health?deep=1` | Same as `/health`, unless `GBRAIN_HTTP_HEALTH_DEEP=1`. Then a wedged watchdog returns 503 before the ping. | Opt-in. Leave it off on the platform health check so one slow search cannot restart the process. |

One in-flight search does not flip `/ready`. The pipeline check needs at least two acquired `POST /mcp` handlers (the default), the oldest older than the window, and no completion in that window. Requests waiting for a slot are not counted.

An unhandled rejection, including an unhandled statement timeout (`57014`, `canceling statement due to statement timeout`), exits the process with status 1 so the host can restart it. Search timeouts that are already caught stay fail-open and do not exit. A statement timeout on the driver's startup types query is observed inside the driver, so the caller's caught 57014 stays a log line. `GBRAIN_HTTP_FATAL_EXIT=0` turns the exit off.

`GBRAIN_SERVE_STALL_WATCHDOG_MS` is a different, opt-in control. It kills the process when the main thread stops running timers at all (a synchronous wedge). It stays off unless you set it.

A starved client pool with a live event loop does not fail `/ready` and raises no exception, so a host that restarts only on process exit would wait forever. The pool watchdog probes database readiness on an interval and exits with status 70 after sustained `pool_starved` or `unknown` verdicts. `server_unreachable` uses three times that fail count. A read-pool success whose direct lane failed uses that same slower count: the read pool can still serve, so it is not client-pool starvation. `client_misconfigured` does not exit. Each miss short of the limit is logged. A probe still in flight is not started again. The first 60 seconds after start are a grace period. `GBRAIN_HTTP_POOL_WATCHDOG_MS=0` or `GBRAIN_HTTP_FATAL_EXIT=0` keeps the process up.

After an aborted statement, cancel is waited on only until `GBRAIN_HTTP_ABORT_CANCEL_MS` (default 5000). When that deadline wins, the reserved connection is discarded so the pool slot returns.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GBRAIN_HTTP_WATCHDOG_MS` | `120000` | Pipeline no-completion window. `0` disables that check. |
| `GBRAIN_HTTP_WATCHDOG_HEARTBEAT_MS` | `30000` | Heartbeat interval. `/ready` fails if the timer is more than twice this late. `0` disables it. |
| `GBRAIN_HTTP_WATCHDOG_MIN_INFLIGHT` | `2` | Acquired MCP requests required before the pipeline check can fail. |
| `GBRAIN_HTTP_HEALTH_DEEP` | off | `1` makes `GET /health?deep=1` consult the watchdog. |
| `GBRAIN_HTTP_MAX_INFLIGHT` | `6` | Concurrent `POST /mcp` handlers. Extra requests wait, then HTTP 503 `server busy`. `0` disables the cap. |
| `GBRAIN_HTTP_INFLIGHT_WAIT_MS` | `15000` | How long a request waits for a slot. |
| `GBRAIN_HTTP_FATAL_EXIT` | on | `0` keeps the process up after an unhandled rejection, and turns the pool watchdog off. |
| `GBRAIN_HTTP_POOL_WATCHDOG_MS` | `15000` | How often the pool watchdog probes. `0` turns it off. |
| `GBRAIN_HTTP_POOL_WATCHDOG_FAILS` | `4` | Consecutive `pool_starved` or `unknown` probes before exit 70. `server_unreachable`, and a read success with a failed direct lane, wait three times this long. |
| `GBRAIN_HTTP_ABORT_CANCEL_MS` | `5000` | After an abort, how long to wait for cancel before discarding the reserved connection. |
| `GBRAIN_SERVE_STALL_WATCHDOG_MS` | off | Optional synchronous-loop kill. Floor 15000. |

Invalid numbers log a warning and keep the default.

## Pooler and one replica

Use the transaction pooler (port 6543) as `DATABASE_URL`. GBrain turns prepared statements off for that port.

Use the session pooler (port 5432 on the same pooler host) as `GBRAIN_DIRECT_DATABASE_URL`. Do not point the direct URL at `db.<project-ref>.supabase.co` unless that host is reachable. On IPv4-only networks it is not, without the provider's IPv4 add-on. If the direct host is unreachable, the connection manager falls back to the session pooler and then to the read pool. `GBRAIN_DISABLE_DIRECT_POOL=1` forces a single pool.

Suggested sizes for **one** HTTP replica, so a search (about two pool slots) cannot take the whole pooler budget:

| Variable | Suggestion |
| --- | --- |
| `GBRAIN_POOL_SIZE` | `6` |
| `GBRAIN_DIRECT_POOL_SIZE` | `2` |
| `GBRAIN_HTTP_MAX_INFLIGHT` | `3` |

The code defaults (`10` / `3` / `6`) are a ceiling for a laptop, not a hosted pooler budget. A second replica needs a fresh count of those slots against the pooler's max clients. Do not add one until that budget is verified.

Startup logs the ready URL and the resolved watchdog numbers on stderr. The banner's Health line stays `/health`.
