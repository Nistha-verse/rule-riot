import "./styles.css";
import type { RuleDefinition, SimulationResult, SimulationTrace } from "../domain/types.js";
import type { SearchResult } from "../search/types.js";
import { ENGINE_VERSION } from "../version.js";
import { ApiError, createApiClient, type RuleRiotApi } from "./api.js";
import { ArenaView } from "./arena-view.js";
import { campaignChallenges, createSearchRequest, createSimulationRequest, defaultRules, howToPlay, isCampaignLevelUnlocked } from "./model.js";
import { PhysicsArena, type ArenaSnapshot } from "./physics.js";
import { causalChainIds, createTraceCursor, currentTraceEntry, moveTraceCursor, type TraceCursor } from "./trace.js";

type Route = "home" | "campaign" | "play" | "sandbox" | "compiler" | "replay" | "howto";
type Busy = "simulate" | "search" | "verify" | null;
type GameStatus = "ready" | "running" | "won" | "failed";

interface AppState {
  route: Route;
  levelIndex: number;
  gameStatus: GameStatus;
  selectedRuleIds: string[];
  simulation: SimulationResult | null;
  search: SearchResult | null;
  cursor: TraceCursor;
  replayInput: string;
  replayResult: Record<string, unknown> | null;
  physicsSnapshot: ArenaSnapshot | null;
  completedChallenges: string[];
  busy: Busy;
  error: string | null;
}

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("Missing #app root");
const appRoot = root;
const api: RuleRiotApi = createApiClient();
const physics = new PhysicsArena();
let arenaView: ArenaView | undefined;

let state: AppState = {
  route: "home", levelIndex: 0, gameStatus: "ready", selectedRuleIds: defaultRules.slice(0, 4).map((rule) => rule.id),
  simulation: null, search: null, cursor: createTraceCursor(), replayInput: "", replayResult: null,
  physicsSnapshot: null, completedChallenges: loadProgress(), busy: null, error: null,
};

function loadProgress(): string[] {
  try { const value = JSON.parse(localStorage.getItem("rule-riot.completed.v1") ?? "[]") as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}
function saveProgress(id: string): void {
  if (state.completedChallenges.includes(id)) return;
  state.completedChallenges = [...state.completedChallenges, id];
  try { localStorage.setItem("rule-riot.completed.v1", JSON.stringify(state.completedChallenges)); } catch { /* local progress is optional */ }
}
function selectedRules(): RuleDefinition[] { return defaultRules.filter((rule) => state.selectedRuleIds.includes(rule.id)); }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }
function traceForState(): SimulationTrace | null {
  if (state.simulation !== null && state.simulation.status !== "invalid-input") return state.simulation.trace;
  if (state.search?.status === "found" && state.search.discovery !== undefined) return state.search.discovery.simulation;
  return state.cursor.trace;
}
function setState(next: Partial<AppState>): void { state = { ...state, ...next }; render(); }
function setRoute(route: Route): void { if (route !== "play" && state.route === "play") physics.pause(); state = { ...state, route, error: null }; render(); }
function selectRules(ids: string[]): void { state.selectedRuleIds = ids; physics.setRules(selectedRules()); render(); }
function levelRules(): RuleDefinition[] { return campaignChallenges[state.levelIndex]?.rules ?? defaultRules.slice(0, 1); }

function startLevel(index: number): void {
  state = { ...state, route: "play", levelIndex: index, gameStatus: "running", selectedRuleIds: levelRulesFor(index).map((rule) => rule.id), simulation: null, error: null };
  physics.setRules(levelRulesFor(index));
  physics.reset();
  physics.start();
  render();
}
function levelRulesFor(index: number): RuleDefinition[] { return campaignChallenges[index]?.rules ?? defaultRules.slice(0, 1); }
function currentLevelComplete(): void {
  const id = campaignChallenges[state.levelIndex]?.id;
  if (id !== undefined) saveProgress(id);
  physics.pause();
  state.gameStatus = "won";
  render();
}
function evaluateLevel(snapshot: ArenaSnapshot): void {
  if (state.route !== "play" || state.gameStatus !== "running") return;
  const level = campaignChallenges[state.levelIndex];
  if (level?.id === "first-impact" && snapshot.events.some((event) => event.type === "collision")) currentLevelComplete();
  if (level?.id === "chain-reaction" && snapshot.events.some((event) => event.type === "gravity-changed") && snapshot.gravity <= -1) currentLevelComplete();
}

async function runSimulation(): Promise<void> {
  if (state.busy !== null) return;
  setState({ busy: "simulate", error: null });
  try {
    const result = await api.simulate(createSimulationRequest(selectedRules()));
    const trace = result.status === "invalid-input" ? null : result.trace;
    state = { ...state, simulation: result, cursor: createTraceCursor(trace), replayInput: trace === null ? state.replayInput : JSON.stringify(trace, null, 2), busy: null };
    if (trace !== null && trace.termination.reason === "completed") {
      if (trace.entries.some((entry) => entry.event.type === "collision")) saveProgress("first-impact");
      const last = trace.entries.at(-1)?.event.id;
      if (causalChainIds(trace, last).length >= 5) saveProgress("chain-reaction");
    }
  } catch (error) { state = { ...state, busy: null, error: error instanceof Error ? error.message : "Simulation failed" }; }
  render();
}
async function runSearch(): Promise<void> {
  if (state.busy !== null || selectedRules().length === 0) return;
  setState({ busy: "search", error: null });
  try {
    const result = await api.search(createSearchRequest(selectedRules()));
    const trace = result.status === "found" && result.discovery !== undefined ? result.discovery.simulation : null;
    state = { ...state, search: result, cursor: createTraceCursor(trace), replayInput: trace === null ? state.replayInput : JSON.stringify(result, null, 2), busy: null };
    if (result.status === "found") saveProgress("chain-reaction");
  } catch (error) { state = { ...state, busy: null, error: error instanceof Error ? error.message : "Search failed" }; }
  render();
}
async function verifyReplay(): Promise<void> {
  if (state.busy !== null || state.replayInput.trim() === "") return;
  setState({ busy: "verify", error: null });
  try {
    const parsed = JSON.parse(state.replayInput) as unknown;
    const trace = parsed && typeof parsed === "object" && "discovery" in parsed ? (parsed as { discovery?: { simulation?: SimulationTrace } }).discovery?.simulation : undefined;
    const actualTrace = trace ?? (parsed as SimulationTrace);
    const result = await api.verify(parsed);
    state = { ...state, replayResult: result, cursor: createTraceCursor(actualTrace), busy: null };
  } catch (error) { state = { ...state, busy: null, error: error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Replay verification failed" }; }
  render();
}

function navButton(route: Route, label: string): string { return `<button class="nav-button ${state.route === route ? "is-current" : ""}" data-route="${route}">${label}</button>`; }
function shell(content: string, options: { game?: boolean } = {}): string {
  return `<div class="game-shell ${options.game ? "game-screen" : ""}"><header class="topbar"><button class="brand" data-route="home"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>RULE RIOT</strong><small>PHYSICS PLAYGROUND</small></span></button><nav class="main-nav" aria-label="Main navigation">${navButton("home", "Home")}${navButton("campaign", "Campaign")}${navButton("sandbox", "Sandbox")}${navButton("compiler", "Compiler")}${navButton("replay", "Replay")}${navButton("howto", "How to play")}</nav><div class="engine-badge"><span class="pulse-dot"></span><span>RAPIER ONLINE</span></div></header>${content}<footer class="footer"><span>RULE RIOT / MADE FOR CURIOUS COLLISIONS</span><span>Engine ${ENGINE_VERSION} · real computation only</span></footer></div>`;
}
function renderHome(): string {
  return shell(`<main class="home-main"><section class="home-hero"><div class="hero-copy"><span class="section-kicker">A PHYSICS PUZZLE PLAYGROUND</span><h1>Break a law.<br><em>Find a riot.</em></h1><p>Rule Riot is a tactile physics game about discovering chain reactions. Set the laws, make an impact, and follow the evidence.</p><div class="hero-actions"><button class="button button-clay button-large" data-action="play-now">Play now <span>→</span></button><button class="button button-quiet" data-route="howto">How it works</button></div><div class="hero-proof"><span><b>01</b> bodies you can move</span><span><b>02</b> laws to combine</span><span><b>∞</b> honest surprises</span></div></div><div class="hero-swatch"><div class="swatch-label">RULES ARE<br>MATTER</div><div class="hero-orbit orbit-one"></div><div class="hero-orbit orbit-two"></div><div class="hero-object hero-object-blue">α</div><div class="hero-object hero-object-red">β</div><div class="hero-object hero-object-yellow">✦</div><span class="orbit-note note-one">collision</span><span class="orbit-note note-two">heat</span><span class="orbit-note note-three">gravity</span></div></section><section class="home-doors"><button data-route="campaign"><span class="door-number">01</span><b>Campaign</b><small>Learn the laws, one challenge at a time.</small><strong>→</strong></button><button data-route="sandbox"><span class="door-number">02</span><b>Sandbox</b><small>Set up an experiment and see what moves.</small><strong>→</strong></button><button data-route="compiler"><span class="door-number">03</span><b>Surprise Compiler</b><small>Let the real engine search for a chain.</small><strong>→</strong></button></section></main>`);
}
function renderCampaign(): string {
  return shell(`<main class="screen-main"><div class="screen-heading"><div><span class="section-kicker">CAMPAIGN / FIELD NOTES</span><h1>Choose your first experiment.</h1><p>Complete a challenge to unlock the next law book. Progress comes from actual results, not clicks.</p></div><span class="progress-stamp">${state.completedChallenges.length} / ${campaignChallenges.length} COMPLETE</span></div><section class="level-grid">${campaignChallenges.map((level, index) => { const unlocked = isCampaignLevelUnlocked(index, state.completedChallenges); const done = state.completedChallenges.includes(level.id); return `<article class="level-card ${done ? "is-complete" : ""} ${unlocked ? "" : "is-locked"}"><div class="level-top"><span class="level-number">${done ? "✓" : `0${index + 1}`}</span><span class="level-state">${done ? "cleared" : unlocked ? "available" : "locked"}</span></div><span class="section-kicker">${escapeHtml(level.eyebrow)}</span><h2>${escapeHtml(level.title)}</h2><p>${escapeHtml(level.description)}</p><div class="level-objective"><span>OBJECTIVE</span><b>${escapeHtml(level.objective)}</b></div><button class="button ${unlocked ? "button-ink" : "button-quiet"}" data-level="${index}" ${unlocked ? "" : "disabled"}>${done ? "Replay level" : unlocked ? "Play level" : "Complete previous level"} ${unlocked ? "→" : ""}</button></article>`; }).join("")}</section></main>`);
}
function ruleCards(): string { return defaultRules.map((rule) => { const checked = state.selectedRuleIds.includes(rule.id); const effectText = rule.effects.map((effect) => effect.type.replaceAll("-", " ")).join(" + "); return `<label class="rule-card ${checked ? "is-active" : ""}"><input type="checkbox" data-rule-id="${rule.id}" ${checked ? "checked" : ""}/><span class="rule-card-check">${checked ? "✓" : ""}</span><span class="rule-card-copy"><strong>${escapeHtml(rule.name)}</strong><small><b>${escapeHtml(rule.trigger.eventType)}</b> → ${escapeHtml(effectText)}</small></span><span class="rule-card-id">${escapeHtml(rule.id)}</span></label>`; }).join(""); }
function renderArena(title: string, subtitle: string): string {
  const level = campaignChallenges[state.levelIndex];
  const play = state.route === "play";
  return `<main class="arena-screen"><div class="arena-screen-head"><div><span class="section-kicker">${play ? `CAMPAIGN / ${escapeHtml(level?.eyebrow ?? "LEVEL")}` : "SANDBOX / LIVE PHYSICS"}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div><div class="arena-objective"><span>OBJECTIVE</span><b>${play ? escapeHtml(level?.objective ?? "Run the experiment") : "Make your own experiment"}</b></div></div><div class="arena-layout"><section class="arena-stage"><div id="arena-host" class="arena-host"></div><div class="arena-stage-tools"><div class="control-group"><button class="button button-ink" id="physics-toggle">${physics.isRunning() ? "Pause" : "Play"}</button><button class="button button-quiet" id="physics-step">Step</button><button class="button button-quiet" id="physics-reset">Reset</button><button class="button button-clay" id="physics-bump">Bump cores</button>${play ? `<button class="button button-quiet" data-route="campaign">Exit level</button>` : ""}</div><span class="control-note">Fixed 60 Hz · click a body to inspect</span></div><div id="arena-readout" class="arena-readout"></div><div id="selection-note" class="selection-note">Start with Bump Cores, or press Step to reveal the first interaction.</div></section><aside class="arena-rail"><div class="rail-block"><span class="section-kicker">ACTIVE LAWS</span>${play ? levelRules().map((rule) => `<div class="mini-rule"><b>${escapeHtml(rule.name)}</b><small>${escapeHtml(rule.trigger.eventType)} → ${escapeHtml(rule.effects[0]?.type ?? "effect")}</small></div>`).join("") : `<div class="rail-help">${state.selectedRuleIds.length} cards active. Change them below, then run the deterministic Sandbox experiment.</div>`}</div>${play && state.gameStatus !== "running" ? `<div class="game-result ${state.gameStatus === "won" ? "is-won" : "is-failed"}"><strong>${state.gameStatus === "won" ? "Level cleared." : "Experiment paused."}</strong><span>${state.gameStatus === "won" ? "You produced the requested physical event." : "Reset and try a different push."}</span><button class="button button-ink" data-action="retry-level">Retry level</button>${state.gameStatus === "won" && state.levelIndex < campaignChallenges.length - 1 ? `<button class="button button-quiet" data-level="${state.levelIndex + 1}">Next level →</button>` : ""}</div>` : ""}${!play ? `<div class="rail-block"><div class="subhead-row"><h2>Rule cards</h2><span>${state.selectedRuleIds.length} active</span></div>${ruleCards()}<button class="button button-cobalt full-button" data-action="simulate">${state.busy === "simulate" ? "Running…" : "Run backend experiment"}</button></div>` : ""}</aside></div></main>`;
}
function traceRows(trace: SimulationTrace | null): string { if (trace === null) return `<div class="empty-state"><strong>No trace loaded.</strong><p>Run an experiment or paste a recorded result.</p></div>`; return trace.entries.slice(0, 80).map((entry, index) => `<button class="timeline-row${state.cursor.index === index ? " is-selected" : ""}" data-trace-index="${index}"><span class="timeline-index">${String(index + 1).padStart(2, "0")}</span><span class="timeline-event"><b>${escapeHtml(entry.event.type)}</b><small>${escapeHtml(entry.event.parentEventId ? `after ${entry.event.parentEventId}` : "root event")} · ${escapeHtml(entry.matchedRuleIds.join(", ") || "no rule")}</small></span><span class="timeline-step">t${entry.event.step}</span></button>`).join(""); }
function renderCompiler(): string { const raw = state.search; const result = raw?.status === "found" || raw?.status === "no-match" ? raw : null; const discovery = result?.status === "found" && result.discovery ? result.discovery : null; return shell(`<main class="screen-main tool-screen"><div class="screen-heading"><div><span class="section-kicker">SURPRISE COMPILER / BOUNDED SEARCH</span><h1>Let the machine look for the weird part.</h1><p>Every candidate runs through the real deterministic engine. No story is written in advance.</p></div><span class="tool-badge">15 max candidates<br>actual execution</span></div><div class="compiler-grid"><section class="tool-card"><div class="compiler-objective"><b>05</b><div><span class="section-kicker">CURRENT OBJECTIVE</span><h2>Find a five-event causal chain</h2><p>One new entity, gravity at or below −1, completed normally.</p></div></div><div class="subhead-row"><h2>Available laws</h2><span>${state.selectedRuleIds.length} selected</span></div><div class="rule-stack">${ruleCards()}</div><button class="button button-clay full-button" data-action="search" ${state.busy !== null || state.selectedRuleIds.length === 0 ? "disabled" : ""}>${state.busy === "search" ? "Searching…" : "Run Surprise Compiler"}</button>${state.error ? `<div class="error-callout">${escapeHtml(state.error)}</div>` : ""}</section><section class="tool-card result-card"><span class="section-kicker">DISCOVERY RESULT</span>${result ? `<div class="result-banner"><span class="status-chip">${escapeHtml(result.status.replace("-", " "))}</span><strong>${escapeHtml(result.message)}</strong></div><div class="metrics-grid"><div><b>${result.stats.candidatesEvaluated}</b><span>evaluated</span></div><div><b>${result.stats.candidatesGenerated}</b><span>generated</span></div><div><b>${result.stats.simulationsLimitTerminated}</b><span>limited</span></div></div>${discovery ? `<div class="winning-rules"><span class="section-kicker">DISCOVERED LAWS</span><div>${discovery.ruleIds.map((id) => `<span class="rule-pill">${escapeHtml(id)}</span>`).join("")}</div><p class="score-line">Score <strong>${discovery.score.score.toLocaleString()}</strong> · chain ${discovery.score.longestCausalChain} · final gravity ${discovery.simulation.finalState.gravity.toFixed(1)}</p><button class="button button-ink" data-action="try-discovery">Try this result in Sandbox</button></div>` : ""}<div class="result-block"><div class="subhead-row"><h2>Evidence</h2><span>${discovery?.simulation.entries.length ?? 0} events</span></div><div class="timeline">${traceRows(discovery?.simulation ?? null)}</div></div>` : `<div class="empty-state large-empty"><span class="empty-mark">?</span><strong>No search run yet.</strong><p>Choose laws, then ask the compiler to search.</p></div>`}</section></div></main>`); }
function renderReplay(): string { const entry = currentTraceEntry(state.cursor); const result = state.replayResult as { status?: string; message?: string } | null; return shell(`<main class="screen-main tool-screen"><div class="screen-heading"><div><span class="section-kicker">REPLAY / RESULTS</span><h1>Inspect the evidence.</h1><p>Load a trace from Sandbox or Compiler, verify it, then step through its causal events.</p></div><span class="tool-badge">deterministic replay<br>not cryptographic proof</span></div><div class="replay-grid"><section class="tool-card"><label class="field-label" for="replay-input">Recorded JSON</label><textarea id="replay-input" class="trace-input" spellcheck="false" placeholder="Paste a SimulationTrace or SearchResult here">${escapeHtml(state.replayInput)}</textarea><div class="experiment-actions"><button class="button button-ink" data-action="verify" ${state.busy !== null ? "disabled" : ""}>${state.busy === "verify" ? "Verifying…" : "Verify replay"}</button><button class="button button-quiet" data-action="load-latest">Load latest result</button></div>${state.error ? `<div class="error-callout">${escapeHtml(state.error)}</div>` : ""}${result ? `<div class="verification ${result.status === "verified" ? "is-verified" : "is-mismatch"}"><span class="verification-mark">${result.status === "verified" ? "✓" : "!"}</span><div><strong>${escapeHtml(result.message ?? result.status)}</strong><small>${result.status === "verified" ? "Fresh replay matches the recorded final state and event trace." : "Inspect the mismatch before trusting this result."}</small></div></div>` : ""}</section><section class="tool-card"><div class="subhead-row"><h2>Event cursor</h2><span>${entry ? `${state.cursor.index + 1} / ${state.cursor.trace?.entries.length}` : "No trace loaded"}</span></div><div class="cursor-controls"><button class="icon-button" data-cursor="-1">←</button><button class="icon-button" data-cursor="1">→</button>${entry ? `<span class="event-label"><b>${escapeHtml(entry.event.type)}</b><small>${escapeHtml(entry.event.parentEventId ?? "root event")}</small></span>` : ""}</div><div class="timeline">${traceRows(state.cursor.trace)}</div></section></div></main>`); }
function renderHowto(): string { return shell(`<main class="screen-main how-screen"><div class="screen-heading"><div><span class="section-kicker">FIELD GUIDE / HOW TO PLAY</span><h1>Curiosity is the control scheme.</h1><p>No developer knowledge required. Start with Play, then use the tools when you want to understand why the world changed.</p></div></div><section class="how-grid">${howToPlay.map(([title, text]) => `<article class="how-card"><span class="how-number">${escapeHtml(title?.slice(0, 2) ?? "")}</span><h2>${escapeHtml(title?.slice(4) ?? title ?? "")}</h2><p>${escapeHtml(text)}</p></article>`).join("")}<article class="how-card wide"><span class="section-kicker">CONTROLS</span><h2>Pause · Step · Reset · Bump Cores</h2><p>Pause stops the render loop. Step advances one fixed physics timestep. Reset restores the level's starting bodies. Bump Cores applies real impulses to the two core bodies.</p></article></section></main>`); }
function renderApp(): void {
  if (state.route === "home") appRoot.innerHTML = renderHome();
  else if (state.route === "campaign") appRoot.innerHTML = renderCampaign();
  else if (state.route === "play") appRoot.innerHTML = shell(renderArena(campaignChallenges[state.levelIndex]?.title ?? "Level", campaignChallenges[state.levelIndex]?.description ?? "Play the level."), { game: true });
  else if (state.route === "sandbox") appRoot.innerHTML = shell(renderArena("Make the laws collide", "A free experiment with real Rapier bodies above and the deterministic backend below."), { game: true });
  else if (state.route === "compiler") appRoot.innerHTML = renderCompiler();
  else appRoot.innerHTML = state.route === "replay" ? renderReplay() : renderHowto();
  bind();
  updateArenaReadout();
}
function bind(): void {
  document.querySelectorAll<HTMLElement>("[data-route]").forEach((element) => element.onclick = () => setRoute(element.dataset.route as Route));
  document.querySelectorAll<HTMLInputElement>("[data-rule-id]").forEach((input) => input.onchange = () => selectRules([...document.querySelectorAll<HTMLInputElement>("[data-rule-id]:checked")].map((item) => item.dataset.ruleId!).filter(Boolean)));
  document.querySelectorAll<HTMLButtonElement>("[data-level]").forEach((button) => button.onclick = () => { const index = Number(button.dataset.level); if (state.route === "campaign" || state.gameStatus === "won") startLevel(index); });
  document.querySelector<HTMLButtonElement>("[data-action=play-now]")?.addEventListener("click", () => startLevel(0));
  document.querySelector<HTMLButtonElement>("[data-action=retry-level]")?.addEventListener("click", () => startLevel(state.levelIndex));
  document.querySelector<HTMLButtonElement>("[data-action=simulate]")?.addEventListener("click", () => { void runSimulation(); });
  document.querySelector<HTMLButtonElement>("[data-action=search]")?.addEventListener("click", () => { void runSearch(); });
  document.querySelector<HTMLButtonElement>("[data-action=verify]")?.addEventListener("click", () => { const textarea = document.querySelector<HTMLTextAreaElement>("#replay-input"); if (textarea) state.replayInput = textarea.value; void verifyReplay(); });
  document.querySelector<HTMLButtonElement>("[data-action=load-latest]")?.addEventListener("click", () => { const trace = traceForState(); if (trace) { state.replayInput = JSON.stringify(trace, null, 2); state.cursor = createTraceCursor(trace); render(); } });
  document.querySelector<HTMLButtonElement>("[data-action=try-discovery]")?.addEventListener("click", () => { const discovery = state.search?.status === "found" ? state.search.discovery : undefined; if (discovery) { selectRules(discovery.ruleIds); setRoute("sandbox"); } });
  document.querySelectorAll<HTMLButtonElement>("[data-trace-index]").forEach((button) => button.onclick = () => { state.cursor = { trace: state.cursor.trace, index: Number(button.dataset.traceIndex) }; render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-cursor]").forEach((button) => button.onclick = () => { state.cursor = moveTraceCursor(state.cursor, Number(button.dataset.cursor)); render(); });
  const toggle = document.querySelector<HTMLButtonElement>("#physics-toggle"); toggle?.addEventListener("click", () => { const running = physics.toggle(); toggle.textContent = running ? "Pause" : "Play"; state.gameStatus = running ? "running" : state.gameStatus; });
  document.querySelector<HTMLButtonElement>("#physics-step")?.addEventListener("click", () => { physics.stepOnce(); state.gameStatus = "running"; render(); });
  document.querySelector<HTMLButtonElement>("#physics-reset")?.addEventListener("click", () => { physics.reset(); state.gameStatus = "ready"; render(); });
  document.querySelector<HTMLButtonElement>("#physics-bump")?.addEventListener("click", () => { physics.impulse(); if (state.gameStatus === "ready") state.gameStatus = "running"; });
}
function updateArenaReadout(): void { const status = document.querySelector<HTMLElement>("#arena-status"); if (status) status.textContent = state.physicsSnapshot?.lastEvent?.label ?? "LIVE PHYSICS / FIXED 60HZ"; const readout = document.querySelector<HTMLElement>("#arena-readout"); if (readout) { const snapshot = state.physicsSnapshot; readout.innerHTML = snapshot ? `<span><b>${snapshot.entities.length}</b> bodies</span><span><b>${snapshot.step}</b> steps</span><span><b>${snapshot.gravity.toFixed(1)}</b> gravity</span><span><b>${escapeHtml(snapshot.lastEvent?.type ?? "quiet")}</b> last event</span>` : "<span>Loading the arena…</span>"; } }
function mountArena(): void { const host = document.querySelector<HTMLElement>("#arena-host"); if (!host) return; arenaView?.destroy(); arenaView = new ArenaView(host, physics); arenaView.setSelectHandler((id) => { const note = document.querySelector<HTMLElement>("#selection-note"); if (note) note.textContent = id ? `Selected ${id} · inspect its motion in the arena.` : "Click a body to inspect it."; }); }
async function boot(): Promise<void> { render(); await physics.ready; physics.addUpdateHandler((snapshot) => { state.physicsSnapshot = snapshot; evaluateLevel(snapshot); updateArenaReadout(); }); if (state.route === "play") physics.start(); render(); if (state.route === "play" || state.route === "sandbox") mountArena(); }
const render = (): void => { renderApp(); if (state.route === "play" || state.route === "sandbox") mountArena(); };
void boot();
