import { html, nothing, type TemplateResult } from "lit";
import { Users, ChevronRight } from "lucide";
import { api } from "./core-bridge.ts";
import { icon } from "./ui.ts";

interface SwarmPeer {
  id: string;
  parentId?: string;
  sessionId?: string;
  sessionUrl?: string;
  state: "reserved" | "ready" | "failed";
  control?: "paused" | "stopped";
  depth: number;
}

interface SwarmView {
  id: string;
  self: SwarmPeer;
  peers: SwarmPeer[];
  board?: { sandboxId: string };
  expiresAt: number;
}

type Control = "active" | "paused" | "stopped";

function peerStatus(peer: SwarmPeer): string {
  return peer.control ?? (peer.state === "ready" ? "active" : peer.state);
}

export function createSwarmStrip(redraw: () => void) {
  const ui = { sessionId: "", view: null as SwarmView | null, open: false, busy: "", error: "" };
  const load = async (sessionId: string): Promise<void> => {
    const view = await api<SwarmView>(`/api/sessions/${encodeURIComponent(sessionId)}/swarm`).catch(() => null);
    if (ui.sessionId !== sessionId) return;
    ui.view = Array.isArray(view?.peers) ? view : null;
    redraw();
  };
  const control = async (memberId: string, state: Control): Promise<void> => {
    const sessionId = ui.sessionId;
    ui.busy = memberId;
    ui.error = "";
    redraw();
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/swarm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "control", memberId, state }),
      });
    } catch (error) {
      ui.error = error instanceof Error ? error.message : "Could not update the worker.";
    } finally {
      ui.busy = "";
      await load(sessionId);
    }
  };
  const row = (peer: SwarmPeer, self: SwarmPeer): TemplateResult => {
    const status = peerStatus(peer);
    const controllable = peer.depth > 0 && peer.control !== "stopped" && peer.id !== self.id;
    const busy = ui.busy === peer.id;
    const name = peer.depth === 0 ? "Root session" : `Worker ${peer.id.slice(0, 8)}`;
    const label = peer.sessionUrl ? html`<a href=${peer.sessionUrl}>${name}</a>` : name;
    return html`<div class="bg-row swarm-peer">
      <div class="bg-row-head static">
        <span class="bg-row-cmd">${label}</span>
        <span class="bg-row-meta">${status}</span>
        ${
          controllable
            ? html`${
                  peer.control === "paused"
                    ? html`<button type="button" ?disabled=${busy} @click=${() => void control(peer.id, "active")}>
                        Resume
                      </button>`
                    : html`<button type="button" ?disabled=${busy} @click=${() => void control(peer.id, "paused")}>
                        Pause
                      </button>`
                }
                <button type="button" ?disabled=${busy} @click=${() => void control(peer.id, "stopped")}>Stop</button>`
            : nothing
        }
      </div>
    </div>`;
  };
  return {
    strip(sessionId: string | null): TemplateResult | typeof nothing {
      if (!sessionId) return nothing;
      if (sessionId !== ui.sessionId) {
        Object.assign(ui, { sessionId, view: null, open: false, error: "" });
        void load(sessionId);
      }
      const view = ui.view;
      if (!view || view.peers.length < 2) return nothing;
      const workers = view.peers.filter((peer) => peer.depth > 0);
      const active = workers.filter((peer) => peerStatus(peer) === "active").length;
      return html`<section class="bg-activity swarm-activity ${ui.open ? "expanded" : ""}">
        <button
          type="button"
          class="bg-activity-strip"
          aria-expanded=${String(ui.open)}
          @click=${() => {
            ui.open = !ui.open;
            if (ui.open) void load(sessionId);
            redraw();
          }}
        >
          ${icon(Users, 13)}<span class="bg-activity-label">Swarm · ${active} of ${workers.length} workers active</span>
          <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
        </button>
        ${
          ui.open
            ? html`<div class="bg-panel" role="region" aria-label="Swarm workers">
                ${ui.error ? html`<div class="bg-panel-note">${ui.error}</div>` : nothing}
                ${
                  view.board
                    ? html`<div class="bg-panel-note">Shared board computer: ${view.board.sandboxId}</div>`
                    : nothing
                }
                ${view.peers.map((peer) => row(peer, view.self))}
              </div>`
            : nothing
        }
      </section>`;
    },
  };
}
