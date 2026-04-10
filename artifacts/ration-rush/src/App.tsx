import { useState, useEffect, useRef, useCallback } from "react";

const TOTAL_SECONDS = 600;
const SATIETY_INTERVAL = 40;
const SATIETY_DRAIN = 10;
const SICK_DRAIN_INTERVAL = 20;
const SICK_DRAIN_AMOUNT = 5;
const SICK_DURATION = 60;
const CRITICAL_TO_INFECTED = 30;
const INFECTED_TO_ZOMBIE = 45;
const STARVATION_TO_DEAD = 45;
const ISOLATION_DURATION = 120;

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
  isolationDuration: number;
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
  yesRequiresBasic?: number;
  applyYes: (
    setInventory: (fn: (p: Record<FoodType, FoodItem>) => Record<FoodType, FoodItem>) => void,
    setScore: (fn: (p: number) => number) => void,
    setSurvivors?: (fn: (p: Survivor[]) => Survivor[]) => void
  ) => void;
  applyNo?: (
    setInventory: (fn: (p: Record<FoodType, FoodItem>) => Record<FoodType, FoodItem>) => void,
    setScore: (fn: (p: number) => number) => void,
    setSurvivors?: (fn: (p: Survivor[]) => Survivor[]) => void
  ) => void;
}

interface PendingChoice {
  prompt: string;
  detail?: string;
  yesLabel: string;
  noLabel: string;
  onYes: () => void;
  onNo: () => void;
  yesRequiresBasic?: number;
}

const CHOICE_EVENTS: ChoiceEventDef[] = [
  {
    time: 150,
    prompt: "Ration strictly to conserve supplies?",
    detail: "Tighten rations now — all survivors lose 10 satiety, but gain +5 Basic food.",
    yesLabel: "Yes — ration strictly (−10 satiety all, +5 Basic)",
    noLabel: "No — keep current rations",
    applyYes: (_setInventory, _setScore, setSurvivors) => {
      _setInventory((prev) => ({
        ...prev,
        basic: { ...prev.basic, count: prev.basic.count + 5 },
      }));
      setSurvivors?.((prev) =>
        prev.map((s) => (s.dead || s.zombie ? s : { ...s, satiety: Math.max(0, s.satiety - 10) }))
      );
    },
  },
  {
    time: 360,
    prompt: "Feed an outsider?",
    detail: "Share 2 Basic rations with a wanderer in need.",
    yesLabel: "Yes — share the food (−2 Basic, +8 score)",
    noLabel: "No — protect our supplies (−6 score)",
    yesRequiresBasic: 2,
    applyYes: (_setInventory, setScore) => {
      _setInventory((prev) => ({
        ...prev,
        basic: { ...prev.basic, count: Math.max(0, prev.basic.count - 2) },
      }));
      setScore((n) => n + 8);
    },
    applyNo: (_setInventory, setScore) => {
      setScore((n) => n - 6);
    },
  },
  {
    time: 420,
    prompt: "Steal from another group?",
    detail: "Take 3 Basic rations from a vulnerable group nearby.",
    yesLabel: "Yes — take the supplies (+3 Basic, −5 score)",
    noLabel: "No — leave them alone (+3 score)",
    applyYes: (_setInventory, setScore) => {
      _setInventory((prev) => ({
        ...prev,
        basic: { ...prev.basic, count: prev.basic.count + 3 },
      }));
      setScore((n) => n - 5);
    },
    applyNo: (_setInventory, setScore) => {
      setScore((n) => n + 3);
    },
  },
];

const GAME_EVENTS: GameEvent[] = [
  {
    time: 90,
    message: "Medic collapses on patrol — loses 15 satiety.",
    logType: "danger",
    applySurvivors: (ss) =>
      ss.map((s) =>
        s.id === "medic" && !s.dead && !s.zombie
          ? { ...s, satiety: Math.max(0, s.satiety - 15) }
          : s
      ),
  },
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
    message: "Aid delivery — +2 Basic rations received.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
      basic: { ...inv.basic, count: inv.basic.count + 2 },
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
    message: "Relief convoy — +1 Protein ration.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
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
    message: "Scavengers return — +1 Expired ration.",
    logType: "good",
    applyInventory: (inv) => ({
      ...inv,
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
  { id: "engineer", name: "Engineer", role: "Engineer", satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, isolationDuration: 0, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "medic",    name: "Medic",    role: "Medic",    satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, isolationDuration: 0, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "worker",   name: "Worker",   role: "Worker",   satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, isolationDuration: 0, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "child",    name: "Child",    role: "Child",    satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, isolationDuration: 0, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
  { id: "elderly",  name: "Elder",    role: "Elder",    satiety: 100, dead: false, starvationDuration: 0, sicknessDuration: 0, criticalDuration: 0, infectionDuration: 0, infected: false, zombie: false, isolated: false, isolationDuration: 0, fedBasic: false, fedProtein: false, fedExpired: false, ...BLANK },
];

const INITIAL_INVENTORY: Record<FoodType, FoodItem> = {
  basic:   { type: "basic",   label: "Basic",   satietyGain: 10, count: 15 },
  protein: { type: "protein", label: "Protein", satietyGain: 20, count: 6  },
  expired: { type: "expired", label: "Expired", satietyGain: 10, count: 4  },
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
  return s.dead || s.zombie || s.isolated;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function tickSurvivor(s: Survivor, isDrainTick: boolean, isSickTick: boolean, drainRate: number): Survivor {
  if (s.dead || s.zombie) return s;

  // Base satiety drain
  let newSatiety = isDrainTick ? Math.max(0, s.satiety - drainRate) : s.satiety;

  // Sickness: extra drain every SICK_DRAIN_INTERVAL seconds
  if (isSickTick && s.sicknessDuration > 0) {
    newSatiety = Math.max(0, newSatiety - SICK_DRAIN_AMOUNT);
  }

  // Sickness counts down every second; auto-clears and marks recovery
  let newSick = s.sicknessDuration;
  let recoveredFromSick = s.recoveredFromSick;
  if (newSick > 0) {
    newSick -= 1;
    if (newSick === 0) recoveredFromSick = true;
  }

  // Isolation: tick duration; cure infection and release after ISOLATION_DURATION
  let isolated = s.isolated;
  let isolationDuration = s.isolationDuration;
  let infected = s.infected;
  let infectionDuration = s.infectionDuration;
  let criticalDuration = s.criticalDuration;
  let justReleasedFromIsolation = false;

  if (isolated) {
    isolationDuration += 1;
    if (isolationDuration >= ISOLATION_DURATION) {
      isolated = false;
      isolationDuration = 0;
      infected = false;
      infectionDuration = 0;
      justReleasedFromIsolation = true;
    }
  }

  // Starvation counts up every second at satiety 0 (isolation does NOT stop starvation)
  let starvationDuration = s.starvationDuration;
  let dead = false;
  if (newSatiety === 0) {
    starvationDuration += 1;
    if (starvationDuration >= STARVATION_TO_DEAD) dead = true;
  } else {
    starvationDuration = 0;
  }

  if (dead) {
    return { ...s, satiety: newSatiety, starvationDuration, dead: true, sicknessDuration: newSick, recoveredFromSick, isolated, isolationDuration, infected, infectionDuration, criticalDuration };
  }

  const satietyStatus = getSatietyStatus(newSatiety);
  let zombie = false;

  if (infected && !isolated) {
    // Infection timer ticks only when NOT isolated
    infectionDuration += 1;
    if (infectionDuration >= INFECTED_TO_ZOMBIE) zombie = true;
  } else if (!infected && !isolated && !justReleasedFromIsolation) {
    // Critical → Infected only when not isolated and not just released
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

  return { ...s, satiety: newSatiety, starvationDuration, dead, sicknessDuration: newSick, recoveredFromSick, criticalDuration, infectionDuration, infected, zombie, isolated, isolationDuration };
}

// ─── style helpers ───────────────────────────────────────────────────────────

function cardBorderClass(s: Survivor): string {
  if (s.zombie)                 return "border-red-950";
  if (s.dead)                   return "border-zinc-800 opacity-40";
  if (isStarving(s))            return "border-red-800";
  if (s.isolated && s.infected) return "border-purple-900";
  if (s.infected)               return "border-purple-900";
  const status = getSatietyStatus(s.satiety);
  if (status === "Critical")    return "border-red-800 critical-pulse";
  if (status === "Weak")        return "border-yellow-900";
  return "border-stone-700";
}

function satietyBarClass(s: Survivor): string {
  if (s.dead || s.zombie) return "bg-zinc-700";
  if (isStarving(s))      return "bg-red-800";
  if (s.infected)         return "bg-purple-900";
  const st = getSatietyStatus(s.satiety);
  if (st === "Critical")  return "bg-red-700";
  if (st === "Weak")      return "bg-yellow-800";
  return "bg-green-900";
}

function foodButtonStyle(type: FoodType, disabled: boolean): string {
  const base = "w-full py-1.5 text-xs font-semibold transition-opacity border uppercase tracking-wide truncate";
  if (disabled) return `${base} opacity-20 cursor-not-allowed border-zinc-800 text-zinc-600 bg-transparent`;
  switch (type) {
    case "basic":   return `${base} border-stone-700 text-stone-400 bg-stone-900/30 hover:bg-stone-800/50 cursor-pointer`;
    case "protein": return `${base} border-green-900 text-green-600 bg-green-950/20 hover:bg-green-900/30 cursor-pointer`;
    case "expired": return `${base} border-lime-900 text-lime-700 bg-lime-950/10 hover:bg-lime-900/20 cursor-pointer`;
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
    ? { label: "💀 Zombie",   cls: "bg-red-950 text-red-500 border-red-900" }
    : s.dead
      ? { label: "✕ Dead",     cls: "bg-zinc-900 text-zinc-500 border-zinc-800" }
      : starving
        ? { label: "⚠ Starving", cls: "bg-red-950 text-red-400 border-red-800 badge-flash" }
        : s.infected
          ? { label: "☣ Infected", cls: "bg-purple-950 text-purple-400 border-purple-900" }
          : satStatus === "Critical"
            ? { label: "▲ Critical", cls: "bg-red-950/60 text-red-400 border-red-900 badge-flash" }
            : satStatus === "Weak"
              ? { label: "Weak",      cls: "bg-yellow-950/40 text-yellow-700 border-yellow-900" }
              : { label: "Stable",    cls: "bg-stone-900/60 text-stone-400 border-stone-700" };

  const nameColor = s.dead || s.zombie ? "text-zinc-600" : starving ? "text-red-400" : "text-foreground";
  const foods: FoodType[] = ["basic", "protein", "expired"];

  const zombieBg   = s.zombie ? "bg-red-950/10" : "";
  const infectedGlow: React.CSSProperties = s.infected && !s.dead && !s.zombie
    ? { boxShadow: "0 0 18px 3px rgba(120, 0, 180, 0.2)" }
    : {};

  return (
    <div
      className={`border p-4 bg-card flex flex-col gap-3 transition-all shadow-lg ${cardBorderClass(s)} ${zombieBg}`}
      style={infectedGlow}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={`font-military text-lg leading-tight truncate ${nameColor}`}>{s.name}</p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{s.role}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[10px] font-semibold px-2 py-0.5 border uppercase tracking-wide ${mainBadge.cls}`}>
            {mainBadge.label}
          </span>
          {s.isolated && (
            <span className="text-[10px] font-semibold px-2 py-0.5 border bg-purple-950/40 text-purple-400 border-purple-900 uppercase tracking-wide">
              ⚿ Isolated
            </span>
          )}
          {s.sicknessDuration > 0 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 border bg-lime-950/30 text-lime-600 border-lime-900 uppercase tracking-wide">
              ⚕ Sick {s.sicknessDuration}s
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Satiety</span>
          <span className={`font-mono font-semibold ${
            s.dead || s.zombie         ? "text-zinc-600"
            : starving                 ? "text-red-400"
            : s.infected               ? "text-purple-400"
            : satStatus === "Critical" ? "text-red-500"
            : satStatus === "Weak"     ? "text-yellow-700"
            : "text-green-700"
          }`}>{s.satiety}</span>
        </div>
        <div className="h-1.5 bg-zinc-900 border border-zinc-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-700 ${satietyBarClass(s)}`}
            style={{ width: `${Math.max(s.satiety, starving ? 3 : 0)}%` }}
          />
        </div>
      </div>

      {!s.dead && !s.zombie && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {starving && (
            <span className="tabular-nums text-red-400 font-semibold uppercase tracking-wide">
              ⚠ Dies in {STARVATION_TO_DEAD - s.starvationDuration}s — feed now!
            </span>
          )}
          {s.infected && !s.isolated && (
            <span className="tabular-nums text-purple-400">
              Turns zombie in <span className="font-mono font-semibold">{INFECTED_TO_ZOMBIE - s.infectionDuration}s</span>
            </span>
          )}
          {s.isolated && (
            <span className="text-purple-400 tabular-nums">
              Cured in <span className="font-mono font-semibold">{ISOLATION_DURATION - s.isolationDuration}s</span>
            </span>
          )}
          {!s.infected && satStatus === "Critical" && s.criticalDuration > 0 && !starving && (
            <span className="tabular-nums text-red-500">
              Infects in <span className="font-mono font-semibold">{CRITICAL_TO_INFECTED - s.criticalDuration}s</span>
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1 pt-0.5">
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
              <span className="ml-1 opacity-60">+{item.satietyGain}</span>
            </button>
          );
        })}
      </div>

      {!s.dead && !s.zombie &&
        (s.infected && !s.isolated || (s.sicknessDuration > 0 || s.infected) && !medicUsed) && (
        <div className="flex flex-col gap-1.5 border-t border-zinc-900 pt-2.5">
          {s.infected && !s.isolated && (
            (() => {
              const canIsolate = inventory.basic.count >= 2;
              return (
                <button
                  disabled={!canIsolate}
                  onClick={() => canIsolate && onIsolate(s.id)}
                  className={`w-full text-xs font-semibold border px-2 py-1.5 transition-all uppercase tracking-wide ${
                    canIsolate
                      ? "border-purple-900 text-purple-400 bg-purple-950/20 hover:bg-purple-950/40 cursor-pointer"
                      : "border-zinc-800 text-zinc-600 opacity-30 cursor-not-allowed"
                  }`}
                >
                  Isolate
                  <span className="ml-1 opacity-60 font-normal normal-case">−2 Basic</span>
                </button>
              );
            })()
          )}
          {(s.sicknessDuration > 0 || s.infected) && !medicUsed && (
            <button
              onClick={() => onMedicTreat(s.id)}
              className="w-full text-xs font-semibold border px-2 py-1.5 border-green-900 text-green-600 bg-green-950/20 hover:bg-green-950/40 cursor-pointer transition-all uppercase tracking-wide"
            >
              Medic Treat
              <span className="ml-1 opacity-60 font-normal normal-case">1×</span>
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
    basic:   "border-stone-700 text-stone-400 bg-stone-900/20",
    protein: "border-green-900 text-green-600 bg-green-950/15",
    expired: "border-lime-900 text-lime-700 bg-lime-950/10",
  };
  const tagLabel: Record<FoodType, string> = {
    basic:   "Basic Ration",
    protein: "Protein Pack",
    expired: "⚠ Spoiled",
  };

  return (
    <div className={`w-full border bg-card px-4 py-3 mb-4 ${foodLocked ? "border-red-900" : "border-stone-800"}`}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-military">// Food Inventory</p>
        <div className="flex gap-2 items-center">
          {drainRate > SATIETY_DRAIN && (
            <span className="text-[10px] font-semibold text-red-400 bg-red-950/30 border border-red-900 px-2 py-0.5 animate-pulse uppercase tracking-wide">
              drain ×{(drainRate / SATIETY_DRAIN).toFixed(1)}/tick
            </span>
          )}
          {foodLocked && (
            <span className="text-[10px] font-bold text-red-400 bg-red-950/40 border border-red-900 px-2 py-0.5 tracking-widest uppercase font-military">
              ▓ SUPPLY CUT ▓
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-3 flex-wrap">
        {items.map((type) => {
          const item = inventory[type];
          const empty = item.count === 0;
          return (
            <div key={type} className={`flex items-center gap-2 border px-3 py-2 transition-opacity ${empty ? "opacity-25 border-zinc-800 text-zinc-600" : tagStyle[type]}`}>
              <span className={`text-xs font-semibold uppercase tracking-wide ${empty ? "text-zinc-600" : ""}`}>
                {type === "expired"
                  ? <><s className="opacity-60">{tagLabel[type]}</s></>
                  : tagLabel[type]}
              </span>
              <span className="text-xs text-muted-foreground">+{item.satietyGain}</span>
              {type === "expired" && (
                <span className={`text-xs font-mono tabular-nums ${sickDuration > SICK_DURATION ? "text-red-400 font-semibold" : "text-lime-900"}`}>
                  sick:{sickDuration}s
                </span>
              )}
              <span className={`font-mono font-bold text-sm tabular-nums ${empty ? "text-zinc-600" : "text-foreground"}`}>×{item.count}</span>
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
    danger:  "text-red-500 border-red-900/60 bg-red-950/20",
    good:    "text-green-600 border-green-900/50 bg-green-950/10",
    neutral: "text-stone-400 border-stone-800 bg-stone-900/20",
  };

  const iconMap: Record<LogType, string> = {
    danger:  "▲",
    good:    "▶",
    neutral: "·",
  };

  return (
    <div className="w-full border border-stone-800 bg-card px-4 py-3 mb-6">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-3 font-military">// Incident Log</p>
      <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
        {[...entries].reverse().map((entry) => (
          <div
            key={entry.id}
            className={`flex items-start gap-2 border px-3 py-2 text-xs ${colorMap[entry.type]}`}
          >
            <span className="font-bold shrink-0 w-3 text-center">{iconMap[entry.type]}</span>
            <span className="font-mono text-muted-foreground shrink-0 tabular-nums">{formatTime(entry.time)}</span>
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
  if (finalScore >= 10) return { label: "STABLE SURVIVAL", cls: "text-green-700"  };
  if (finalScore >= 0)  return { label: "BARELY MADE IT",  cls: "text-yellow-700" };
  return                       { label: "COLLAPSE",         cls: "text-red-600"   };
}

function ResultsScreen({ data }: { data: ResultsData }) {
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

  const rawScore = basePts + satietyPts + infectionPts + sickPts + resourcePts + decisionScore;

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
    { label: "Decisions",        pts: decisionScore,        detail: "choice events"           },
  ];

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg flex flex-col gap-6">
        <div className="text-center">
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3 font-military">// Simulation ended · {formatTime(elapsedTime)}</p>
          <p className={`font-military text-5xl tracking-widest mb-2 uppercase ${outcome.cls}`}>{outcome.label}</p>
          <p className="text-5xl font-mono font-bold text-foreground tabular-nums">{finalScore >= 0 ? "+" : ""}{finalScore}</p>
          <p className="text-xs text-muted-foreground mt-1 font-mono">raw {rawScore >= 0 ? "+" : ""}{rawScore} → normalized −20…+20</p>
        </div>

        <div className="border border-stone-800 bg-card overflow-hidden">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-4 pt-3 pb-2 font-military border-b border-stone-900">// Score Breakdown</p>
          <div className="divide-y divide-stone-900">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm text-foreground">{r.label}</span>
                  <span className="text-xs text-muted-foreground ml-2">{r.detail}</span>
                </div>
                <span className={`font-mono font-semibold tabular-nums text-sm ${r.pts > 0 ? "text-green-600" : r.pts < 0 ? "text-red-600" : "text-zinc-600"}`}>
                  {r.pts >= 0 ? "+" : ""}{r.pts}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="border border-stone-800 bg-card overflow-hidden">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-4 pt-3 pb-2 font-military border-b border-stone-900">// Survivor Status</p>
          <div className="divide-y divide-stone-900">
            {survivors.map((s) => {
              const tag = s.zombie ? { label: "💀 Zombie", cls: "text-red-500"  }
                        : s.dead   ? { label: "✕ Dead",   cls: "text-zinc-600" }
                        : { label: `▶ Alive · ${s.satiety}`, cls: "text-green-600" };
              const diet = !s.dead && !s.zombie
                ? [s.fedBasic && "Basic", s.fedProtein && "Protein", s.fedExpired && "Expired"].filter(Boolean).join(", ") || "—"
                : "—";
              return (
                <div key={s.id} className="flex items-center justify-between px-4 py-2.5 gap-4">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-foreground font-military">{s.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">ate: {diet}</span>
                  </div>
                  <span className={`text-xs font-semibold shrink-0 ${tag.cls}`}>{tag.label}</span>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

function ChoiceModal({ choice, inventory }: { choice: PendingChoice; inventory: Record<FoodType, FoodItem> }) {
  const yesDisabled = (choice.yesRequiresBasic ?? 0) > 0 && inventory.basic.count < (choice.yesRequiresBasic ?? 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm">
      <div
        className="w-full max-w-sm mx-4 border border-red-900/80 bg-card p-6 shadow-2xl flex flex-col gap-5"
        style={{ boxShadow: "0 0 50px rgba(130,0,0,0.3)" }}
      >
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] uppercase tracking-widest text-red-700 font-military">⚠ Decision required</p>
          <p className="font-military text-2xl text-foreground leading-tight uppercase tracking-wide">{choice.prompt}</p>
          {choice.detail && (
            <p className="text-sm text-muted-foreground leading-snug">{choice.detail}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <button
            disabled={yesDisabled}
            onClick={!yesDisabled ? choice.onYes : undefined}
            className={`w-full border font-semibold py-3 px-4 text-sm transition-all uppercase tracking-wide ${
              yesDisabled
                ? "border-zinc-800 bg-zinc-900/20 text-zinc-600 opacity-40 cursor-not-allowed"
                : "border-green-900 bg-green-950/40 text-green-500 hover:bg-green-950/70 cursor-pointer"
            }`}
          >
            {choice.yesLabel}
            {yesDisabled && <span className="ml-2 normal-case font-normal text-xs opacity-70">— not enough Basic</span>}
          </button>
          <button
            onClick={choice.onNo}
            className="w-full border border-stone-700 bg-stone-900/40 text-stone-400 font-semibold py-3 px-4 text-sm hover:bg-stone-800/60 cursor-pointer transition-all uppercase tracking-wide"
          >
            {choice.noLabel}
          </button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground font-military tracking-widest uppercase">// Timer Paused //</p>
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
    { text: "Isolate: pauses infection timer — cured after 120s (costs 2 Basic, cannot be fed while isolated)" },
    { text: "Medic Treat instantly cures Infection or Sickness — 1× use only" },
    { text: "Sickness: extra −5 satiety every 20s" },
  ];

  return (
    <div className="border border-stone-800 p-4 bg-card flex flex-col gap-3">
      <p className="font-military text-[10px] uppercase tracking-widest text-muted-foreground">// Field Protocols</p>
      <ul className="flex flex-col gap-2">
        {rules.map((r) => (
          <li key={r.text} className="flex items-start gap-2 text-xs text-stone-500 leading-snug">
            <span className="shrink-0 text-red-800 font-bold">▸</span>
            {r.text}
          </li>
        ))}
      </ul>
      <div className="border-t border-stone-900 pt-2.5">
        <p className="text-xs text-stone-600 leading-relaxed italic">
          Survive. Stabilize. Manage risk. Choose wisely.
        </p>
      </div>
    </div>
  );
}

function IntroScreen({ onStart }: { onStart: () => void }) {
  const rules = [
    "Allocate food to keep survivors alive",
    "Satiety decreases over time — feed before it hits zero",
    "Critical survivors become Infected after 30s",
    "Infected survivors turn Zombie after 45s — Isolate to delay, but it does not cure",
    "Medic Treat cures Infection or Sickness — 1× use only for the entire run",
    "Expired food causes Sick — food only half effective while sick",
    "Events will strike resources and survivors",
    "Keep your team alive until extraction arrives",
  ];

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg flex flex-col items-center gap-8">

        <div className="text-center">
          <p className="text-[10px] font-military tracking-[0.4em] text-red-900 uppercase mb-4">☢ CLASSIFIED OPERATION ☢</p>
          <h1
            className="font-military text-7xl tracking-widest text-red-700 uppercase leading-none mb-3"
            style={{ textShadow: "0 0 40px rgba(160,0,0,0.45), 2px 2px 0 rgba(0,0,0,0.9)" }}
          >
            RATION<br />RUSH
          </h1>
          <p className="text-xs text-muted-foreground tracking-widest uppercase font-military">Survive · Feed · Decide</p>
        </div>

        <div className="w-full border border-stone-800 bg-card px-6 py-5">
          <p className="text-[10px] uppercase tracking-widest text-red-800 font-military mb-4">// Operational Briefing</p>
          <ul className="flex flex-col gap-3 list-none">
            {rules.map((rule) => (
              <li key={rule} className="flex items-start gap-3 text-sm text-foreground/80">
                <span className="shrink-0 text-red-800 font-bold mt-0.5">▸</span>
                {rule}
              </li>
            ))}
          </ul>
        </div>

        <button
          onClick={onStart}
          className="px-10 py-4 text-lg font-military uppercase tracking-[0.2em] bg-red-900 text-red-100 border border-red-700 cursor-pointer transition-all hover:bg-red-800 hover:border-red-600"
          style={{ textShadow: "0 0 12px rgba(255,120,120,0.25)" }}
        >
          ▶ Begin Simulation
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
    const isSickTick  = elapsedTime % SICK_DRAIN_INTERVAL === 0;
    setSurvivors((prev) => prev.map((s) => tickSurvivor(s, isDrainTick, isSickTick, drainRateRef.current)));
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
        yesRequiresBasic: choice.yesRequiresBasic,
        onYes: () => {
          choice.applyYes(setInventory, setScore, setSurvivors);
          setPendingChoice(null);
          setPaused(false);
        },
        onNo: () => {
          if (choice.applyNo) choice.applyNo(setInventory, setScore, setSurvivors);
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
      prev.map((s) => (s.id === survivorId && s.infected && !s.isolated ? { ...s, isolated: true, isolationDuration: 0 } : s))
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
          isolationDuration: 0,
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
      {pendingChoice && <ChoiceModal choice={pendingChoice} inventory={inventory} />}
      <div className="w-full max-w-3xl px-4 pt-8">
        <div className="text-center mb-6">
          <p className="text-[10px] font-military uppercase tracking-[0.35em] text-muted-foreground mb-2">⏱ Time Remaining</p>
          <p className={`font-military text-7xl tabular-nums tracking-widest ${
            remainingTime <= 60  ? "text-red-600 timer-danger"
            : remainingTime <= 180 ? "text-red-700"
            : remainingTime <= 300 ? "text-red-900"
            : "text-foreground"
          }`}>
            {formatTime(remainingTime)}
          </p>
          {started && nextAny && (
            <p className="text-xs text-muted-foreground mt-2 font-military uppercase tracking-widest">
              Next {nextAny.isChoice ? <span className="text-red-600 font-semibold">decision</span> : "event"} in{" "}
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {nextAny.time - elapsedTime}s
              </span>
            </p>
          )}
        </div>

        {!started && (
          <div className="flex justify-center mb-6">
            <button
              onClick={startTimer}
              className="px-8 py-3 text-base font-military uppercase tracking-[0.2em] bg-red-900 text-red-100 border border-red-700 cursor-pointer transition-all hover:bg-red-800"
            >
              ▶ Start
            </button>
          </div>
        )}

        {started && (
          <p className="text-center text-xs text-muted-foreground mb-6 font-military tracking-widest uppercase">
            {remainingTime === 0 ? "// Simulation ended //" : "// Active //"}
            {" · "}
            <span className="text-green-700 font-medium">{aliveCount} alive</span>
            {deadCount > 0 && <> · <span className="text-stone-500 font-medium">{deadCount} dead</span></>}
            {zombieCount > 0 && <> · <span className="text-red-700 font-medium">{zombieCount} zombie{zombieCount > 1 ? "s" : ""}</span></>}
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
