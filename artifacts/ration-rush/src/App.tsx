import { useState, useEffect, useRef, useCallback } from "react";

const TOTAL_SECONDS = 600;
const SATIETY_INTERVAL = 40;
const SATIETY_DRAIN = 10;
const SICK_DURATION = 60;
const CRITICAL_TO_INFECTED = 30;
const INFECTED_TO_ZOMBIE = 45;
const STARVATION_TO_DEAD = 45;

type SatietyStatus = "Stable" | "Weak" | "Critical";
type FoodType = "basic" | "protein" | "expired";
type LogType = "danger" | "good" | "neutral";

interface FoodItem {
  type: FoodType;
  label: string;
  satietyGain: number;
  count: number;
}

interface Survivor {
  id: string;
  name: string;
  role: string;
  satiety: number;
  dead: boolean;
  starvationDuration: number;
  sicknessDuration: number;
  criticalDuration: number;
  infectionDuration: number;
  infected: boolean;
  zombie: boolean;
  isolated: boolean;
  fedBasic: boolean;
  fedProtein: boolean;
  fedExpired: boolean;
  wasInfectedAndCured: boolean;
  recoveredFromSick: boolean;
  fedWhileSick: boolean;
}

interface LogEntry {
  id: number;
  time: number;
  message: string;
  type: LogType;
}

interface GameEvent {
  time: number;
  message: string;
  logType: LogType;
  applyInventory?: (inv: Record<FoodType, FoodItem>) => Record<FoodType, FoodItem>;
  applySurvivors?: (survivors: Survivor[]) => Survivor[];
  newSickDuration?: number;
  newDrainRate?: number;
  lockFood?: boolean;
}

interface ChoiceEventDef {
  time: number;
  prompt: string;
  detail?: string;
  yesLabel: string;
  noLabel: string;
  applyYes: (
    setInventory: (fn: (p: Record<FoodType, FoodItem>) => Record<FoodType, FoodItem>) => void,
    setScore: (fn: (p: number) => number) => void
  ) => void;
}

interface PendingChoice {
  prompt: string;
  detail?: string;
  yesLabel: string;
  noLabel: string;
  onYes: () => void;
  onNo: () => void;
}

const CHOICE_EVENTS: ChoiceEventDef[] = [
  {
    time: 360,
    prompt: "Feed an outsider?",
    detail: "Share 2 Basic rations with a wanderer in need.",
    yesLabel: "Yes — share the food (−2 Basic, +8 score)",
    noLabel: "No — protect our supplies",
    applyYes: (setInventory, setScore) => {
      setInventory((prev) => ({
        ...prev,
        basic: { ...prev.basic, count: Math.max(0, prev.basic.count - 2) },
      }));
      setScore((n) => n + 8);
    },
  },
  {
    time: 420,
    prompt: "Steal from another group?",
    detail: "Take 3 Basic rations from a vulnerable group nearby.",
    yesLabel: "Yes — take the supplies (+3 Basic, −5 score)",
    noLabel: "No — leave them alone",
    applyYes: (setInventory, setScore) => {
      setInventory((prev) => ({
        ...prev,
        basic: { ...prev.basic, count: prev.basic.count + 3 },
      }));
      setScore((n) => n - 5);
    },
  },
];

const GAME_EVENTS: GameEvent[] = [
  {
    time: 60,
    message: "Supply contaminated — 4 Basic rations turned Expired.",
    logType: "danger",
    applyInventory: (inv) => ({
      ...inv,
      basic:   { ...inv.basic,   count: Math.max(0, inv.basic.count - 4) },
      expired: { ...inv.expired, count: inv.expired.count + 4 },
    }),
  },
  {
    time: 120,
    message: "Supply drop! +3 Protein rations recovered.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
      protein: { ...inv.protein, count: inv.protein.count + 3 },
    }),
  },
  {
    time: 165,
    message: "Engineer injured during patrol — loses 15 satiety.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) =>
        s.id === "engineer" && !s.dead && !s.zombie
          ? { ...s, satiety: Math.max(0, s.satiety - 15) }
          : s
      ),
  },
  {
    time: 210,
    message: "Rations raided — 3 Basic rations stolen.",
    logType: "danger",
    applyInventory: (inv) => ({
      ...inv,
      basic: { ...inv.basic, count: Math.max(0, inv.basic.count - 3) },
    }),
  },
  {
    time: 240,
    message: "Elder shows signs of infection — immediately Infected.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) =>
        s.id === "elderly" && !s.dead && !s.zombie && !s.infected
          ? { ...s, infected: true, criticalDuration: 0, infectionDuration: 0 }
          : s
      ),
  },
  {
    time: 270,
    message: "Aid delivery — +3 Basic rations received.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
      basic: { ...inv.basic, count: inv.basic.count + 3 },
    }),
  },
  {
    time: 300,
    message: "Contamination spreads — Expired food now causes 120s sickness. −2 Protein lost.",
    logType: "danger",
    newSickDuration: 120,
    applyInventory: (inv) => ({
      ...inv,
      protein: { ...inv.protein, count: Math.max(0, inv.protein.count - 2) },
    }),
  },
  {
    time: 330,
    message: "Pathogen wave — all Weak survivors immediately Infected.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) => {
        if (s.dead || s.zombie || s.infected) return s;
        if (getSatietyStatus(s.satiety) !== "Weak") return s;
        return { ...s, infected: true, criticalDuration: 0, infectionDuration: 0 };
      }),
  },
  {
    time: 360,
    message: "Worker collapses — loses 15 satiety.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) =>
        s.id === "worker" && !s.dead && !s.zombie
          ? { ...s, satiety: Math.max(0, s.satiety - 15) }
          : s
      ),
  },
  {
    time: 390,
    message: "Relief convoy — +2 Basic, +1 Protein rations.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
      basic:   { ...inv.basic,   count: inv.basic.count + 2   },
      protein: { ...inv.protein, count: inv.protein.count + 1 },
    }),
  },
  {
    time: 420,
    message: "Caloric collapse — all survivors lose 15 satiety.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) => (s.dead || s.zombie ? s : { ...s, satiety: Math.max(0, s.satiety - 15) })),
  },
  {
    time: 450,
    message: "All Critical survivors begin starving.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) => {
        if (s.dead || s.zombie || s.starvationDuration > 0) return s;
        if (getSatietyStatus(s.satiety) !== "Critical") return s;
        return { ...s, starvationDuration: 1 };
      }),
  },
  {
    time: 480,
    message: "Scavengers return — +1 Basic, +1 Protein, +1 Expired.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
      basic:   { ...inv.basic,   count: inv.basic.count + 1   },
      protein: { ...inv.protein, count: inv.protein.count + 1 },
      expired: { ...inv.expired, count: inv.expired.count + 1 },
    }),
  },
  {
    time: 510,
    message: "Child found extra rations — +20 satiety.",
    logType: "good",
    applySurvivors: (ss) =>
      ss.map((s) =>
        s.id === "child" && !s.dead && !s.zombie
          ? { ...s, satiety: Math.min(100, s.satiety + 20) }
          : s
      ),
  },
  {
    time: 540,
    message: "Supply lines cut — no more food can be distributed.",
    logType: "danger",
    lockFood: true,
  },
];

const BLANK: Pick<Survivor, "wasInfectedAndCured" | "recoveredFromSick" | "fedWhileSick"> = {
  wasInfectedAndCured: false, recoveredFromSick: false, fedWhileSick: false,
};

const INITIAL_SURVIVORS: Survivor[] = [
  { id: "engineer", name: "Engineer", role: "Engineer", satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "medic",    name: "Medic",    role: "Medic",    satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "worker",   name: "Worker",   role: "Worker",   satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "child",    name: "Child",    role: "Child",    satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "elderly",  name: "Elder",    role: "Elder",    satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
];

const INITIAL_INVENTORY: Record<FoodType, FoodItem> = {
  basic:   { type: "basic",   label: "Basic",   satietyGain: 10, count: 15 },
  protein: { type: "protein", label: "Protein", satietyGain: 20, count: 6  },
  expired: { type: "expired", label: "Expired", satietyGain: 20, count: 4  },
};

// ─── helpers ────────────────────────────────────────────────────────────────

function getSatietyStatus(satiety: number): SatietyStatus {
  if (satiety <= 24) return "Critical";
  if (satiety <= 49) return "Weak";
  return "Stable";
}

function isStarving(s: Survivor): boolean {
  return s.satiety === 0 && !s.dead && !s.zombie;
}

function isUnfeedable(s: Survivor): boolean {
  return s.dead || s.zombie;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function tickSurvivor(s: Survivor, isDrainTick: boolean, drainRate: number): Survivor {
  if (s.dead || s.zombie) return s;

  const newSatiety = isDrainTick ? Math.max(0, s.satiety - drainRate) : s.satiety;

  // Sickness counts down every second; auto-clears and marks recovery
  let newSick = s.sicknessDuration;
  let recoveredFromSick = s.recoveredFromSick;
  if (newSick > 0) {
    newSick -= 1;
    if (newSick === 0) recoveredFromSick = true;
  }

  // Starvation counts up every second at satiety 0
  let starvationDuration = s.starvationDuration;
  let dead = false;
  if (newSatiety === 0) {
    starvationDuration += 1;
    if (starvationDuration >= STARVATION_TO_DEAD) dead = true;
  } else {
    starvationDuration = 0;
  }

  if (dead) {
    return { ...s, satiety: newSatiety, starvationDuration, dead: true, sicknessDuration: newSick, recoveredFromSick };
  }

  const satietyStatus = getSatietyStatus(newSatiety);
  let infected = s.infected;
  let zombie = false;
  let criticalDuration = s.criticalDuration;
  let infectionDuration = s.infectionDuration;

  if (infected) {
    // Infection timer ALWAYS ticks — never pauses, even when isolated
    infectionDuration += 1;
    if (infectionDuration >= INFECTED_TO_ZOMBIE) zombie = true;
  } else {
    if (satietyStatus === "Critical") {
      criticalDuration += 1;
      if (criticalDuration >= CRITICAL_TO_INFECTED) {
        infected = true;
        criticalDuration = 0;
        infectionDuration = 0;
      }
    } else {
      criticalDuration = 0;
    }
  }

  return { ...s, satiety: newSatiety, starvationDuration, dead, sicknessDuration: newSick, recoveredFromSick, criticalDuration, infectionDuration, infected, zombie };
}

// ─── style helpers ───────────────────────────────────────────────────────────

function cardBorderClass(s: Survivor): string {
  if (s.zombie)                 return "border-red-900";
  if (s.dead)                   return "border-zinc-700 opacity-50";
  if (isStarving(s))            return "border-red-600";
  if (s.isolated && s.infected) return "border-cyan-700";
  if (s.infected)               return "border-red-600";
  const status = getSatietyStatus(s.satiety);
  if (status === "Critical")    return "border-red-600 critical-pulse";
  if (status === "Weak")        return "border-yellow-600";
  return "border-green-800";
}

function satietyBarClass(s: Survivor): string {
  if (s.dead || s.zombie) return "bg-zinc-600";
  if (isStarving(s))      return "bg-red-600";
  if (s.infected)         return "bg-red-600";
  const st = getSatietyStatus(s.satiety);
  if (st === "Critical")  return "bg-red-500";
  if (st === "Weak")      return "bg-yellow-500";
  return "bg-green-500";
}

function foodButtonStyle(type: FoodType, disabled: boolean): string {
  const base = "flex-1 py-1.5 text-xs font-semibold rounded transition-opacity border";
  if (disabled) return `${base} opacity-30 cursor-not-allowed border-zinc-700 text-zinc-500 bg-transparent`;
  switch (type) {
    case "basic":   return `${base} border-sky-700 text-sky-300 hover:bg-sky-900/40 cursor-pointer`;
    case "protein": return `${base} border-violet-700 text-violet-300 hover:bg-violet-900/40 cursor-pointer`;
    case "expired": return `${base} border-amber-700 text-amber-300 hover:bg-amber-900/40 cursor-pointer`;
  }
}

// ─── components ──────────────────────────────────────────────────────────────

interface SurvivorCardProps {
  survivor: Survivor;
  inventory: Record<FoodType, FoodItem>;
  onFeed: (survivorId: string, foodType: FoodType) => void;
  onIsolate: (survivorId: string) => void;
  onMedicTreat: (survivorId: string) => void;
  foodLocked: boolean;
  medicUsed: boolean;
}

function SurvivorCard({ survivor: s, inventory, onFeed, onIsolate, onMedicTreat, foodLocked, medicUsed }: SurvivorCardProps) {
  const blocked   = isUnfeedable(s) || foodLocked;
  const starving  = isStarving(s);
  const satStatus = getSatietyStatus(s.satiety);

  const mainBadge = s.zombie
    ? { label: "Zombie",   cls: "bg-red-950/70 text-red-400 border-red-900" }
    : s.dead
      ? { label: "Dead",     cls: "bg-zinc-800/60 text-zinc-500 border-zinc-700" }
      : starving
        ? { label: "Starving", cls: "bg-red-900/50 text-red-300 border-red-700 animate-pulse" }
        : s.infected
          ? { label: "Infected", cls: "bg-red-900/50 text-red-300 border-red-700" }
          : satStatus === "Critical"
            ? { label: "Critical", cls: "bg-red-900/40 text-red-300 border-red-700" }
            : satStatus === "Weak"
              ? { label: "Weak",     cls: "bg-yellow-900/40 text-yellow-300 border-yellow-700" }
              : { label: "Stable",   cls: "bg-green-900/40 text-green-300 border-green-800" };

  const nameColor = s.dead || s.zombie ? "text-zinc-500" : starving ? "text-red-400" : "text-foreground";
  const foods: FoodType[] = ["basic", "protein", "expired"];

  const zombieBg   = s.zombie ? "bg-red-950/25" : "";
  const infectedGlow: React.CSSProperties = s.infected && !s.dead && !s.zombie
    ? { boxShadow: "0 0 14px 2px rgba(220, 38, 38, 0.3)" }
    : {};

  return (
    <div
      className={`rounded-xl border p-4 bg-card flex flex-col gap-3 transition-all shadow-md ${cardBorderClass(s)} ${zombieBg}`}
      style={infectedGlow}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={`font-bold text-lg leading-tight truncate ${nameColor}`}>{s.name}</p>
          <p className="text-xs text-muted-foreground uppercase tracking-widest">{s.role}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${mainBadge.cls}`}>
            {mainBadge.label}
          </span>
          {s.isolated && s.infected && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded border bg-cyan-900/40 text-cyan-300 border-cyan-700">
              Isolated
            </span>
          )}
          {s.sicknessDuration > 0 && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded border bg-amber-900/40 text-amber-300 border-amber-700">
              Sick {s.sicknessDuration}s
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-muted-foreground">Satiety</span>
          <span className={`font-mono font-semibold ${
            s.dead || s.zombie         ? "text-zinc-500"
            : starving                 ? "text-red-400"
            : s.infected               ? "text-red-400"
            : satStatus === "Critical" ? "text-red-400"
            : satStatus === "Weak"     ? "text-yellow-400"
            : "text-green-400"
          }`}>{s.satiety}</span>
        </div>
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${satietyBarClass(s)}`}
            style={{ width: `${Math.max(s.satiety, starving ? 3 : 0)}%` }}
          />
        </div>
      </div>

      {!s.dead && !s.zombie && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {starving && (
            <span className="tabular-nums text-red-400 font-semibold">
              Dies in {STARVATION_TO_DEAD - s.starvationDuration}s — feed now!
            </span>
          )}
          {s.infected && !s.isolated && (
            <span className="tabular-nums">
              Turns zombie in <span className="text-red-400 font-mono font-semibold">{INFECTED_TO_ZOMBIE - s.infectionDuration}s</span>
            </span>
          )}
          {s.infected && s.isolated && (
            <span className="text-cyan-400 font-semibold tabular-nums">
              Isolated — turns zombie in <span className="font-mono">{INFECTED_TO_ZOMBIE - s.infectionDuration}s</span>
            </span>
          )}
          {!s.infected && satStatus === "Critical" && s.criticalDuration > 0 && !starving && (
            <span className="tabular-nums">
              Infects in <span className="text-red-400 font-mono font-semibold">{CRITICAL_TO_INFECTED - s.criticalDuration}s</span>
            </span>
          )}
        </div>
      )}

      <div className="flex gap-1.5 pt-0.5">
        {foods.map((type) => {
          const item = inventory[type];
          const disabled = blocked || item.count === 0;
          return (
            <button
              key={type}
              disabled={disabled}
              onClick={() => !disabled && onFeed(s.id, type)}
              className={foodButtonStyle(type, disabled)}
            >
              {item.label}
              <span className="ml-1 opacity-70">+{item.satietyGain}</span>
            </button>
          );
        })}
      </div>

      {!s.dead && !s.zombie &&
        (s.infected && !s.isolated || (s.sicknessDuration > 0 || s.infected) && !medicUsed) && (
        <div className="flex gap-1.5 flex-wrap border-t border-zinc-800 pt-2.5">
          {s.infected && !s.isolated && (
            (() => {
              const canIsolate = inventory.basic.count >= 2;
              return (
                <button
                  disabled={!canIsolate}
                  onClick={() => canIsolate && onIsolate(s.id)}
                  className={`flex-1 text-xs font-semibold rounded-lg border px-2 py-1.5 transition-all ${
                    canIsolate
                      ? "border-cyan-700 text-cyan-300 bg-cyan-950/30 hover:bg-cyan-950/60 cursor-pointer"
                      : "border-zinc-700 text-zinc-500 opacity-40 cursor-not-allowed"
                  }`}
                >
                  Isolate
                  <span className="ml-1 opacity-60 font-normal">−2 Basic</span>
                </button>
              );
            })()
          )}
          {(s.sicknessDuration > 0 || s.infected) && !medicUsed && (
            <button
              onClick={() => onMedicTreat(s.id)}
              className="flex-1 text-xs font-semibold rounded-lg border px-2 py-1.5 border-green-700 text-green-300 bg-green-950/30 hover:bg-green-950/60 cursor-pointer transition-all"
            >
              Medic Treat
              <span className="ml-1 opacity-60 font-normal">1×</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InventoryPanel({ inventory, sickDuration, drainRate, foodLocked }: {
  inventory: Record<FoodType, FoodItem>;
  sickDuration: number;
  drainRate: number;
  foodLocked: boolean;
}) {
  const items: FoodType[] = ["basic", "protein", "expired"];
  const tagStyle: Record<FoodType, string> = {
    basic:   "border-sky-700 text-sky-300",
    protein: "border-violet-700 text-violet-300",
    expired: "border-amber-700 text-amber-300",
  };

  return (
    <div className={`w-full rounded-xl border bg-card px-4 py-3 mb-4 ${foodLocked ? "border-red-700" : "border-zinc-700"}`}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Food Inventory</p>
        <div className="flex gap-2 items-center">
          {drainRate > SATIETY_DRAIN && (
            <span className="text-xs font-semibold text-amber-400 bg-amber-950/40 border border-amber-700 rounded px-2 py-0.5 animate-pulse">
              drain ×{(drainRate / SATIETY_DRAIN).toFixed(1)}/tick
            </span>
          )}
          {foodLocked && (
            <span className="text-xs font-bold text-red-300 bg-red-950/50 border border-red-700 rounded px-2 py-0.5 tracking-wide">
              LOCKED
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-3 flex-wrap">
        {items.map((type) => {
          const item = inventory[type];
          const empty = item.count === 0;
          return (
            <div key={type} className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-opacity ${empty ? "opacity-40 border-zinc-700" : tagStyle[type]}`}>
              <span className={`text-sm font-semibold ${empty ? "text-zinc-500" : ""}`}>{item.label}</span>
              <span className="text-xs text-muted-foreground">+{item.satietyGain}</span>
              {type === "expired" && (
                <span className={`text-xs font-mono tabular-nums ${sickDuration > SICK_DURATION ? "text-red-400 font-semibold" : "text-muted-foreground"}`}>
                  sick:{sickDuration}s
                </span>
              )}
              <span className={`font-mono font-bold text-sm tabular-nums ${empty ? "text-zinc-500" : "text-foreground"}`}>×{item.count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return null;

  const colorMap: Record<LogType, string> = {
    danger:  "text-red-400 border-red-900 bg-red-950/30",
    good:    "text-green-400 border-green-900 bg-green-950/30",
    neutral: "text-zinc-400 border-zinc-700 bg-zinc-800/30",
  };

  const iconMap: Record<LogType, string> = {
    danger:  "!",
    good:    "+",
    neutral: "·",
  };

  return (
    <div className="w-full rounded-xl border border-zinc-700 bg-card px-4 py-3 mb-6">
      <p className="text-xs uppercase tracking-widest text-muted-foreground mb-3 font-medium">Event Log</p>
      <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
        {[...entries].reverse().map((entry) => (
          <div
            key={entry.id}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${colorMap[entry.type]}`}
          >
            <span className="font-bold shrink-0 w-3 text-center">{iconMap[entry.type]}</span>
            <span className="font-mono text-zinc-500 shrink-0 tabular-nums">{formatTime(entry.time)}</span>
            <span className="leading-snug">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ResultsData {
  survivors: Survivor[];
  elapsedTime: number;
  proteinUsed: number;
  decisionScore: number;
}

function getOutcomeLabel(finalScore: number): { label: string; cls: string } {
  if (finalScore >= 10) return { label: "STABLE SURVIVAL", cls: "text-green-400"  };
  if (finalScore >= 0)  return { label: "BARELY MADE IT",  cls: "text-yellow-400" };
  return                       { label: "COLLAPSE",         cls: "text-red-500"   };
}

function ResultsScreen({ data, onRestart }: { data: ResultsData; onRestart: () => void }) {
  const { survivors, elapsedTime, proteinUsed, decisionScore } = data;

  const alive   = survivors.filter((s) => !s.dead && !s.zombie);
  const dead    = survivors.filter((s) => s.dead);
  const zombies = survivors.filter((s) => s.zombie);

  // Base survival
  const basePts = alive.length * 6 + dead.length * -10 + zombies.length * -6;

  // Satiety score (alive survivors only)
  const satietyPts = alive.reduce((sum, s) => {
    if (s.satiety >= 70) return sum + 2;
    if (s.satiety >= 40) return sum + 1;
    return sum;
  }, 0);

  // Infection management: +2 per survivor cured of infection
  const curedCount = survivors.filter((s) => s.wasInfectedAndCured).length;
  const infectionPts = curedCount * 2;

  // Sickness management: −2 if still sick at end, +1 per recovery
  const sickAtEnd      = survivors.filter((s) => s.sicknessDuration > 0).length;
  const recoveredCount = survivors.filter((s) => s.recoveredFromSick).length;
  const sickPts = sickAtEnd * -2 + recoveredCount * 1;

  // Resource efficiency: +1 per protein used
  const resourcePts = proteinUsed;

  // Balanced diet: +1 per alive survivor with ≥2 food types AND not fed while sick
  const balancedCount = alive.filter((s) => {
    if (s.fedWhileSick) return false;
    return [s.fedBasic, s.fedProtein, s.fedExpired].filter(Boolean).length >= 2;
  }).length;
  const balancedPts = balancedCount;

  const rawScore = basePts + satietyPts + infectionPts + sickPts + resourcePts + balancedPts + decisionScore;

  // Normalize raw score to −20…+20
  const finalScore = Math.max(-20, Math.min(20, Math.round(((rawScore - (-60)) / 120) * 40 - 20)));

  const outcome = getOutcomeLabel(finalScore);

  const rows: { label: string; pts: number; detail: string }[] = [
    { label: "Survivors alive",  pts: alive.length * 6,    detail: `${alive.length} × +6`   },
    { label: "Deaths",           pts: dead.length * -10,   detail: `${dead.length} × −10`   },
    { label: "Zombies",          pts: zombies.length * -6,  detail: `${zombies.length} × −6` },
    { label: "Satiety",          pts: satietyPts,           detail: "per alive survivor"      },
    { label: "Infection cures",  pts: infectionPts,         detail: `${curedCount} × +2`      },
    { label: "Sickness",         pts: sickPts,              detail: `sick at end: −2, recovered: +1` },
    { label: "Protein used",     pts: resourcePts,          detail: `${proteinUsed} × +1`    },
    { label: "Balanced diets",   pts: balancedPts,          detail: `${balancedCount} × +1`  },
    { label: "Decisions",        pts: decisionScore,        detail: "choice events"           },
  ];

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg flex flex-col gap-6">
        <div className="text-center">
          <p className="text-xs uppercase tracking-widest text-muted-foreground mb-2 font-medium">Simulation ended · {formatTime(elapsedTime)}</p>
          <p className={`text-5xl font-black tracking-tight mb-1 ${outcome.cls}`}>{outcome.label}</p>
          <p className="text-4xl font-mono font-bold text-foreground tabular-nums">{finalScore >= 0 ? "+" : ""}{finalScore}</p>
          <p className="text-xs text-muted-foreground mt-1 font-mono">raw {rawScore >= 0 ? "+" : ""}{rawScore} → normalized −20…+20</p>
        </div>

        <div className="rounded-xl border border-zinc-700 bg-card overflow-hidden">
          <p className="text-xs uppercase tracking-widest text-muted-foreground px-4 pt-3 pb-2 font-medium border-b border-zinc-800">Score Breakdown</p>
          <div className="divide-y divide-zinc-800">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm text-foreground">{r.label}</span>
                  <span className="text-xs text-muted-foreground ml-2">{r.detail}</span>
                </div>
                <span className={`font-mono font-semibold tabular-nums text-sm ${r.pts > 0 ? "text-green-400" : r.pts < 0 ? "text-red-400" : "text-zinc-500"}`}>
                  {r.pts >= 0 ? "+" : ""}{r.pts}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-700 bg-card overflow-hidden">
          <p className="text-xs uppercase tracking-widest text-muted-foreground px-4 pt-3 pb-2 font-medium border-b border-zinc-800">Survivor Status</p>
          <div className="divide-y divide-zinc-800">
            {survivors.map((s) => {
              const tag = s.zombie ? { label: "Zombie", cls: "text-red-400"   }
                        : s.dead   ? { label: "Dead",   cls: "text-zinc-500" }
                        : { label: `Alive · ${s.satiety} satiety`, cls: "text-green-400" };
              const diet = !s.dead && !s.zombie
                ? [s.fedBasic && "Basic", s.fedProtein && "Protein", s.fedExpired && "Expired"].filter(Boolean).join(", ") || "—"
                : "—";
              return (
                <div key={s.id} className="flex items-center justify-between px-4 py-2.5 gap-4">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-foreground">{s.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">ate: {diet}</span>
                  </div>
                  <span className={`text-xs font-semibold shrink-0 ${tag.cls}`}>{tag.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <button
          onClick={onRestart}
          className="w-full py-3 rounded-xl border border-zinc-600 bg-zinc-800/50 text-zinc-300 font-semibold hover:bg-zinc-800 cursor-pointer transition-all"
        >
          Play Again
        </button>
      </div>
    </div>
  );
}

function ChoiceModal({ choice }: { choice: PendingChoice }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 rounded-2xl border border-zinc-600 bg-card p-6 shadow-2xl flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Decision required</p>
          <p className="text-2xl font-bold text-foreground leading-tight">{choice.prompt}</p>
          {choice.detail && (
            <p className="text-sm text-muted-foreground leading-snug">{choice.detail}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={choice.onYes}
            className="w-full rounded-xl border border-green-700 bg-green-950/50 text-green-300 font-semibold py-3 px-4 text-sm hover:bg-green-950/80 cursor-pointer transition-all"
          >
            {choice.yesLabel}
          </button>
          <button
            onClick={choice.onNo}
            className="w-full rounded-xl border border-zinc-600 bg-zinc-800/50 text-zinc-400 font-semibold py-3 px-4 text-sm hover:bg-zinc-800 cursor-pointer transition-all"
          >
            {choice.noLabel}
          </button>
        </div>
        <p className="text-center text-xs text-muted-foreground">⏸ Timer paused</p>
      </div>
    </div>
  );
}

function RulesCard() {
  const rules = [
    { text: "Keep satiety above 0" },
    { text: `Critical (${CRITICAL_TO_INFECTED}s) → Infected` },
    { text: `Infected (${INFECTED_TO_ZOMBIE}s) → Zombie` },
    { text: `Starvation (${STARVATION_TO_DEAD}s) → Dead` },
    { text: "Expired food → Sick (half effect)" },
  ];

  return (
    <div className="rounded-xl border border-zinc-700/60 p-4 bg-zinc-900/40 flex flex-col gap-3">
      <p className="font-bold text-xs uppercase tracking-widest text-muted-foreground">Rules</p>
      <ul className="flex flex-col gap-2">
        {rules.map((r) => (
          <li key={r.text} className="flex items-start gap-2 text-xs text-zinc-400 leading-snug">
            <span className="shrink-0 mt-[5px] w-1 h-1 rounded-full bg-zinc-600" />
            {r.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function IntroScreen({ onStart }: { onStart: () => void }) {
  const rules = [
    "Allocate food to keep survivors alive",
    "Satiety decreases over time",
    "Critical survivors can become Infected",
    "Infected survivors can turn into Zombies",
    "Expired food causes Sick (reduces food effectiveness)",
    "Events will impact resources and survivors",
    "Keep your team alive until extraction arrives",
  ];

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg flex flex-col items-center gap-8">
        <div className="text-center">
          <h1 className="text-6xl font-bold tracking-tight text-accent mb-3">RATION RUSH</h1>
          <p className="text-base text-muted-foreground">A survival resource management simulation</p>
        </div>

        <div className="w-full rounded-xl border border-zinc-700 bg-card px-6 py-5">
          <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold mb-4">Game Rules</p>
          <ul className="flex flex-col gap-2.5 list-none">
            {rules.map((rule) => (
              <li key={rule} className="flex items-start gap-3 text-sm text-foreground/90">
                <span className="shrink-0 mt-[6px] w-1.5 h-1.5 rounded-full bg-accent/70" />
                {rule}
              </li>
            ))}
          </ul>
        </div>

        <button
          onClick={onStart}
          className="px-8 py-4 text-xl font-semibold rounded-lg bg-primary text-primary-foreground cursor-pointer transition-opacity hover:opacity-90"
        >
          BEGIN SIMULATION
        </button>
      </div>
    </div>
  );
}

function GameScreen() {
  const [elapsedTime, setElapsedTime]   = useState(0);
  const [started, setStarted]           = useState(false);
  const [survivors, setSurvivors]       = useState<Survivor[]>(INITIAL_SURVIVORS);
  const [inventory, setInventory]       = useState<Record<FoodType, FoodItem>>({ ...INITIAL_INVENTORY });
  const [eventLog, setEventLog]         = useState<LogEntry[]>([]);
  const [sickDuration, setSickDuration] = useState(SICK_DURATION);
  const sickDurationRef                 = useRef(SICK_DURATION);
  const [drainRate, setDrainRate]       = useState(SATIETY_DRAIN);
  const drainRateRef                    = useRef(SATIETY_DRAIN);
  const [foodLocked, setFoodLocked]     = useState(false);
  const foodLockedRef                   = useRef(false);
  const [medicUsed, setMedicUsed]       = useState(false);
  const [score, setScore]               = useState(0);
  const [paused, setPaused]             = useState(false);
  const [pendingChoice, setPendingChoice] = useState<PendingChoice | null>(null);
  const [proteinUsed, setProteinUsed]   = useState(0);
  const [submitted, setSubmitted]       = useState(false);
  const logIdRef                        = useRef(0);
  const intervalRef                     = useRef<ReturnType<typeof setInterval> | null>(null);

  const remainingTime = TOTAL_SECONDS - elapsedTime;

  const startTimer = useCallback(() => {
    if (started) return;
    setStarted(true);
  }, [started]);

  // Single setInterval — stops ticking while paused
  useEffect(() => {
    if (!started || paused) return;
    intervalRef.current = setInterval(() => {
      setElapsedTime((prev) => {
        if (prev + 1 >= TOTAL_SECONDS) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return TOTAL_SECONDS;
        }
        return prev + 1;
      });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [started, paused]);

  // Per-second survivor tick
  useEffect(() => {
    if (!started || elapsedTime === 0) return;
    const isDrainTick = elapsedTime % SATIETY_INTERVAL === 0;
    setSurvivors((prev) => prev.map((s) => tickSurvivor(s, isDrainTick, drainRateRef.current)));
  }, [elapsedTime, started]);

  // Event system
  useEffect(() => {
    if (!started || elapsedTime === 0) return;

    const event = GAME_EVENTS.find((e) => e.time === elapsedTime);
    if (event) {
      if (event.applyInventory) setInventory((prev) => event.applyInventory!(prev));
      if (event.applySurvivors) setSurvivors((prev) => event.applySurvivors!(prev));
      if (event.newSickDuration !== undefined) { setSickDuration(event.newSickDuration); sickDurationRef.current = event.newSickDuration; }
      if (event.newDrainRate !== undefined) { setDrainRate(event.newDrainRate); drainRateRef.current = event.newDrainRate; }
      if (event.lockFood) { setFoodLocked(true); foodLockedRef.current = true; }
      const id = ++logIdRef.current;
      setEventLog((prev) => [...prev, { id, time: elapsedTime, message: event.message, type: event.logType }]);
    }

    const choice = CHOICE_EVENTS.find((e) => e.time === elapsedTime);
    if (choice) {
      setPaused(true);
      setPendingChoice({
        prompt: choice.prompt,
        detail: choice.detail,
        yesLabel: choice.yesLabel,
        noLabel: choice.noLabel,
        onYes: () => {
          choice.applyYes(setInventory, setScore);
          setPendingChoice(null);
          setPaused(false);
        },
        onNo: () => {
          setPendingChoice(null);
          setPaused(false);
        },
      });
    }
  }, [elapsedTime, started]);

  const feedSurvivor = useCallback((survivorId: string, foodType: FoodType) => {
    if (foodLockedRef.current) return;
    setInventory((prev) => {
      const item = prev[foodType];
      if (item.count === 0) return prev;
      return { ...prev, [foodType]: { ...item, count: item.count - 1 } };
    });
    if (foodType === "protein") setProteinUsed((n) => n + 1);
    setSurvivors((prev) =>
      prev.map((s) => {
        if (s.id !== survivorId) return s;
        if (isUnfeedable(s)) return s;
        const baseGain = INITIAL_INVENTORY[foodType].satietyGain;
        const gain = s.sicknessDuration > 0 ? Math.floor(baseGain / 2) : baseGain;
        const newSatiety = Math.min(100, s.satiety + gain);
        const newSick = foodType === "expired" ? sickDurationRef.current : s.sicknessDuration;
        const newStarvation = newSatiety > 0 ? 0 : s.starvationDuration;
        return {
          ...s,
          satiety: newSatiety,
          sicknessDuration: newSick,
          starvationDuration: newStarvation,
          fedBasic:    s.fedBasic    || foodType === "basic",
          fedProtein:  s.fedProtein  || foodType === "protein",
          fedExpired:  s.fedExpired  || foodType === "expired",
          fedWhileSick: s.fedWhileSick || s.sicknessDuration > 0,
        };
      })
    );
  }, []);

  const isolateSurvivor = useCallback((survivorId: string) => {
    setInventory((prev) => {
      if (prev.basic.count < 2) return prev;
      return { ...prev, basic: { ...prev.basic, count: prev.basic.count - 2 } };
    });
    setSurvivors((prev) =>
      prev.map((s) => (s.id === survivorId && s.infected && !s.isolated ? { ...s, isolated: true } : s))
    );
  }, []);

  const medicTreat = useCallback((survivorId: string) => {
    setMedicUsed(true);
    setSurvivors((prev) =>
      prev.map((s) => {
        if (s.id !== survivorId || s.dead || s.zombie) return s;
        return {
          ...s,
          sicknessDuration: 0,
          infected: false,
          isolated: false,
          criticalDuration: 0,
          infectionDuration: 0,
          wasInfectedAndCured: s.wasInfectedAndCured || s.infected,
          recoveredFromSick: s.recoveredFromSick || s.sicknessDuration > 0,
        };
      })
    );
  }, []);

  const submitGame = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSubmitted(true);
  }, []);

  // End at timer expiry
  useEffect(() => {
    if (started && !submitted && elapsedTime >= TOTAL_SECONDS) {
      submitGame();
    }
  }, [elapsedTime, started, submitted, submitGame]);

  // Early termination: all survivors dead or zombie
  useEffect(() => {
    if (!started || submitted) return;
    const allGone = survivors.every((s) => s.dead || s.zombie);
    if (allGone) submitGame();
  }, [survivors, started, submitted, submitGame]);

  const aliveCount  = survivors.filter((s) => !s.dead && !s.zombie).length;
  const zombieCount = survivors.filter((s) => s.zombie).length;
  const deadCount   = survivors.filter((s) => s.dead).length;

  if (submitted) {
    return (
      <ResultsScreen
        data={{ survivors, elapsedTime, proteinUsed, decisionScore: score }}
        onRestart={() => window.location.reload()}
      />
    );
  }

  // Next upcoming event (auto + choice combined)
  const allUpcoming = [
    ...GAME_EVENTS.map((e) => ({ time: e.time, isChoice: false })),
    ...CHOICE_EVENTS.map((e) => ({ time: e.time, isChoice: true })),
  ].filter((e) => e.time > elapsedTime).sort((a, b) => a.time - b.time);
  const nextAny = allUpcoming[0];

  return (
    <div className="min-h-screen w-full flex flex-col items-center bg-background pb-12">
      {pendingChoice && <ChoiceModal choice={pendingChoice} />}
      <div className="w-full max-w-3xl px-4 pt-8">
        <div className="text-center mb-6">
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-widest mb-2">Time Remaining</p>
          <p className={`text-7xl font-mono font-bold tabular-nums ${
            remainingTime <= 60 ? "text-destructive" : remainingTime <= 300 ? "text-accent" : "text-foreground"
          }`}>
            {formatTime(remainingTime)}
          </p>
          {started && nextAny && (
            <p className="text-xs text-muted-foreground mt-2">
              Next {nextAny.isChoice ? <span className="text-amber-400 font-semibold">decision</span> : "event"} in{" "}
              <span className="text-foreground font-mono font-semibold tabular-nums">
                {nextAny.time - elapsedTime}s
              </span>
            </p>
          )}
        </div>

        {!started && (
          <div className="flex justify-center mb-6">
            <button
              onClick={startTimer}
              className="px-6 py-3 text-lg font-semibold rounded-lg bg-primary text-primary-foreground cursor-pointer transition-opacity hover:opacity-90"
            >
              Start Timer
            </button>
          </div>
        )}

        {started && (
          <p className="text-center text-sm text-muted-foreground mb-6">
            {remainingTime === 0 ? "Simulation ended." : "Game Running"}
            {" · "}
            <span className="text-foreground font-medium">{aliveCount}</span> alive
            {deadCount > 0 && <> · <span className="text-zinc-400 font-medium">{deadCount} dead</span></>}
            {zombieCount > 0 && <> · <span className="text-red-400 font-medium">{zombieCount} zombie{zombieCount > 1 ? "s" : ""}</span></>}
          </p>
        )}

        <InventoryPanel inventory={inventory} sickDuration={sickDuration} drainRate={drainRate} foodLocked={foodLocked} />
        <EventLog entries={eventLog} />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {survivors.map((s) => (
            <SurvivorCard key={s.id} survivor={s} inventory={inventory} onFeed={feedSurvivor} onIsolate={isolateSurvivor} onMedicTreat={medicTreat} foodLocked={foodLocked} medicUsed={medicUsed} />
          ))}
          <RulesCard />
        </div>
      </div>
    </div>
  );
}

function App() {
  const [screen, setScreen] = useState<"intro" | "game">("intro");
  return screen === "intro"
    ? <IntroScreen onStart={() => setScreen("game")} />
    : <GameScreen />;
}

export default App;
