// The Spec view: the phase gate when the pending version fills the next phase, else the spec page for the version waiting
// for the human, or the newest one. Rewound, it shows the version in force then and takes no comments.
import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ProjectView } from "../contract";
import { specReviewBlocks } from "../format";
import { BUTTON } from "./common";
import { GateScreen } from "./gate";
import { SpecPage, bbProjectNamesOf } from "./spec-page";

export function SpecView({ view, busy, rewound, requested, onApprove, onTicket, onPlanner }: { view: ProjectView; busy: boolean; rewound: boolean; requested: number | null; onApprove(version: number): void; onTicket(key: string): void; onPlanner?: () => void }) {
  const { spec, overview } = view;
  // The gate is where a phase-filling version is read and approved; the whole spec is one step away and back.
  const [whole, setWhole] = useState(false);
  // A server older than this page sends no gate field at all: that is no gate.
  const gate = rewound || (requested !== null && requested !== view.gate?.version) ? null : (view.gate ?? null);
  if (gate !== null && !whole) return <GateScreen view={view} gate={gate} busy={busy} onApprove={onApprove} onTicket={onTicket} onWholeSpec={() => setWhole(true)} />;
  const lineApproves = view.next?.action?.control === "approve";
  const waiting = specReviewBlocks(view.specReview) ? null : overview.state === "draft" ? spec.version : overview.state === "archived" ? null : spec.pendingVersion;
  const approve = rewound || lineApproves || waiting === null ? null : { version: waiting, label: `Approve v${waiting}`, busy, onApprove: () => onApprove(waiting) };
  const tried = rewound ? spec.version : (requested ?? (overview.state === "draft" ? spec.version : spec.pendingVersion) ?? spec.version);
  return (
    <div className="space-y-3">
      {gate !== null && (
        <p data-back-to-gate className="flex flex-wrap items-center gap-2 text-xs text-[var(--loom-muted)]">
          <button type="button" className={BUTTON} onClick={() => setWhole(false)}>
            <Icon name="ChevronLeft" className="size-3.5" />
            Back to the gate
          </button>
          The whole of v{gate.version}, with what changed since v{gate.inForce}.
        </p>
      )}
      {rewound && (
        <p data-spec-rewound className="text-xs text-[var(--loom-muted)]">
          At this moment, version {spec.version} was the spec in force.
        </p>
      )}
      {!rewound && gate === null && spec.pendingVersion !== null && (
        <p data-spec-pending className="text-xs text-[var(--loom-muted)]">
          v{spec.pendingVersion} waits for your approval; until then the project runs on v{spec.version} and its tickets stay as they are.
        </p>
      )}
      <SpecPage
        slug={overview.slug}
        version={rewound ? spec.version : (requested ?? undefined)}
        readOnly={rewound}
        bbProjectNames={bbProjectNamesOf(view)}
        specReview={view.specReview}
        approve={approve}
        tried={tried}
        inForce={overview.state === "draft" ? null : spec.version}
        {...(onPlanner === undefined ? {} : { onPlanner })}
      />
    </div>
  );
}
