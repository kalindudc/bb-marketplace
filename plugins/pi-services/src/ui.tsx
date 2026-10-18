import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginRpcContract,
  PluginSettingsSectionProps,
  PluginThreadHeaderActionProps,
  StandardSchemaV1,
  StandardSchemaV1Result,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import type {
  GetSettingsInput,
  GetSettingsOutput,
  ListModelsInput,
  ListModelsOutput,
  PiModelInfo,
  RegenerateTitleInput,
  RegenerateTitleOutput,
  UpdateSettingsInput,
  UpdateSettingsOutput,
} from "./rpc-shapes";

/** Type-only schema: the host validates on the server; the client only types the call. */
function schema<T>(): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "pi-services",
      validate: (value) => ({ value: value as T }) as StandardSchemaV1Result<T>,
      types: { input: {} as T, output: {} as T },
    },
  };
}

/** Frontend mirror of PI_SERVICES_RPC (see rpc-shapes.ts); keeps RPC calls typed without zod in the bundle. */
const FRONTEND_RPC = {
  regenerateTitle: {
    input: schema<RegenerateTitleInput>(),
    output: schema<RegenerateTitleOutput>(),
  },
  updateSettings: {
    input: schema<UpdateSettingsInput>(),
    output: schema<UpdateSettingsOutput>(),
  },
  listModels: {
    input: schema<ListModelsInput>(),
    output: schema<ListModelsOutput>(),
  },
  getSettings: {
    input: schema<GetSettingsInput>(),
    output: schema<GetSettingsOutput>(),
  },
} satisfies PluginRpcContract;

/** Settings page: pi executable and a model dropdown populated from pi's own list. */
export function PiServicesSettingsSection(_props: PluginSettingsSectionProps) {
  const rpc = useRpc<typeof FRONTEND_RPC>();
  const [executable, setExecutable] = useState<string>("pi");
  const [model, setModel] = useState<string>("");
  const [models, setModels] = useState<PiModelInfo[] | null>(null);
  const [draftExecutable, setDraftExecutable] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await rpc.call("getSettings", {});
        const list = await rpc.call("listModels", {});
        if (cancelled) return;
        setExecutable(settings.executable);
        setModel(settings.model);
        setModels(list.models);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const save = async (field: "executable" | "model", value: string) => {
    setBusy(true);
    setError(null);
    try {
      const next =
        field === "executable"
          ? await rpc.call("updateSettings", { executable: value || null })
          : await rpc.call("updateSettings", { model: value || null });
      setExecutable(next.executable);
      setModel(next.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const modelsWithDefault: PiModelInfo[] = [
    { id: "", provider: "pi", model: "(pi default)", thinking: false, images: false },
    ...(models ?? []),
  ];

  return (
    <div className="pi-services-settings space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Pi executable</span>
        <input
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          value={draftExecutable ?? executable}
          placeholder="pi"
          disabled={busy}
          onChange={(e) => setDraftExecutable(e.target.value)}
          onBlur={() => {
            if (draftExecutable !== null && draftExecutable !== executable) {
              void save("executable", draftExecutable);
              setDraftExecutable(null);
            }
          }}
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Command or path used to launch the pi CLI from the bb server.
        </span>
      </label>
      <label className="block">
        <span className="text-sm font-medium">Model</span>
        <select
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
          value={model}
          disabled={busy || models === null}
          onChange={(e) => void save("model", e.target.value)}
        >
          {models === null ? (
            <option value={model}>{model || "(pi default)"}</option>
          ) : (
            modelsWithDefault.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === "" ? m.model : `${m.provider} / ${m.model}`}
              </option>
            ))
          )}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">
          Models come from the pi CLI's own list (pi --list-models).
        </span>
      </label>
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Thread header button: regenerates this thread's title with pi. */
export function RegenerateTitleButton({ threadId }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof FRONTEND_RPC>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      aria-label="Regenerate thread title with pi"
      title={failed ? "Regenerate failed — try again" : "Regenerate thread title with pi"}
      disabled={busy}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        setFailed(false);
        try {
          await rpc.call("regenerateTitle", { threadId });
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="RefreshCw" className={busy ? "size-4 animate-spin" : "size-4"} aria-hidden />
    </button>
  );
}
