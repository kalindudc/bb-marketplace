import { useState } from "react";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { scheduleLabel } from "../../shared/member-schedule";
import type { Member, ScheduleControl } from "../../shared/schema";
import { QueryState } from "./primitives";

function RunTime({ at }: { at: number }) {
  const value = new Date(at);
  return <time dateTime={value.toISOString()}>{value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
}

export function MemberSchedules({ member, controls = false }: { member: Member; controls?: boolean }) {
  const update = experimental_useRpcMutation({ contract: rpcContract, method: "updateMemberSchedule" });
  const [error, setError] = useState<unknown>(null);
  const schedules = member.permanent?.schedules;
  if (!schedules?.length) return null;
  const change = (id: string, action: ScheduleControl["action"]) => {
    setError(null);
    void update.mutate({ threadId: member.threadId, id, action }).catch(setError);
  };
  return <div aria-label="Member schedules">
    <ul className="lg-rows lg-briefs m">{schedules.map(schedule => <li key={schedule.id}>
      <p data-content><b>{scheduleLabel(schedule)}</b> (server time) · {schedule.duty}</p>
      <p>{schedule.paused ? "Paused" : <>Next run: <RunTime at={schedule.nextAt} /> (your time)</>}
        {schedule.lastAt !== undefined && <> · Last admitted: <RunTime at={schedule.lastAt} /></>}</p>
      {controls && <p>{!schedule.paused && <button type="button" className="btn sm" disabled={update.isPending} aria-label={`Pause schedule: ${schedule.duty}`} onClick={() => change(schedule.id, "pause")}>Pause</button>}{" "}
        <button type="button" className="btn sm" disabled={update.isPending} aria-label={`Remove schedule: ${schedule.duty}`} onClick={() => change(schedule.id, "remove")}>Remove</button></p>}
    </li>)}</ul>
    <QueryState error={error} />
  </div>;
}
