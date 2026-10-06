/**
 * Wires the hosted-HTTP fatal exit, pipeline watchdog, and inflight gate
 * onto one server. Route modules read the guards through a WeakMap so
 * serve-http.ts stays a thin registration site.
 */
import { installHostedHttpFatalHandlers } from './http-fatal.ts';
import {
  createHttpPoolWatchdog,
  type HttpPoolWatchdogEngine,
} from './http-pool-watchdog.ts';
import {
  HttpInflightGate,
  HttpPipelineWatchdog,
  resolveHttpWatchdogConfig,
  type HttpWatchdogConfig,
} from './http-pipeline-watchdog.ts';

export interface HostedHttpGuards {
  config: HttpWatchdogConfig;
  watchdog: HttpPipelineWatchdog;
  gate: HttpInflightGate;
  arm(installFatal: boolean): () => void;
  readyLine(port: number): string;
}

const attached = new WeakMap<object, HostedHttpGuards>();

export function createHostedHttpGuards(
  env: Record<string, string | undefined> = process.env,
  warn?: (msg: string) => void,
  engine?: HttpPoolWatchdogEngine,
): HostedHttpGuards {
  const config = resolveHttpWatchdogConfig(env, warn);
  const watchdog = new HttpPipelineWatchdog(config);
  const gate = new HttpInflightGate(config.maxInflight, config.inflightWaitMs);
  let fatalInstalled = false;
  let poolWatchdogLabel = 'off';
  const guards: HostedHttpGuards = {
    config,
    watchdog,
    gate,
    arm(installFatal: boolean) {
      watchdog.start();
      fatalInstalled = installFatal && config.fatalExit;
      const uninstall = fatalInstalled ? installHostedHttpFatalHandlers() : () => {};
      const pool = fatalInstalled ? createHttpPoolWatchdog(engine, { env, warn }) : undefined;
      poolWatchdogLabel = pool?.label ?? 'off';
      const stopPool = pool?.start() ?? (() => {});
      return () => {
        uninstall();
        watchdog.stop();
        stopPool();
      };
    },
    readyLine(port: number) {
      return `[serve-http] Ready: http://localhost:${port}/ready (pipeline=${config.pipelineMs}ms heartbeat=${config.heartbeatMs}ms min_inflight=${config.minInflight}; max_inflight=${config.maxInflight} wait=${config.inflightWaitMs}ms; fatal_exit=${fatalInstalled ? 'on' : 'off'}; pool_watchdog=${poolWatchdogLabel})`;
    },
  };
  return guards;
}

export function attachHostedHttpGuards(ctx: object, guards: HostedHttpGuards): void {
  attached.set(ctx, guards);
}

export function readHostedHttpGuards(ctx: object): HostedHttpGuards | undefined {
  return attached.get(ctx);
}
