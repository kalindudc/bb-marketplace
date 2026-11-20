import type { Waypoint, WaypointState } from "./schema";

export function waypointCheck(waypoint: Pick<Waypoint, "actor" | "check">) {
  return waypoint.check ?? (waypoint.actor === "user" ? "you" : waypoint.actor === "outside" ? "keeper" : "warden");
}

export function resolutionWords(waypoint: Pick<Waypoint, "actor" | "check"> & { state: WaypointState; acceptedBy?: string | null; resolutionReason?: string | null }) {
  const { state, acceptedBy, resolutionReason } = waypoint;
  const word = state === "accepted" ? `accepted by ${acceptedBy ?? "the Keeper"}; no Warden check` :
    state === "done" ? (waypointCheck(waypoint) === "you" ? "done; marked by you" : "done; no check was planned") : state;
  return resolutionReason ? `${word}: ${resolutionReason}` : word;
}

export const verifiedWaypoint = (waypoint: { state: WaypointState }) => waypoint.state === "verified";
export const settled = (waypoint: { state: WaypointState }) =>
  verifiedWaypoint(waypoint) || waypoint.state === "accepted" || waypoint.state === "done" || waypoint.state === "skipped" || waypoint.state === "waived";
