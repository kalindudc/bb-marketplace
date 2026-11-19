import { experimental_useRpcQuery, useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useRef, useState } from "react";
import { rpcContract, type Room } from "../../shared/contract";
import type { CharacterDef, Member } from "../../shared/schema";
import { voiceShown, CheckIndependence, Crest, GuardPosture, OpensMark, Vocabulary, glowVars, levelFor, levelsShown, plural } from "../kit";
import { Empty, PageButton, SegFilter, StateMark, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { levelFromWins, questsIn, visibleMembers } from "./model";
import { CharacterVoiceForm, VOICE_TAB, useOpenPanelTab } from "./panels";
import { CharacterAvatar } from "../engine/avatar";
import { BubbleLines } from "./bubble-lines";
import { ClassEditForm, useOpenClassEditor } from "./class-editor";
import { ClassFacts, ProjectPick, modelCell, useClassExecutions } from "./class-facts";
import { RecordFold } from "./quest-record";
import { FoldLoad } from "./skeletons";
import { RegistryExport } from "./backup";
import { usePanelState } from "./panel-state";
import { VoiceCheckSummary } from "./voice-check";
import { Level, RecordBrief, ServiceRecord, roleOf, serviceRecordOf } from "./service-record";
import { PresentationProblems, ReportVoices, VoiceSeal, YourCharacter } from "./authorship";
import { TaleList } from "./tales";


function recordOf(members: Member[], characterId: string) {
  const mine = members.filter((m) => m.characterId === characterId);
  const wins = mine.reduce((sum, m) => sum + m.verifiedWins, 0);
  const live = mine.filter((m) => m.state === "working" || m.state === "waiting");
  return { mine, wins, live, level: levelFromWins(wins) };
}


export function CharacterSheets({ registry, room }: { registry: Registry; room: Room }) {
  const navigate = useBbNavigate();
  const members = visibleMembers(room);
  const [cls, setCls] = usePanelState<string>("characters.class", "all", (v) => v === "all" || registry.classes.some((c) => c.id === v));
  const shown = registry.characters.filter((c) => cls === "all" || c.classes.includes(cls));
  const onQuest = registry.characters.filter((c) => recordOf(members, c.id).live.length > 0).length;
  const classCount = new Set(registry.characters.flatMap((c) => c.classes)).size;
  return <div className="tv-sheets">
    <div className="tv-sline">
      <h1 className="tv-hero"><b className="num">{registry.characters.length}</b><span>character sheets <span className="anc">records</span></span></h1>
      <div className="tv-facts"><span>in <b className="num">{classCount}</b> classes</span><span><b className="num">{onQuest}</b> on a quest now</span>{levelsShown(registry) && <span>levels count what each class is trusted for · agents never see levels</span>}</div>
      <RegistryExport kind="character" name="every character sheet" />
    </div>
    <PresentationProblems problems={registry.problems} characters={registry.characters} />
    {registry.classes.length > 1 && <SegFilter label="Filter characters by class" value={cls} onChange={setCls} options={[{ id: "all", label: "All", count: registry.characters.length }, ...registry.classes.filter((c) => registry.characters.some((ch) => ch.classes.includes(c.id))).map((c) => ({ id: c.id, label: c.label, count: registry.characters.filter((ch) => ch.classes.includes(c.id)).length }))]} />}
    <div className="tv-chars">{shown.map((character) => {
      const own = registry.classes.find((c) => character.classes.includes(c.id));
      const rec = recordOf(members, character.id);
      const service = serviceRecordOf(registry, character.id);
      // The kit's one rule; with no records from the server there is no level to show.
      const lv = levelFor(registry, character.id, character.classes[0] ?? "");
      const where = rec.live[0];
      return <button type="button" className="tv-ccard act" key={character.id} onClick={() => navigate.toPluginPanel("tavern", { subPath: `character/${character.id}` })} title={`Open ${character.name}'s character sheet`}>
        {own ? <Crest cls={own} character={character} size={44} level={lv?.level} /> : <span className="tv-crest-missing" style={{ width: 44, height: 44 }} />}
        <span className="tv-cc-id"><b className="tv-cc-n">{character.name}</b><span className="tv-cc-r">{own ? <>{own.label} <span className="anc">{own.plain}</span></> : "No class registered"} · {character.temper}</span>{service !== undefined && levelsShown(registry) && <Level lv={lv} role={roleOf(character.classes)} />}{where ? <><StateMark tone="work">{where.title ?? where.doing ?? "on a quest"}</StateMark><CheckIndependence member={where} /><GuardPosture member={where} /></> : <StateMark tone="wait">at the bar</StateMark>}</span>
        {voiceShown(registry) && <span className="tv-voice tv-cc-v" data-content>{character.lines.row}</span>}
        <span className="tv-cc-rec">{service === undefined ? <><span><b className="num">{rec.mine.length}</b> visible threads</span><span><b className="num">{rec.wins}</b> verified wins</span></> : <RecordBrief record={service} role={roleOf(character.classes)} />}<OpensMark /></span>
      </button>;
    })}</div>
    {!registry.characters.length && <Empty>No characters registered. Define one in ~/.agents/tavern/characters/.</Empty>}
  </div>;
}

export function CharacterSheetEditor({ character, registry, room }: { character: CharacterDef; registry: Registry; room: Room }) {
  const openTab = useOpenPanelTab();
  const [inline, setInline] = useState(false);
  const classes = registry.classes.filter((c) => character.classes.includes(c.id));
  const cls = classes.find(c => c.id === character.classes[0]);
  const rec = recordOf(visibleMembers(room), character.id);
  // An older server sends no record: the sheet then keeps the count it can see, and says so.
  const service = serviceRecordOf(registry, character.id);
  const lv = levelFor(registry, character.id, character.classes[0] ?? "");
  const edit = () => { if (!openTab(VOICE_TAB, { characterId: character.id })) setInline(true); };
  return <div className="tv-sheet">
    <header className="tv-sheet-head tv-card lit" style={glowVars(`sheet:${character.id}`)}>
      <CharacterAvatar character={character} mode={registry.ambientMotion ?? room.ambientMotion ?? "calm"} />
      <div className="tv-sh-t">
        <div className="tv-sheet-name">{cls && <Crest cls={cls} character={character} size={40} level={lv?.level} />}<h1>{character.name}</h1></div>
        <span className="tv-cc-r">{cls ? <>{cls.label} <span className="anc">{cls.plain}</span></> : "No class"} · {character.temper}</span>
        {service !== undefined && levelsShown(registry) && <Level lv={lv} role={roleOf(character.classes)} detail />}
        {service !== undefined && <ServiceRecord record={service} name={character.name} />}
        <PresentationProblems problems={registry.problems} characters={registry.characters} only={character} />
        <div className="tv-facts">{service === undefined && <span><b className="num">{rec.wins}</b> verified wins in visible threads</span>}<YourCharacter authorship={registry.characterAuthorship?.find((a) => a.characterId === character.id)} /><VoiceSeal character={character} />{levelsShown(registry) && <span>Agents never see levels.</span>}<code className="tv-sh-src" title={`~/.agents/tavern/characters/${character.id}.md`}>~/.agents/tavern/characters/{character.id}.md</code></div>
      </div>
      <button type="button" className="btn pri" onClick={edit} aria-expanded={inline || undefined} title="Opens the editor in the side panel, beside this sheet"><PageGlyph name="told" /><span>Edit {character.name}'s voice and avatar</span><OpensMark /></button>
      <RegistryExport kind="character" id={character.id} name={`${character.name}'s sheet`} />
    </header>
    {service !== undefined && <TaleList record={service} characterId={character.id} name={character.name} />}
    {inline && <section className="tv-card tv-inlineform" aria-label={`Edit ${character.name}'s voice`}><CharacterVoiceForm character={character} registry={registry} /><button type="button" className="btn sm" onClick={() => setInline(false)}><span>Hide the editor</span></button></section>}
    <div className="tv-editor tv-card">
      <section className="tv-lens" aria-labelledby="tv-lens-h">
        <div className="tv-zone-h"><PageGlyph name="file" size={16} /><span><b id="tv-lens-h">Lens</b><span className="m">shapes the work · read-only</span></span></div>
        {classes.map((c) => <div key={c.id} className="tv-lens-c"><div className="lbl">{c.label} ({c.plain})</div><pre className="tv-code">{c.body}</pre><PageButton path={`class/${c.id}`} className="ghost sm">View the class</PageButton></div>)}
        {!classes.length && <Empty>No matching class in the registry.</Empty>}
      </section>
      <section className="tv-voiceed" aria-labelledby="tv-voice-h">
        <div className="tv-zone-h"><PageGlyph name="told" size={16} /><span><b id="tv-voice-h">Voice</b><span className="m">presentation only · {character.style}</span></span></div>
        <dl className="tv-preview">{Object.entries(character.lines).map(([slot, line]) => <div key={slot}><dt>{slot}</dt><dd className="tv-voice">{line}</dd></div>)}</dl>
        <BubbleLines says={character.says} />
        {character.quirks.length > 0 && <><div className="lbl" style={{ marginTop: 10 }}>Quirks</div><ul className="tv-li-list">{character.quirks.map((q, i) => <li key={i}><span>{q}</span></li>)}</ul></>}
        <p className="m small" style={{ marginTop: 10 }}>Asks, blockers, findings, evidence and numbers stay plain.</p>
        {!voiceShown(registry) && <p className="m small" data-voice-off>Character voice is off in Settings: agents write plainly, and these lines aren't used.</p>}
        {voiceShown(registry) && <ReportVoices voices={registry.characterReportVoices?.find((v) => v.characterId === character.id)?.voices ?? []} name={character.name} questShort={(id) => questsIn(room).find((q) => q.id === id)?.short ?? service?.records.find((r) => r.questId === id)?.short ?? "a quest"} />}
        <VoiceCheckSummary character={character} />
      </section>
    </div>
  </div>;
}

export function ClassesList({ registry }: { registry: Registry }) {
  const navigate = useBbNavigate();
  const startable = registry.classes.filter((c) => c.startable).length;
  const hireable = registry.classes.filter((c) => c.hireable).length;
  const facts = useClassExecutions();
  /** Fields a project file could change, across every class, while the page has no project. */
  const projectFields = [...new Set((facts.data?.classes ?? []).flatMap((e) => [...e.hire.fields, ...e.start.fields]).filter((f) => f.dependsOnProject).map((f) => f.field))];
  return <div className="tv-classes">
    <div className="tv-sline">
      <h1 className="tv-hero"><b className="num">{registry.classes.length}</b><span>classes <span className="anc">types</span></span></h1>
      <div className="tv-facts"><span><b className="num">{startable}</b> startable</span><span><b className="num">{hireable}</b> hireable</span><span className="tv-facts-long">edit on each class page · files in <code>~/.agents/tavern/classes/</code> and <code>.agents/tavern/classes/</code> override built-ins</span></div>
      <RegistryExport kind="class" name="every class" />
    </div>
    {(projectFields.length > 0 || (facts.project.id && !facts.project.fromThread)) && <ProjectPick project={facts.project} fields={projectFields} />}
    {facts.error && <p className="tv-problem tv-cf-failed" role="alert"><PageGlyph name="fail" /><span>Couldn't load what each class gets, so the Model column shows the class file's model where there is one: {facts.error.message}</span><button type="button" className="btn sm" onClick={() => void facts.refetch()}><span>Try again</span></button></p>}
    <div className="tv-card tv-ctable">
      <div className="tv-ct-row tv-ct-head" aria-hidden="true"><span>Class</span><span>Start</span><span>Hire</span><span>Lens</span><span>Model</span><span>Characters</span><span /></div>
      {registry.classes.map((cls) => {
        const chars = cls.characters.map((id) => registry.characters.find((c) => c.id === id)).filter((c): c is CharacterDef => !!c);
        return <button type="button" key={cls.id} className="tv-ct-row act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `class/${cls.id}` })} title={`Open the ${cls.label} class`}>
          <span className="tv-ct-name"><b>{cls.label}</b> <span className="anc">{cls.plain}</span><span className="tv-ct-src" title={cls.source}>{cls.source}</span></span>
          <span>{cls.startable ? <PageGlyph name="done" className="tv-yes" /> : <span className="m">no</span>}<span className="sr">{cls.startable ? "startable" : "not startable"}</span></span>
          <span>{cls.hireable ? <PageGlyph name="done" className="tv-yes" /> : <span className="m">no</span>}<span className="sr">{cls.hireable ? "hireable" : "not hireable"}</span></span>
          <span className="tv-ct-lens">{cls.description}</span>
          <ModelCell cls={cls} entry={facts.data?.classes.find((e) => e.classId === cls.id)} failure={facts.error?.message ?? null} />
          <span className="tv-ct-chars">{chars.length ? chars.slice(0, 5).map((c) => <Crest key={c.id} cls={cls} character={c} size={20} />) : <span className="m small">drawn at first start</span>}</span>
          <span><OpensMark /></span>
        </button>;
      })}
    </div>
    <p className="tv-never"><PageGlyph name="lock" /><span><b>Never alone, for every class:</b> merge · deploy · production write · send as you · delete. Each needs your explicit OK.</span></p>
  </div>;
}

/** The list's Model column: what a hire runs on as the server resolves it, with the class file's value only until that arrives. */
function ModelCell({ cls, entry, failure }: { cls: Registry["classes"][number]; entry: Parameters<typeof modelCell>[0]; failure: string | null }) {
  const m = modelCell(entry, cls.model ?? null, failure, cls);
  return <span className="tv-ct-model" title={m.title}><span data-content>{m.text}</span>{m.note && <span className="m small"> {m.note.startsWith("(") ? m.note : `· ${m.note}`}</span>}</span>;
}

export function ClassDetail({ id, registry }: { id: string; registry: Registry }) {
  const cls = registry.classes.find((c) => c.id === id);
  if (!cls) return <Empty>Class not found: {id}</Empty>;
  return <ClassDetailView cls={cls} registry={registry} />;
}

function ClassDetailView({ cls, registry }: { cls: Registry["classes"][number]; registry: Registry }) {
  const [inline, setInline] = useState(false);
  const chars = cls.characters.map((cid) => registry.characters.find((c) => c.id === cid)).filter((c): c is CharacterDef => !!c);
  const charLinks = <div className="tv-cd-chars">{chars.map((c) => <PageButton key={c.id} path={`character/${c.id}`} className="ghost sm"><Crest cls={cls} character={c} size={18} /> {c.name}</PageButton>)}</div>;
  const facts = useClassExecutions();
  const entry = facts.data?.classes.find((e) => e.classId === cls.id);
  const opener = useRef<HTMLButtonElement>(null);
  const openEditor = useOpenClassEditor();
  const edit = () => { if (!openEditor(cls.id, cls.label)) setInline(true); };
  return <div className="tv-classd">
    <header className="tv-sheet-head tv-card lit" style={glowVars(`class:${cls.id}`)}>
      {chars[0] ? <Crest cls={cls} character={chars[0]} size={64} level={levelFor(registry, chars[0].id, cls.id)?.level} /> : <PageGlyph name="file" size={32} />}
      <div className="tv-sh-t"><h1>{cls.label} <span className="anc">{cls.plain}</span></h1><p className="tv-cc-r">{cls.description}</p><div className="tv-facts"><span>{cls.startable ? "startable" : "not startable"}</span><span>{cls.hireable ? "hireable" : "not hireable"}</span><span>{plural(chars.length, "character")}</span></div></div>
      <code className="tv-sh-src" title={cls.source}>{cls.source}</code>
      <button type="button" ref={opener} data-class-edit-opener={cls.id} className="btn pri" onClick={edit} aria-expanded={inline || undefined} title="Opens the class editor in the side panel, beside this page"><PageGlyph name="file" /><span>Edit the {cls.label} class</span><OpensMark /></button>
      <RegistryExport kind="class" id={cls.id} name={`the ${cls.label} class`} />
    </header>
    {inline && <section className="tv-card tv-inlineform" aria-label={`Edit the ${cls.label} class`}><ClassEditForm classId={cls.id} registry={registry} focusOnOpen /><button type="button" className="btn sm" onClick={() => { setInline(false); requestAnimationFrame(() => opener.current?.focus()); }}><span>Hide the editor</span></button></section>}
    <div className="tv-ggrid">
      <section className="tv-card tv-cdsec" aria-labelledby="tv-cd-lens"><header className="tv-colh"><h2 id="tv-cd-lens">Role prompt <span className="anc">lens</span></h2></header><pre className="tv-code">{cls.body}</pre></section>
      <aside className="tv-col" aria-label="Model, tools and hiring">
        {entry ? <ClassFacts key={cls.id} entry={entry} registry={registry} label={cls.label} hireable={cls.hireable} startable={cls.startable} project={facts.project} />
          : <RecordFold id={`class:${cls.id}.facts`} title="What it gets" open>{facts.data ? <p className="m small">Tavern has no facts for this class in this project.</p> : <FoldLoad error={facts.error} retry={facts.refetch} label="what it gets" lines={6} />}</RecordFold>}
        <RecordFold id={`class:${cls.id}.hiring`} title="Hiring" count={plural(cls.hires.length, "class")} open={false} preview={<p className="m small">May hire {cls.hires.join(", ") || "nobody"}{cls.greenlight === "explicit" ? <> · staffing needs your OK</> : cls.greenlight ? <> · {cls.greenlight}</> : null}</p>}>
          <dl className="tv-dl"><dt>May hire</dt><dd>{cls.hires.join(", ") || "Nobody"}</dd><dt>Staffing</dt><dd>{cls.greenlight === "explicit" ? <>Explicit <Vocabulary word="map" /></> : cls.greenlight ?? "No staffing policy"}</dd></dl>
          <p className="m small">Consequential actions always need explicit approval. Production commands also need immediate confirmation.</p>
        </RecordFold>
        {chars.length > 0 && <RecordFold id={`class:${cls.id}.characters`} title="Characters" count={plural(chars.length, "character")} open={false} preview={charLinks}>{charLinks}</RecordFold>}
      </aside>
    </div>
  </div>;
}
