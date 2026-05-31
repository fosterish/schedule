import m from "mithril";

/** Autosave-on-blur field; commits changed values via onsave, supports a validate hook and an external invalid flag. */
export const AutoField = {
  oninit(vnode) {
    vnode.state.local = String(vnode.attrs.value ?? "");
    vnode.state.committed = vnode.state.local;
    vnode.state.saving = false;
    vnode.state.savedAt = 0;
    vnode.state.error = null;
    vnode.state.invalid = false;
  },
  onbeforeupdate(vnode, old) {
    // Accept a new parent value only when the user isn't mid-edit.
    if (
      vnode.attrs.value !== old.attrs.value &&
      vnode.state.local === vnode.state.committed
    ) {
      vnode.state.local = String(vnode.attrs.value ?? "");
      vnode.state.committed = vnode.state.local;
    }
    return true;
  },
  view(vnode) {
    const s = vnode.state;
    const a = vnode.attrs;
    const tag = a.type === "textarea" ? "textarea" : "input";
    const inputType = a.type === "textarea" ? null : a.type || "text";
    const commit = () => {
      if (s.local === s.committed) return;
      let next;
      if (a.validate) {
        const r = a.validate(s.local);
        if (!r || !r.ok) {
          // Don't touch s.committed so the parent's value prop won't snap the typed text away on next render.
          s.invalid = true;
          m.redraw();
          return;
        }
        next = r.value;
      } else if (a.type === "number") {
        next = Number(s.local);
        if (!Number.isFinite(next)) {
          s.local = s.committed;
          s.error = "invalid number";
          m.redraw();
          return;
        }
      } else {
        next = s.local;
      }
      const prev = s.committed;
      s.committed = s.local;
      s.saving = true;
      s.error = null;
      Promise.resolve()
        .then(() => a.onsave && a.onsave(next))
        .then(() => {
          s.savedAt = Date.now();
          setTimeout(() => m.redraw(), 800);
        })
        .catch((err) => {
          s.local = prev;
          s.committed = prev;
          s.error = err.message || "failed";
        })
        .finally(() => {
          s.saving = false;
          m.redraw();
        });
    };
    const clearInvalid = () => {
      if (s.invalid) {
        s.invalid = false;
        m.redraw();
      }
    };
    const handlers = {
      value: s.local,
      oninput: (e) => {
        s.local = e.target.value;
        clearInvalid();
      },
      onfocus: clearInvalid,
      onblur: commit,
      onkeydown: (e) => {
        if (e.key === "Enter" && tag === "input") {
          e.preventDefault();
          e.target.blur();
        }
      },
      type: inputType,
      placeholder: a.placeholder,
      disabled: a.disabled,
      autofocus: a.autofocus,
    };
    if (a.commitOnChange) {
      handlers.onchange = commit;
    }
    return m(
      "span.autofield" + (s.invalid || a.invalid ? ".invalid" : ""),
      m(tag, handlers),
      Date.now() - s.savedAt < 800 ? m("span.saved-tick.show", "\u2713") : null,
      s.error ? m("span.muted", { style: "color: var(--danger)" }, " " + s.error) : null
    );
  },
};
