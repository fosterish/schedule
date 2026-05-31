import m from "mithril";
import { PALETTE } from "../palette.js";

/** Color-swatch picker; onpick(key) fires on click, selected swatch shows an accent ring so similar colors stay distinguishable. */
export const ColorPicker = {
  view(vnode) {
    const { value, onpick } = vnode.attrs;
    return m(
      ".color-picker",
      PALETTE.map((p) =>
        m(
          "button.color-swatch" + (p.key === value ? ".selected" : ""),
          {
            type: "button",
            key: p.key,
            // Only the fill needs the hex; the selected ring is painted via box-shadow.
            style: `background:${p.hex}`,
            "aria-label": p.label,
            "aria-pressed": p.key === value ? "true" : "false",
            title: p.label,
            onclick: (e) => {
              e.preventDefault();
              if (typeof onpick === "function") onpick(p.key);
            },
          },
          // Rendered unconditionally so the swatch size doesn't jump between selected states.
          m("span.color-swatch-check", "\u2713")
        )
      )
    );
  },
};
