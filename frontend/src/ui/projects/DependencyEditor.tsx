import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";

import type { Dependency } from "@bindings/Dependency";
import type { Task } from "@bindings/Task";
import type { TaskId } from "@bindings/TaskId";
import * as project from "@lib/project";
import * as projectOps from "@state/mutations/project";
import { pushToast } from "@state/toast";
import { Combobox } from "@ui/components/Combobox";
import { Select } from "@ui/components/Select";
import { TrashButton } from "@ui/components/TrashButton";
import { PlusIcon } from "@ui/components/icons";

import s from "./DependencyEditor.module.css";

type Dir = project.graph.DepDirection;

interface Props {
  task: Task;
  tasks: Task[];
  deps: Dependency[];
}

interface Row {
  dir: Dir;
  other: Task;
}

const CYCLE_MSG = "That dependency would create a cycle.";

// Inline dependency editor under a selected task. Every row carries its own
// direction + task pickers; edits map to an atomic edge replace that also
// reorders the list so blockers precede their blocked tasks.
export function DependencyEditor({ task, tasks, deps }: Props): JSX.Element {
  const [drafts, setDrafts] = useState<{ key: number; dir: Dir }[]>([]);
  const nextKey = useRef(0);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows: Row[] = [];
  for (const d of deps) {
    if (d.blockedId === task.id) {
      const other = byId.get(d.blockerId);
      if (other) rows.push({ dir: "blockedBy", other });
    } else if (d.blockerId === task.id) {
      const other = byId.get(d.blockedId);
      if (other) rows.push({ dir: "blocks", other });
    }
  }
  rows.sort((a, b) => project.tasks.compareTaskOrder(a.other, b.other));

  const linked = new Set<TaskId>(rows.map((r) => r.other.id));
  const candidates = (keep?: TaskId): Task[] =>
    tasks.filter((t) => t.id !== task.id && (t.id === keep || !linked.has(t.id)));

  function edge(dir: Dir, otherId: TaskId): projectOps.DepKey {
    const e = project.graph.edgeFromDep(dir, task.id, otherId);
    return { blockedId: e.to, blockerId: e.from };
  }

  function setDir(row: Row, dir: Dir): void {
    if (dir === row.dir) return;
    if (!projectOps.replaceDependency(edge(row.dir, row.other.id), edge(dir, row.other.id))) {
      pushToast(CYCLE_MSG, "error");
    }
  }

  function setOther(row: Row, other: Task): void {
    if (other.id === row.other.id) return;
    if (!projectOps.replaceDependency(edge(row.dir, row.other.id), edge(row.dir, other.id))) {
      pushToast(CYCLE_MSG, "error");
    }
  }

  function remove(row: Row): void {
    const e = edge(row.dir, row.other.id);
    projectOps.removeDependency(e.blockedId, e.blockerId);
  }

  function addDraft(): void {
    setDrafts((d) => [...d, { key: nextKey.current++, dir: "blockedBy" }]);
  }

  function dropDraft(key: number): void {
    setDrafts((d) => d.filter((x) => x.key !== key));
  }

  function commitDraft(key: number, dir: Dir, other: Task): void {
    const e = edge(dir, other.id);
    if (projectOps.addDependency(e.blockedId, e.blockerId)) dropDraft(key);
    else pushToast(CYCLE_MSG, "error");
  }

  const dirSelect = (dir: Dir, onChange: (d: Dir) => void): JSX.Element => (
    <Select<Dir>
      class={s.dir!}
      options={[
        { value: "blockedBy", label: "Blocked by" },
        { value: "blocks", label: "Blocking" },
      ]}
      value={dir}
      onChange={onChange}
      ariaLabel="Dependency direction"
    />
  );

  return (
    <div class={s.deps} onClick={(e) => e.stopPropagation()}>
      <span class={s.heading}>Dependencies</span>
      {rows.map((r) => (
        <div key={r.other.id} class={s.row}>
          {dirSelect(r.dir, (d) => setDir(r, d))}
          <Combobox<Task>
            class={s.taskField!}
            valueClass={r.other.completedAt != null ? s.done : undefined}
            items={candidates(r.other.id)}
            value={r.other}
            getKey={(t) => t.id}
            getLabel={(t) => t.name || "Untitled task"}
            onSelect={(t) => {
              if (t) setOther(r, t);
            }}
          />
          <TrashButton onClick={() => remove(r)} label="Remove dependency" />
        </div>
      ))}
      {drafts.map((d) => (
        <div key={d.key} class={s.row}>
          {dirSelect(d.dir, (dir) => setDrafts((xs) => xs.map((x) => (x.key === d.key ? { ...x, dir } : x))))}
          <Combobox<Task>
            class={s.taskField!}
            items={candidates()}
            value={null}
            getKey={(t) => t.id}
            getLabel={(t) => t.name || "Untitled task"}
            placeholder={"Select task\u2026"}
            onSelect={(t) => {
              if (t) commitDraft(d.key, d.dir, t);
            }}
          />
          <TrashButton onClick={() => dropDraft(d.key)} label="Discard dependency" />
        </div>
      ))}
      <button type="button" class={s.add} onClick={addDraft}>
        <PlusIcon />
        <span>Add dependency</span>
      </button>
    </div>
  );
}
