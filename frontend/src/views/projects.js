import m from "mithril";
import { api } from "../api.js";
import { Popup, trashIcon } from "../components/popup.js";
import { AutoField } from "../components/autosave.js";
import { ColorPicker } from "../components/color_picker.js";
import { PipPicker } from "../components/pip_picker.js";
import { fuzzyFilter } from "../components/fuzzy.js";
import {
  depEdge,
  DEP_BLOCKED_BY,
  DEP_BLOCKING,
} from "../components/dep_edge.js";
import {
  edgesFromDepsMap,
  partitionByCompletion,
  topoOrder,
  isOrderValid,
  reorderOps,
  dropConflictIds,
  reorderTargetIndex,
  wouldCreateCycle,
  hasCycle,
} from "../components/task_order.js";
import {
  DEFAULT_PROJECT_COLOR,
  paletteColor,
  randomProjectColor,
} from "../palette.js";
import {
  historyState,
  doUndo,
  doRedo,
  onHistoryChange,
} from "../history.js";

// Projects tab and detail subroute both walk the "project" undo/redo stack.
const HISTORY_CONTEXT = "project";

// Module-scoped last-viewed projects route, shared by the always-mounted list and transient detail; in-memory only since a `/projects/:id` can be deleted.
let cachedLastProjectsRoute = "/projects";

// Accept only `/projects` and `/projects/:id`; reject anything else so a bad value can't send the tab off-tab.
function isProjectsRoute(route) {
  return (
    typeof route === "string" &&
    (route === "/projects" || /^\/projects\/\d+$/.test(route))
  );
}

export function loadLastProjectsRoute() {
  return isProjectsRoute(cachedLastProjectsRoute) ? cachedLastProjectsRoute : null;
}

function saveLastProjectsRoute(route) {
  if (!isProjectsRoute(route)) return;
  if (route === cachedLastProjectsRoute) return; // dedup, avoid redraw thrash
  cachedLastProjectsRoute = route;
}

// Undo/redo toolbar control for both Projects views; disabled state reads from the "project" slot only.
function undoRedoControls() {
  const slot = historyState[HISTORY_CONTEXT];
  return m(".row.row-tight", [
    m(
      "button.icon-btn",
      {
        title: "Undo (Ctrl/Cmd+Z)",
        disabled: !slot.can_undo,
        onclick: () => doUndo(HISTORY_CONTEXT),
      },
      m("span.icon.icon-undo")
    ),
    m(
      "button.icon-btn",
      {
        title: "Redo (Ctrl/Cmd+Shift+Z)",
        disabled: !slot.can_redo,
        onclick: () => doRedo(HISTORY_CONTEXT),
      },
      m("span.icon.icon-redo")
    ),
  ]);
}

export const ProjectsList = {
  oninit(vnode) {
    vnode.state.projects = null;
    // `editing` holds the popup's mode and (for edit) the project row; one slot since only one popup opens.
    vnode.state.editing = null;
    // Fuzzy-filter query for the toolbar input; transient, resets on each fresh mount.
    vnode.state.filter = "";
    vnode.state.loading = false;
    // Record the list route only when active, so a deep-link to `/projects/:id` doesn't clobber the detail route.
    if ((m.route.get() || "") === "/projects") saveLastProjectsRoute("/projects");
    this.reload(vnode);
    // Reload after a project-context undo/redo; ignore schedule-context edits to avoid cross-tab refetches.
    vnode.state._unsubHistory = onHistoryChange((ctx) => {
      if (ctx === HISTORY_CONTEXT) this.reload(vnode);
    });
  },
  onupdate() {
    // ProjectsList never unmounts, so onupdate records the list route on return from `/projects/:id` (oninit can't).
    if ((m.route.get() || "") === "/projects") saveLastProjectsRoute("/projects");
  },
  onremove(vnode) {
    if (vnode.state._unsubHistory) vnode.state._unsubHistory();
  },
  reload(vnode) {
    vnode.state.loading = true;
    api.listProjects().then(
      (rows) => {
        vnode.state.projects = rows;
        vnode.state.loading = false;
        m.redraw();
      },
      () => {
        vnode.state.loading = false;
        m.redraw();
      }
    );
  },
  view(vnode) {
    const s = vnode.state;
    if (!s.projects) return null;
    // Filter once across the whole list, then split, so the fuzzy ranker's order stays stable within each partition.
    const filtered = fuzzyFilter(s.projects, s.filter, (p) => p.name);
    const active = filtered.filter((p) => !p.archived_at);
    const archived = filtered.filter((p) => p.archived_at);
    const hasFilter = s.filter.trim() !== "";
    const closeEditing = () => {
      s.editing = null;
      this.reload(vnode);
    };
    return [
      // `.tab-fixed-header` + `.tab-scroll` keep the toolbar pinned while the list scrolls; secondary row carries undo/redo.
      m(".tab-fixed-header", [
        m(".toolbar-row.toolbar-row-primary", [
          m("h2", "Projects"),
          m(".spacer-h"),
          m(
            "button.primary",
            {
              // Open the popup in create mode with a local draft; nothing is POSTed until the user clicks Create.
              onclick: () => {
                s.editing = { mode: "create" };
              },
            },
            m("span.icon.icon-plus"),
            m("span.label", "New project")
          ),
        ]),
        // Secondary row: filter input left, undo/redo right via the shared `[left] .spacer-h [right]` strategy.
        m(".toolbar-row.toolbar-row-secondary", [
          // Wrap the filter input + clear X so the X anchors to the input's right edge; suppressed for whitespace-only queries.
          m(
            ".filter-input",
            m("input", {
              type: "text",
              placeholder: "Filter projects",
              value: s.filter,
              oninput: (e) => {
                s.filter = e.target.value;
              },
            }),
            hasFilter
              ? m(
                  "button.icon-btn.filter-clear",
                  {
                    type: "button",
                    "aria-label": "Clear filter",
                    title: "Clear filter",
                    onclick: (e) => {
                      s.filter = "";
                      // Refocus the input after clearing; the button is a sibling, so walk up to the wrapper.
                      const input = e.currentTarget.parentElement.querySelector(
                        "input"
                      );
                      if (input) input.focus();
                    },
                  },
                  m("span.icon.icon-close")
                )
              : null
          ),
          m(".spacer-h"),
          undoRedoControls(),
        ]),
      ]),
      m(".tab-scroll", [
        m(".list-section", active.map((p) => projectRow(p, vnode, this))),
        archived.length
          ? [
              m("h3", { style: "margin-top:24px" }, "Archived"),
              m(
                ".list-section",
                archived.map((p) => projectRow(p, vnode, this))
              ),
            ]
          : null,
      ]),
      s.editing
        ? m(ProjectPopup, {
            mode: s.editing.mode,
            project: s.editing.project || null,
            onclose: closeEditing,
            ondelete:
              s.editing.mode === "edit"
                ? () =>
                    api.deleteProject(s.editing.project.id).then(closeEditing)
                : undefined,
          })
        : null,
    ];
  },
};

function projectRow(p, vnode, self) {
  const completed = p.completed_tasks != null ? p.completed_tasks : 0;
  const total = p.total_tasks != null ? p.total_tasks : 0;
  // Inline `--block-color` lets the shared `.list-row.project-row` rule paint each row its project color without per-key CSS.
  return m(
    ".list-row.project-row" + (p.archived_at ? ".archived" : ""),
    {
      key: p.id,
      style: { "--block-color": paletteColor(p.color || DEFAULT_PROJECT_COLOR) },
      onclick: (e) => {
        if (e.target.closest("button")) return;
        m.route.set("/projects/" + p.id);
      },
    },
    m("span.name", p.name),
    m(".spacer-h"),
    // `.project-row-trailer` wraps meta + edit together as one unit; at ≤500px it becomes `display: contents` for reordering.
    m(
      ".project-row-trailer",
      m(
        ".project-row-meta",
        // Projects with no tasks suppress the count column; rendering "0 / 0" would just be visual noise.
        total > 0
          ? m(
              "span.project-stat.tasks",
              { title: "Completed / total tasks" },
              m("span.project-stat-label", "Tasks:"),
              m("span.project-stat-value", `${completed} / ${total}`)
            )
          : null,
        m(
          "span.project-stat",
          { title: "Value" },
          m("span.project-stat-label", "Value:"),
          m(PipPicker, {
            value: p.value,
            count: 5,
            color: "lime",
            readonly: true,
            onpick: () => {},
          })
        ),
        m(
          "span.project-stat",
          { title: "Time cost" },
          m("span.project-stat-label", "Time:"),
          m(PipPicker, {
            value: p.time_cost,
            count: 5,
            color: "sky",
            readonly: true,
            onpick: () => {},
          })
        )
      ),
      m(
        "button.icon-btn.project-row-edit",
        {
          title: "Edit",
          onclick: (e) => {
            e.stopPropagation();
            vnode.state.editing = { mode: "edit", project: p };
          },
        },
        m("span.icon.icon-menu-dots")
      )
    )
  );
}

const ProjectPopup = {
  oninit(vnode) {
    // Create mode keeps a local draft until Create; edit mode reads `vnode.attrs.project` directly (autosave-per-field).
    if (vnode.attrs.mode === "create") {
      vnode.state.draft = {
        name: "",
        value: 1,
        time_cost: 1,
        color: randomProjectColor(),
      };
      vnode.state.submitting = false;
    }
  },
  view(vnode) {
    const isCreate = vnode.attrs.mode === "create";
    const p = isCreate ? vnode.state.draft : vnode.attrs.project;

    // Edit mode PATCHes and reconciles, create mode mutates the draft; both update locally so pickers reflect the click immediately.
    const patch = isCreate
      ? (body) => {
          Object.assign(p, body);
          m.redraw();
          return Promise.resolve();
        }
      : (body) => {
          Object.assign(p, body);
          m.redraw();
          return api.patchProject(p.id, body).then((np) => {
            Object.assign(p, np);
            m.redraw();
          });
        };

    // One-shot autofocus on Name in create mode; `_focusedName` guards against re-grabbing focus on later renders.
    const wantsFocus = isCreate && !vnode.state._focusedName;

    const submit = () => {
      if (vnode.state.submitting) return;
      if (p.name.trim() === "") return;
      vnode.state.submitting = true;
      m.redraw();
      api
        .createProject({
          name: p.name,
          value: p.value,
          time_cost: p.time_cost,
          color: p.color,
        })
        .then(
          () => vnode.attrs.onclose(),
          () => {
            vnode.state.submitting = false;
            m.redraw();
          }
        );
    };

    return m(
      Popup,
      {
        title: isCreate ? "New project" : "Project",
        onclose: vnode.attrs.onclose,
        deleteLabel: isCreate ? undefined : "Delete project",
        onDelete: isCreate
          ? undefined
          : () => vnode.attrs.ondelete && vnode.attrs.ondelete(),
        // Bare footer button; `.popup-footer` already right-aligns, so no `.popup-add-row` scaffolding is needed.
        footer: isCreate
          ? m(
              "button.primary",
              {
                onclick: submit,
                disabled: !!vnode.state.submitting || p.name.trim() === "",
                title:
                  p.name.trim() === ""
                    ? "Enter a name to create the project"
                    : "Create this project",
              },
              m("span.label", "Create")
            )
          : null,
      },
      m(
        ".field",
        {
          oncreate: wantsFocus
            ? (vn) => {
                vnode.state._focusedName = true;
                const input = vn.dom.querySelector("input");
                if (!input) return;
                // Defer one frame so the popup's keydown listener lands before we grab focus.
                requestAnimationFrame(() => {
                  input.focus();
                  input.select();
                });
              }
            : undefined,
        },
        [
          m(".field-label", "Name"),
          // Create mode uses a plain input (live draft, no premature save-tick); edit mode keeps AutoField for blur-commit.
          isCreate
            ? m("input", {
                type: "text",
                value: p.name,
                placeholder: "Project name",
                oninput: (e) => {
                  p.name = e.target.value;
                },
              })
            : m(AutoField, {
                value: p.name,
                onsave: (v) => patch({ name: v }),
              }),
        ]
      ),
      m(".field-grid", [
        m(".field", [
          m(".field-label", "Value"),
          m(PipPicker, {
            value: p.value,
            count: 5,
            color: "lime",
            onpick: (v) => patch({ value: v }),
          }),
        ]),
        m(".field", [
          m(".field-label", "Time"),
          m(PipPicker, {
            value: p.time_cost,
            count: 5,
            color: "sky",
            onpick: (v) => patch({ time_cost: v }),
          }),
        ]),
      ]),
      m(".field", [
        m(".field-label", "Color"),
        m(ColorPicker, {
          value: p.color || DEFAULT_PROJECT_COLOR,
          onpick: (key) => patch({ color: key }),
        }),
      ]),
      // Archive toggle is edit-only — a project that doesn't exist yet
      // can't be archived.
      isCreate
        ? null
        : m(".field", [
            m(".field-label", "Status"),
            m(
              "label",
              m("input", {
                type: "checkbox",
                checked: !!p.archived_at,
                onchange: (e) =>
                  api
                    .archiveProject(p.id, { archived: e.target.checked })
                    .then((np) => Object.assign(p, np)),
              }),
              " Archived"
            ),
          ]),
      // Detail-view-only bulk delete, gated on `showDeleteCompleted`; disabled with a tooltip when nothing is completed.
      !isCreate && vnode.attrs.showDeleteCompleted
        ? m(".field", [
            m(
              "button.danger",
              {
                disabled: !vnode.attrs.completedCount,
                title: vnode.attrs.completedCount
                  ? "Permanently delete all completed tasks"
                  : "No completed tasks to delete",
                onclick: () =>
                  vnode.attrs.onDeleteCompleted &&
                  vnode.attrs.onDeleteCompleted(),
              },
              vnode.attrs.completedCount
                ? `Delete all completed tasks (${vnode.attrs.completedCount})`
                : "Delete all completed tasks"
            ),
          ])
        : null
    );
  },
};

export const ProjectDetail = {
  oninit(vnode) {
    vnode.state.project = null;
    vnode.state.tasks = null;
    vnode.state.deps = {}; // task_id -> array of blocker_id
    vnode.state.editingTask = null;
    vnode.state.editingProject = false;
    vnode.state.loading = false;
    // Record this detail route; ProjectDetail is keyed per id (remounts on id change), so oninit suffices.
    saveLastProjectsRoute("/projects/" + vnode.attrs.id);
    this.reload(vnode);
    vnode.state._unsubHistory = onHistoryChange((ctx) => {
      if (ctx === HISTORY_CONTEXT) this.reload(vnode);
    });
  },
  onremove(vnode) {
    if (vnode.state._unsubHistory) vnode.state._unsubHistory();
  },
  reload(vnode) {
    const id = vnode.attrs.id;
    vnode.state.loading = true;
    const done = () => {
      vnode.state.loading = false;
      m.redraw();
    };
    return Promise.all([api.getProject(id), api.listTasks(id)]).then(
      ([p, tasks]) => {
        // Build the deps map locally and swap project+tasks+deps atomically, so a mid-reload redraw never renders tasks against an empty map.
        const deps = {};
        return Promise.all(
          tasks.map((t) =>
            api.listDeps(t.id).then((d) => (deps[t.id] = d))
          )
        ).then(() => {
          vnode.state.project = p;
          vnode.state.tasks = tasks;
          vnode.state.deps = deps;
          done();
        });
      },
      () => done()
    );
  },
  // Repair only violations of the topological invariant (incomplete blockers precede dependents); completed tasks sink and their edges are excluded.
  enforceTopo(vnode) {
    const s = vnode.state;
    if (!s.tasks) return Promise.resolve();
    const completed = new Set(
      s.tasks.filter((t) => t.completed_at).map((t) => t.id)
    );
    const { incomplete } = partitionByCompletion(s.tasks);
    const currentIds = incomplete.map((t) => t.id);
    const edges = edgesFromDepsMap(s.deps, (id) => !completed.has(id));
    if (isOrderValid(currentIds, edges)) return Promise.resolve();
    const ops = reorderOps(currentIds, topoOrder(currentIds, edges));
    if (!ops.length) return Promise.resolve();
    return ops
      .reduce(
        (p, op) => p.then(() => api.reorderTask(op.id, op.afterId)),
        Promise.resolve()
      )
      .then(() => this.reload(vnode));
  },
  reloadThenEnforce(vnode) {
    return this.reload(vnode).then(() => this.enforceTopo(vnode));
  },
  view(vnode) {
    const s = vnode.state;
    if (!s.project || !s.tasks) return null;
    return [
      // Fixed-header + scroll layout keeps the title, stats, and actions pinned while the task list scrolls underneath.
      m(".tab-fixed-header", [
        m(".toolbar-row.toolbar-row-primary.project-detail-head", [
          m(".project-detail-titleblock", [
            m("h2", s.project.name),
            // Read-only value/time pips reuse the project-list row's `.project-stat` markup; editing happens in the edit popup.
            m(".project-detail-stats", [
              m(
                "span.project-stat",
                { title: "Value" },
                m("span.project-stat-label", "Value:"),
                m(PipPicker, {
                  value: s.project.value,
                  count: 5,
                  color: "lime",
                  readonly: true,
                  onpick: () => {},
                })
              ),
              m(
                "span.project-stat",
                { title: "Time cost" },
                m("span.project-stat-label", "Time:"),
                m(PipPicker, {
                  value: s.project.time_cost,
                  count: 5,
                  color: "sky",
                  readonly: true,
                  onpick: () => {},
                })
              ),
            ]),
          ]),
          m(".spacer-h"),
          m(
            "button.primary",
            {
              // Open the popup in create mode with a local draft; the task isn't POSTed until the user clicks Add.
              onclick: () => {
                s.editingTask = { mode: "create" };
              },
            },
            m("span.icon.icon-plus"),
            m("span.label", "Add task")
          ),
          m(
            "button.icon-btn",
            {
              title: "Edit project",
              onclick: () => (s.editingProject = true),
            },
            m("span.icon.icon-menu-dots")
          ),
        ]),
        // Secondary row: Back nav left, undo/redo right via the shared `[left] .spacer-h [right]` strategy.
        m(".toolbar-row.toolbar-row-secondary", [
          m(
            "button",
            { onclick: () => m.route.set("/projects") },
            m("span.icon.icon-chevron-left"),
            m("span.label", "Back to Projects")
          ),
          m(".spacer-h"),
          undoRedoControls(),
        ]),
      ]),
      // While a drag is armed, lock touch-action so a touch drag reorders instead of scrolling.
      m(
        ".tab-scroll" + (s.taskDrag ? ".drag-active" : ""),
        renderTaskList(vnode, this)
      ),
      s.editingProject
        ? m(ProjectPopup, {
            mode: "edit",
            project: s.project,
            onclose: () => {
              s.editingProject = false;
              this.reload(vnode);
            },
            ondelete: () =>
              api.deleteProject(s.project.id).then(() => m.route.set("/projects")),
            // Detail-view-only bulk action; the list and create popup omit this flag.
            showDeleteCompleted: true,
            completedCount: s.tasks.filter((t) => t.completed_at).length,
            // One transactional request, not N parallel deletes that raced SQLite into "database is locked"; one composite undo entry.
            onDeleteCompleted: () =>
              api.deleteCompletedTasks(s.project.id).then(() =>
                this.reload(vnode)
              ),
          })
        : null,
      s.editingTask
        ? m(TaskEditPopup, {
            mode: s.editingTask.mode,
            task: s.editingTask.task || null,
            project: s.project,
            allTasks: s.tasks,
            // Full deps map (taskId → blockerIds) so the popup renders both forward and reverse edges.
            depsMap: s.deps,
            // Closing re-enforces the topological invariant so a new dependent lands below its blockers.
            onclose: () => {
              s.editingTask = null;
              this.reloadThenEnforce(vnode);
            },
            ondelete: () =>
              api.deleteTask(s.editingTask.task.id).then(() => {
                s.editingTask = null;
                this.reload(vnode);
              }),
            // Reload + re-enforce after a dependency change so reverse edges, badges, and order stay consistent.
            onmutated: () => this.reloadThenEnforce(vnode),
          })
        : null,
    ];
  },
};

// Display-time sort only: incomplete tasks first, completed sunk to the bottom; the server order is left unchanged.
function displayTasks(tasks) {
  const { incomplete, completed } = partitionByCompletion(tasks);
  return [...incomplete, ...completed];
}

function renderTaskList(vnode, self) {
  const s = vnode.state;
  const dd = s.taskDrag;
  const display = displayTasks(s.tasks);
  if (!dd || !dd.moved) {
    return m(
      ".list-section",
      display.map((t) => taskRow(t, vnode, self, {}))
    );
  }

  const conflict = new Set(dd.conflictIds || []);
  // Dragged row pulled out and reinserted at targetIndex, clamped within the incomplete zone.
  const order = display.slice();
  const from = order.findIndex((t) => t.id === dd.draggedId);
  const [moved] = order.splice(from, 1);
  order.splice(dd.targetIndex, 0, moved);

  const rows = order.map((t) =>
    t.id === dd.draggedId
      ? taskPlaceholder(dd)
      : taskRow(t, vnode, self, { conflict: conflict.has(t.id) })
  );

  return [m(".list-section", rows), taskGhost(moved, dd, blockedByCount(vnode, moved))];
}

// Count of unfinished tasks blocking `t` (completed blockers are satisfied); drives the "blocked by N" badge.
function blockedByCount(vnode, t) {
  return (vnode.state.deps[t.id] || []).filter((bid) => {
    const blocker = vnode.state.tasks.find((x) => x.id === bid);
    return blocker && !blocker.completed_at;
  }).length;
}

function taskRow(t, vnode, self, opts) {
  const blockedBy = blockedByCount(vnode, t);
  const project = vnode.state.project;
  const cls = [
    t.completed_at ? "completed" : "",
    opts && opts.conflict ? "dep-conflict" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return m(
    ".list-row.task-row",
    {
      key: t.id,
      class: cls,
      // Parent project's palette color drives the shared colored-edge/tint rule (same --block-color the project rows use).
      style: {
        "--block-color": paletteColor(
          (project && project.color) || DEFAULT_PROJECT_COLOR
        ),
      },
      // Drag-start lives on the row body; the gesture layer distinguishes a press-drag from a tap and skips controls.
      onpointerdown: (e) => onRowPointerDown(vnode, self, t, e),
      onclick: (e) => {
        // Swallow the click that trails a mouse drag so it doesn't also
        // open the popup.
        if (vnode.state._suppressTaskClick) {
          vnode.state._suppressTaskClick = false;
          return;
        }
        if (e.target.closest("input,button,a,select,textarea,.task-drag-handle"))
          return;
        vnode.state.editingTask = { mode: "edit", task: t };
      },
    },
    m("input", {
      type: "checkbox",
      checked: !!t.completed_at,
      onchange: (e) => {
        const done = e.target.checked;
        // Optimistic: flip locally so the row re-sorts instantly; the API + reload reconcile the real timestamp.
        t.completed_at = done ? new Date().toISOString() : null;
        m.redraw();
        const fn = done ? api.completeTask : api.uncompleteTask;
        // Re-enforce after reload: un-completing re-activates edges and may reveal a violation; completing only removes constraints.
        fn(t.id).then(
          () => self.reloadThenEnforce(vnode),
          () => self.reload(vnode)
        );
      },
    }),
    m("span.name", t.name),
    // Spacer pushes the badge + handle to the right edge; the row opens via a body tap.
    m(".spacer-h"),
    blockedBy ? m("span.muted.blocked-by", `blocked by ${blockedBy}`) : null,
    // Completed tasks can't be reordered, so they get no handle.
    t.completed_at ? null : dragHandle()
  );
}

// Grab handle: the only reorder affordance on touch; a mouse can also drag the row body.
function dragHandle() {
  return m(
    "span.task-drag-handle",
    { "aria-label": "Drag to reorder", title: "Drag to reorder" },
    m("span.icon.icon-drag-handle")
  );
}

// Dashed slot held open at the dragged row's candidate landing position; no pointer events.
function taskPlaceholder(dd) {
  return m(".list-row.placeholder", {
    key: "task-placeholder",
    style: `height:${dd.height}px`,
  });
}

// Translucent floating copy of the dragged task, fixed-positioned outside the keyed list so reordering rows never disturbs it.
function taskGhost(t, dd, blockedBy) {
  // No key: the ghost is a sibling of the unkeyed `.list-section`, and Mithril forbids mixing keyed/unkeyed siblings.
  return m(
    ".list-row.task-row.dragging",
    {
      style:
        `position:fixed;left:${dd.listLeft}px;width:${dd.listWidth}px;` +
        `height:${dd.height}px;top:${dd.ghostTopAbs}px;` +
        `--block-color:${dd.blockColor};`,
    },
    m("input", { type: "checkbox", checked: !!t.completed_at, disabled: true }),
    m("span.name", t.name),
    m(".spacer-h"),
    blockedBy ? m("span.muted.blocked-by", `blocked by ${blockedBy}`) : null,
    dragHandle()
  );
}

// Drag arms once the pointer moves 5px past the press point, for both mouse and the touch handle.
const DRAG_THRESHOLD_PX = 5;

// Pointerdown starts a gesture, not yet a drag; listeners resolve it into a tap or drag, skipping interactive controls.
function onRowPointerDown(vnode, self, t, e) {
  if (e.button != null && e.button !== 0) return;
  if (e.target.closest("input,button,a,select,textarea")) return;
  // Completed tasks aren't reorderable: no drag arms, but a tap still opens the popup.
  if (t.completed_at) return;
  // Touch reorders only via the handle; a body touch stays free to scroll or tap.
  if (e.pointerType === "touch" && !e.target.closest(".task-drag-handle")) return;
  const rowEl = e.currentTarget;
  const listEl = rowEl.closest(".list-section");
  if (!listEl) return;
  // Suppress text-selection on mouse; a touch on the handle can't scroll (touch-action: none), so nothing to guard.
  if (e.pointerType !== "touch") e.preventDefault();

  const g = {
    self,
    task: t,
    pointerType: e.pointerType,
    startX: e.clientX,
    startY: e.clientY,
    listEl,
    armed: false,
  };
  const move = (ev) => onGestureMove(vnode, ev);
  const up = () => onGestureUp(vnode);
  const key = (ev) => {
    if (ev.key === "Escape") cancelTaskDrag(vnode);
  };
  g._move = move;
  g._up = up;
  g._key = key;
  document.addEventListener("pointermove", move, { passive: false });
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
  document.addEventListener("keydown", key);

  if (e.pointerType === "touch") {
    // Non-passive touchmove: once armed, preventDefault cancels any residual scroll during the drag.
    const touchMove = (ev) => {
      if (vnode.state.taskGesture === g && g.armed && ev.cancelable) {
        ev.preventDefault();
      }
    };
    g._touchMove = touchMove;
    document.addEventListener("touchmove", touchMove, { passive: false });
  }
  vnode.state.taskGesture = g;
}

function onGestureMove(vnode, e) {
  const g = vnode.state.taskGesture;
  if (!g) return;
  if (!g.armed) {
    const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    if (dist < DRAG_THRESHOLD_PX) return;
    armTaskDrag(vnode, g);
  }
  // Armed: drive the preview and suppress scroll / selection.
  e.preventDefault();
  taskDragMove(vnode, e);
}

// Promote the gesture into a drag, snapshotting row geometry once so mid-drag DOM reordering can't feed back into the math.
function armTaskDrag(vnode, g) {
  const rowEls = [...g.listEl.querySelectorAll(".list-row")];
  // DOM rows render in display order, so pair snapshot rects with that order, not the server order.
  const display = displayTasks(vnode.state.tasks);
  const ids = display.map((x) => x.id);
  const rows = rowEls.map((el, i) => {
    const r = el.getBoundingClientRect();
    return { id: ids[i], top: r.top, height: r.height, mid: r.top + r.height / 2 };
  });
  const originalIndex = ids.indexOf(g.task.id);
  if (originalIndex < 0) {
    teardownTaskGesture(g);
    vnode.state.taskGesture = null;
    return;
  }
  const listRect = g.listEl.getBoundingClientRect();
  const myRect = rowEls[originalIndex].getBoundingClientRect();
  const project = vnode.state.project;
  g.armed = true;
  // A mouse drag emits a trailing click, so arm the guard; touch drags emit none.
  if (g.pointerType !== "touch") vnode.state._suppressTaskClick = true;
  // Short haptic tick on touch to confirm the handle drag engaged.
  if (g.pointerType === "touch" && navigator.vibrate) navigator.vibrate(15);
  vnode.state.taskDrag = {
    draggedId: g.task.id,
    rows,
    displayIds: ids,
    // Incomplete count = the boundary the dragged row can't cross; completed rows sit fixed below it.
    incompleteCount: display.filter((x) => !x.completed_at).length,
    originalIndex,
    startY: g.startY,
    height: myRect.height,
    listLeft: listRect.left,
    listWidth: listRect.width,
    ghostTopAbs: myRect.top,
    blockColor: paletteColor(
      (project && project.color) || DEFAULT_PROJECT_COLOR
    ),
    targetIndex: originalIndex,
    afterId: null,
    conflictIds: [],
    invalid: false,
    moved: true,
  };
  m.redraw();
}

function taskDragMove(vnode, e) {
  const dd = vnode.state.taskDrag;
  if (!dd) return;
  // The ghost always tracks the pointer; only the placeholder freezes.
  const deltaY = e.clientY - dd.startY;
  dd.ghostTopAbs = dd.rows[dd.originalIndex].top + deltaY;
  const dirSign = deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0;
  const leadingEdge = dirSign > 0 ? dd.ghostTopAbs + dd.height : dd.ghostTopAbs;
  const mids = dd.rows.map((r) => r.mid);
  let candidateIndex = reorderTargetIndex(
    mids,
    dd.originalIndex,
    leadingEdge,
    dirSign
  );
  // Clamp to the incomplete zone: with the dragged row removed, the last legal slot is `incompleteCount - 1`.
  candidateIndex = Math.min(candidateIndex, dd.incompleteCount - 1);

  // Candidate order at the pointer's current position (display ids snapshot).
  const ids = dd.displayIds.slice();
  ids.splice(dd.originalIndex, 1);
  ids.splice(candidateIndex, 0, dd.draggedId);

  // Completed tasks impose no live ordering constraint, so exclude them from the conflict graph.
  const completed = new Set(
    vnode.state.tasks.filter((x) => x.completed_at).map((x) => x.id)
  );
  const edges = edgesFromDepsMap(vnode.state.deps, (id) => !completed.has(id));
  const conflicts = dropConflictIds(ids, dd.draggedId, edges);

  if (conflicts.length === 0) {
    // Valid: placeholder tracks the pointer and becomes the new last-valid.
    dd.targetIndex = candidateIndex;
    dd.afterId = candidateIndex === 0 ? null : ids[candidateIndex - 1];
    dd.conflictIds = [];
    dd.invalid = false;
  } else {
    // Invalid: freeze the placeholder at the last-valid index, but light up the offending dependency rows.
    dd.conflictIds = conflicts;
    dd.invalid = true;
  }
  m.redraw();
}

function onGestureUp(vnode) {
  const g = vnode.state.taskGesture;
  const dd = vnode.state.taskDrag;
  teardownTaskGesture(g);
  vnode.state.taskGesture = null;
  if (!dd) return; // never armed → a tap; onclick opens the popup
  vnode.state.taskDrag = null;
  const self = g.self;
  // The placeholder only sits at a valid index, so releasing commits `targetIndex`; no-op if unmoved.
  if (dd.targetIndex === dd.originalIndex) {
    m.redraw();
    return;
  }
  // Optimistic reorder: apply the new display order in memory for an instant update, then persist and reconcile on reload.
  const display = displayTasks(vnode.state.tasks);
  const fromIdx = display.findIndex((x) => x.id === dd.draggedId);
  if (fromIdx >= 0) {
    const [movedTask] = display.splice(fromIdx, 1);
    display.splice(dd.targetIndex, 0, movedTask);
    vnode.state.tasks = display;
  }
  m.redraw();
  api
    .reorderTask(dd.draggedId, dd.afterId)
    .then(() => self.reload(vnode))
    .catch((err) => {
      console.error("Reorder task failed:", err);
      self.reload(vnode);
    });
}

function cancelTaskDrag(vnode) {
  const g = vnode.state.taskGesture;
  if (g) teardownTaskGesture(g);
  vnode.state.taskGesture = null;
  vnode.state.taskDrag = null;
  vnode.state._suppressTaskClick = false;
  m.redraw();
}

function teardownTaskGesture(g) {
  if (!g) return;
  document.removeEventListener("pointermove", g._move);
  document.removeEventListener("pointerup", g._up);
  document.removeEventListener("pointercancel", g._up);
  document.removeEventListener("keydown", g._key);
  if (g._touchMove) document.removeEventListener("touchmove", g._touchMove);
}

// Dependency rows for `t`: forward edges render as "Blocked by", reverse edges as "Blocking".
function persistedDepRows(t, depsMap, allTasks) {
  const rows = [];
  for (const blockerId of depsMap[t.id] || []) {
    rows.push({ type: DEP_BLOCKED_BY, otherId: blockerId });
  }
  for (const other of allTasks) {
    if (other.id === t.id) continue;
    if ((depsMap[other.id] || []).includes(t.id)) {
      rows.push({ type: DEP_BLOCKING, otherId: other.id });
    }
  }
  return rows;
}

const TaskEditPopup = {
  oninit(vnode) {
    const isCreate = vnode.attrs.mode === "create";
    if (isCreate) {
      // Local draft until Add; deps staged as { type, otherId } and persisted after creation.
      vnode.state.draft = { name: "", description: "", deps: [] };
      vnode.state.submitting = false;
      vnode.state.descriptionExpanded = false;
      vnode.state.dependenciesExpanded = false;
    } else {
      const t = vnode.attrs.task;
      // Auto-expand the accordions when content already exists behind them.
      vnode.state.descriptionExpanded = !!(
        t.description && t.description.trim()
      );
      vnode.state.dependenciesExpanded =
        persistedDepRows(t, vnode.attrs.depsMap || {}, vnode.attrs.allTasks || [])
          .length > 0;
    }
    // Uncommitted dependency rows the user is mid-adding (edit mode).
    vnode.state.newRows = [];
    vnode.state._newRowSeq = 0;
    // Key of the dep row whose search dropdown is currently open, or null.
    vnode.state.openSearch = null;
    // Transient warning when a pick/flip would form a dependency cycle; cleared on the next valid interaction.
    vnode.state.depWarning = null;
  },
  view(vnode) {
    const isCreate = vnode.attrs.mode === "create";
    const t = isCreate ? vnode.state.draft : vnode.attrs.task;
    const allTasks = vnode.attrs.allTasks || [];
    const depsMap = vnode.attrs.depsMap || {};

    // One-shot autofocus on the Name field in create mode.
    const wantsFocus = isCreate && !vnode.state._focusedName;

    const submit = () => {
      if (vnode.state.submitting) return;
      if (t.name.trim() === "") return;
      vnode.state.submitting = true;
      m.redraw();
      api
        .createTask(vnode.attrs.project.id, {
          name: t.name,
          description: t.description.trim() === "" ? null : t.description,
        })
        .then((nt) =>
          // Persist staged deps now the task has an id, mapping each through `depEdge` like edit mode.
          Promise.all(
            t.deps.map((d) => {
              const e = depEdge(d.type, nt.id, d.otherId);
              return api.addDep(e.blockedId, e.blockerId);
            })
          )
        )
        .then(
          () => vnode.attrs.onclose(),
          () => {
            vnode.state.submitting = false;
            m.redraw();
          }
        );
    };

    // `depEdge` resolves (type, ids) to the stored (blockedId, blockerId) pair so add/remove/flip agree on directionality.
    const refresh = () => vnode.attrs.onmutated && vnode.attrs.onmutated();
    const addEdge = (type, otherId) => {
      const e = depEdge(type, t.id, otherId);
      return api.addDep(e.blockedId, e.blockerId);
    };
    const removeEdge = (type, otherId) => {
      const e = depEdge(type, t.id, otherId);
      return api.removeDep(e.blockedId, e.blockerId);
    };

    // The backend only rejects direct 2-cycles, so this client-side check guards against transitive cycles.
    const existingEdges = edgesFromDepsMap(depsMap);
    // Sentinel node for the not-yet-created task in create mode; never collides with a real numeric id.
    const NEW_NODE = "__new_task__";
    const thisNode = isCreate ? NEW_NODE : t.id;
    const toEdge = (type, otherId, fromId = thisNode) => {
      const e = depEdge(type, fromId, otherId);
      return { from: e.blockerId, to: e.blockedId };
    };
    // Edges contributed by `t`: staged drafts in create mode, nothing extra in edit mode (already in `existingEdges`).
    const ownStagedEdges = () =>
      isCreate ? t.deps.map((d) => toEdge(d.type, d.otherId)) : [];
    // Would adding (type → otherId) on `t` create a cycle anywhere?
    const addWouldCycle = (type, otherId) => {
      const edge = toEdge(type, otherId);
      if (isCreate) {
        return hasCycle([...existingEdges, ...ownStagedEdges(), edge]);
      }
      return wouldCreateCycle(existingEdges, edge);
    };

    const typeSelect = (type, onchange) =>
      m(
        "select",
        { value: type, onchange },
        m("option", { value: DEP_BLOCKED_BY }, "Blocked by"),
        m("option", { value: DEP_BLOCKING }, "Blocking")
      );

    return m(
      Popup,
      {
        title: isCreate ? "New task" : "Task",
        onclose: vnode.attrs.onclose,
        deleteLabel: isCreate ? undefined : "Delete task",
        onDelete: isCreate
          ? undefined
          : () => vnode.attrs.ondelete && vnode.attrs.ondelete(),
        footer: isCreate
          ? m(
              "button.primary",
              {
                onclick: submit,
                // Block creation while the name is missing, a submit is in flight, or staged deps form a cycle.
                disabled:
                  !!vnode.state.submitting ||
                  t.name.trim() === "" ||
                  hasCycle([...existingEdges, ...ownStagedEdges()]),
                title:
                  t.name.trim() === ""
                    ? "Enter a name to add the task"
                    : "Add this task",
              },
              m("span.icon.icon-plus"),
              m("span.label", "Add task")
            )
          : null,
      },
      m(
        ".field",
        {
          oncreate: wantsFocus
            ? (vn) => {
                vnode.state._focusedName = true;
                const input = vn.dom.querySelector("input");
                if (!input) return;
                requestAnimationFrame(() => {
                  input.focus();
                  input.select();
                });
              }
            : undefined,
        },
        [
          m(".field-label", "Name"),
          // Plain input in create mode (live draft, no premature
          // saved-tick); AutoField autosaves in edit mode.
          isCreate
            ? m("input", {
                type: "text",
                value: t.name,
                placeholder: "Task name",
                oninput: (e) => {
                  t.name = e.target.value;
                },
              })
            : m(AutoField, {
                value: t.name,
                onsave: (v) =>
                  api
                    .patchTask(t.id, { name: v })
                    .then((nt) => Object.assign(t, nt)),
              }),
        ]
      ),
      // Description accordion — chevron rotates via `.rotated` when open (shared with the item popup).
      m(".field", [
        m(
          ".field-label.collapsible-label",
          {
            onclick: () => {
              vnode.state.descriptionExpanded =
                !vnode.state.descriptionExpanded;
            },
            role: "button",
            tabindex: 0,
            "aria-expanded": vnode.state.descriptionExpanded
              ? "true"
              : "false",
            onkeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                vnode.state.descriptionExpanded =
                  !vnode.state.descriptionExpanded;
              }
            },
          },
          m("span", "Description"),
          m(
            "span.icon.icon-chevron-right" +
              (vnode.state.descriptionExpanded ? ".rotated" : "")
          )
        ),
        vnode.state.descriptionExpanded
          ? isCreate
            ? m("textarea", {
                value: t.description,
                oninput: (e) => {
                  t.description = e.target.value;
                },
              })
            : m(AutoField, {
                value: t.description || "",
                type: "textarea",
                onsave: (v) =>
                  api
                    .patchTask(t.id, { description: v === "" ? null : v })
                    .then((nt) => Object.assign(t, nt)),
              })
          : null,
      ]),
      // Dependencies accordion: edit mode persists edges immediately, create mode stages them in `draft.deps` and commits after creation.
      (() => {
        // Committed rows: persisted edges (edit) or staged drafts (create), both arrays of { type, otherId }.
        const committed = isCreate
          ? t.deps
          : persistedDepRows(t, depsMap, allTasks);
        // Ids already linked to `t` are filtered from the search so the user can't double-link or pick a direct-cycle target.
        const connected = new Set(committed.map((r) => r.otherId));
        const candidatesFor = (query) =>
          fuzzyFilter(
            allTasks.filter((o) => o.id !== t.id && !connected.has(o.id)),
            query,
            (o) => o.name
          );

        // Typeahead: `onmousedown`+preventDefault fires the pick before the input's blur closes the results list.
        const searchInput = (key, query, onpick) =>
          m(".dep-search", [
            m("input", {
              type: "text",
              placeholder: "Search tasks\u2026",
              value: query,
              onfocus: () => {
                vnode.state.openSearch = key;
              },
              oninput: (e) => {
                const row = vnode.state.newRows.find((r) => r.key === key);
                if (row) row.query = e.target.value;
                vnode.state.openSearch = key;
              },
              onblur: () => {
                setTimeout(() => {
                  if (vnode.state.openSearch === key) {
                    vnode.state.openSearch = null;
                    m.redraw();
                  }
                }, 150);
              },
            }),
            vnode.state.openSearch === key
              ? m(
                  ".menu-items.dep-search-results",
                  candidatesFor(query).map((o) =>
                    m(
                      "button",
                      {
                        type: "button",
                        onmousedown: (e) => {
                          e.preventDefault();
                          onpick(o);
                        },
                      },
                      o.name
                    )
                  )
                )
              : null,
          ]);

        const removeBtn = (onclick) =>
          m(
            "button.icon-btn.dep-remove",
            {
              type: "button",
              "aria-label": "Remove dependency",
              title: "Remove dependency",
              onclick,
            },
            trashIcon()
          );

        // Mode-branched mutators (the only fork between create/edit).
        const commitNewRow = (row, o) => {
          // Reject and warn before staging/sending if the edge would close a cycle.
          if (addWouldCycle(row.type, o.id)) {
            vnode.state.depWarning =
              `Linking "${o.name}" here would create a dependency cycle.`;
            m.redraw();
            return;
          }
          vnode.state.depWarning = null;
          vnode.state.openSearch = null;
          vnode.state.newRows = vnode.state.newRows.filter((r) => r !== row);
          if (isCreate) {
            t.deps.push({ type: row.type, otherId: o.id });
            m.redraw();
          } else {
            // Optimistically write the edge into the live deps map so the committed row replaces the draft in the same frame.
            const e = depEdge(row.type, t.id, o.id);
            const arr = depsMap[e.blockedId] || (depsMap[e.blockedId] = []);
            if (!arr.includes(e.blockerId)) arr.push(e.blockerId);
            m.redraw();
            addEdge(row.type, o.id).then(refresh, refresh);
          }
        };
        const flipCommitted = (row, next) => {
          if (next === row.type) return;
          // Flipping reverses the edge direction and can itself form a cycle; check with the old edge removed.
          if (isCreate) {
            const trial = t.deps.map((r) =>
              r === row ? { type: next, otherId: r.otherId } : r
            );
            const trialEdges = trial.map((d) => toEdge(d.type, d.otherId));
            if (hasCycle([...existingEdges, ...trialEdges])) {
              vnode.state.depWarning =
                "Flipping this dependency would create a cycle.";
              m.redraw();
              return;
            }
            vnode.state.depWarning = null;
            row.type = next;
            m.redraw();
          } else {
            const oldEdge = toEdge(row.type, row.otherId);
            const without = existingEdges.filter(
              (e2) => !(e2.from === oldEdge.from && e2.to === oldEdge.to)
            );
            if (wouldCreateCycle(without, toEdge(next, row.otherId))) {
              vnode.state.depWarning =
                "Flipping this dependency would create a cycle.";
              m.redraw();
              return;
            }
            vnode.state.depWarning = null;
            removeEdge(row.type, row.otherId)
              .then(() => addEdge(next, row.otherId))
              .then(refresh);
          }
        };
        const removeCommitted = (row) => {
          if (isCreate) {
            t.deps = t.deps.filter((r) => r !== row);
            m.redraw();
          } else {
            removeEdge(row.type, row.otherId).then(refresh);
          }
        };

        // Committed row: the type dropdown flips the edge; the target name is locked; trash deletes it.
        const committedRow = (row) => {
          const other = allTasks.find((x) => x.id === row.otherId);
          return m(
            ".dep-row",
            { key: `c-${row.otherId}` },
            typeSelect(row.type, (e) => flipCommitted(row, e.target.value)),
            m("input.dep-target-locked", {
              type: "text",
              readonly: true,
              value: other ? other.name : "(unknown)",
              tabindex: "-1",
            }),
            removeBtn(() => removeCommitted(row))
          );
        };

        // Draft row: in-progress add, not committed until a target is picked.
        const draftRow = (row) =>
          m(
            ".dep-row",
            { key: `n-${row.key}` },
            typeSelect(row.type, (e) => {
              row.type = e.target.value;
            }),
            searchInput(row.key, row.query, (o) => commitNewRow(row, o)),
            removeBtn(() => {
              vnode.state.newRows = vnode.state.newRows.filter(
                (r) => r !== row
              );
              vnode.state.depWarning = null;
            })
          );

        return m(".field", [
          m(
            ".field-label.collapsible-label",
            {
              onclick: () => {
                vnode.state.dependenciesExpanded =
                  !vnode.state.dependenciesExpanded;
              },
              role: "button",
              tabindex: 0,
              "aria-expanded": vnode.state.dependenciesExpanded
                ? "true"
                : "false",
              onkeydown: (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  vnode.state.dependenciesExpanded =
                    !vnode.state.dependenciesExpanded;
                }
              },
            },
            m("span", "Dependencies"),
            m(
              "span.icon.icon-chevron-right" +
                (vnode.state.dependenciesExpanded ? ".rotated" : "")
            )
          ),
          vnode.state.dependenciesExpanded
            ? m(".dep-list", [
                vnode.state.depWarning
                  ? m(".dep-warning", vnode.state.depWarning)
                  : null,
                // Committed rows then draft rows; keyed rows live in their own container so the outer array stays all-unkeyed (Mithril rule).
                m(".dep-rows", [
                  ...committed.map((r) => committedRow(r)),
                  ...vnode.state.newRows.map((r) => draftRow(r)),
                ]),
                m(
                  "button.icon-btn.dep-add",
                  {
                    type: "button",
                    title: "Add dependency",
                    "aria-label": "Add dependency",
                    onclick: () => {
                      vnode.state.newRows.push({
                        key: ++vnode.state._newRowSeq,
                        type: DEP_BLOCKED_BY,
                        query: "",
                      });
                      vnode.state.openSearch = null;
                      vnode.state.depWarning = null;
                    },
                  },
                  m("span.icon.icon-plus")
                ),
              ])
            : null,
        ]);
      })()
    );
  },
};
