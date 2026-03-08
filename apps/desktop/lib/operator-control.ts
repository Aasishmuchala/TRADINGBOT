import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type OperatorMode = "Research" | "Paper" | "Protected" | "SemiAuto";
export type OperatorEventLevel = "info" | "warn" | "risk";

export type OperatorEvent = {
  id: string;
  timestamp: string;
  level: OperatorEventLevel;
  action: string;
  message: string;
  detail?: string;
};

export type OperatorEventPage = {
  events: OperatorEvent[];
  hasMore: boolean;
  nextBeforeEventId: string | null;
};

const VALID_OPERATOR_MODES = new Set<OperatorMode>(["Research", "Paper", "Protected", "SemiAuto"]);
const MAINTENANCE_ACTIONS = new Set(["export-audit", "compact-audit-db", "prune-legacy-incidents"]);

function workspaceRoot() {
  return path.resolve(process.cwd(), "..", "..");
}

function stateDir() {
  return path.join(workspaceRoot(), ".sthyra");
}

function operatorEventPath() {
  return path.join(stateDir(), "operator-events.ndjson");
}

function operatorModeRequestPath() {
  return path.join(stateDir(), "operator-mode-request.txt");
}

function normalizeOperatorEventTimestamp(timestamp: string): string {
  if (/^\d+$/.test(timestamp)) {
    const numericTimestamp = Number(timestamp);
    if (Number.isFinite(numericTimestamp)) {
      return new Date(numericTimestamp).toISOString();
    }
  }

  return timestamp;
}

export async function readOperatorEventsPage(limit = 40, beforeEventId?: string | null): Promise<OperatorEventPage> {
  try {
    const raw = await readFile(operatorEventPath(), "utf8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const event = JSON.parse(line) as OperatorEvent;
        return {
          ...event,
          timestamp: normalizeOperatorEventTimestamp(event.timestamp),
        };
      });

    const reversed = events.reverse();
    const startIndex = beforeEventId
      ? (() => {
          const index = reversed.findIndex((event) => event.id === beforeEventId);
          return index >= 0 ? index + 1 : 0;
        })()
      : 0;
    const pageEvents = reversed.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < reversed.length;

    return {
      events: pageEvents,
      hasMore,
      nextBeforeEventId: hasMore && pageEvents.length > 0 ? pageEvents[pageEvents.length - 1].id : null,
    };
  } catch {
    return {
      events: [],
      hasMore: false,
      nextBeforeEventId: null,
    };
  }
}

export async function readOperatorEvents(limit = 40): Promise<OperatorEvent[]> {
  const page = await readOperatorEventsPage(limit);
  return page.events;
}

export function isMaintenanceOperatorEvent(event: OperatorEvent): boolean {
  return MAINTENANCE_ACTIONS.has(event.action);
}

export async function appendOperatorEvent(event: Omit<OperatorEvent, "id" | "timestamp">) {
  const payload: OperatorEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...event,
  };

  await mkdir(stateDir(), { recursive: true });
  await appendFile(operatorEventPath(), `${JSON.stringify(payload)}\n`, "utf8");

  return payload;
}

export async function clearMaintenanceOperatorEvents(): Promise<number> {
  const events = await readOperatorEvents(Number.MAX_SAFE_INTEGER);

  if (events.length === 0) {
    return 0;
  }

  const retainedEvents = events.filter((event) => !isMaintenanceOperatorEvent(event));
  const removedCount = events.length - retainedEvents.length;

  await mkdir(stateDir(), { recursive: true });
  const payload = retainedEvents
    .slice()
    .reverse()
    .map((event) => JSON.stringify(event))
    .join("\n");
  await writeFile(operatorEventPath(), payload ? `${payload}\n` : "", "utf8");

  return removedCount;
}

export async function readPendingModeRequest(): Promise<OperatorMode | null> {
  try {
    const raw = (await readFile(operatorModeRequestPath(), "utf8")).trim();
    if (!VALID_OPERATOR_MODES.has(raw as OperatorMode)) {
      return null;
    }
    return raw as OperatorMode;
  } catch {
    return null;
  }
}

export async function writePendingModeRequest(mode: OperatorMode) {
  if (!VALID_OPERATOR_MODES.has(mode)) {
    throw new Error(`Unsupported mode request: ${mode}`);
  }

  await mkdir(stateDir(), { recursive: true });
  await writeFile(operatorModeRequestPath(), `${mode}\n`, "utf8");

  return operatorModeRequestPath();
}