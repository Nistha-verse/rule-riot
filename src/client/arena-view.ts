import type { ArenaSnapshot, PhysicsArena } from "./physics.js";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./physics.js";

const COLORS = {
  paper: "#f7f0e3",
  ink: "#1f2526",
  cobalt: "#3e5f83",
  clay: "#b94d3c",
  ochre: "#d49a3a",
  sage: "#6d8974",
  muted: "#9c9588",
};

export class ArenaView {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private snapshot: ArenaSnapshot = { step: 0, gravity: 1, ambientHeat: 0, entities: [], lastEvent: null };
  private selectedId: string | null = null;
  private onSelect: ((id: string | null) => void) | undefined;
  private resizeObserver: ResizeObserver | undefined;

  constructor(private readonly host: HTMLElement, private readonly physics: PhysicsArena) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "arena-canvas";
    this.canvas.setAttribute("aria-label", "Live physics arena");
    host.append(this.canvas);
    const context = this.canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context is unavailable");
    this.context = context;
    physics.addUpdateHandler((snapshot) => {
      this.snapshot = snapshot;
      this.draw();
    });
    this.canvas.addEventListener("click", (event) => this.selectAt(event));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  setSelectHandler(handler: (id: string | null) => void): void {
    this.onSelect = handler;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  private worldToScreen(x: number, y: number): { x: number; y: number; scale: number } {
    const rect = this.host.getBoundingClientRect();
    const scale = Math.min(rect.width / WORLD_WIDTH, rect.height / WORLD_HEIGHT);
    return { x: rect.width / 2 + x * scale, y: rect.height / 2 + y * scale, scale };
  }

  private draw(): void {
    const rect = this.host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ctx = this.context;
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, rect.width, rect.height);
    this.drawGrid(rect.width, rect.height);
    const origin = this.worldToScreen(0, 0);
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.strokeStyle = COLORS.ink;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 3;
    ctx.strokeRect(-WORLD_WIDTH * origin.scale / 2, -WORLD_HEIGHT * origin.scale / 2, WORLD_WIDTH * origin.scale, WORLD_HEIGHT * origin.scale);
    ctx.restore();
    for (const entity of this.snapshot.entities) this.drawEntity(entity, origin.scale, rect.width, rect.height);
    this.drawCaption(rect.width, rect.height);
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.context;
    ctx.save();
    ctx.strokeStyle = "#d9cfbd";
    ctx.globalAlpha = 0.48;
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 28) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawEntity(entity: ArenaSnapshot["entities"][number], scale: number, width: number, height: number): void {
    const ctx = this.context;
    const x = width / 2 + entity.x * scale;
    const y = height / 2 + entity.y * scale;
    const radius = (entity.kind === "core" ? 0.48 : entity.kind === "thermal" ? 0.62 : 0.28) * scale;
    const fill = entity.kind === "core" ? COLORS.cobalt : entity.kind === "thermal" ? COLORS.ochre : COLORS.clay;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = fill;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = Math.max(2, scale * 0.06);
    ctx.beginPath();
    if (entity.kind === "core") {
      ctx.moveTo(0, -radius);
      ctx.lineTo(radius * 0.9, -radius * 0.25);
      ctx.lineTo(radius * 0.65, radius * 0.85);
      ctx.lineTo(-radius * 0.65, radius * 0.85);
      ctx.lineTo(-radius * 0.9, -radius * 0.25);
      ctx.closePath();
    } else if (entity.kind === "thermal") {
      for (let index = 0; index < 8; index += 1) {
        const angle = index * Math.PI / 4;
        const point = radius * (index % 2 === 0 ? 1 : 0.78);
        const px = Math.cos(angle) * point;
        const py = Math.sin(angle) * point;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    if (this.selectedId === entity.id) {
      ctx.strokeStyle = COLORS.sage;
      ctx.lineWidth = 4;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, radius + 10, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = COLORS.ink;
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(entity.id, 0, radius + 18);
    ctx.fillStyle = "rgba(31, 37, 38, 0.18)";
    ctx.fillRect(-radius, radius + 4, radius * 2, 4);
    ctx.fillStyle = entity.health > 50 ? COLORS.sage : COLORS.clay;
    ctx.fillRect(-radius, radius + 4, radius * 2 * Math.max(0, entity.health / 100), 4);
    ctx.restore();
  }

  private drawCaption(width: number, height: number): void {
    const ctx = this.context;
    ctx.save();
    ctx.fillStyle = COLORS.ink;
    ctx.font = "700 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(`STEP ${String(this.snapshot.step).padStart(4, "0")}`, 18, height - 18);
    ctx.textAlign = "right";
    ctx.fillText(`G ${this.snapshot.gravity.toFixed(1)}  ·  HEAT ${this.snapshot.ambientHeat.toFixed(1)}`, width - 18, height - 18);
    ctx.restore();
  }

  private selectAt(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const origin = this.worldToScreen(0, 0);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let nearest: { id: string; distance: number } | null = null;
    for (const entity of this.snapshot.entities) {
      const position = this.worldToScreen(entity.x, entity.y);
      const distance = Math.hypot(position.x - x, position.y - y);
      if (distance < Math.min(42, origin.scale) && (nearest === null || distance < nearest.distance)) nearest = { id: entity.id, distance };
    }
    this.selectedId = nearest?.id ?? null;
    this.onSelect?.(this.selectedId);
    this.draw();
  }
}
