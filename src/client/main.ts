import "./styles.css";
import type { RuleDefinition, SimulationResult, SimulationTrace } from "../domain/types.js";
import type { Discovery, SearchResult } from "../search/types.js";
import { ENGINE_VERSION } from "../version.js";
import { ApiError, createApiClient, type RuleRiotApi } from "./api.js";
import { ArenaView } from "./arena-view.js";
import { campaignChallenges, createSearchRequest, createSimulationRequest, createInitialWorld, defaultRules } from "./model.js";
import { PhysicsArena, type ArenaSnapshot } from "./physics.js";
import { causalChainIds, createTraceCursor, currentTraceEntry, moveTraceCursor, type TraceCursor } from "./trace.js";

type Route = "campaign" | "sandbox" | "compiler" | "replay";

interface AppState {
  route: Route;
  selectedRuleIds: string[];
  simulation: SimulationResult | null;
  search: SearchResult | null;
  cursor: TraceCursor;
  replayInput: string;
  replayResult: Record<string, unknown> | null;
  selectedEntity: string | null;
  physicsSnapshot: ArenaSnapshot | null;
  completedChallenges: string[];
  busy: "simulate" | "search" | "verify" | null;
  error: string | null;
}

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("Missing #app root");
const appRoot: HTMLElement = root;

const api: RuleRiotApi = createApiClient();
const physics = new PhysicsArena();
let arenaView: ArenaView;
let state: AppState = {
  route: "campaign",
  selectedRuleIds: defaultRules.slice(0, 4).map((rule) => rule.id),
  simulation: null,
  search: null,
  cursor: createTraceCursor(),
  replayInput: "",
  replayResult: null,
  selectedEntity: null,
  physicsSnapshot: null,
  completedChallenges: loadProgress(),
  busy: null,
  error: null,
};

function loadProgress(): string[] {
  try {
    const value = localStorage.getItem("rule-riot.completed.v1");
    const parsed = value === null ? [] : JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function markChallengeComplete(id: string): void {
  if (state.completedChallenges.includes(id)) return;
  state.completedChallenges = [...state.completedChallenges, id];
  try { localStorage.setItem("rule-riot.completed.v1", JSON.stringify(state.completedChallenges)); } catch { /* local progress is optional */ }
}

function selectedRules(): RuleDefinition[] {
  return defaultRules.filter((rule) => state.selectedRuleIds.includes(rule.id));
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

function traceForState(): SimulationTrace | null {
  if (state.simulation !== null && state.simulation.status !== "invalid-input") return state.simulation.trace;
  if (state.search?.status === "found" && state.search.discovery !== undefined) return state.search.discovery.simulation;
  return null;
}

function setRoute(route: Route): void {
  state = { ...state, route, error: null };
  render();
}

function setRules(ids: string[]): void {
  state.selectedRuleIds = ids;
  physics.setRules(selectedRules());
  render();
}

async function runSimulation(): Promise<void> {
  if (state.busy !== null) return;
  state = { ...state, busy: "simulate", error: null };
  render();
  try {
    const result = await api.simulate(createSimulationRequest(selectedRules()));
    const trace = result.status === "invalid-input" ? null : result.trace;
    state = { ...state, simulation: result, cursor: createTraceCursor(trace), replayInput: trace === null ? state.replayInput : JSON.stringify(trace, null, 2), busy: null };
    if (trace !== null && trace.termination.reason === "completed") {
      if (trace.entries.some((entry) => entry.event.type === "collision")) markChallengeComplete("first-impact");
      const lastEvent = trace.entries.at(-1)?.event.id;
      if (causalChainIds(trace, lastEvent).length >= 5) markChallengeComplete("chain-reaction");
    }
  } catch (error) {
    state = { ...state, busy: null, error: error instanceof Error ? error.message : "Simulation failed" };
  }
  render();
}

async function runSearch(): Promise<void> {
  if (state.busy !== null || selectedRules().length === 0) return;
  state = { ...state, busy: "search", error: null };
  render();
  try {
    const result = await api.search(createSearchRequest(selectedRules()));
    const trace = result.status === "found" && result.discovery !== undefined ? result.discovery.simulation : null;
    state = { ...state, search: result, cursor: createTraceCursor(trace), replayInput: trace === null ? state.replayInput : JSON.stringify(result, null, 2), busy: null };
    if (trace !== null && result.status === "found") markChallengeComplete("chain-reaction");
  } catch (error) {
    state = { ...state, busy: null, error: error instanceof Error ? error.message : "Search failed" };
  }
  render();
}

async function verifyReplay(): Promise<void> {
  if (state.busy !== null || state.replayInput.trim().length === 0) return;
  state = { ...state, busy: "verify", error: null };
  render();
  try {
    const parsed = JSON.parse(state.replayInput) as unknown;
    const result = await api.verify(parsed);
    state = { ...state, replayResult: result, busy: null };
  } catch (error) {
    state = { ...state, busy: null, error: error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Replay verification failed" };
  }
  render();
}

function traceRows(trace: SimulationTrace | null): string {
  if (trace === null) return `<div class="empty-state"><span class="empty-mark">+</span><strong>No experiment trace yet.</strong><p>Run an experiment or search for a chain to fill this timeline with real events.</p></div>`;
  return trace.entries.slice(0, 60).map((entry, index) => {
    const selected = state.cursor.index === index ? " is-selected" : "";
    const parent = entry.event.parentEventId === undefined ? "root" : `after ${entry.event.parentEventId}`;
    return `<button class="timeline-row${selected}" data-trace-index="${index}"><span class="timeline-index">${String(index + 1).padStart(2, "0")}</span><span class="timeline-event"><b>${escapeHtml(entry.event.type)}</b><small>${escapeHtml(parent)} · ${escapeHtml(entry.matchedRuleIds.join(", ") || "no rule")}</small></span><span class="timeline-step">t${entry.event.step}</span></button>`;
  }).join("");
}

function ruleCards(mode: "select" | "catalogue" = "select"): string {
  return defaultRules.map((rule) => {
    const checked = state.selectedRuleIds.includes(rule.id);
    const effectText = rule.effects.map((effect) => effect.type.replaceAll("-", " ")).join(" + ");
    return `<label class="rule-card ${checked ? "is-active" : ""}"><input type="checkbox" data-rule-id="${rule.id}" ${checked ? "checked" : ""} ${mode === "catalogue" ? "disabled" : ""}/><span class="rule-card-check" aria-hidden="true">${checked ? "✓" : ""}</span><span class="rule-card-copy"><strong>${escapeHtml(rule.name)}</strong><small><b>${escapeHtml(rule.trigger.eventType)}</b> → ${escapeHtml(effectText)}</small></span><span class="rule-card-id">${escapeHtml(rule.id)}</span></label>`;
  }).join("");
}

function renderCampaign(): string {
  return `<section class="panel-section campaign-panel"><div class="section-kicker">CAMPAIGN / FIELD NOTES</div><h1>Learn the laws by breaking them.</h1><p class="lede">Rule Riot is a physics playground where every surprising result is earned by computation. Start with a collision, then let the compiler find the chain.</p><div class="challenge-list">${campaignChallenges.map((challenge) => `<article class="challenge-card ${state.completedChallenges.includes(challenge.id) ? "is-complete" : ""}"><div class="challenge-number">${state.completedChallenges.includes(challenge.id) ? "✓" : challenge.eyebrow.replace("Lesson ", "")}</div><div><div class="section-kicker">${escapeHtml(challenge.eyebrow)}</div><h2>${escapeHtml(challenge.title)}</h2><p>${escapeHtml(challenge.description)}</p><small class="objective-note">Objective: ${escapeHtml(challenge.objective)}</small><div class="challenge-actions"><button class="button button-ink" data-challenge="${challenge.id}">${state.completedChallenges.includes(challenge.id) ? "Replay challenge" : "Try challenge"}</button><button class="button button-quiet" data-challenge-compiler="${challenge.id}">Find the chain</button></div></div></article>`).join("")}</div><div class="how-it-works"><span class="stamp">HOW IT WORKS</span><ol><li><b>Choose laws</b><span>Pick cards that describe the world.</span></li><li><b>Run an experiment</b><span>Watch actual bodies collide in the arena.</span></li><li><b>Find the surprise</b><span>Ask the compiler to search combinations.</span></li></ol></div></section>`;
}

function renderSandbox(): string {
  const result = state.simulation;
  const status = result === null ? "READY FOR AN EXPERIMENT" : result.status === "invalid-input" ? "INPUT NEEDS ATTENTION" : result.termination.reason.toUpperCase();
  return `<section class="panel-section"><div class="section-kicker">SANDBOX / DIRECT EXPERIMENT</div><div class="panel-title-row"><div><h1>Change a law. Watch the world answer.</h1><p class="lede">This panel calls the deterministic backend. The live arena above is a separate Rapier playground for tactile testing.</p></div><span class="status-chip ${result?.status === "completed" ? "status-good" : ""}">${status}</span></div><div class="rule-stack"><div class="subhead-row"><h2>Rule cards</h2><span>${state.selectedRuleIds.length} active</span></div>${ruleCards()}</div><div class="experiment-actions"><button class="button button-cobalt" data-action="simulate" ${state.busy !== null ? "disabled" : ""}>${state.busy === "simulate" ? "Running…" : "Run experiment"}</button><button class="button button-quiet" data-action="reset-result">Clear result</button></div>${state.error ? `<div class="error-callout">${escapeHtml(state.error)}</div>` : ""}<div class="result-block"><div class="subhead-row"><h2>Event trace</h2>${result && result.status !== "invalid-input" ? `<span>${result.metrics.eventsProcessed} events / ${result.termination.reason}</span>` : ""}</div><div class="timeline">${traceRows(result && result.status !== "invalid-input" ? result.trace : null)}</div></div></section>`;
}

function renderCompiler(): string {
  const rawResult = state.search;
  const result = rawResult?.status === "found" || rawResult?.status === "no-match" ? rawResult : null;
  const discovery = result?.status === "found" && result.discovery !== undefined ? result.discovery : null;
  return `<section class="panel-section"><div class="section-kicker">SURPRISE COMPILER / BOUNDED SEARCH</div><h1>Let the machine look for the weird part.</h1><p class="lede">Every candidate is run through the real engine. No story is written in advance, and a no-match is a useful answer.</p><div class="compiler-objective"><div class="objective-number">05</div><div><span class="section-kicker">CURRENT OBJECTIVE</span><h2>Find a five-event causal chain</h2><p>At least one new entity, gravity at or below −1, and a normally completed run.</p></div></div><div class="rule-stack"><div class="subhead-row"><h2>Available catalogue</h2><span>${state.selectedRuleIds.length} selected</span></div>${ruleCards()}</div><div class="experiment-actions"><button class="button button-clay" data-action="search" ${state.busy !== null || state.selectedRuleIds.length === 0 ? "disabled" : ""}>${state.busy === "search" ? "Searching…" : "Run Surprise Compiler"}</button><span class="budget-label">Budget: 50 candidates / 50 evaluations</span></div>${state.error ? `<div class="error-callout">${escapeHtml(state.error)}</div>` : ""}${result ? `<div class="search-result ${result.status === "found" ? "is-found" : ""}"><div class="result-banner"><span class="status-chip">${escapeHtml(result.status.replace("-", " "))}</span><strong>${escapeHtml(result.message)}</strong></div><div class="metrics-grid"><div><b>${result.stats.candidatesEvaluated}</b><span>evaluated</span></div><div><b>${result.stats.candidatesGenerated}</b><span>generated</span></div><div><b>${result.stats.simulationsLimitTerminated}</b><span>limited runs</span></div></div>${discovery ? `<div class="winning-rules"><span class="section-kicker">DISCOVERED LAWS</span><div>${discovery.ruleIds.map((id) => `<span class="rule-pill">${escapeHtml(id)}</span>`).join("")}</div><p class="score-line">Score <strong>${discovery.score.score.toLocaleString()}</strong> · chain ${discovery.score.longestCausalChain} · ${discovery.score.entitiesCreated} created · gravity ${discovery.simulation.finalState.gravity.toFixed(1)}</p></div>` : ""}</div>` : ""}<div class="result-block"><div class="subhead-row"><h2>Causal chain</h2>${discovery ? `<span>${discovery.simulation.entries.length} trace entries</span>` : ""}</div><div class="timeline">${traceRows(discovery?.simulation ?? null)}</div></div></section>`;
}

function renderReplay(): string {
  const entry = currentTraceEntry(state.cursor);
  const result = state.replayResult as { status?: string; message?: string; error?: { message?: string } } | null;
  return `<section class="panel-section"><div class="section-kicker">REPLAY INSPECTOR / DETERMINISTIC CHECK</div><h1>Replay the evidence, not the headline.</h1><p class="lede">Paste a trace or a compiler result. The backend reruns the request and compares the recorded state and event sequence.</p><label class="field-label" for="replay-input">Recorded JSON</label><textarea id="replay-input" class="trace-input" spellcheck="false" placeholder="Paste a SimulationTrace or SearchResult here">${escapeHtml(state.replayInput)}</textarea><div class="experiment-actions"><button class="button button-ink" data-action="verify" ${state.busy !== null ? "disabled" : ""}>${state.busy === "verify" ? "Verifying…" : "Verify replay"}</button><button class="button button-quiet" data-action="load-latest">Load latest result</button></div>${state.error ? `<div class="error-callout">${escapeHtml(state.error)}</div>` : ""}${result ? `<div class="verification ${result.status === "verified" ? "is-verified" : "is-mismatch"}"><span class="verification-mark">${result.status === "verified" ? "✓" : "!"}</span><div><strong>${escapeHtml(String(result.message ?? result.error?.message ?? "Replay result"))}</strong><small>${result.status === "verified" ? "The recorded evidence matches a fresh deterministic run." : "The evidence needs inspection before it can be trusted."}</small></div></div>` : ""}<div class="replay-inspector"><div class="subhead-row"><h2>Cursor</h2><span>${entry ? `${state.cursor.index + 1} / ${state.cursor.trace?.entries.length}` : "No trace loaded"}</span></div><div class="cursor-controls"><button class="icon-button" data-cursor="-1" aria-label="Previous event">←</button><button class="icon-button" data-cursor="1" aria-label="Next event">→</button>${entry ? `<span class="event-label"><b>${escapeHtml(entry.event.type)}</b><small>${escapeHtml(entry.event.parentEventId ?? "root event")} · ${escapeHtml(entry.matchedRuleIds.join(", ") || "no rule matched")}</small></span>` : ""}</div><div class="timeline compact">${traceRows(state.cursor.trace)}</div></div></section>`;
}

function renderPanel(): string {
  if (state.route === "campaign") return renderCampaign();
  if (state.route === "sandbox") return renderSandbox();
  if (state.route === "compiler") return renderCompiler();
  return renderReplay();
}

function render(): void {
  const panel = document.querySelector<HTMLElement>("#workbench-panel");
  if (panel !== null) panel.innerHTML = renderPanel();
  document.querySelectorAll<HTMLButtonElement>("[data-route]").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.route === state.route);
  });
  updateArenaReadout();
  bindPanel();
}

function updateArenaReadout(): void {
  const status = document.querySelector<HTMLElement>("#arena-status");
  if (status !== null) status.textContent = state.physicsSnapshot === null ? "WAKING UP RAPier" : state.physicsSnapshot.lastEvent?.label ?? "LIVE PHYSICS / FIXED 60HZ";
  const readout = document.querySelector<HTMLElement>("#arena-readout");
  if (readout !== null) {
    const snapshot = state.physicsSnapshot;
    readout.innerHTML = snapshot === null ? "<span>Loading the arena…</span>" : `<span><b>${snapshot.entities.length}</b> bodies</span><span><b>${snapshot.step}</b> steps</span><span><b>${snapshot.gravity.toFixed(1)}</b> gravity</span><span><b>${snapshot.lastEvent ? escapeHtml(snapshot.lastEvent.type) : "quiet"}</b> last event</span>`;
  }
}

function bindPanel(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-route]").forEach((button) => button.onclick = () => setRoute(button.dataset.route as Route));
  document.querySelectorAll<HTMLInputElement>("[data-rule-id]").forEach((input) => input.onchange = () => setRules([...document.querySelectorAll<HTMLInputElement>("[data-rule-id]:checked")].map((item) => item.dataset.ruleId!).filter(Boolean)));
  document.querySelectorAll<HTMLButtonElement>("[data-trace-index]").forEach((button) => button.onclick = () => { state.cursor = { trace: state.cursor.trace, index: Number(button.dataset.traceIndex) }; render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-cursor]").forEach((button) => button.onclick = () => { state.cursor = moveTraceCursor(state.cursor, Number(button.dataset.cursor)); render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-challenge]").forEach((button) => button.onclick = () => { const challenge = campaignChallenges.find((item) => item.id === button.dataset.challenge); if (challenge) { setRules(challenge.rules.map((rule) => rule.id)); setRoute("sandbox"); } });
  document.querySelectorAll<HTMLButtonElement>("[data-challenge-compiler]").forEach((button) => button.onclick = () => { const challenge = campaignChallenges.find((item) => item.id === button.dataset.challengeCompiler); if (challenge) { setRules(challenge.rules.map((rule) => rule.id)); setRoute("compiler"); } });
  document.querySelector<HTMLButtonElement>("[data-action=simulate]")?.addEventListener("click", () => { void runSimulation(); });
  document.querySelector<HTMLButtonElement>("[data-action=search]")?.addEventListener("click", () => { void runSearch(); });
  document.querySelector<HTMLButtonElement>("[data-action=verify]")?.addEventListener("click", () => { const textarea = document.querySelector<HTMLTextAreaElement>("#replay-input"); if (textarea) state.replayInput = textarea.value; void verifyReplay(); });
  document.querySelector<HTMLButtonElement>("[data-action=load-latest]")?.addEventListener("click", () => { const trace = traceForState(); if (trace) state.replayInput = JSON.stringify(trace, null, 2); render(); });
  document.querySelector<HTMLButtonElement>("[data-action=reset-result]")?.addEventListener("click", () => { state = { ...state, simulation: null, search: null, cursor: createTraceCursor(), error: null }; render(); });
}

function renderShell(): void {
  appRoot.innerHTML = `<div class="game-shell"><header class="topbar"><a class="brand" href="#campaign" data-route="campaign"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>RULE RIOT</strong><small>PHYSICS PLAYGROUND</small></span></a><nav class="main-nav" aria-label="Main navigation"><button data-route="sandbox">Play</button><button data-route="campaign">Campaign</button><button data-route="sandbox">Sandbox</button><button data-route="compiler">Compiler</button><button data-route="replay">Replay</button></nav><div class="engine-badge"><span class="pulse-dot"></span><span>RAPIER ONLINE</span></div></header><main class="app-layout"><section class="arena-column"><div class="arena-heading"><div><span class="section-kicker">LIVE ARENA / LOCAL PHYSICS</span><h2>Make the laws collide.</h2></div><span id="arena-status" class="arena-status">WAKING UP RAPIER</span></div><div id="arena-host" class="arena-host"></div><div class="arena-controls"><div class="control-group"><button class="button button-ink" id="physics-toggle">Pause</button><button class="button button-quiet" id="physics-step">Step</button><button class="button button-quiet" id="physics-reset">Reset</button><button class="button button-clay" id="physics-bump">Bump cores</button></div><div class="control-note">Fixed timestep · bounded bodies · real collision events</div></div><div class="arena-readout" id="arena-readout"></div><div class="selection-note" id="selection-note">Click a body to inspect it.</div></section><aside class="workbench" id="workbench-panel"></aside></main><footer class="footer"><span>RULE RIOT / MADE FOR CURIOUS COLLISIONS</span><span>Engine ${ENGINE_VERSION} · No fabricated outcomes</span></footer></div>`;
  arenaView = new ArenaView(document.querySelector<HTMLElement>("#arena-host")!, physics);
  arenaView.setSelectHandler((id) => { state.selectedEntity = id; const note = document.querySelector<HTMLElement>("#selection-note"); if (note) note.textContent = id ? `Selected ${id} · inspect its motion in the arena.` : "Click a body to inspect it."; });
  document.querySelector<HTMLButtonElement>("#physics-toggle")?.addEventListener("click", (event) => { const running = physics.toggle(); (event.currentTarget as HTMLButtonElement).textContent = running ? "Pause" : "Play"; });
  document.querySelector<HTMLButtonElement>("#physics-step")?.addEventListener("click", () => physics.stepOnce());
  document.querySelector<HTMLButtonElement>("#physics-reset")?.addEventListener("click", () => physics.reset());
  document.querySelector<HTMLButtonElement>("#physics-bump")?.addEventListener("click", () => physics.impulse());
}

async function boot(): Promise<void> {
  renderShell();
  render();
  try {
    await physics.ready;
    physics.setRules(selectedRules());
    state.physicsSnapshot = physics.snapshot();
    physics.start();
    render();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Rapier could not start";
    render();
  }
}

  physics.addUpdateHandler((snapshot) => { state.physicsSnapshot = snapshot; updateArenaReadout(); });
void boot();
