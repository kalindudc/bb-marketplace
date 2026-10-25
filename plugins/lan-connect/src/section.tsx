import { UrlLink, experimental_copyToClipboard, useRealtime, useRpc, type PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LanStatusDto, PairingDto, rpcContract } from "./contract";

// Kept in step with STATUS_CHANNEL in contract.ts; importing its value would bundle zod into the app.
const STATUS_CHANNEL = "lan-connect:status";
const BUTTON =
  "inline-flex cursor-pointer items-center rounded-md border px-3 py-1.5 text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const date = (at: number) => new Date(at).toLocaleString();

function statusLine(status: LanStatusDto): string {
  if (!status.enabled) return "Off. Devices on your network cannot reach bb.";
  if (!status.listening) return "On, but not listening.";
  return `Listening for ${status.scheme.toUpperCase()} on port ${status.port}.`;
}

function Pairing({ pairing }: { pairing: PairingDto }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => setCopied(await experimental_copyToClipboard({ text: pairing.url }));
  return (
    <div className="flex flex-wrap items-start gap-4 rounded-md border p-3">
      <img
        alt="Pairing QR code"
        className="size-40 rounded-md bg-white p-1"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`}
      />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <p>Scan the code with the device, or open the link on it.</p>
        <p className="font-mono text-lg tracking-widest">{`${pairing.code.slice(0, 4)}-${pairing.code.slice(4)}`}</p>
        <p className="break-all">
          <UrlLink href={pairing.url}>{pairing.url}</UrlLink>
        </p>
        <button type="button" className={BUTTON} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <p className="text-xs text-muted-foreground">Works once. Expires at {new Date(pairing.expiresAt).toLocaleTimeString()}.</p>
      </div>
    </div>
  );
}

export function LanSection(_props: PluginSettingsSectionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const [status, setStatus] = useState<LanStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpcRef.current.call("status"));
      setError(null);
    } catch (failure) {
      setError(message(failure));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime(STATUS_CHANNEL, () => {
    void refresh();
  });

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError(null);
      await refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return <p className={error === null ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{error ?? "Loading…"}</p>;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p>{statusLine(status)}</p>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(() => rpcRef.current.call("setEnabled", { enabled: !status.enabled }))}>
          {status.enabled ? "Turn off" : "Turn on LAN access"}
        </button>
      </div>
      {status.error !== null && <p className="text-destructive">{status.error}</p>}
      {error !== null && <p className="text-destructive">{error}</p>}
      {status.listening && (
        <>
          <div className="space-y-1">
            <p className="font-medium">Open bb at</p>
            <ul className="space-y-1">
              {status.urls.map((url) => (
                <li key={url}>
                  <UrlLink href={url}>{url}</UrlLink>
                </li>
              ))}
            </ul>
            {status.scheme === "http" && (
              <p className="text-xs text-muted-foreground">
                This is unencrypted HTTP. Browsers block voice input and clipboard access on it; add a TLS certificate and key to serve HTTPS.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void act(() => rpcRef.current.call("pair"))}>
              Pair a device
            </button>
            {status.pairing !== null && <Pairing pairing={status.pairing} />}
          </div>
        </>
      )}
      <div className="space-y-2">
        <p className="font-medium">Paired devices</p>
        {status.devices.length === 0 ? (
          <p className="text-muted-foreground">No devices are paired.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {status.devices.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className={device.enabled ? "truncate font-medium" : "truncate font-medium text-muted-foreground"}>{device.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {!device.enabled && "LAN access off · "}
                    Paired {date(device.createdAt)} · Last seen {date(device.lastSeenAt)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy}
                    aria-label={`${device.enabled ? "Turn off" : "Turn on"} ${device.name}`}
                    onClick={() => void act(() => rpcRef.current.call("setDeviceEnabled", { deviceId: device.id, enabled: !device.enabled }))}
                  >
                    {device.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy}
                    aria-label={`Revoke ${device.name}`}
                    onClick={() => void act(() => rpcRef.current.call("revoke", { deviceId: device.id }))}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">A paired device can use all of bb, including terminals. Turn a device off to block it until you turn it back on, without pairing it again. Revoke any device you lose.</p>
      </div>
    </div>
  );
}
