import { createHostPort, type HostPort } from "../../host/client";
import type { TavernRuntime } from "../runtime";
import { SourceCapture } from "./capture";
import { PlacementCarry } from "./carry";
import { PlacementController } from "./controller";
import { PlacementDeliveries } from "./delivery";
import { PlacementProvisioner } from "./provision";
import { PlacementReady } from "./ready";
import type { SourceDiscovery } from "./source-discovery";
import { PlacementStore } from "./store";
import { PlacementTransport } from "./transport";
import { PlacementSubmissions } from "./submission";
import { PlacementForge } from "./forge";
import { PlacementPreservation } from "./preserve";

export class PlacementServices {
  readonly store;
  readonly deliveries;
  readonly provisioner;
  readonly controller;
  private readonly built: {
    host?: HostPort; sources?: SourceDiscovery; capture?: SourceCapture;
    forge?: PlacementForge; transport?: PlacementTransport; carry?: PlacementCarry; ready?: PlacementReady; submissions?: PlacementSubmissions; preserve?: PlacementPreservation;
  } = {};

  constructor(private readonly runtime: TavernRuntime) {
    this.store = new PlacementStore(runtime.keeper.store.db, () => runtime.keeper.now());
    this.deliveries = new PlacementDeliveries(runtime.keeper.store.db, this.store);
    this.provisioner = new PlacementProvisioner(runtime.bb, this.store, runtime.keeper.store);
    this.controller = new PlacementController(runtime, this);
  }

  get forge(): PlacementForge { return this.built.forge ??= new PlacementForge(this.runtime); }
  get host(): HostPort { return this.built.host ??= createHostPort(this.runtime.bb); }
  get sources(): SourceDiscovery { return this.built.sources ??= this.runtime.placementSources(); }
  get capture(): SourceCapture { return this.built.capture ??= new SourceCapture(this.sources, this.host, this.store); }
  get transport(): PlacementTransport { return this.built.transport ??= new PlacementTransport(this.runtime.bb, this.host, this.store); }
  get carry(): PlacementCarry { return this.built.carry ??= new PlacementCarry(this.runtime.bb, this.host, this.store, this.runtime.away); }
  get submissions(): PlacementSubmissions {
    const runtime = this.runtime;
    return this.built.submissions ??= new PlacementSubmissions(runtime.bb, this.host, this.store, runtime.away, runtime.keeper.store, runtime.keeper.journal, this.transport);
  }
  get preserve(): PlacementPreservation {
    const runtime = this.runtime;
    return this.built.preserve ??= new PlacementPreservation(runtime.bb, this.host, this.store, runtime.away, runtime.keeper.store, runtime.keeper.journal, this.transport);
  }
  get ready(): PlacementReady {
    const runtime = this.runtime;
    return this.built.ready ??= new PlacementReady({ bb: runtime.bb, host: this.host, placements: this.store, deliveries: this.deliveries, transport: this.transport, carry: this.carry, scopeForThread: threadId => { if (!runtime.scopes) throw new Error("Tavern scopes are not registered"); return runtime.scopes.api.hostTemplate(threadId); }, changed: threadId => runtime.keeper.changed(threadId), observedHost: host => this.controller.observeHost(host) });
  }
}
