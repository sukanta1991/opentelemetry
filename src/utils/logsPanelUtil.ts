import { LogRecord } from '../store/model';

export function getLogTimeMs(log: LogRecord): number {
  return log.timeMs ?? log.observedTimeMs ?? 0;
}

export function sortRowsByLogTime<T extends { i: number }>(rows: T[], logs: LogRecord[]): T[] {
  return rows.slice().sort((a, b) => getLogTimeMs(logs[a.i]) - getLogTimeMs(logs[b.i]));
}
