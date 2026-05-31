import m from "mithril";
import { paletteColor } from "../palette.js";

/** Pip row mirroring ColorPicker; value clamped to [0..count] for legacy rows. onpick gives a 1-based index. readonly drops interaction. */
export const PipPicker = {
  view(vnode) {
    const { value, count, color, onpick, readonly } = vnode.attrs;
    const filled = Math.min(count, Math.max(0, Math.round(value || 0)));
    const hex = paletteColor(color);
    return m(
      ".pip-picker" + (readonly ? ".readonly" : ""),
      Array.from({ length: count }, (_, i) => {
        const idx = i + 1;
        const isFilled = idx <= filled;
        return m(
          "button.pip" + (isFilled ? ".filled" : ""),
          {
            type: "button",
            key: idx,
            disabled: !!readonly,
            tabindex: readonly ? -1 : 0,
            "aria-label": `Set to ${idx}`,
            style: isFilled ? `background:${hex};border-color:${hex}` : "",
            onclick: readonly
              ? undefined
              : (e) => {
                  e.preventDefault();
                  // Stop the click from bubbling to a parent row's onclick (projects list rows route to detail).
                  e.stopPropagation();
                  if (typeof onpick === "function") onpick(idx);
                },
          }
        );
      })
    );
  },
};
