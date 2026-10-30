import { useState } from "react";
import { toast } from "sonner";
import { experimental_copyToClipboard, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, ErrorNote, FIELD_CODE } from "../common";
import { messageOf, useShuttleMutation, useShuttleQuery } from "../data";
import { plural } from "../format";

/** Every Shuttle setting as TOML: copy it out, or paste one in and see what changes before applying it. */
export function TransferSection() {
  const exported = useShuttleQuery("exportToml", {});
  const importer = useShuttleMutation("importToml");
  const [shown, setShown] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [toml, setToml] = useState("");
  const [preview, setPreview] = useState<{ toml: string; changes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    if (exported.data === undefined) return;
    if (await experimental_copyToClipboard({ text: exported.data.toml })) toast.success("Copied Shuttle's settings as TOML");
    else toast.error("Could not copy to the clipboard");
  };
  // Import refusals (a TOML that does not parse, an invalid config) stay on the form, next to what was pasted.
  const importToml = async (apply: boolean) => {
    setError(null);
    try {
      return await importer.mutate({ toml, apply });
    } catch (failure) {
      setError(messageOf(failure));
      return null;
    }
  };
  const check = async () => {
    const out = await importToml(false);
    if (out !== null) setPreview({ toml, changes: out.changes });
  };
  const apply = async () => {
    const out = await importToml(true);
    if (out === null) return;
    toast.success(out.changes.length === 0 ? "Nothing to change" : `Imported ${plural(out.changes.length, "change")}`);
    setPreview(null);
    setToml("");
    setPasting(false);
  };
  const close = () => {
    setPasting(false);
    setPreview(null);
    setError(null);
  };
  const current = preview !== null && preview.toml === toml ? preview : null;

  return (
    <div data-section="transfer" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} disabled={exported.data === undefined} onClick={() => void copy()}>
          <Icon name="Copy" className="size-3.5" aria-hidden />
          Copy as TOML
        </button>
        <button type="button" className={BUTTON} onClick={() => (pasting ? close() : setPasting(true))} aria-expanded={pasting}>
          <Icon name="FileText" className="size-3.5" aria-hidden />
          Paste TOML…
        </button>
        <button type="button" className={BUTTON_GHOST} onClick={() => setShown(!shown)} aria-expanded={shown}>
          {shown ? "Hide the TOML" : "Show the TOML"}
        </button>
        <span className="text-xs text-muted-foreground">Pasting shows what changes before it saves.</span>
      </div>
      {exported.error !== null && <ErrorNote>Could not export the settings: {messageOf(exported.error)}</ErrorNote>}
      {shown && exported.data !== undefined && (
        <pre data-toml className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed">{exported.data.toml}</pre>
      )}
      {pasting && (
        <div className="flex flex-col gap-2">
          <textarea aria-label="TOML to import" rows={10} className={`${FIELD_CODE} w-full`} placeholder={"[[server]]\nid = \"github\"\n…"}
            value={toml} onChange={(event) => setToml(event.target.value)} />
          {error !== null && <ErrorNote>{error}</ErrorNote>}
          {current !== null && (
            <div data-import-preview className="rounded-md border border-border bg-background p-3 text-sm">
              {current.changes.length === 0 ? (
                <span className="text-muted-foreground">This TOML matches the settings you have.</span>
              ) : (
                <>
                  <div className="mb-1 text-xs text-muted-foreground">Applying it makes {plural(current.changes.length, "change")}:</div>
                  <ul className="list-disc pl-5">
                    {current.changes.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON_GHOST} onClick={close}>Cancel</button>
            <button type="button" className={BUTTON} disabled={toml.trim() === "" || importer.isPending} onClick={() => void check()}>Preview changes</button>
            <button type="button" className={BUTTON_PRIMARY} disabled={current === null || current.changes.length === 0 || importer.isPending} onClick={() => void apply()}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
