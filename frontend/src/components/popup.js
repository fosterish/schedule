import m from "mithril";

// Inline SVG so the trash glyph renders consistently across platforms and inherits currentColor.
export function trashIcon() {
  return m.trust(
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="3 6 5 6 21 6"></polyline>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
      '<path d="M10 11v6M14 11v6"></path>' +
      '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>' +
      "</svg>"
  );
}

/** Modal popup; onclose handles dismissals, optional onDelete renders a trash button, optional footer renders a bottom action row. */
export const Popup = {
  oncreate(vnode) {
    const onKey = (e) => {
      if (e.key === "Escape" && vnode.attrs.onclose) vnode.attrs.onclose();
    };
    vnode.state._onKey = onKey;
    document.addEventListener("keydown", onKey);
  },
  onremove(vnode) {
    document.removeEventListener("keydown", vnode.state._onKey);
  },
  view(vnode) {
    const { onclose, onDelete, title, deleteLabel, footer } = vnode.attrs;
    return m(
      ".popup-overlay",
      {
        onclick: (e) => {
          if (e.target.classList.contains("popup-overlay") && onclose)
            onclose();
        },
      },
      m(
        ".popup",
        { onclick: (e) => e.stopPropagation() },
        m(
          ".popup-header",
          title ? m("h3", title) : m("h3.is-empty", "\u00A0"),
          m(
            ".popup-corner",
            onDelete
              ? m(
                  "button.icon-btn.danger",
                  {
                    onclick: onDelete,
                    "aria-label": deleteLabel || "Delete",
                    title: deleteLabel || "Delete",
                  },
                  trashIcon()
                )
              : null,
            m(
              "button.close",
              {
                onclick: () => onclose && onclose(),
                "aria-label": "Close",
                title: "Close",
              },
              m("span.icon.icon-close")
            )
          )
        ),
        vnode.children,
        footer ? m(".popup-footer", footer) : null
      )
    );
  },
};
