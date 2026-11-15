import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { experimental_useRpcQuery, experimental_useSidebarThreads, useRpc, type PluginAppBuilder, type PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { CHARGES, HUES, SHAPES } from "../../shared/schema";
import { useRegistry, memberIdentity } from "../kit";
import { CrestPaths, PlainCrestPaths } from "../kit/crest";
import { bindRpc, clearThreadState } from "./state";
type Setter = NonNullable<PluginContentScriptContext["experimental_setThreadRowStatus"]>;
let setter: Setter | null = null;
const listeners = new Set<() => void>();
function publish(value: Setter | null) { setter = value; listeners.forEach(fn => fn()); }
const iconName = (shape: string, hue: string, charge: string) => `tavern-crest-${shape}-${hue}-${charge}`;
function crestIcon(shape: typeof SHAPES[number], hue: typeof HUES[number], charge: typeof CHARGES[number]): ComponentType<{
    className?: string;
}> {
    return function RowCrest({ className }) {
        return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><CrestPaths shape={shape} hue={hue} charge={charge} size={14} /></svg>;
    };
}
const plainIconName = (shape: string) => `tavern-crest-${shape}-plain`;
function plainCrestIcon(shape: typeof SHAPES[number]): ComponentType<{ className?: string }> {
    return function RowPlainCrest({ className }) {
        return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><PlainCrestPaths shape={shape} size={14} /></svg>;
    };
}
function RowBatch({ ids, write }: {
    ids: string[];
    write: Setter;
}) {
    const query = experimental_useRpcQuery({ contract: rpcContract, method: "crests", input: { threadIds: ids } });
    const registry = useRegistry();
    useEffect(() => {
        const marked: string[] = [];
        if (query.data && registry.data)
            for (const crest of query.data.crests) {
                const identity = memberIdentity(registry.data, crest);
                if (identity) {
                    write(crest.threadId, { icon: identity.character.plain ? plainIconName(identity.cls.shape) : iconName(identity.cls.shape, identity.character.hue, identity.character.charge), label: crest.label });
                    marked.push(crest.threadId);
                }
            }
        return () => marked.forEach(id => write(id, null));
    }, [query.data, registry.data, write]);
    return null;
}
function RowOverlay() {
    const threads = experimental_useSidebarThreads();
    const rpc = useRpc<typeof rpcContract>();
    const write = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => setter, () => null);
    useEffect(() => { bindRpc(rpc); return clearThreadState; }, [rpc]);
    const ids = threads.threads.map(t => t.id);
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 500)
        batches.push(ids.slice(i, i + 500));
    return write ? <>{batches.map((batch, i) => <RowBatch key={i} ids={batch} write={write}/>)}</> : null;
}
export function registerRowCrests(app: PluginAppBuilder) {
    for (const shape of SHAPES)
        app.experimental_icons.register({ name: plainIconName(shape), component: plainCrestIcon(shape) });
    for (const shape of SHAPES)
        for (const hue of HUES)
            for (const charge of CHARGES)
                app.experimental_icons.register({ name: iconName(shape, hue, charge), component: crestIcon(shape, hue, charge) });
    app.contentScripts.register({ id: "tavern-row-crests", mount(context) { const next = context.experimental_setThreadRowStatus ?? null; publish(next); return () => { if (setter === next)
            publish(null); }; } });
    app.slots.experimental_appOverlay({ id: "tavern-row-crests", component: RowOverlay });
}
