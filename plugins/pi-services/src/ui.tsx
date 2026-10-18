import { experimental_Icon as Icon, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type {
  PluginRpcContract,
  PluginSettingsSectionProps,
  PluginThreadHeaderActionProps,
  StandardSchemaV1,
  StandardSchemaV1Result,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import type {
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
} satisfies PluginRpcContract;

/** Settings page: pi executable and model selection knobs. */
export function PiServicesSettingsSection(_props: PluginSettingsSectionProps) {
  const state = useSettings();
  const rpc = useRpc<typeof FRONTEND_RPC>();
  const [draftExecutable, setDraftExecutable] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storedExecutable = String(state.values?.executable ?? "pi");
  const storedModel = String(state.values?.model ?? "");
  const executable = draftExecutable ?? storedExecutable;
  const model = draftModel ?? storedModel;

  const save = async (field: "executable" | "model", value: string) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call(
        "updateSettings",
        field === "executable" ? { executable: value || null } : { model: value || null },
      );
      if (field === "executable") setDraftExecutable(null);
      else setDraftModel(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (state.isLoading || state.values === undefined) {
    return <p className="text-sm text-muted-foreground">Loading pi services settings…</p>;
  }

  return (
    <div className="pi-services-settings space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Pi executable</span>
        <input
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          value={executable}
          placeholder="pi"
          disabled={busy}
          onChange={(e) => setDraftExecutable(e.target.value)}
          onBlur={() => {
            if (draftExecutable !== null && draftExecutable !== storedExecutable) {
              void save("executable", draftExecutable);
            }
          }}
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Command or path used to launch the pi CLI from the bb server.
        </span>
      </label>
      <label className="block">
        <span className="text-sm font-medium">Model</span>
        <input
          className="mt-1 w-full rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          value={model}
          placeholder="pi's default model"
          disabled={busy}
          onChange={(e) => setDraftModel(e.target.value)}
          onBlur={() => {
            if (draftModel !== null && draftModel !== storedModel) {
              void save("model", draftModel);
            }
          }}
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Passed to pi --model (for example sonnet:high or provider/model). Empty uses pi's default model.
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
